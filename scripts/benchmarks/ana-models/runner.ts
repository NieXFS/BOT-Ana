import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from '../../../src/botDefaults';
import type { TenantBotConfig } from '../../../src/configProvider';
import type {
  ProfessionalSelectionGateInput,
  ProfessionalSelectionGateResult,
} from '../../../src/services/professional-selection-gate';
import {
  DEEPSEEK_V4_FLASH_MODEL,
} from '../../../src/services/receptionistLlmProvider';
import {
  CONFLICT_ALTERNATIVES,
  createFixtureToolHarness,
  DEFAULT_SLOTS,
  FIXED_NOW,
  fixtureUpcomingAppointments,
  IDS,
  SERVICES_RESULT,
} from './fixtures';
import { HOLDOUT_SCENARIOS } from './scenarios-holdout';
import { P0_SCENARIOS } from './scenarios';
import type {
  BenchmarkArm,
  BenchmarkGuardMode,
  BenchmarkPromptVariant,
  BenchmarkProvider,
  BenchmarkResult,
  BenchmarkScenario,
  BenchmarkScenarioRun,
  BenchmarkSuite,
  BenchmarkSummaryArm,
  BenchmarkTranscriptEntry,
} from './types';

const BENCHMARK_VERSION = 'ana-models-v5';
const DEFAULT_SEED = 20260727;
const DEFAULT_MAX_COST_USD = 1;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_BYTES_PER_ROUND = 4_096;
const ANTI_VERBOSITY_SUFFIX =
  '\n\nINSTRUÇÃO DE BENCHMARK — BRAÇO ANTI-VERBOSIDADE (não faz parte do prompt de produção): Responda como uma mensagem curta e natural de WhatsApp. Não use bullets, listas numeradas ou Markdown. Use no máximo 1 emoji por mensagem. Diga apenas o necessário para avançar a conversa.';

const MODEL_PRICING = {
  asOf: '2026-07-28',
  currency: 'USD',
  unit: '1M tokens',
  sources: {
    openai: 'https://openai.com/api/pricing/',
    deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
  models: {
    'gpt-4o-mini': {
      inputCacheHit: 0.075,
      inputCacheMiss: 0.15,
      output: 0.6,
    },
    'deepseek-v4-flash': {
      inputCacheHit: 0.0028,
      inputCacheMiss: 0.14,
      output: 0.28,
    },
  },
} as const;

class BenchmarkHarnessError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BenchmarkHarnessError';
    this.code = code;
    if (options && 'cause' in options) {
      this.cause = options.cause;
    }
  }
}

// Hard block de rede interna: o import do brain carrega módulos que constroem
// clientes lazy de Postgres/ERP. Mesmo que um refactor futuro tente usá-los por
// engano, apontar para a porta descartada impede qualquer acesso real.
// O `.env` da Ana pode carregar NODE_ENV=production mesmo no Mac. Este processo
// é deliberadamente um ambiente sintético: fixar `test` impede que o gate de
// dados reais do DeepSeek confunda o harness com o serviço produtivo. Isso não
// relaxa a produção, porque a sobrescrita existe somente neste entrypoint.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://benchmark:benchmark@127.0.0.1:1/benchmark';
process.env.ERP_API_TOKEN = 'benchmark-no-erp-access';
process.env.ERP_BASE_URL = 'http://127.0.0.1:1';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';

interface CliOptions {
  providers: BenchmarkProvider[];
  promptVariants: BenchmarkPromptVariant[];
  repeats: number;
  seed: number;
  caseIds: Set<string> | null;
  suite: BenchmarkSuite;
  guards: BenchmarkGuardMode;
  plan: boolean;
  maxCostUsd: number;
  outputDir?: string;
  reauditDir?: string;
}

function argumentValue(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Valor inválido: ${value}. Use um inteiro positivo.`);
  }
  return parsed;
}

function parseProviders(value: string | undefined): BenchmarkProvider[] {
  const providers = (value ?? 'openai,deepseek')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = providers.filter(
    (provider) => provider !== 'openai' && provider !== 'deepseek'
  );
  if (invalid.length > 0 || providers.length === 0) {
    throw new Error(`Providers inválidos: ${invalid.join(', ') || '(vazio)'}.`);
  }
  return [...new Set(providers)] as BenchmarkProvider[];
}

function parsePromptVariants(
  value: string | undefined
): BenchmarkPromptVariant[] {
  const variants = (value ?? 'base')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = variants.filter(
    (variant) => variant !== 'base' && variant !== 'anti-verbosity'
  );
  if (invalid.length > 0 || variants.length === 0) {
    throw new Error(
      `Variantes de prompt inválidas: ${invalid.join(', ') || '(vazio)'}.`
    );
  }
  return [...new Set(variants)] as BenchmarkPromptVariant[];
}

function parseSuite(value: string | undefined): BenchmarkSuite {
  const suite = (value ?? 'p0').trim().toLowerCase();
  if (suite === 'core') return 'p0';
  if (suite === 'p0' || suite === 'holdout' || suite === 'all') {
    return suite;
  }
  throw new Error('--suite deve ser p0, holdout ou all.');
}

function parseGuardMode(value: string | undefined): BenchmarkGuardMode {
  const mode = (value ?? 'audit').trim().toLowerCase();
  if (mode === 'audit' || mode === 'enforce') return mode;
  throw new Error('--guards deve ser audit ou enforce.');
}

function parseOptions(): CliOptions {
  const maxCostRaw = argumentValue('--max-cost-usd');
  const maxCostUsd =
    maxCostRaw === undefined ? DEFAULT_MAX_COST_USD : Number(maxCostRaw);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error('--max-cost-usd precisa ser um número positivo.');
  }

  const caseRaw = argumentValue('--cases');
  return {
    providers: parseProviders(argumentValue('--providers')),
    promptVariants: parsePromptVariants(
      argumentValue('--prompt-variants') ??
        argumentValue('--prompt-variant')
    ),
    repeats: parsePositiveInt(argumentValue('--repeats'), 1),
    seed: parsePositiveInt(argumentValue('--seed'), DEFAULT_SEED),
    caseIds: caseRaw
      ? new Set(
          caseRaw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      : null,
    suite: parseSuite(argumentValue('--suite')),
    guards: parseGuardMode(argumentValue('--guards')),
    plan: process.argv.includes('--plan'),
    maxCostUsd,
    outputDir: argumentValue('--output-dir'),
    reauditDir: argumentValue('--reaudit'),
  };
}

function buildArm(
  provider: BenchmarkProvider,
  promptVariant: BenchmarkPromptVariant = 'base'
): BenchmarkArm {
  return {
    provider,
    model:
      provider === 'deepseek' ? DEEPSEEK_V4_FLASH_MODEL : 'gpt-4o-mini',
    promptVariant,
    thinking: 'disabled',
    temperature: 0.4,
    maxTokens: 500,
  };
}

function promptForVariant(
  basePrompt: string,
  variant: BenchmarkPromptVariant
): string {
  return variant === 'anti-verbosity'
    ? `${basePrompt}${ANTI_VERBOSITY_SUFFIX}`
    : basePrompt;
}

function buildConfig(arm: BenchmarkArm): TenantBotConfig {
  return {
    tenantSlug: 'benchmark-ana',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT,
    greetingMessage: DEFAULT_GREETING_MESSAGE,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    aiProvider: arm.provider,
    aiModel: arm.model,
    aiTemperature: arm.temperature,
    aiMaxTokens: arm.maxTokens,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '08:00',
    botActiveEnd: '20:00',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'benchmark-no-whatsapp',
    waApiVersion: 'v21.0',
    phoneNumberId: 'benchmark-phone-number-id',
    isActive: true,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function sanitizeExecutionError(error: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  const candidate = error as {
    status?: number;
    code?: string;
    message?: string;
  };
  const message = String(candidate?.message ?? 'Falha desconhecida')
    .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_ -]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .slice(0, 500);
  return {
    ...(typeof candidate?.status === 'number'
      ? { status: candidate.status }
      : {}),
    ...(typeof candidate?.code === 'string'
      ? { code: candidate.code.slice(0, 100) }
      : {}),
    message,
  };
}

function isLikelyProviderError(error: unknown): boolean {
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    code?: unknown;
  };
  return (
    typeof candidate?.status === 'number' ||
    (typeof candidate?.name === 'string' &&
      /(api|openai|deepseek|connection|timeout|rate.?limit)/i.test(
        candidate.name
      )) ||
    (typeof candidate?.code === 'string' &&
      /^(AI_|ECONN|ETIMEDOUT|ENET|EAI_|ERR_HTTP|rate_limit|invalid_request)/i.test(
        candidate.code
      ))
  );
}

function estimateCostUsd(
  arm: BenchmarkArm,
  usage: BenchmarkScenarioRun['usage']
): number | null {
  if (
    usage.length === 0 ||
    usage.some(
      (request) =>
        request.totalTokens <= 0 ||
        request.promptTokens < 0 ||
        request.completionTokens < 0
    )
  ) {
    return null;
  }

  const pricing = MODEL_PRICING.models[arm.model as keyof typeof MODEL_PRICING.models];
  if (!pricing) return null;

  let total = 0;
  for (const request of usage) {
    const cached = Math.min(
      request.promptTokens,
      request.cachedPromptTokens ?? 0
    );
    const uncached =
      request.cacheMissPromptTokens ??
      Math.max(0, request.promptTokens - cached);

    total += (cached / 1_000_000) * pricing.inputCacheHit;
    total += (uncached / 1_000_000) * pricing.inputCacheMiss;
    total +=
      (request.completionTokens / 1_000_000) * pricing.output;
  }
  return total;
}

function toolResultSucceeded(result: string): boolean {
  try {
    return (JSON.parse(result) as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}

function argsForEffectiveProfessional(
  args: Record<string, unknown>,
  effectiveProfessionalId: string | undefined
): Record<string, unknown> {
  return effectiveProfessionalId
    ? { ...args, professionalId: effectiveProfessionalId }
    : args;
}

type GuardReason =
  BenchmarkScenarioRun['toolTrace'][number]['runtimeGuard']['blockedBy'][number];

interface RuntimeGuardDeps {
  serviceSelectionGate: (
    serviceId: string,
    services: NonNullable<typeof SERVICES_RESULT.services>,
    userMessages: string[]
  ) => { ok: true } | { ok: false; hintMessage: string };
  professionalSelectionGate: (
    input: ProfessionalSelectionGateInput
  ) => ProfessionalSelectionGateResult;
  bookingConfirmationGate: (input: {
    currentUserMessage: string;
    history: Array<{ role: string; content?: unknown }>;
    confirmedDuplicate: boolean;
    expectedBooking: {
      date: string;
      time: string;
      serviceName?: string;
      professionalName?: string;
    };
    duplicateCancellationSucceeded: boolean;
    currentUserMessageIndex: number;
  }) =>
    | { ok: true; consumesCancellationEvidence: boolean }
    | { ok: false; hintMessage: string };
  cancellationIntentGate: (input: {
    currentUserMessage: string;
    history: Array<{ role: string; content?: unknown }>;
  }) => { ok: true } | { ok: false; hintMessage: string };
  resolveCancellationTarget: (input: {
    appointments: ReturnType<typeof fixtureUpcomingAppointments>;
    requestedAppointmentId: string;
    currentUserMessage: string;
    timezone: string;
  }) =>
    | {
        ok: true;
        appointmentId: string;
        correctedFromRequestedId: boolean;
      }
    | { ok: false; message: string };
}

interface RuntimeGuardEvaluation {
  runtimeGuard: {
    wouldExecute: boolean;
    blockedBy: GuardReason[];
  };
  blockedResult: string | null;
  /** Canonicaliza só a I/O; o trace continua guardando args brutos do modelo. */
  effectiveProfessionalId?: string;
  resolvedCancellationId?: string;
  consumesCancellationEvidence: boolean;
}

function evaluateRuntimeGuard(
  deps: RuntimeGuardDeps,
  input: {
    functionName: string;
    args: Record<string, unknown>;
    userText: string;
    gateHistory: Array<{ role: string; content?: unknown }>;
    fixtureMode: BenchmarkScenario['fixtureMode'];
    cancelledAppointmentIds: readonly string[];
    duplicateCancellationSucceeded: boolean;
    timezone: string;
  }
): RuntimeGuardEvaluation {
  const blockedBy: GuardReason[] = [];
  let primaryHint: string | null = null;
  let resolvedCancellationId: string | undefined;
  let consumesCancellationEvidence = false;
  const userMessages = input.gateHistory
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : ''
    );

  if (
    input.functionName === 'getAvailableSlots' ||
    input.functionName === 'bookAppointment'
  ) {
    const isConfirmedRescheduleAfterCancellation =
      input.functionName === 'bookAppointment' &&
      input.duplicateCancellationSucceeded;
    if (!isConfirmedRescheduleAfterCancellation) {
      const selection = deps.serviceSelectionGate(
        String(input.args.serviceId ?? ''),
        SERVICES_RESULT.services ?? [],
        userMessages
      );
      if (!selection.ok) {
        blockedBy.push('service_selection');
        primaryHint = selection.hintMessage;
      }
    }
  }

  // Mesmo após uma remarcação autorizada, a escolha do profissional precisa
  // continuar compatível com o serviço atual. Produção aplica este gate depois
  // do de serviço e antes de toda I/O de calendário.
  let effectiveProfessionalId: string | undefined;
  if (
    (input.functionName === 'getAvailableSlots' ||
      input.functionName === 'bookAppointment') &&
    blockedBy.length === 0
  ) {
    const selection = deps.professionalSelectionGate({
      serviceId: String(input.args.serviceId ?? ''),
      professionalId:
        typeof input.args.professionalId === 'string'
          ? input.args.professionalId
          : undefined,
      servicesResult: SERVICES_RESULT,
      userMessages,
    });
    if (!selection.ok) {
      blockedBy.push('professional_selection');
      primaryHint = selection.hintMessage;
    } else {
      effectiveProfessionalId = selection.effectiveProfessionalId;
    }
  }

  // Produção retorna no primeiro gate bloqueado; não audita confirmação depois
  // que o serviço já falhou.
  if (
    input.functionName === 'bookAppointment' &&
    blockedBy.length === 0
  ) {
    const serviceId = String(input.args.serviceId ?? '');
    const professionalId =
      effectiveProfessionalId ??
      (typeof input.args.professionalId === 'string'
        ? input.args.professionalId
        : undefined);
    const confirmation = deps.bookingConfirmationGate({
      currentUserMessage: input.userText,
      history: input.gateHistory,
      confirmedDuplicate: input.args.confirmedDuplicate === true,
      expectedBooking: {
        date: String(input.args.date ?? ''),
        time: String(input.args.time ?? ''),
        serviceName: SERVICES_RESULT.services?.find(
          (service) => service.id === serviceId
        )?.name,
        professionalName: professionalId
          ? SERVICES_RESULT.professionals?.find(
              (professional) => professional.id === professionalId
            )?.name
          : undefined,
      },
      duplicateCancellationSucceeded:
        input.duplicateCancellationSucceeded,
      currentUserMessageIndex: input.gateHistory.length - 1,
    });
    if (!confirmation.ok) {
      blockedBy.push('booking_confirmation');
      primaryHint = confirmation.hintMessage;
    } else {
      consumesCancellationEvidence =
        confirmation.consumesCancellationEvidence;
    }
  }

  if (input.functionName === 'cancelAppointment') {
    const cancellation = deps.cancellationIntentGate({
      currentUserMessage: input.userText,
      history: input.gateHistory,
    });
    if (!cancellation.ok) {
      blockedBy.push('cancellation_intent');
      primaryHint = cancellation.hintMessage;
    } else {
      const target = deps.resolveCancellationTarget({
        appointments: fixtureUpcomingAppointments(
          input.fixtureMode ?? 'normal',
          input.cancelledAppointmentIds
        ),
        requestedAppointmentId: String(
          input.args.appointmentId ?? ''
        ),
        currentUserMessage: input.userText,
        timezone: input.timezone,
      });
      if (!target.ok) {
        blockedBy.push('cancellation_target');
        primaryHint = target.message;
      } else {
        resolvedCancellationId = target.appointmentId;
      }
    }
  }

  return {
    runtimeGuard: {
      wouldExecute: blockedBy.length === 0,
      blockedBy,
    },
    blockedResult:
      primaryHint === null
        ? null
        : JSON.stringify({ success: false, message: primaryHint }),
    ...(resolvedCancellationId ? { resolvedCancellationId } : {}),
    ...(effectiveProfessionalId ? { effectiveProfessionalId } : {}),
    consumesCancellationEvidence,
  };
}

function addRuntimeGuardObservation(
  protection: BenchmarkScenarioRun['runtimeProtection'],
  runtimeGuard: RuntimeGuardEvaluation['runtimeGuard']
): void {
  if (runtimeGuard.wouldExecute) {
    protection.allowedToolCalls += 1;
    return;
  }

  protection.blockedToolCalls += 1;
  for (const guard of runtimeGuard.blockedBy) {
    if (guard === 'service_selection') {
      protection.blockedBy.serviceSelection += 1;
    } else if (guard === 'professional_selection') {
      protection.blockedBy.professionalSelection += 1;
    } else if (guard === 'booking_confirmation') {
      protection.blockedBy.bookingConfirmation += 1;
    } else if (guard === 'cancellation_intent') {
      protection.blockedBy.cancellationIntent += 1;
    } else if (guard === 'cancellation_target') {
      protection.blockedBy.cancellationTarget += 1;
    } else {
      protection.blockedBy.toolArguments += 1;
    }
  }
}

function collectForbiddenAppointmentIds(
  entries: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
  }>
): string[] {
  return entries.flatMap((entry) => {
    const ids: string[] = [];
    if (
      entry.name === 'cancelAppointment' &&
      typeof entry.args.appointmentId === 'string'
    ) {
      ids.push(entry.args.appointmentId);
    }
    for (const match of entry.result.matchAll(
      /\[id:\s*([^\]\s]+)\]/g
    )) {
      if (match[1]) ids.push(match[1]);
    }
    if (entry.name === 'getUpcomingAppointments') {
      try {
        const parsed = JSON.parse(entry.result) as {
          appointments?: Array<{ id?: unknown }>;
        };
        for (const appointment of parsed.appointments ?? []) {
          if (typeof appointment.id === 'string') {
            ids.push(appointment.id);
          }
        }
      } catch {
        // A inspeção ainda cobre os demais IDs conhecidos e INTERNAL_HINT.
      }
    }
    return ids;
  });
}

function emptyRuntimeProtection(): BenchmarkScenarioRun['runtimeProtection'] {
  return {
    blockedToolCalls: 0,
    allowedToolCalls: 0,
    blockedBy: {
      serviceSelection: 0,
      professionalSelection: 0,
      bookingConfirmation: 0,
      cancellationIntent: 0,
      cancellationTarget: 0,
      toolArguments: 0,
    },
    protectedBookEffects: 0,
    protectedCancelEffects: 0,
    replyAuthoritativeReadChecks: 0,
    replyBlockedByLeakGuard: false,
    replyLeakReasons: [],
    lastReplyLeakReasons: [],
    screenedRawFinalReply: null,
  };
}

/** Mantém reauditoria de JSONL v3 honesta após novos contadores de guardrail. */
function normalizeRuntimeProtection(
  protection: BenchmarkScenarioRun['runtimeProtection'] | undefined
): BenchmarkScenarioRun['runtimeProtection'] {
  const defaults = emptyRuntimeProtection();
  if (!protection) return defaults;

  return {
    ...defaults,
    ...protection,
    blockedBy: {
      ...defaults.blockedBy,
      ...protection.blockedBy,
    },
    replyLeakReasons: Array.isArray(protection.replyLeakReasons)
      ? protection.replyLeakReasons
      : [],
    lastReplyLeakReasons: Array.isArray(protection.lastReplyLeakReasons)
      ? protection.lastReplyLeakReasons
      : [],
  };
}

function estimateWorstCaseScenarioCost(
  arm: BenchmarkArm,
  scenario: BenchmarkScenario,
  systemPrompt: string,
  toolSchemaBytes: number
): number {
  const pricing = MODEL_PRICING.models[arm.model as keyof typeof MODEL_PRICING.models];
  if (!pricing) {
    throw new BenchmarkHarnessError(
      'pricing_missing',
      `Sem tabela de preço para ${arm.model}.`
    );
  }

  const promptTokenUpperBound = Buffer.byteLength(systemPrompt, 'utf8');
  let priorConversationTokenUpperBound = (
    scenario.initialHistory ?? []
  ).reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'),
    0
  );
  let inputTokensUpperBound = 0;
  let outputTokensUpperBound = 0;

  for (const userText of scenario.turns) {
    const userTokenUpperBound = Buffer.byteLength(userText, 'utf8');
    const turnBase =
      promptTokenUpperBound +
      toolSchemaBytes +
      priorConversationTokenUpperBound +
      userTokenUpperBound;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      inputTokensUpperBound +=
        turnBase +
        round * (arm.maxTokens + MAX_TOOL_RESULT_BYTES_PER_ROUND);
      outputTokensUpperBound += arm.maxTokens;
    }

    priorConversationTokenUpperBound +=
      userTokenUpperBound + arm.maxTokens;
  }

  // Reserva fail-closed: assume todo input como cache miss.
  const byteBasedUpperBound =
    (inputTokensUpperBound / 1_000_000) * pricing.inputCacheMiss +
    (outputTokensUpperBound / 1_000_000) * pricing.output;

  // Margem adicional para envelopes JSON/protocolo e diferenças de tokenização
  // que não aparecem no texto bruto usado no cálculo.
  return byteBasedUpperBound * 2;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.ceil(ordered.length * fraction) - 1;
  return ordered[Math.max(0, index)];
}

function summarize(results: BenchmarkResult[]): BenchmarkSummaryArm[] {
  const arms = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const key = `${result.arm.provider}:${result.arm.model}:${
      result.arm.promptVariant ?? 'base'
    }`;
    const existing = arms.get(key) ?? [];
    existing.push(result);
    arms.set(key, existing);
  }

  return [...arms.values()].map((armResults) => {
    const first = armResults[0];
    const usage = armResults.flatMap((result) => result.usage);
    const passed = armResults.filter((result) => result.outcome === 'pass').length;
    const failed = armResults.filter((result) => result.outcome === 'fail').length;
    const providerErrors = armResults.filter(
      (result) => result.outcome === 'provider_error'
    ).length;
    const harnessErrors = armResults.filter(
      (result) => result.outcome === 'harness_error'
    ).length;
    const hardFailures = armResults.reduce(
      (count, result) =>
        count +
        result.assertions.filter(
          (assertion) => assertion.severity === 'hard' && !assertion.pass
        ).length,
      0
    );
    const softFailures = armResults.reduce(
      (count, result) =>
        count +
        result.assertions.filter(
          (assertion) => assertion.severity === 'soft' && !assertion.pass
        ).length,
      0
    );
    const successfulResults = armResults.filter(
      (result) => result.outcome === 'pass'
    );
    const allCostsKnown = armResults.every(
      (result) => result.estimatedCostUsd !== null
    );
    const totalEstimatedCost = allCostsKnown
      ? armResults.reduce(
          (sum, result) => sum + (result.estimatedCostUsd ?? 0),
          0
        )
      : null;

    return {
      provider: first.arm.provider,
      model: first.arm.model,
      promptVariant: first.arm.promptVariant ?? 'base',
      runs: armResults.length,
      passed,
      failed,
      providerErrors,
      harnessErrors,
      passRate: armResults.length > 0 ? passed / armResults.length : 0,
      hardFailures,
      softFailures,
      requests: usage.length,
      promptTokens: usage.reduce(
        (sum, request) => sum + request.promptTokens,
        0
      ),
      completionTokens: usage.reduce(
        (sum, request) => sum + request.completionTokens,
        0
      ),
      cachedPromptTokens: usage.reduce(
        (sum, request) => sum + (request.cachedPromptTokens ?? 0),
        0
      ),
      totalTokens: usage.reduce((sum, request) => sum + request.totalTokens, 0),
      totalRequestDurationMs: usage.reduce(
        (sum, request) => sum + request.durationMs,
        0
      ),
      totalResolutionDurationMs: armResults.reduce(
        (sum, result) => sum + result.durationMs,
        0
      ),
      p50RequestMs: percentile(
        usage.map((request) => request.durationMs),
        0.5
      ),
      p95RequestMs: percentile(
        usage.map((request) => request.durationMs),
        0.95
      ),
      p50ResolutionMs: percentile(
        armResults.map((result) => result.durationMs),
        0.5
      ),
      p95ResolutionMs: percentile(
        armResults.map((result) => result.durationMs),
        0.95
      ),
      p50SuccessfulResolutionMs: percentile(
        successfulResults.map((result) => result.durationMs),
        0.5
      ),
      p95SuccessfulResolutionMs: percentile(
        successfulResults.map((result) => result.durationMs),
        0.95
      ),
      estimatedCostUsd: totalEstimatedCost,
      costPerSuccessfulResolutionUsd:
        totalEstimatedCost !== null && passed > 0
          ? totalEstimatedCost / passed
          : null,
    };
  });
}

function csvCell(value: string): string {
  // Output do modelo é não confiável. Aspas não impedem formula injection no
  // Excel/Sheets, então neutralizamos os quatro prefixos executáveis.
  const neutralized = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function buildBlindReviewArtifacts(
  results: BenchmarkResult[],
  random: () => number
): {
  csv: string;
  key: Array<{
    anonymousResponseId: string;
    scenarioId: string;
    repetition: number;
    provider: BenchmarkProvider;
    model: string;
    promptVariant: BenchmarkPromptVariant;
  }>;
} {
  const rows = results.flatMap((result) => {
    let finalAssistantIndex = -1;
    for (let index = result.transcript.length - 1; index >= 0; index -= 1) {
      if (result.transcript[index].role === 'assistant') {
        finalAssistantIndex = index;
        break;
      }
    }
    const contextEntries =
      finalAssistantIndex >= 0
        ? result.transcript.slice(0, finalAssistantIndex)
        : result.transcript;
    const finalReply =
      finalAssistantIndex >= 0
        ? result.transcript[finalAssistantIndex].content
        : '';
    const context = contextEntries
      .map(
        (entry) =>
          `${entry.role === 'user' ? 'Cliente' : 'Ana/atendente'}: ${
            entry.content
          }`
      )
      .join('\n\n');
    return {
      scenarioId: result.scenarioId,
      repetition: result.repetition,
      provider: result.arm.provider,
      model: result.arm.model,
      promptVariant: result.arm.promptVariant ?? 'base',
      anonymousId: hash(
        `${result.runId}:${result.scenarioId}:${result.repetition}:${result.arm.provider}:${result.arm.model}:${result.arm.promptVariant ?? 'base'}`
      ).slice(0, 16),
      context,
      reply: finalReply,
    };
  });
  const ordered = shuffled(rows, random);
  const csv = [
    'scenario_id,repetition,anonymous_response_id,conversation_context,response,context_score,naturalness_score,concision_score,empathy_score,notes',
    ...ordered.map((row) =>
      [
        csvCell(row.scenarioId),
        String(row.repetition),
        csvCell(row.anonymousId),
        csvCell(row.context),
        csvCell(row.reply),
        '',
        '',
        '',
        '',
        '',
      ].join(',')
    ),
  ].join('\n');
  const key = ordered.map((row) => ({
    anonymousResponseId: row.anonymousId,
    scenarioId: row.scenarioId,
    repetition: row.repetition,
    provider: row.provider,
    model: row.model,
    promptVariant: row.promptVariant,
  }));
  return { csv, key };
}

function buildReport(
  results: BenchmarkResult[],
  summary: BenchmarkSummaryArm[],
  metadata: {
    promptHash: string;
    promptVariantHashes: Record<BenchmarkPromptVariant, string | null>;
    fixtureHash: string;
    scenarioHash: string;
    toolSchemaHash: string;
    harnessHash: string;
    stoppedByCostLimit: boolean;
    maxCostUsd: number;
    guardMode: BenchmarkGuardMode;
    suite: BenchmarkSuite;
  }
): string {
  const scenarioIds = [...new Set(results.map((result) => result.scenarioId))];
  const money = (value: number | null) =>
    value === null ? 'indisponível' : `US$ ${value.toFixed(6)}`;
  const observedModels = (
    provider: BenchmarkProvider,
    promptVariant: BenchmarkPromptVariant
  ) => [
    ...new Set(
      results
        .filter(
          (result) =>
            result.arm.provider === provider &&
            (result.arm.promptVariant ?? 'base') === promptVariant
        )
        .flatMap((result) => result.providerReportedModels)
    ),
  ];
  const lines = [
    '# Benchmark Ana — GPT-4o mini × DeepSeek V4 Flash',
    '',
    `Gerado em: ${new Date().toISOString()}`,
    '',
    `Prompt hash: \`${metadata.promptHash}\`  `,
    `Prompt base: \`${metadata.promptVariantHashes.base}\`  `,
    `Prompt anti-verbosidade: ${
      metadata.promptVariantHashes['anti-verbosity']
        ? `\`${metadata.promptVariantHashes['anti-verbosity']}\``
        : 'não selecionado'
    }  `,
    `Fixture hash: \`${metadata.fixtureHash}\`  `,
    `Cenários hash: \`${metadata.scenarioHash}\`  `,
    `Tool schema hash: \`${metadata.toolSchemaHash}\`  `,
    `Harness hash: \`${metadata.harnessHash}\``,
    `Suite: \`${metadata.suite}\`  `,
    `Guardrails: \`${metadata.guardMode}\``,
    '',
    `Execução interrompida pelo limite conservador de custo: ${
      metadata.stoppedByCostLimit ? 'sim' : 'não'
    } (US$ ${metadata.maxCostUsd.toFixed(2)}).`,
    '',
    '## Aderência bruta do modelo',
    '',
    'O pass rate abaixo avalia a tentativa bruta do LLM. Bloqueios de segurança do runtime são mostrados separadamente e não apagam erro do modelo.',
    '',
    '| Provider | Variante | Modelo pedido | Modelo(s) retornado(s) | Passou | Falhou | Erros provider | Erros harness | Pass rate | Hard | Soft | Requests | p50 req | p95 req | p50 E2E | p95 E2E | Custo | Custo/sucesso |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.map(
      (arm) => {
        const returned = observedModels(
          arm.provider,
          arm.promptVariant
        );
        return `| ${arm.provider} | ${arm.promptVariant} | ${arm.model} | ${
          returned.length > 0 ? returned.join(', ') : 'não informado'
        } | ${arm.passed}/${arm.runs} | ${arm.failed} | ${
          arm.providerErrors
        } | ${arm.harnessErrors} | ${(arm.passRate * 100).toFixed(
          1
        )}% | ${arm.hardFailures} | ${arm.softFailures} | ${
          arm.requests
        } | ${arm.p50RequestMs ?? '—'} ms | ${
          arm.p95RequestMs ?? '—'
        } ms | ${arm.p50ResolutionMs ?? '—'} ms | ${
          arm.p95ResolutionMs ?? '—'
        } ms | ${money(arm.estimatedCostUsd)} | ${money(
          arm.costPerSuccessfulResolutionUsd
        )} |`;
      }
    ),
    '',
    '## Proteções do runtime (simulação sobre a mesma trace)',
    '',
    '| Provider | Variante | Tools brutas | Permitidas | Bloqueadas | Args | Serviço | Profissional | Confirmação | Intenção cancel. | Alvo cancel. | Efeitos booking protegidos | Efeitos cancelamento protegidos | Respostas barradas por leak guard |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.map((arm) => {
      const armResults = results.filter(
        (result) =>
          result.arm.provider === arm.provider &&
          (result.arm.promptVariant ?? 'base') === arm.promptVariant
      );
      const total = (selector: (result: BenchmarkResult) => number) =>
        armResults.reduce((sum, result) => sum + selector(result), 0);
      return `| ${arm.provider} | ${arm.promptVariant} | ${total(
        (result) => result.toolTrace.length
      )} | ${total(
        (result) => result.runtimeProtection.allowedToolCalls
      )} | ${total(
        (result) => result.runtimeProtection.blockedToolCalls
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.toolArguments
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.serviceSelection
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.professionalSelection
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.bookingConfirmation
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.cancellationIntent
      )} | ${total(
        (result) => result.runtimeProtection.blockedBy.cancellationTarget
      )} | ${total(
        (result) => result.runtimeProtection.protectedBookEffects
      )} | ${total(
        (result) => result.runtimeProtection.protectedCancelEffects
      )} | ${total(
        (result) =>
          Number(result.runtimeProtection.replyBlockedByLeakGuard)
      )} |`;
    }),
    '',
    'Uma mesma tool pode ser barrada por mais de um guardrail; por isso a soma das colunas de motivo pode superar o total de tools bloqueadas. Esta seção é uma auditoria estática da trace bruta, não um replay de uma segunda conversa com respostas protegidas.',
    '',
    '## Por cenário',
    '',
    '| Cenário | Provider | Variante | Resultado |',
    '|---|---|---|---|',
    ...scenarioIds.flatMap((scenarioId) =>
      summary.map((arm) => {
        const providerResults = results.filter(
          (result) =>
            result.scenarioId === scenarioId &&
            result.arm.provider === arm.provider &&
            (result.arm.promptVariant ?? 'base') === arm.promptVariant
        );
        const passed = providerResults.filter(
          (result) => result.outcome === 'pass'
        ).length;
        const errors = providerResults.filter(
          (result) => result.outcome === 'provider_error'
        ).length;
        const harnessErrors = providerResults.filter(
          (result) => result.outcome === 'harness_error'
        ).length;
        const p50 = percentile(
          providerResults.map((result) => result.durationMs),
          0.5
        );
        const cell = `${passed}/${providerResults.length}${
          errors ? ` (${errors} erro provider)` : ''
        }${harnessErrors ? ` (${harnessErrors} erro harness)` : ''} · p50 E2E ${
          p50 ?? '—'
        } ms`;
        return `| ${scenarioId} | ${arm.provider} | ${arm.promptVariant} | ${cell} |`;
      })
    ),
    '',
    '## Falhas',
    '',
  ];

  const failures = results.filter((result) => result.outcome !== 'pass');
  if (failures.length === 0) {
    lines.push('Nenhuma falha automática.');
  } else {
    for (const result of failures) {
      lines.push(
        `### ${result.scenarioId} · ${result.arm.provider}/${result.arm.model} · repetição ${result.repetition}`,
        ''
      );
      if (result.providerError) {
        lines.push(
          `Erro de provider: ${result.providerError.status ?? 'n/a'} ${
            result.providerError.code ?? ''
          } ${result.providerError.message}`.trim(),
          ''
        );
      }
      if (result.harnessError) {
        lines.push(
          `Erro de harness: ${result.harnessError.code ?? 'n/a'} ${
            result.harnessError.message
          }`.trim(),
          ''
        );
      }
      for (const item of result.assertions.filter(
        (assertion) => !assertion.pass
      )) {
        lines.push(
          `- ${item.severity.toUpperCase()} \`${item.id}\`: esperado ${JSON.stringify(
            item.expected
          )}; observado ${JSON.stringify(item.actual)}`
        );
      }
      lines.push('');
    }
  }

  lines.push(
    '## Metodologia de custo',
    '',
    `Tabela congelada em ${MODEL_PRICING.asOf}; preços em USD por 1M tokens. Fontes: ${MODEL_PRICING.sources.openai} e ${MODEL_PRICING.sources.deepseek}. O hard cap reserva, antes de cada par, um teto fail-closed baseado em bytes UTF-8, ${MAX_TOOL_ROUNDS} rodadas e ${MAX_TOOL_RESULT_BYTES_PER_ROUND} bytes de resultado de tool por rodada; usage ausente é contabilizado pelo teto, nunca como zero.`,
    ''
  );

  return lines.join('\n');
}

async function runScenario(
  scenario: BenchmarkScenario,
  arm: BenchmarkArm,
  repetition: number,
  guardMode: BenchmarkGuardMode
): Promise<BenchmarkScenarioRun> {
  const {
    buildSystemPromptFromServices,
    maybePrependGreeting,
    runReceptionistModelLoop,
  } = await import('../../../src/services/brainService');
  const {
    bookingConfirmationGate,
    cancellationIntentGate,
    RescheduleCancellationEvidenceStore,
  } = await import('../../../src/services/bookingConfirmationGate');
  const {
    buildSafeWriteConfirmation,
    inspectCustomerReply,
    needsAuthoritativeAppointmentRead,
    normalizeCustomerReplyStyle,
  } = await import('../../../src/services/customerReplyGuard');
  const {
    serviceSelectionGate,
  } = await import('../../../src/services/service-gate');
  const {
    professionalSelectionGate,
  } = await import('../../../src/services/professional-selection-gate');
  const {
    resolveCancellationTarget,
  } = await import('../../../src/services/calendarService');

  const config = buildConfig(arm);
  const baseSystemPrompt = buildSystemPromptFromServices(
    config,
    SERVICES_RESULT,
    FIXED_NOW
  );
  const systemPrompt = promptForVariant(
    baseSystemPrompt,
    arm.promptVariant
  );
  const harness = createFixtureToolHarness(scenario.fixtureMode);
  if (!harness.dryRun || !harness.state.dryRun) {
    throw new Error('Hard block: benchmark recebeu executor não-dry-run.');
  }

  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = (
    scenario.initialHistory ?? []
  ).map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));
  const transcript: BenchmarkTranscriptEntry[] = [
    ...(scenario.initialHistory ?? []),
  ];
  const toolTrace: BenchmarkScenarioRun['toolTrace'] = [];
  const usage: BenchmarkScenarioRun['usage'] = [];
  const runtimeModels = new Set<string>();
  const providerReportedModels = new Set<string>();
  let exhausted = false;
  const protectedBookKeys = new Set<string>();
  const protectedCancellationIds = new Set<string>();
  const runtimeProtection = emptyRuntimeProtection();
  const rescheduleEvidenceStore =
    new RescheduleCancellationEvidenceStore();
  const evidenceConversationKey = `benchmark:${scenario.id}:${repetition}:${arm.provider}`;

  try {
    for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
      const userTurn = turnIndex + 1;
      const turnNow = FIXED_NOW.getTime() + turnIndex * 60_000;
      const userText = scenario.turns[turnIndex];
      transcript.push({ role: 'user', content: userText });
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userText },
      ];
      const gateHistory = [
        ...history,
        { role: 'user' as const, content: userText },
      ];
      const turnGuardObservations: RuntimeGuardEvaluation[] = [];
      const loop = await runReceptionistModelLoop({
        config,
        messages,
        executeTool: async (functionName, args) => {
          const evaluation = evaluateRuntimeGuard(
            {
              serviceSelectionGate,
              professionalSelectionGate,
              bookingConfirmationGate,
              cancellationIntentGate,
              resolveCancellationTarget,
            },
            {
              functionName,
              args,
              userText,
              gateHistory,
              fixtureMode: scenario.fixtureMode,
              cancelledAppointmentIds: [...protectedCancellationIds],
              duplicateCancellationSucceeded:
                rescheduleEvidenceStore.peek(
                  evidenceConversationKey,
                  turnNow
                ) !== null,
              timezone: config.timezone,
            }
          );
          turnGuardObservations.push(evaluation);
          addRuntimeGuardObservation(
            runtimeProtection,
            evaluation.runtimeGuard
          );

          const effectiveArgs = argsForEffectiveProfessional(
            args,
            evaluation.effectiveProfessionalId
          );

          let result: string;
          const consumedCancellationEvidence =
            evaluation.runtimeGuard.wouldExecute &&
            functionName === 'bookAppointment' &&
            rescheduleEvidenceStore.peek(
              evidenceConversationKey,
              turnNow
            ) !== null
              ? rescheduleEvidenceStore.consume(
                  evidenceConversationKey,
                  turnNow
                )
              : null;
          if (
            guardMode === 'enforce' &&
            !evaluation.runtimeGuard.wouldExecute
          ) {
            if (!evaluation.blockedResult) {
              throw new BenchmarkHarnessError(
                'guard_missing_hint',
                `Guard bloqueou ${functionName} sem INTERNAL_HINT.`
              );
            }
            result = evaluation.blockedResult;
          } else {
            try {
              result = await harness.execute(functionName, effectiveArgs);
            } catch (error) {
              throw new BenchmarkHarnessError(
                'fixture_execute_failed',
                `Fixture falhou ao executar ${functionName}.`,
                { cause: error }
              );
            }
          }
          if (
            consumedCancellationEvidence &&
            !toolResultSucceeded(result)
          ) {
            rescheduleEvidenceStore.restore(
              consumedCancellationEvidence,
              turnNow
            );
          }

          if (
            evaluation.runtimeGuard.wouldExecute &&
            toolResultSucceeded(result)
          ) {
            if (functionName === 'bookAppointment') {
              const key = [
                String(args.date ?? ''),
                String(args.time ?? ''),
                String(args.serviceId ?? ''),
                String(effectiveArgs.professionalId ?? 'auto'),
              ].join('|');
              protectedBookKeys.add(key);
              runtimeProtection.protectedBookEffects =
                protectedBookKeys.size;
            } else if (functionName === 'cancelAppointment') {
              protectedCancellationIds.add(
                evaluation.resolvedCancellationId ??
                  String(args.appointmentId ?? '')
              );
              runtimeProtection.protectedCancelEffects =
                protectedCancellationIds.size;
              rescheduleEvidenceStore.record(
                evidenceConversationKey,
                evaluation.resolvedCancellationId ??
                  String(args.appointmentId ?? ''),
                turnNow
              );
            }
          }

          return result;
        },
        thinkingMode: arm.thinking,
        userId: `bench_${hash(
          `${scenario.id}:${repetition}:${arm.provider}:${arm.promptVariant}`
        ).slice(0, 32)}`,
      });

      let observationIndex = 0;
      const currentTurnTrace = loop.toolTrace.map((entry) => {
        const argumentsWereBlocked =
          !entry.argumentsValidJson ||
          /INTERNAL_HINT: argumentos inválidos para/i.test(entry.result);
        if (argumentsWereBlocked) {
          runtimeProtection.blockedToolCalls += 1;
          runtimeProtection.blockedBy.toolArguments += 1;
          return {
            ...entry,
            userTurn,
            runtimeGuard: {
              wouldExecute: false,
              blockedBy: ['tool_arguments' as const],
            },
          };
        }

        const observation =
          turnGuardObservations[observationIndex];
        observationIndex += 1;
        if (!observation) {
          throw new BenchmarkHarnessError(
            'guard_trace_mismatch',
            'Tool válida ficou sem observação dos guardrails.'
          );
        }
        return {
          ...entry,
          userTurn,
          runtimeGuard: observation.runtimeGuard,
        };
      });
      if (observationIndex !== turnGuardObservations.length) {
        throw new BenchmarkHarnessError(
          'guard_trace_mismatch',
          `Trace de guard (${turnGuardObservations.length}) divergiu das tools válidas (${observationIndex}).`
        );
      }
      toolTrace.push(...currentTurnTrace);
      usage.push(...loop.usage);
      runtimeModels.add(loop.model);
      for (const reportedModel of loop.providerReportedModels ?? []) {
        providerReportedModels.add(reportedModel);
      }
      exhausted ||= loop.exhausted;

      const rawReply = loop.rawReply || DEFAULT_FALLBACK_MESSAGE;
      const finalReply = maybePrependGreeting(
        rawReply,
        history.length === 0,
        config
      );
      const protectedSuccessfulTrace = currentTurnTrace.filter(
        (entry) =>
          entry.runtimeGuard.wouldExecute &&
          toolResultSucceeded(entry.result)
      );
      const safeWriteConfirmation = buildSafeWriteConfirmation(
        protectedSuccessfulTrace
      );
      const candidateReply = normalizeCustomerReplyStyle(
        loop.rawReply ||
          safeWriteConfirmation ||
          DEFAULT_FALLBACK_MESSAGE
      );
      const forbiddenAppointmentIds =
        collectForbiddenAppointmentIds(loop.toolTrace);
      const customerReplyEvidenceTrace = [...loop.toolTrace];
      if (
        needsAuthoritativeAppointmentRead(
          candidateReply,
          customerReplyEvidenceTrace
        )
      ) {
        customerReplyEvidenceTrace.push({
          round: loop.rounds + 1,
          name: 'getUpcomingAppointments',
          args: {},
          argumentsValidJson: true,
          result: await harness.execute(
            'getUpcomingAppointments',
            {}
          ),
        });
        runtimeProtection.replyAuthoritativeReadChecks += 1;
      }
      const inspection = inspectCustomerReply(
        candidateReply,
        SERVICES_RESULT,
        forbiddenAppointmentIds,
        customerReplyEvidenceTrace
      );
      runtimeProtection.lastReplyLeakReasons = [
        ...inspection.reasons,
      ];
      if (!inspection.safe) {
        runtimeProtection.replyBlockedByLeakGuard = true;
        for (const reason of inspection.reasons) {
          if (!runtimeProtection.replyLeakReasons.includes(reason)) {
            runtimeProtection.replyLeakReasons.push(reason);
          }
        }
      }
      runtimeProtection.screenedRawFinalReply = maybePrependGreeting(
        inspection.safe
          ? candidateReply
          : safeWriteConfirmation || DEFAULT_FALLBACK_MESSAGE,
        history.length === 0,
        config
      );
      transcript.push({ role: 'assistant', content: finalReply });
      history.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: finalReply }
      );
    }

    return {
      scenarioId: scenario.id,
      repetition,
      arm,
      transcript,
      toolTrace,
      usage,
      runtimeModels: [...runtimeModels],
      providerReportedModels: [...providerReportedModels],
      exhausted,
      fixtureState: {
        bookAttempts: harness.state.bookAttempts,
        bookEffects: harness.state.bookEffects,
        cancelAttempts: harness.state.cancelAttempts,
        cancelEffects: harness.state.cancelEffects,
        cancelledAppointmentIds: [...harness.state.cancelledAppointmentIds],
      },
      runtimeProtection,
    };
  } catch (error) {
    const sanitized = sanitizeExecutionError(error);
    const isHarnessError =
      error instanceof BenchmarkHarnessError ||
      !isLikelyProviderError(error);
    return {
      scenarioId: scenario.id,
      repetition,
      arm,
      transcript,
      toolTrace,
      usage,
      runtimeModels: [...runtimeModels],
      providerReportedModels: [...providerReportedModels],
      exhausted,
      fixtureState: {
        bookAttempts: harness.state.bookAttempts,
        bookEffects: harness.state.bookEffects,
        cancelAttempts: harness.state.cancelAttempts,
        cancelEffects: harness.state.cancelEffects,
        cancelledAppointmentIds: [...harness.state.cancelledAppointmentIds],
      },
      runtimeProtection,
      ...(isHarnessError
        ? {
            harnessError: {
              ...(sanitized.code ? { code: sanitized.code } : {}),
              message: sanitized.message,
            },
          }
        : { providerError: sanitized }),
    };
  }
}

interface ReauditedResult {
  stored: BenchmarkResult;
  run: BenchmarkScenarioRun;
  assertions: BenchmarkResult['assertions'];
  blockedSuccessfulBookCalls: number;
  blockedSuccessfulCancelCalls: number;
}

function assistantRepliesByScenarioTurn(
  result: BenchmarkScenarioRun,
  scenario: BenchmarkScenario
): Map<number, string> {
  const replies = new Map<number, string>();
  const dynamicTranscript = result.transcript.slice(
    scenario.initialHistory?.length ?? 0
  );
  let userTurn = 0;
  for (const entry of dynamicTranscript) {
    if (entry.role === 'user') {
      userTurn += 1;
    } else if (userTurn > 0) {
      const previous = replies.get(userTurn);
      replies.set(
        userTurn,
        previous ? `${previous}\n${entry.content}` : entry.content
      );
    }
  }
  return replies;
}

async function reauditStoredResult(
  storedInput: BenchmarkResult,
  scenario: BenchmarkScenario,
  deps: RuntimeGuardDeps & {
    inspectCustomerReply: (
      reply: string,
      services: typeof SERVICES_RESULT,
      forbiddenAppointmentIds: string[],
      toolTrace: Array<{ name: string; result: string }>
    ) => {
      safe: boolean;
      reasons: BenchmarkScenarioRun['runtimeProtection']['replyLeakReasons'];
    };
    buildSafeWriteConfirmation: (
      trace: Array<{ name: string; result: string }>
    ) => string | null;
    needsAuthoritativeAppointmentRead: (
      reply: string,
      trace: Array<{ name: string; result: string }>
    ) => boolean;
    normalizeCustomerReplyStyle: (reply: string) => string;
  }
): Promise<ReauditedResult> {
  const stored = {
    ...storedInput,
    arm: {
      ...storedInput.arm,
      promptVariant: storedInput.arm.promptVariant ?? 'base',
    },
    runtimeProtection: normalizeRuntimeProtection(
      storedInput.runtimeProtection
    ),
  } as BenchmarkResult;
  const runtimeProtection = emptyRuntimeProtection();
  const protectedBookKeys = new Set<string>();
  const protectedCancellationIds = new Set<string>();
  const {
    RescheduleCancellationEvidenceStore,
  } = await import('../../../src/services/bookingConfirmationGate');
  const rescheduleEvidenceStore =
    new RescheduleCancellationEvidenceStore();
  const evidenceConversationKey = `reaudit:${stored.scenarioId}:${stored.repetition}:${stored.arm.provider}`;
  const replies = assistantRepliesByScenarioTurn(stored, scenario);
  const recomputedTrace: BenchmarkScenarioRun['toolTrace'] = [];
  let blockedSuccessfulBookCalls = 0;
  let blockedSuccessfulCancelCalls = 0;
  const history: Array<{ role: string; content?: unknown }> = (
    scenario.initialHistory ?? []
  ).map((entry) => ({ role: entry.role, content: entry.content }));

  for (
    let turnIndex = 0;
    turnIndex < scenario.turns.length;
    turnIndex += 1
  ) {
    const userTurn = turnIndex + 1;
    const turnNow = FIXED_NOW.getTime() + turnIndex * 60_000;
    const userText = scenario.turns[turnIndex];
    const gateHistory = [
      ...history,
      { role: 'user', content: userText },
    ];
    const turnTrace = stored.toolTrace.filter(
      (entry) => entry.userTurn === userTurn
    );
    const guardedTurnTrace: BenchmarkScenarioRun['toolTrace'] = [];

    for (const entry of turnTrace) {
      const argumentsWereBlocked =
        !entry.argumentsValidJson ||
        /INTERNAL_HINT: argumentos inválidos para/i.test(entry.result);
      if (argumentsWereBlocked) {
        const runtimeGuard = {
          wouldExecute: false,
          blockedBy: ['tool_arguments' as const],
        };
        addRuntimeGuardObservation(runtimeProtection, runtimeGuard);
        const recomputed = { ...entry, runtimeGuard };
        recomputedTrace.push(recomputed);
        guardedTurnTrace.push(recomputed);
        continue;
      }

      const evaluation = evaluateRuntimeGuard(deps, {
        functionName: entry.name,
        args: entry.args,
        userText,
        gateHistory,
        fixtureMode: scenario.fixtureMode,
        cancelledAppointmentIds: [...protectedCancellationIds],
        duplicateCancellationSucceeded:
          rescheduleEvidenceStore.peek(
            evidenceConversationKey,
            turnNow
          ) !== null,
        timezone: 'America/Sao_Paulo',
      });
      addRuntimeGuardObservation(
        runtimeProtection,
        evaluation.runtimeGuard
      );
      const recomputed = {
        ...entry,
        runtimeGuard: evaluation.runtimeGuard,
      };
      recomputedTrace.push(recomputed);
      const effectiveArgs = argsForEffectiveProfessional(
        entry.args,
        evaluation.effectiveProfessionalId
      );
      const consumedCancellationEvidence =
        evaluation.runtimeGuard.wouldExecute &&
        entry.name === 'bookAppointment' &&
        rescheduleEvidenceStore.peek(
          evidenceConversationKey,
          turnNow
        ) !== null
          ? rescheduleEvidenceStore.consume(
              evidenceConversationKey,
              turnNow
            )
          : null;
      guardedTurnTrace.push({
        ...recomputed,
        result:
          evaluation.runtimeGuard.wouldExecute
            ? entry.result
            : evaluation.blockedResult ??
              JSON.stringify({
                success: false,
                message:
                  'INTERNAL_HINT: chamada bloqueada pelos guardrails atuais.',
              }),
      });
      if (
        consumedCancellationEvidence &&
        !toolResultSucceeded(entry.result)
      ) {
        rescheduleEvidenceStore.restore(
          consumedCancellationEvidence,
          turnNow
        );
      }

      if (
        !evaluation.runtimeGuard.wouldExecute &&
        toolResultSucceeded(entry.result)
      ) {
        if (entry.name === 'bookAppointment') {
          blockedSuccessfulBookCalls += 1;
        } else if (entry.name === 'cancelAppointment') {
          blockedSuccessfulCancelCalls += 1;
        }
      }

      if (
        evaluation.runtimeGuard.wouldExecute &&
        toolResultSucceeded(entry.result)
      ) {
        if (entry.name === 'bookAppointment') {
          protectedBookKeys.add(
            [
              String(entry.args.date ?? ''),
              String(entry.args.time ?? ''),
              String(entry.args.serviceId ?? ''),
              String(effectiveArgs.professionalId ?? 'auto'),
            ].join('|')
          );
          runtimeProtection.protectedBookEffects =
            protectedBookKeys.size;
        } else if (entry.name === 'cancelAppointment') {
          protectedCancellationIds.add(
            evaluation.resolvedCancellationId ??
              String(entry.args.appointmentId ?? '')
          );
          runtimeProtection.protectedCancelEffects =
            protectedCancellationIds.size;
          rescheduleEvidenceStore.record(
            evidenceConversationKey,
            evaluation.resolvedCancellationId ??
              String(entry.args.appointmentId ?? ''),
            turnNow
          );
        }
      }
    }

    const reply = replies.get(userTurn) ?? '';
    if (reply) {
      const normalizedReply =
        deps.normalizeCustomerReplyStyle(reply);
      const forbiddenAppointmentIds =
        collectForbiddenAppointmentIds(guardedTurnTrace);
      const customerReplyEvidenceTrace = [...guardedTurnTrace];
      if (
        deps.needsAuthoritativeAppointmentRead(
          normalizedReply,
          customerReplyEvidenceTrace
        )
      ) {
        customerReplyEvidenceTrace.push({
          userTurn,
          round: 0,
          name: 'getUpcomingAppointments',
          args: {},
          argumentsValidJson: true,
          result: JSON.stringify({
            success: true,
            appointments: fixtureUpcomingAppointments(
              scenario.fixtureMode ?? 'normal',
              [...protectedCancellationIds]
            ),
          }),
          runtimeGuard: {
            wouldExecute: true,
            blockedBy: [],
          },
        });
        runtimeProtection.replyAuthoritativeReadChecks += 1;
      }
      const inspection = deps.inspectCustomerReply(
        normalizedReply,
        SERVICES_RESULT,
        forbiddenAppointmentIds,
        customerReplyEvidenceTrace
      );
      runtimeProtection.lastReplyLeakReasons = [
        ...inspection.reasons,
      ];
      if (!inspection.safe) {
        runtimeProtection.replyBlockedByLeakGuard = true;
        for (const reason of inspection.reasons) {
          if (
            !runtimeProtection.replyLeakReasons.includes(reason)
          ) {
            runtimeProtection.replyLeakReasons.push(reason);
          }
        }
      }
      const safeWriteConfirmation =
        deps.buildSafeWriteConfirmation(
          guardedTurnTrace.filter(
            (entry) =>
              entry.runtimeGuard.wouldExecute &&
              toolResultSucceeded(entry.result)
          )
        );
      runtimeProtection.screenedRawFinalReply = inspection.safe
        ? normalizedReply
        : safeWriteConfirmation || DEFAULT_FALLBACK_MESSAGE;
    }

    history.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: reply }
    );
  }

  const run: BenchmarkScenarioRun = {
    ...stored,
    toolTrace: recomputedTrace,
    runtimeProtection,
  };
  const assertions =
    stored.providerError || stored.harnessError
      ? []
      : scenario.evaluate(run);
  return {
    stored,
    run,
    assertions,
    blockedSuccessfulBookCalls,
    blockedSuccessfulCancelCalls,
  };
}

function sumProtection(
  results: ReauditedResult[],
  source: 'original' | 'current',
  selector: (
    protection: BenchmarkScenarioRun['runtimeProtection']
  ) => number
): number {
  return results.reduce(
    (sum, item) =>
      sum +
      selector(
        source === 'original'
          ? item.stored.runtimeProtection
          : item.run.runtimeProtection
      ),
    0
  );
}

async function runReaudit(inputDir: string): Promise<void> {
  const targetDir = path.resolve(inputDir);
  const resultsPath = path.join(targetDir, 'results.jsonl');
  const manifestPath = path.join(targetDir, 'manifest.json');
  const reportPath = path.join(targetDir, 'report.md');
  const [resultsSource, manifestSource, originalReport] =
    await Promise.all([
      readFile(resultsPath, 'utf8'),
      readFile(manifestPath, 'utf8'),
      readFile(reportPath, 'utf8'),
    ]);
  const storedResults = resultsSource
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as BenchmarkResult;
      } catch (error) {
        throw new BenchmarkHarnessError(
          'reaudit_invalid_jsonl',
          `Linha ${index + 1} de results.jsonl não é JSON válido.`,
          { cause: error }
        );
      }
    });
  if (storedResults.length === 0) {
    throw new BenchmarkHarnessError(
      'reaudit_empty_results',
      'results.jsonl não contém resultados.'
    );
  }

  const allScenarios = [...P0_SCENARIOS, ...HOLDOUT_SCENARIOS];
  const scenarioById = new Map(
    allScenarios.map((scenario) => [scenario.id, scenario])
  );
  const unknownScenarios = [
    ...new Set(
      storedResults
        .map((result) => result.scenarioId)
        .filter((id) => !scenarioById.has(id))
    ),
  ];
  if (unknownScenarios.length > 0) {
    throw new BenchmarkHarnessError(
      'reaudit_unknown_scenario',
      `Cenários da rodada sem definição atual: ${unknownScenarios.join(
        ', '
      )}.`
    );
  }

  const [
    bookingGuards,
    serviceGuards,
    professionalGuards,
    calendarGuards,
    replyGuards,
    brain,
  ] = await Promise.all([
    import('../../../src/services/bookingConfirmationGate'),
    import('../../../src/services/service-gate'),
    import('../../../src/services/professional-selection-gate'),
    import('../../../src/services/calendarService'),
    import('../../../src/services/customerReplyGuard'),
    import('../../../src/services/brainService'),
  ]);
  const deps = {
    bookingConfirmationGate:
      bookingGuards.bookingConfirmationGate,
    cancellationIntentGate:
      bookingGuards.cancellationIntentGate,
    serviceSelectionGate: serviceGuards.serviceSelectionGate,
    professionalSelectionGate:
      professionalGuards.professionalSelectionGate,
    resolveCancellationTarget:
      calendarGuards.resolveCancellationTarget,
    inspectCustomerReply: replyGuards.inspectCustomerReply,
    buildSafeWriteConfirmation:
      replyGuards.buildSafeWriteConfirmation,
    needsAuthoritativeAppointmentRead:
      replyGuards.needsAuthoritativeAppointmentRead,
    normalizeCustomerReplyStyle:
      replyGuards.normalizeCustomerReplyStyle,
  };
  const reaudited: ReauditedResult[] = [];
  for (const stored of storedResults) {
    reaudited.push(
      await reauditStoredResult(
        stored,
        scenarioById.get(stored.scenarioId)!,
        deps
      )
    );
  }

  const manifest = JSON.parse(manifestSource) as {
    promptHash?: string;
    toolSchemaHash?: string;
  };
  const currentBasePrompt = brain.buildSystemPromptFromServices(
    buildConfig(buildArm('openai')),
    SERVICES_RESULT,
    FIXED_NOW
  );
  const currentPromptHash = hash(currentBasePrompt);
  const currentToolSchemaHash = hash(
    JSON.stringify(brain.RECEPTIONIST_TOOLS)
  );
  const groups = new Map<string, ReauditedResult[]>();
  for (const item of reaudited) {
    const key = `${item.stored.arm.provider}/${item.stored.arm.model}`;
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  const allAssertions = reaudited.flatMap((item) => item.assertions);
  const originalProtectionStart = originalReport.indexOf(
    '## Proteções do runtime'
  );
  const originalProtectionEnd =
    originalProtectionStart >= 0
      ? originalReport.indexOf(
          '\n## ',
          originalProtectionStart + 3
        )
      : -1;
  const originalProtectionSection =
    originalProtectionStart >= 0
      ? originalReport
          .slice(
            originalProtectionStart,
            originalProtectionEnd >= 0
              ? originalProtectionEnd
              : undefined
          )
          .trim()
      : 'Seção original não encontrada.';
  const lines = [
    '# Reauditoria estática offline — guardrails atuais',
    '',
    `Gerado em: ${new Date().toISOString()}`,
    '',
    `Fonte imutável: \`${resultsPath}\``,
    '',
    `Resultados reprocessados: ${reaudited.length}. Zero chamadas a provider, ERP, Postgres ou WhatsApp.`,
    '',
    `Prompt hash original: \`${manifest.promptHash ?? 'ausente'}\`  `,
    `Prompt hash atual: \`${currentPromptHash}\`  `,
    `Prompt preservado: ${
      manifest.promptHash === currentPromptHash ? 'sim' : 'NÃO'
    }`,
    '',
    `Tool schema hash original: \`${
      manifest.toolSchemaHash ?? 'ausente'
    }\`  `,
    `Tool schema hash atual: \`${currentToolSchemaHash}\`  `,
    `Tool schema preservado: ${
      manifest.toolSchemaHash === currentToolSchemaHash ? 'sim' : 'NÃO'
    }`,
    '',
    '## Comparação das proteções',
    '',
    '| Braço | Bloqueadas original | Bloqueadas atual | Booking permitido original | Booking permitido atual | Cancelamento permitido original | Cancelamento permitido atual | Writes booking brutos agora bloqueados | Writes cancel brutos agora bloqueados | Respostas barradas atual |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...[...groups.entries()].map(([label, group]) => {
      const originalBlocked = sumProtection(
        group,
        'original',
        (protection) => protection.blockedToolCalls
      );
      const currentBlocked = sumProtection(
        group,
        'current',
        (protection) => protection.blockedToolCalls
      );
      const originalBooks = sumProtection(
        group,
        'original',
        (protection) => protection.protectedBookEffects
      );
      const currentBooks = sumProtection(
        group,
        'current',
        (protection) => protection.protectedBookEffects
      );
      const originalCancels = sumProtection(
        group,
        'original',
        (protection) => protection.protectedCancelEffects
      );
      const currentCancels = sumProtection(
        group,
        'current',
        (protection) => protection.protectedCancelEffects
      );
      const blockedBooks = group.reduce(
        (sum, item) =>
          sum + item.blockedSuccessfulBookCalls,
        0
      );
      const blockedCancels = group.reduce(
        (sum, item) =>
          sum + item.blockedSuccessfulCancelCalls,
        0
      );
      const blockedReplies = group.filter(
        (item) =>
          item.run.runtimeProtection.replyBlockedByLeakGuard
      ).length;
      return `| ${label} | ${originalBlocked} | ${currentBlocked} | ${originalBooks} | ${currentBooks} | ${originalCancels} | ${currentCancels} | ${blockedBooks} | ${blockedCancels} | ${blockedReplies} |`;
    }),
    '',
    '“Permitido” reproduz a coluna de efeitos protegidos do relatório original: writes brutos com success:true que os guardrails deixariam chegar à fronteira de persistência. As colunas “agora bloqueados” contam success:true da fixture que os guardrails atuais rejeitariam.',
    '',
    '### Motivos atuais',
    '',
    '| Braço | Args | Serviço | Profissional | Confirmação | Intenção cancel. | Alvo cancel. |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...[...groups.entries()].map(([label, group]) => {
      const total = (
        selector: (
          blockedBy: BenchmarkScenarioRun['runtimeProtection']['blockedBy']
        ) => number
      ) =>
        sumProtection(
          group,
          'current',
          (protection) => selector(protection.blockedBy)
        );
      return `| ${label} | ${total(
        (blockedBy) => blockedBy.toolArguments
      )} | ${total(
        (blockedBy) => blockedBy.serviceSelection
      )} | ${total(
        (blockedBy) => blockedBy.professionalSelection
      )} | ${total(
        (blockedBy) => blockedBy.bookingConfirmation
      )} | ${total(
        (blockedBy) => blockedBy.cancellationIntent
      )} | ${total(
        (blockedBy) => blockedBy.cancellationTarget
      )} |`;
    }),
    '',
    '### Respostas barradas atuais',
    '',
    ...reaudited.flatMap((item) => {
      if (!item.run.runtimeProtection.replyBlockedByLeakGuard) {
        return [];
      }
      return [
        `- \`${item.stored.scenarioId}\` · ${item.stored.arm.provider}/${item.stored.arm.model} · repetição ${item.stored.repetition}: ${item.run.runtimeProtection.replyLeakReasons.join(', ')}`,
      ];
    }),
    ...(reaudited.some(
      (item) =>
        item.run.runtimeProtection.replyBlockedByLeakGuard
    )
      ? []
      : ['- Nenhuma.']),
    '',
    '## Assertions recalculadas',
    '',
    `Hard: ${allAssertions.filter((item) => item.severity === 'hard' && item.pass).length} passaram; ${allAssertions.filter((item) => item.severity === 'hard' && !item.pass).length} falharam.  `,
    `Soft: ${allAssertions.filter((item) => item.severity === 'soft' && item.pass).length} passaram; ${allAssertions.filter((item) => item.severity === 'soft' && !item.pass).length} falharam.`,
    '',
  ];
  for (const item of reaudited) {
    const failures = item.assertions.filter(
      (assertion) => !assertion.pass
    );
    if (failures.length === 0) continue;
    lines.push(
      `### ${item.stored.scenarioId} · ${item.stored.arm.provider}/${item.stored.arm.model} · repetição ${item.stored.repetition}`,
      ''
    );
    for (const failure of failures) {
      lines.push(
        `- ${failure.severity.toUpperCase()} \`${failure.id}\`: esperado ${JSON.stringify(
          failure.expected
        )}; observado ${JSON.stringify(failure.actual)}`
      );
    }
    lines.push('');
  }
  lines.push(
    '## Tabela original preservada',
    '',
    originalProtectionSection,
    ''
  );

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');
  const outputPath = path.join(
    targetDir,
    `reaudit-${timestamp}.md`
  );
  await writeFile(outputPath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  const currentBlockedWrites = reaudited.reduce(
    (sum, item) =>
      sum +
      item.blockedSuccessfulBookCalls +
      item.blockedSuccessfulCancelCalls,
    0
  );
  console.log(`Reauditoria offline: ${outputPath}`);
  console.log(
    `Writes brutos bloqueados pelos guardrails atuais: ${currentBlockedWrites}.`
  );
  console.log(
    `Assertions atuais: ${allAssertions.filter((item) => !item.pass).length} falha(s).`
  );
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (options.reauditDir) {
    await runReaudit(options.reauditDir);
    return;
  }
  const suiteScenarios =
    options.suite === 'p0'
      ? P0_SCENARIOS
      : options.suite === 'holdout'
        ? HOLDOUT_SCENARIOS
        : [...P0_SCENARIOS, ...HOLDOUT_SCENARIOS];
  const scenarios = suiteScenarios.filter(
    (scenario) => !options.caseIds || options.caseIds.has(scenario.id)
  );
  if (scenarios.length === 0) {
    throw new Error('Nenhum cenário selecionado.');
  }
  if (options.caseIds) {
    const missing = [...options.caseIds].filter(
      (id) => !suiteScenarios.some((scenario) => scenario.id === id)
    );
    if (missing.length > 0) {
      throw new Error(`Cenários desconhecidos: ${missing.join(', ')}.`);
    }
  }

  const keyStatus = {
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  };

  console.log(
    `Benchmark ${BENCHMARK_VERSION}: suite=${options.suite}, guards=${options.guards}, ${scenarios.length} cenários × ${options.repeats} repetição(ões) × ${options.providers.length} provider(s) × ${options.promptVariants.length} variante(s).`
  );
  console.log(
    `Credenciais presentes: OpenAI=${keyStatus.openai ? 'sim' : 'não'}, DeepSeek=${
      keyStatus.deepseek ? 'sim' : 'não'
    }.`
  );
  console.log(
    'Segurança: ferramentas em memória; zero acesso a ERP, Postgres, WhatsApp ou produção.'
  );

  const {
    buildSystemPromptFromServices,
    RECEPTIONIST_TOOLS,
  } = await import('../../../src/services/brainService');
  const referencePrompt = buildSystemPromptFromServices(
    buildConfig(buildArm('openai')),
    SERVICES_RESULT,
    FIXED_NOW
  );
  const promptHash = hash(referencePrompt);
  const promptVariantHashes: Record<
    BenchmarkPromptVariant,
    string | null
  > = {
    base: promptHash,
    'anti-verbosity': options.promptVariants.includes(
      'anti-verbosity'
    )
      ? hash(promptForVariant(referencePrompt, 'anti-verbosity'))
      : null,
  };
  const toolSchemaBytes = Buffer.byteLength(
    JSON.stringify(RECEPTIONIST_TOOLS),
    'utf8'
  );
  const arms = options.providers.flatMap((provider) =>
    options.promptVariants.map((variant) =>
      buildArm(provider, variant)
    )
  );
  const estimatedFullRunCost = scenarios.reduce(
    (scenarioTotal, scenario) =>
      scenarioTotal +
      arms.reduce(
        (armTotal, arm) =>
          armTotal +
          estimateWorstCaseScenarioCost(
            arm,
            scenario,
            promptForVariant(
              referencePrompt,
              arm.promptVariant
            ),
            toolSchemaBytes
          ),
        0
      ),
    0
  ) * options.repeats;

  if (options.plan) {
    for (const scenario of scenarios) {
      console.log(`- ${scenario.id}: ${scenario.description}`);
    }
    console.log(`Prompt base hash: ${promptHash}`);
    for (const variant of options.promptVariants.filter(
      (item) => item !== 'base'
    )) {
      console.log(
        `Prompt ${variant} hash: ${
          promptVariantHashes[variant]
        }`
      );
    }
    console.log(
      `Custo máximo conservador da rodada planejada: US$ ${estimatedFullRunCost.toFixed(
        6
      )}.`
    );
    if (
      scenarios.some(
        (scenario) =>
          scenario.id === 'P0-RESCHEDULE-CROSS-TURN'
      )
    ) {
      const {
        bookingConfirmationGate,
        RescheduleCancellationEvidenceStore,
      } = await import(
        '../../../src/services/bookingConfirmationGate'
      );
      const crossTurnHistory = [
        {
          role: 'assistant',
          content:
            'Você já tem um agendamento futuro. Prefere manter os dois, remarcar, cancelar o anterior ou pensar depois?',
        },
        {
          role: 'user',
          content:
            'Quero remarcar. Cancele o anterior; escolho o novo horário depois.',
        },
        {
          role: 'assistant',
          content: 'O anterior foi cancelado.',
        },
        {
          role: 'user',
          content: 'Para o novo, quero às 10h30.',
        },
        {
          role: 'assistant',
          content:
            'Limpeza de Pele com Júlia em 04/08/2026 às 10h30. Confirma?',
        },
        { role: 'user', content: 'sim' },
      ];
      const evidenceStore =
        new RescheduleCancellationEvidenceStore();
      const evidenceConversationKey =
        'plan:P0-RESCHEDULE-CROSS-TURN';
      evidenceStore.record(
        evidenceConversationKey,
        IDS.appointment.existing,
        FIXED_NOW.getTime()
      );
      const crossTurnDecision = bookingConfirmationGate({
        currentUserMessage: 'sim',
        history: crossTurnHistory,
        currentUserMessageIndex:
          crossTurnHistory.length - 1,
        confirmedDuplicate: true,
        expectedBooking: {
          date: '2026-08-04',
          time: '10:30',
          serviceName: 'Limpeza de Pele',
          professionalName: 'Júlia',
        },
        duplicateCancellationSucceeded:
          evidenceStore.peek(
            evidenceConversationKey,
            FIXED_NOW.getTime() + 60_000
          ) !== null,
      });
      console.log(
        `P0-RESCHEDULE-CROSS-TURN (probe determinístico, sem provider): ${
          crossTurnDecision.ok
            ? 'LIBERADO por evidência autoritativa cross-turn dentro da janela'
            : 'BLOQUEADO'
        }.`
      );
    }
    return;
  }

  const missingProviders = options.providers.filter(
    (provider) => !keyStatus[provider]
  );
  if (missingProviders.length > 0) {
    throw new Error(
      `Chave ausente para: ${missingProviders.join(
        ', '
      )}. Nenhuma chamada foi executada.`
    );
  }

  const fixturePath = path.resolve(
    'scripts/benchmarks/ana-models/fixtures.ts'
  );
  const scenariosPath = path.resolve(
    'scripts/benchmarks/ana-models/scenarios.ts'
  );
  const holdoutScenariosPath = path.resolve(
    'scripts/benchmarks/ana-models/scenarios-holdout.ts'
  );
  const runnerPath = path.resolve('scripts/benchmarks/ana-models/runner.ts');
  const packagePath = path.resolve('package.json');
  const [
    fixtureSource,
    scenariosSource,
    holdoutScenariosSource,
    runnerSource,
    packageSource,
  ] =
    await Promise.all([
      readFile(fixturePath, 'utf8'),
      readFile(scenariosPath, 'utf8'),
      readFile(holdoutScenariosPath, 'utf8'),
      readFile(runnerPath, 'utf8'),
      readFile(packagePath, 'utf8'),
    ]);
  const fixtureHash = hash(
    JSON.stringify({
      services: SERVICES_RESULT,
      slots: DEFAULT_SLOTS,
      conflictAlternatives: CONFLICT_ALTERNATIVES,
      ids: IDS,
      sourceHash: hash(fixtureSource),
    })
  );
  const scenarioHash = hash(
    JSON.stringify({
      selected: scenarios.map((scenario) => ({
        id: scenario.id,
        description: scenario.description,
        fixtureMode: scenario.fixtureMode ?? 'normal',
        initialHistory: scenario.initialHistory ?? [],
        turns: scenario.turns,
      })),
      sourceHashes: {
        p0: hash(scenariosSource),
        holdout: hash(holdoutScenariosSource),
      },
    })
  );
  const toolSchemaHash = hash(JSON.stringify(RECEPTIONIST_TOOLS));
  const harnessHash = hash(runnerSource);
  const packageJson = JSON.parse(packageSource) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(
    options.outputDir ?? path.join('benchmark-results', timestamp)
  );
  await mkdir(outputDir, { recursive: true });

  const manifest = {
    schemaVersion: 4,
    benchmarkVersion: BENCHMARK_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    layer: 'model-in-the-loop',
    dryRun: true,
    fixedNow: FIXED_NOW.toISOString(),
    timezone: 'America/Sao_Paulo',
    arms,
    suite: options.suite,
    guards: options.guards,
    repeats: options.repeats,
    seed: options.seed,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
    })),
    promptHash,
    promptVariantHashes,
    fixtureHash,
    scenarioHash,
    toolSchemaHash,
    harnessHash,
    runtime: {
      node: process.version,
      openaiSdk: packageJson.dependencies?.openai ?? null,
      tsNode: packageJson.devDependencies?.['ts-node'] ?? null,
    },
    pricing: MODEL_PRICING,
    maxCostUsd: options.maxCostUsd,
    costLimitPolicy:
      'Reserva conservadora pelo conjunto de braços antes de iniciar o cenário; usage ausente consome a reserva.',
  };
  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  await writeFile(path.join(outputDir, 'results.jsonl'), '', 'utf8');

  const random = seededRandom(options.seed);
  const results: BenchmarkResult[] = [];
  let accumulatedCost = 0;
  let stoppedByCostLimit = false;

  benchmarkLoop:
  for (let repetition = 1; repetition <= options.repeats; repetition += 1) {
    for (const scenario of scenarios) {
      const orderedArms = shuffled(arms, random);
      const reservedPairCost = orderedArms.reduce(
        (sum, arm) =>
          sum +
          estimateWorstCaseScenarioCost(
            arm,
            scenario,
            promptForVariant(
              referencePrompt,
              arm.promptVariant
            ),
            toolSchemaBytes
          ),
        0
      );
      if (accumulatedCost + reservedPairCost > options.maxCostUsd) {
        stoppedByCostLimit = true;
        console.warn(
          `⚠️ Hard block de custo antes de ${scenario.id}: acumulado US$ ${accumulatedCost.toFixed(
            6
          )}, reserva do par US$ ${reservedPairCost.toFixed(
            6
          )}, limite US$ ${options.maxCostUsd.toFixed(2)}.`
        );
        break benchmarkLoop;
      }

      for (const arm of orderedArms) {
        const startedAt = Date.now();
        const run = await runScenario(
          scenario,
          arm,
          repetition,
          options.guards
        );
        const assertions =
          run.providerError || run.harnessError ? [] : scenario.evaluate(run);
        const hardFailures = assertions.filter(
          (item) => item.severity === 'hard' && !item.pass
        );
        const estimatedCostUsd = estimateCostUsd(arm, run.usage);
        const unknownUsageReserve = estimateWorstCaseScenarioCost(
          arm,
          scenario,
          promptForVariant(referencePrompt, arm.promptVariant),
          toolSchemaBytes
        );
        accumulatedCost += estimatedCostUsd ?? unknownUsageReserve;
        const result: BenchmarkResult = {
          ...run,
          schemaVersion: 4,
          benchmarkVersion: BENCHMARK_VERSION,
          runId,
          seed: options.seed,
          durationMs: Date.now() - startedAt,
          assertions,
          estimatedCostUsd,
          outcome: run.providerError
            ? 'provider_error'
            : run.harnessError
              ? 'harness_error'
            : hardFailures.length > 0
              ? 'fail'
              : 'pass',
          failureClass: run.providerError
            ? 'provider'
            : run.harnessError
              ? 'harness'
            : hardFailures.length > 0
              ? 'model'
              : 'none',
        };
        results.push(result);
        await appendFile(
          path.join(outputDir, 'results.jsonl'),
          `${JSON.stringify(result)}\n`,
          'utf8'
        );

        const hardLabel =
          result.outcome === 'pass'
            ? 'PASS'
            : result.outcome === 'provider_error'
              ? 'PROVIDER_ERROR'
              : result.outcome === 'harness_error'
                ? 'HARNESS_ERROR'
              : `FAIL(${hardFailures.length})`;
        console.log(
          `${hardLabel} ${scenario.id} · ${arm.provider}/${arm.model}/${arm.promptVariant} · ${
            result.durationMs
          }ms · ${
            estimatedCostUsd === null
              ? `custo indisponível (reserva US$ ${unknownUsageReserve.toFixed(
                  6
                )})`
              : `US$ ${estimatedCostUsd.toFixed(6)}`
          }`
        );
      }
    }
  }

  const summary = summarize(results);
  const reportMetadata = {
    promptHash,
    promptVariantHashes,
    fixtureHash,
    scenarioHash,
    toolSchemaHash,
    harnessHash,
    stoppedByCostLimit,
    maxCostUsd: options.maxCostUsd,
    guardMode: options.guards,
    suite: options.suite,
  };
  await writeFile(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(
      {
        runId,
        ...reportMetadata,
        pricing: MODEL_PRICING,
        arms: summary,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outputDir, 'report.md'),
    `${buildReport(results, summary, reportMetadata)}\n`,
    'utf8'
  );
  const blindReview = buildBlindReviewArtifacts(results, random);
  await writeFile(
    path.join(outputDir, 'blind-review.csv'),
    `${blindReview.csv}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outputDir, 'blind-review-key.json'),
    `${JSON.stringify(blindReview.key, null, 2)}\n`,
    'utf8'
  );

  console.log(`Relatório: ${path.join(outputDir, 'report.md')}`);
  console.log(
    `Custo total estimado: US$ ${accumulatedCost.toFixed(6)} (limite US$ ${options.maxCostUsd.toFixed(
      2
    )}).`
  );

  if (
    stoppedByCostLimit ||
    results.some(
      (result) =>
        result.outcome === 'provider_error' ||
        result.outcome === 'harness_error'
    )
  ) {
    process.exitCode = 2;
  } else if (results.some((result) => result.outcome === 'fail')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const sanitized = sanitizeExecutionError(error);
  console.error(`❌ Benchmark abortado: ${sanitized.message}`);
  process.exitCode = 2;
});
