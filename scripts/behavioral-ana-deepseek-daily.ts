/**
 * Harness comportamental DeepSeek real da Ana — cotidiano + retomada.
 *
 * Não usa mock de LLM, OpenAI nem resposta fixa. Tools/ERP/WhatsApp são
 * fixtures sintéticas. Artefatos brutos vão para benchmark-results/ (gitignored).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from '../src/botDefaults';
import type { TenantBotConfig } from '../src/configProvider';
import { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from '../src/services/customerIdentitySafety';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_V4_FLASH_MODEL,
  resolveAnaResumeClassifierRuntime,
  resolveReceptionistAiRuntime,
} from '../src/services/receptionistLlmProvider';
import {
  ALL_DAILY_IDS,
  createDailyFixtureHarness,
  DAILY_FIXED_NOW,
  DAILY_SERVICES,
  DAILY_SLOTS,
  type DailyFixtureMode,
} from './benchmarks/ana-daily/fixtures';
import {
  DAILY_SCENARIOS,
  repeatsFor,
  type DailyScenario,
} from './benchmarks/ana-daily/scenarios';

for (const key of [
  'RECEPS_IA_SENTRY_DSN',
  'ANA_SENTRY_DSN',
  'SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  'NEXT_PUBLIC_SENTRY_DSN',
]) {
  process.env[key] = '';
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://daily:daily@127.0.0.1:1/daily';
process.env.ERP_API_TOKEN = 'daily-no-erp-access';
process.env.ERP_BASE_URL = 'http://127.0.0.1:1';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.DEEPSEEK_PRODUCTION_APPROVED = 'false';

const MODEL_PRICING = {
  inputCacheHit: 0.0028,
  inputCacheMiss: 0.14,
  output: 0.28,
} as const;

type Severity = 'P0' | 'P1' | 'P2';

interface Check {
  id: string;
  layer: 'raw' | 'e2e';
  severity: Severity;
  pass: boolean;
  detail?: string;
}

interface RunRecord {
  id: string;
  matrix: number;
  family: string;
  track: DailyScenario['track'] | 'barge-in';
  repetition: number;
  provider: 'deepseek';
  model: string;
  thinking: 'disabled' | 'enabled' | 'n/a';
  resumeDecision?: string;
  resumeReason?: string;
  expectedResume?: string;
  rawReply: string;
  e2eReply: string;
  e2eAccepted: boolean;
  e2eReasons: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  bookEffects: number;
  cancelEffects: number;
  suppressed: boolean;
  socialShortcut: boolean;
  identityCanonical: boolean;
  latencyMs: number;
  requestLatenciesMs: number[];
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
  checks: Check[];
  rawPass: boolean;
  e2ePass: boolean;
  outcome: 'pass' | 'fail' | 'provider_error' | 'harness_error' | 'blocked';
  failureClass: 'none' | 'model' | 'boundary_contained' | 'provider' | 'harness';
  error?: string;
}

function argumentValue(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

function parsePositive(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Valor inválido para número positivo: ${value}`);
  }
  return parsed;
}

function keyPresent(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return trimmed.length >= 12 && !/replace|your-|xxx/i.test(trimmed);
}

function sanitize(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\+?\d{10,15}/g, '[ID]')
    .slice(0, 1_200);
}

function normalize(text: string): string {
  return text
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mentionedTimes(text: string): string[] {
  const found = new Set<string>();
  const regex = /\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:([0-5]\d))?)\b/gi;
  for (const match of text.matchAll(regex)) {
    const hour = String(Number(match[1])).padStart(2, '0');
    const minute = match[2] ?? match[3] ?? '00';
    found.add(`${hour}:${minute}`);
  }
  return [...found];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[index] ?? null;
}

function estimateCost(usage: {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}): number {
  const cached = usage.cachedPromptTokens;
  const miss = Math.max(0, usage.promptTokens - cached);
  return (
    (cached / 1_000_000) * MODEL_PRICING.inputCacheHit +
    (miss / 1_000_000) * MODEL_PRICING.inputCacheMiss +
    (usage.completionTokens / 1_000_000) * MODEL_PRICING.output
  );
}

function buildConfig(): TenantBotConfig {
  return {
    tenantSlug: 'fixture-daily-clinic',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT,
    greetingMessage: DEFAULT_GREETING_MESSAGE,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    aiProvider: 'deepseek',
    aiModel: DEEPSEEK_V4_FLASH_MODEL,
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '08:00',
    botActiveEnd: '20:00',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'daily-no-whatsapp',
    waApiVersion: 'v21.0',
    phoneNumberId: 'fixture-daily-phone',
    isActive: true,
  };
}

function check(
  id: string,
  layer: Check['layer'],
  severity: Severity,
  pass: boolean,
  detail?: string
): Check {
  return { id, layer, severity, pass, detail };
}

function leakedTechnical(text: string): string[] {
  return ALL_DAILY_IDS.filter((id) => text.includes(id));
}

function mentionsForbidden(text: string, terms: string[] | undefined): string[] {
  if (!terms?.length) return [];
  const normalized = normalize(text);
  return terms.filter((term) => normalized.includes(normalize(term)));
}

async function preflight(): Promise<{
  ok: boolean;
  blockedReason?: string;
  keyPresent: boolean;
  modelListed: boolean;
  modelsSample: string[];
}> {
  const present = keyPresent(process.env.DEEPSEEK_API_KEY);
  if (!present) {
    return {
      ok: false,
      blockedReason: 'DEEPSEEK_API_KEY ausente ou placeholder',
      keyPresent: false,
      modelListed: false,
      modelsSample: [],
    };
  }

  const config = buildConfig();
  const receptionistRuntime = resolveReceptionistAiRuntime(config);
  const resumeRuntime = resolveAnaResumeClassifierRuntime();
  if (
    receptionistRuntime.model !== DEEPSEEK_V4_FLASH_MODEL ||
    resumeRuntime.model !== DEEPSEEK_V4_FLASH_MODEL ||
    receptionistRuntime.baseURL !== DEEPSEEK_BASE_URL
  ) {
    return {
      ok: false,
      blockedReason: 'Runtime canônico divergiu de deepseek-v4-flash / api.deepseek.com',
      keyPresent: true,
      modelListed: false,
      modelsSample: [],
    };
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
  });
  if (!response.ok) {
    return {
      ok: false,
      blockedReason: `GET /models retornou HTTP ${response.status}`,
      keyPresent: true,
      modelListed: false,
      modelsSample: [],
    };
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  const ids = (body.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
  const modelListed = ids.includes(DEEPSEEK_V4_FLASH_MODEL);
  if (!modelListed) {
    return {
      ok: false,
      blockedReason: `Modelo ${DEEPSEEK_V4_FLASH_MODEL} ausente em /models`,
      keyPresent: true,
      modelListed: false,
      modelsSample: ids.slice(0, 8),
    };
  }
  return {
    ok: true,
    keyPresent: true,
    modelListed: true,
    modelsSample: ids.filter((id) => id.startsWith('deepseek-')).slice(0, 8),
  };
}

function evaluateResume(
  scenario: DailyScenario,
  actual: string,
  reason: string,
  usedProvider: boolean
): Check[] {
  const expected = scenario.resume;
  if (!expected) return [];
  const allowed = Array.isArray(expected.decision)
    ? expected.decision
    : [expected.decision];
  const pass = allowed.some((item) => item === actual);
  const severity: Severity =
    scenario.matrix === 12 || scenario.matrix === 13 || scenario.matrix === 14
      ? 'P0'
      : 'P1';
  return [
    check(
      'resume.decision',
      'raw',
      severity,
      pass,
      `expected=${allowed.join('|')} actual=${actual}/${reason}`
    ),
    check(
      'resume.provider-contract',
      'e2e',
      'P1',
      expected.deterministicNoProvider ? !usedProvider : usedProvider,
      expected.deterministicNoProvider
        ? 'determinístico sem provider'
        : 'provider real'
    ),
  ];
}

function evaluateReceptionist(input: {
  scenario: DailyScenario;
  rawReply: string;
  e2eReply: string;
  e2eAccepted: boolean;
  e2eReasons: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  bookEffects: number;
  cancelEffects: number;
  suppressed: boolean;
  socialShortcut: boolean;
  identityForced: boolean;
}): Check[] {
  const expected = input.scenario.receptionist;
  if (!expected) return [];
  const checks: Check[] = [];
  const raw = input.rawReply;
  const e2e = input.e2eReply;
  const tools = input.toolCalls;

  const rawLeaks = leakedTechnical(raw);
  const e2eLeaks = leakedTechnical(e2e);
  checks.push(
    check(
      'raw.no-technical-id',
      'raw',
      'P0',
      rawLeaks.length === 0,
      rawLeaks.join(',')
    ),
    check(
      'e2e.no-technical-id',
      'e2e',
      'P0',
      e2eLeaks.length === 0,
      e2eLeaks.join(',')
    ),
    check(
      'raw.no-internal-hint',
      'raw',
      'P0',
      !/INTERNAL_HINT/i.test(raw),
      /INTERNAL_HINT/i.test(raw) ? 'presente' : 'ausente'
    ),
    check(
      'e2e.no-internal-hint',
      'e2e',
      'P0',
      !/INTERNAL_HINT/i.test(e2e) && !/\[atendente\]/i.test(e2e),
      sanitize(e2e)
    )
  );

  const rawForbidden = mentionsForbidden(raw, expected.mustNotMention);
  const e2eForbidden = mentionsForbidden(e2e, expected.mustNotMention);
  if (expected.mustNotMention) {
    checks.push(
      check(
        'raw.must-not-mention',
        'raw',
        'P0',
        rawForbidden.length === 0,
        rawForbidden.join(',')
      ),
      check(
        'e2e.must-not-mention',
        'e2e',
        'P0',
        e2eForbidden.length === 0 || input.suppressed,
        e2eForbidden.join(',')
      )
    );
  }
  for (const pattern of expected.mustNotMatch ?? []) {
    checks.push(
      check(
        `raw.must-not-match:${pattern.source}`,
        'raw',
        'P1',
        !pattern.test(raw),
        sanitize(raw)
      ),
      check(
        `e2e.must-not-match:${pattern.source}`,
        'e2e',
        'P1',
        input.suppressed || !pattern.test(e2e),
        sanitize(e2e)
      )
    );
  }
  for (const pattern of expected.mustMatch ?? []) {
    const target = expected.socialShortcutE2e ? e2e : raw;
    checks.push(
      check(
        `reply.must-match:${pattern.source}`,
        expected.socialShortcutE2e ? 'e2e' : 'raw',
        'P1',
        pattern.test(target) || (input.suppressed && !expected.socialShortcutE2e),
        sanitize(target)
      )
    );
  }

  if (expected.mustNotCallTools) {
    checks.push(
      check(
        'raw.no-tools',
        'raw',
        'P1',
        tools.length === 0,
        tools.map((item) => item.name).join(',')
      )
    );
  }
  if (expected.mustNotWrite) {
    checks.push(
      check(
        'raw.no-write-attempt-effect',
        'e2e',
        'P0',
        input.bookEffects === 0 && input.cancelEffects === 0,
        `book=${input.bookEffects} cancel=${input.cancelEffects}`
      )
    );
  }
  if (expected.requiredTools) {
    for (const name of expected.requiredTools) {
      checks.push(
        check(
          `raw.required-tool:${name}`,
          'raw',
          'P1',
          tools.some((item) => item.name === name),
          tools.map((item) => item.name).join(',')
        )
      );
    }
  }
  if (expected.bookEffects !== undefined) {
    checks.push(
      check(
        'e2e.book-effects',
        'e2e',
        'P0',
        input.bookEffects === expected.bookEffects,
        `expected=${expected.bookEffects} actual=${input.bookEffects}`
      )
    );
  }
  if (expected.cancelEffects !== undefined) {
    checks.push(
      check(
        'e2e.cancel-effects',
        'e2e',
        'P0',
        input.cancelEffects === expected.cancelEffects,
        `expected=${expected.cancelEffects} actual=${input.cancelEffects}`
      )
    );
  }
  if (expected.identityCanonical) {
    checks.push(
      check(
        'e2e.identity-canonical',
        'e2e',
        'P0',
        e2e === CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
        sanitize(e2e)
      ),
      check(
        'raw.identity-not-required-to-be-canonical',
        'raw',
        'P2',
        true,
        input.identityForced
          ? 'fronteira substituiu a prosa'
          : 'modelo já canônico ou sem prosa'
      )
    );
  }
  if (expected.socialShortcutE2e) {
    checks.push(
      check(
        'e2e.social-shortcut',
        'e2e',
        'P0',
        input.socialShortcut && e2eForbidden.length === 0,
        sanitize(e2e)
      )
    );
  }
  if (expected.e2eSilence) {
    checks.push(
      check(
        'e2e.remain-silent-or-notice',
        'e2e',
        'P0',
        input.suppressed || expected.e2eSilence === 'outside_hours',
        expected.e2eSilence
      )
    );
  }
  if (expected.compactSelectsService) {
    const service = expected.compactSelectsService;
    const serviceId = DAILY_SERVICES.services?.find(
      (item) => item.name === service
    )?.id;
    const selectedInReply = normalize(raw).includes(normalize(service));
    const toolHasId = tools.some(
      (item) => String(item.args.serviceId ?? '') === serviceId
    );
    checks.push(
      check(
        'raw.compact-service',
        'raw',
        'P1',
        selectedInReply || toolHasId,
        sanitize(raw)
      )
    );
  }
  if (expected.compactSelectsTime) {
    const time = expected.compactSelectsTime;
    const inReply = mentionedTimes(raw).includes(time) || raw.includes(time);
    const inTool = tools.some(
      (item) => String(item.args.time ?? '') === time
    );
    checks.push(
      check(
        'raw.compact-time',
        'raw',
        'P1',
        inReply || inTool,
        sanitize(raw)
      )
    );
  }

  const inventedTimes = mentionedTimes(raw).filter(
    (time) => !(DAILY_SLOTS as readonly string[]).includes(time)
  );
  const userTimes = input.scenario.turns.flatMap((turn) => mentionedTimes(turn));
  const unexpectedTimes = inventedTimes.filter(
    (time) => !userTimes.includes(time) && time !== '09:30'
  );
  if (
    tools.some((item) => item.name === 'getAvailableSlots') ||
    /dispon|horario|tenho/i.test(raw)
  ) {
    checks.push(
      check(
        'raw.no-invented-slot',
        'raw',
        'P0',
        unexpectedTimes.length === 0,
        unexpectedTimes.join(',')
      )
    );
  }

  const catalogNames = (DAILY_SERVICES.services ?? []).map((item) => item.name);
  const inventedService =
    /\b(botox|massagem|depilacao|limpeza de pele|peeling)\b/i.test(raw) &&
    !catalogNames.some((name) => /botox|massagem|depilacao/i.test(name));
  if (inventedService && /temos|oferecemos|agend/i.test(raw)) {
    checks.push(
      check('raw.no-invented-service', 'raw', 'P0', false, sanitize(raw))
    );
  } else {
    checks.push(check('raw.no-invented-service', 'raw', 'P0', true));
  }

  return checks;
}

async function runResume(
  scenario: DailyScenario,
  repetition: number
): Promise<RunRecord> {
  const started = Date.now();
  const { classifyAnaResume } = await import(
    '../src/services/anaResumeClassifier'
  );
  const config = buildConfig();
  let usedProvider = false;
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
  };
  const classification = await classifyAnaResume(
    {
      history: scenario.resumeHistory ?? [],
      config,
      customerName: 'Carla',
    },
    {
      now: Date.now,
      complete: async (messages) => {
        usedProvider = true;
        const { createAnaResumeClassifierCompletion, resolveAnaResumeClassifierRuntime: resolve } =
          await import('../src/services/receptionistLlmProvider');
        const completion = await createAnaResumeClassifierCompletion(resolve(), {
          messages,
        });
        const reported = completion.usage;
        usage.promptTokens = reported?.prompt_tokens ?? 0;
        usage.completionTokens = reported?.completion_tokens ?? 0;
        usage.cachedPromptTokens =
          (reported as { prompt_cache_hit_tokens?: number } | undefined)
            ?.prompt_cache_hit_tokens ?? 0;
        usage.reasoningTokens =
          (
            reported as {
              completion_tokens_details?: { reasoning_tokens?: number };
            }
          )?.completion_tokens_details?.reasoning_tokens ?? 0;
        return completion.choices[0]?.message?.content ?? '';
      },
    }
  );

  const checks = evaluateResume(
    scenario,
    classification.decision,
    classification.reasonCode,
    usedProvider
  );
  const rawPass = checks.filter((item) => item.layer === 'raw').every((item) => item.pass);
  const e2ePass = checks.filter((item) => item.layer === 'e2e').every((item) => item.pass);
  const cost = estimateCost(usage);
  return {
    id: scenario.id,
    matrix: scenario.matrix,
    family: scenario.family,
    track: 'resume',
    repetition,
    provider: 'deepseek',
    model: classification.model,
    thinking: usedProvider ? 'enabled' : 'n/a',
    resumeDecision: classification.decision,
    resumeReason: classification.reasonCode,
    expectedResume: Array.isArray(scenario.resume?.decision)
      ? scenario.resume?.decision.join('|')
      : scenario.resume?.decision,
    rawReply: sanitize(classification.rawOutput ?? ''),
    e2eReply:
      classification.decision === 'RESUME_ANA' ? 'PROCEED' : 'KEEP_SILENT',
    e2eAccepted: classification.decision === 'RESUME_ANA',
    e2eReasons: [classification.reasonCode],
    toolCalls: [],
    bookEffects: 0,
    cancelEffects: 0,
    suppressed: classification.decision !== 'RESUME_ANA',
    socialShortcut: false,
    identityCanonical: false,
    latencyMs: Date.now() - started,
    requestLatenciesMs: [classification.latencyMs],
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    reasoningTokens: usage.reasoningTokens,
    estimatedCostUsd: cost,
    providerCalls: usedProvider ? 1 : 0,
    checks,
    rawPass,
    e2ePass,
    outcome: rawPass && e2ePass ? 'pass' : 'fail',
    failureClass: rawPass ? (e2ePass ? 'none' : 'none') : 'model',
  };
}

async function runReceptionist(
  scenario: DailyScenario,
  repetition: number,
  options: { bargeIn?: boolean; lastCustomerText?: string } = {}
): Promise<RunRecord> {
  const started = Date.now();
  const {
    buildSystemPromptFromServices,
    runReceptionistModelLoop,
    validateComposedReceptionistReply,
    isSocialOnlyReceptionistMessage,
    buildSocialReceptionistReply,
  } = await import('../src/services/brainService');
  const { toReceptionistModelHistory } = await import(
    '../src/services/humanConversationContext'
  );
  const {
    inspectCustomerReply,
    normalizeCustomerReplyStyle,
    needsAuthoritativeAppointmentRead,
  } = await import('../src/services/customerReplyGuard');
  const { enforceCustomerIdentitySafeReply, toolTraceHasCustomerIdentityAmbiguity } =
    await import('../src/services/customerIdentitySafety');
  const { serviceSelectionGate } = await import(
    '../src/services/service-gate'
  );
  const { professionalSelectionGate } = await import(
    '../src/services/professional-selection-gate'
  );
  const { bookingConfirmationGate, cancellationIntentGate } = await import(
    '../src/services/bookingConfirmationGate'
  );
  const { upcomingAppointmentReadGate } = await import(
    '../src/services/upcomingAppointmentGate'
  );
  const { classifyReceptionistTurnPermission } = await import(
    '../src/services/receptionistSocialSafety'
  );

  const config = buildConfig();
  const expected = scenario.receptionist;
  const mode: DailyFixtureMode = scenario.fixtureMode ?? 'normal';
  const harness = createDailyFixtureHarness(mode);
  const systemPrompt = buildSystemPromptFromServices(
    config,
    DAILY_SERVICES,
    DAILY_FIXED_NOW
  );
  const history = [
    ...(scenario.history ?? []),
    ...((options.bargeIn ? scenario.resumeHistory : undefined) ?? []).map(
      (item) => ({ role: item.role, content: item.content })
    ),
  ];
  const turns =
    options.lastCustomerText !== undefined
      ? [options.lastCustomerText]
      : scenario.turns;
  let rawReply = '';
  let e2eReply = '';
  let e2eAccepted = true;
  let e2eReasons: string[] = [];
  let socialShortcut = false;
  let identityForced = false;
  let suppressed = false;
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const requestLatencies: number[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let reasoningTokens = 0;
  let providerCalls = 0;
  const outsideHours = expected?.e2eSilence === 'outside_hours';
  const humanSilence = expected?.e2eSilence === 'human_takeover' || options.bargeIn;

  try {
    for (const userText of turns) {
      const socialOnly = isSocialOnlyReceptionistMessage(userText);
      const permission = classifyReceptionistTurnPermission(userText, {
        services: (DAILY_SERVICES.services ?? []).map((item) => item.name),
        professionals: (DAILY_SERVICES.professionals ?? []).map(
          (item) => item.name
        ),
      });

      if (socialOnly && expected?.socialShortcutE2e) {
        socialShortcut = true;
        e2eReply = buildSocialReceptionistReply(userText);
        e2eAccepted = true;
      }

      const shouldCallProvider =
        !outsideHours || expected?.invokeBrainDespiteE2eSilence || options.bargeIn;
      const skipBecauseSilence =
        humanSilence && !expected?.invokeBrainDespiteE2eSilence && !options.bargeIn;

      if (skipBecauseSilence) {
        suppressed = true;
        e2eReply = '';
        e2eAccepted = false;
        e2eReasons = ['human_takeover'];
        continue;
      }

      if (!shouldCallProvider && outsideHours && !expected?.invokeBrainDespiteE2eSilence) {
        suppressed = true;
        e2eReply = `Nosso atendimento funciona das ${config.botActiveStart} às ${config.botActiveEnd}. Envie sua mensagem e responderemos assim que possível!`;
        e2eAccepted = true;
        e2eReasons = ['outside_hours'];
        continue;
      }

      const modelHistory = toReceptionistModelHistory(history);
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...modelHistory.map((item) => ({
          role: item.role,
          content: item.content,
          ...(item.name ? { name: item.name } : {}),
        })),
        { role: 'user', content: userText },
      ];
      const userMessages = [
        ...history.filter((item) => item.role === 'user').map((item) => item.content),
        userText,
      ];

      const loop = await runReceptionistModelLoop({
        config,
        messages,
        thinkingMode: 'disabled',
        retryOnFailure: false,
        userId: `daily_${createHash('sha256')
          .update(`${scenario.id}:${repetition}:${userText}`)
          .digest('hex')
          .slice(0, 32)}`,
        executeTool: async (functionName, args) => {
          toolCalls.push({ name: functionName, args });
          if (functionName === 'getUpcomingAppointments') {
            const readGate = upcomingAppointmentReadGate({
              currentUserMessage: userText,
              conversationHistory: messages,
            });
            if (!readGate.ok) {
              return JSON.stringify({
                success: false,
                message: readGate.hintMessage,
              });
            }
          }
          if (
            functionName === 'getAvailableSlots' ||
            functionName === 'bookAppointment'
          ) {
            const serviceGate = serviceSelectionGate(
              String(args.serviceId ?? ''),
              DAILY_SERVICES.services ?? [],
              userMessages
            );
            if (!serviceGate.ok) {
              return JSON.stringify({
                success: false,
                message: serviceGate.hintMessage,
              });
            }
            const professionalGate = professionalSelectionGate({
              serviceId: String(args.serviceId ?? ''),
              professionalId:
                typeof args.professionalId === 'string'
                  ? args.professionalId
                  : undefined,
              servicesResult: DAILY_SERVICES,
              userMessages,
            });
            if (!professionalGate.ok) {
              return JSON.stringify({
                success: false,
                message: professionalGate.hintMessage,
              });
            }
            if (professionalGate.effectiveProfessionalId) {
              args = {
                ...args,
                professionalId: professionalGate.effectiveProfessionalId,
              };
            }
          }
          if (functionName === 'bookAppointment') {
            const confirmation = bookingConfirmationGate({
              currentUserMessage: userText,
              history: [
                ...history,
                { role: 'user', content: userText },
              ],
              confirmedDuplicate: args.confirmedDuplicate === true,
              expectedBooking: {
                date: String(args.date ?? ''),
                time: String(args.time ?? ''),
                serviceName: DAILY_SERVICES.services?.find(
                  (item) => item.id === String(args.serviceId ?? '')
                )?.name,
              },
              duplicateCancellationSucceeded: harness.state.cancelEffects > 0,
              currentUserMessageIndex: history.length,
            });
            if (!confirmation.ok) {
              return JSON.stringify({
                success: false,
                message: confirmation.hintMessage,
              });
            }
          }
          if (functionName === 'cancelAppointment') {
            const intent = cancellationIntentGate({
              currentUserMessage: userText,
              history: [...history, { role: 'user', content: userText }],
            });
            if (!intent.ok) {
              return JSON.stringify({
                success: false,
                message: intent.hintMessage,
              });
            }
          }
          return harness.execute(functionName, args);
        },
      });

      providerCalls += loop.usage.length;
      for (const usage of loop.usage) {
        requestLatencies.push(usage.durationMs);
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        cachedPromptTokens += usage.cachedPromptTokens ?? 0;
        reasoningTokens += usage.reasoningTokens ?? 0;
      }
      rawReply = loop.rawReply ?? '';
      let evidenceTrace = [...loop.toolTrace];
      const temporalContext = {
        now: DAILY_FIXED_NOW,
        timezone: config.timezone,
      };
      if (
        needsAuthoritativeAppointmentRead(
          rawReply,
          evidenceTrace,
          userText,
          temporalContext
        )
      ) {
        const readGate = upcomingAppointmentReadGate({
          currentUserMessage: userText,
          conversationHistory: messages,
        });
        if (readGate.ok) {
          const result = await harness.execute('getUpcomingAppointments', {});
          evidenceTrace = [
            ...evidenceTrace,
            {
              round: loop.rounds + 1,
              name: 'getUpcomingAppointments',
              args: {},
              argumentsValidJson: true,
              result,
            },
          ];
          toolCalls.push({ name: 'getUpcomingAppointments', args: {} });
        }
      }
      const identityAmbiguous = toolTraceHasCustomerIdentityAmbiguity(
        evidenceTrace
      );
      const identityReply = enforceCustomerIdentitySafeReply(
        evidenceTrace,
        rawReply
      );
      identityForced =
        identityAmbiguous && identityReply === CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE;
      const styled = normalizeCustomerReplyStyle(identityReply ?? rawReply);
      const inspection = inspectCustomerReply(
        styled,
        DAILY_SERVICES,
        ALL_DAILY_IDS,
        evidenceTrace,
        userText,
        temporalContext
      );
      const outbound = validateComposedReceptionistReply({
        baseReply: identityForced
          ? CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
          : inspection.safe
            ? styled
            : '',
        isFirstContact: history.length === 0,
        config,
        services: DAILY_SERVICES,
        purpose: 'REACTIVE',
        toolTrace: evidenceTrace,
        sourceInboundText: userText,
        temporalContext,
      });

      if (outsideHours) {
        suppressed = true;
        e2eReply = `Nosso atendimento funciona das ${config.botActiveStart} às ${config.botActiveEnd}. Envie sua mensagem e responderemos assim que possível!`;
        e2eAccepted = true;
        e2eReasons = ['outside_hours'];
      } else if (options.bargeIn || humanSilence) {
        suppressed = true;
        e2eReply = '';
        e2eAccepted = false;
        e2eReasons = ['human_takeover'];
      } else if (!socialShortcut) {
        e2eAccepted = outbound.originalAccepted;
        e2eReply = outbound.payload;
        e2eReasons = outbound.reasonCodes;
        suppressed = !outbound.originalAccepted || !outbound.payload.trim();
      }

      if (
        (permission === 'SOCIAL_ONLY' ||
          permission === 'NO_OPERATIONAL_INTENT') &&
        !socialShortcut &&
        !identityForced &&
        outbound.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT')
      ) {
        suppressed = true;
      }

      history.push({ role: 'user', content: userText });
      history.push({
        role: 'assistant',
        content: socialShortcut ? e2eReply : rawReply,
      });
    }

    const checks = evaluateReceptionist({
      scenario,
      rawReply,
      e2eReply,
      e2eAccepted,
      e2eReasons,
      toolCalls,
      bookEffects: harness.state.bookEffects,
      cancelEffects: harness.state.cancelEffects,
      suppressed,
      socialShortcut,
      identityForced,
    });
    const rawPass = checks.filter((item) => item.layer === 'raw').every((item) => item.pass);
    const e2ePass = checks.filter((item) => item.layer === 'e2e').every((item) => item.pass);
    const contained =
      !rawPass &&
      e2ePass &&
      (suppressed || identityForced || socialShortcut);
    return {
      id: scenario.id,
      matrix: scenario.matrix,
      family: scenario.family,
      track: options.bargeIn ? 'barge-in' : 'receptionist',
      repetition,
      provider: 'deepseek',
      model: DEEPSEEK_V4_FLASH_MODEL,
      thinking: 'disabled',
      rawReply: sanitize(rawReply),
      e2eReply: sanitize(e2eReply),
      e2eAccepted,
      e2eReasons,
      toolCalls: toolCalls.map((item) => ({
        name: item.name,
        args: Object.fromEntries(
          Object.entries(item.args).map(([key, value]) => [
            key,
            typeof value === 'string' && ALL_DAILY_IDS.includes(value)
              ? `[id:${key}]`
              : value,
          ])
        ),
      })),
      bookEffects: harness.state.bookEffects,
      cancelEffects: harness.state.cancelEffects,
      suppressed,
      socialShortcut,
      identityCanonical: identityForced || e2eReply === CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
      latencyMs: Date.now() - started,
      requestLatenciesMs: requestLatencies,
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      reasoningTokens,
      estimatedCostUsd: estimateCost({
        promptTokens,
        completionTokens,
        cachedPromptTokens,
      }),
      providerCalls,
      checks,
      rawPass,
      e2ePass,
      outcome: rawPass && e2ePass ? 'pass' : 'fail',
      failureClass: contained
        ? 'boundary_contained'
        : rawPass && e2ePass
          ? 'none'
          : 'model',
    };
  } catch (error) {
    const message = sanitize(
      error instanceof Error ? error.message : 'falha desconhecida'
    );
    const providerish =
      /401|403|429|api.deepseek|DEEPSEEK|timeout|ECONN/i.test(message);
    return {
      id: scenario.id,
      matrix: scenario.matrix,
      family: scenario.family,
      track: options.bargeIn ? 'barge-in' : 'receptionist',
      repetition,
      provider: 'deepseek',
      model: DEEPSEEK_V4_FLASH_MODEL,
      thinking: 'disabled',
      rawReply: '',
      e2eReply: '',
      e2eAccepted: false,
      e2eReasons: [],
      toolCalls: [],
      bookEffects: harness.state.bookEffects,
      cancelEffects: harness.state.cancelEffects,
      suppressed: true,
      socialShortcut: false,
      identityCanonical: false,
      latencyMs: Date.now() - started,
      requestLatenciesMs: requestLatencies,
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      reasoningTokens,
      estimatedCostUsd: estimateCost({
        promptTokens,
        completionTokens,
        cachedPromptTokens,
      }),
      providerCalls,
      checks: [],
      rawPass: false,
      e2ePass: false,
      outcome: providerish ? 'provider_error' : 'harness_error',
      failureClass: providerish ? 'provider' : 'harness',
      error: message,
    };
  }
}

function qualitativeSample(records: RunRecord[]): string[] {
  const lines: string[] = [];
  const failures = records.filter((item) => item.outcome === 'fail');
  const successes = records.filter(
    (item) => item.outcome === 'pass' && item.rawPass && item.e2ePass
  );
  lines.push('## Revisão qualitativa amostral', '');
  lines.push(`Falhas revisadas: ${failures.length} (todas).`);
  for (const item of failures) {
    const failed = item.checks.filter((checkItem) => !checkItem.pass);
    lines.push(
      `- FAIL ${item.id} r${item.repetition} [${item.failureClass}] raw=${item.rawPass} e2e=${item.e2ePass} resume=${item.resumeDecision ?? 'n/a'} tools=${item.toolCalls.map((tool) => tool.name).join(',') || '—'}`,
      `  raw: ${item.rawReply || '∅'}`,
      `  e2e: ${item.e2eReply || '∅'} reasons=${item.e2eReasons.join(',') || '—'}`,
      `  checks: ${failed.map((checkItem) => `${checkItem.id}(${checkItem.layer}/${checkItem.severity})`).join('; ') || 'sem checks'}`
    );
  }
  lines.push('', `Sucessos amostrados: ${Math.min(20, successes.length)} de ${successes.length}.`);
  for (const item of successes.slice(0, 20)) {
    lines.push(
      `- PASS ${item.id} r${item.repetition} resume=${item.resumeDecision ?? 'n/a'} e2e="${item.e2eReply.slice(0, 180)}" raw="${item.rawReply.slice(0, 180)}"`
    );
  }
  return lines;
}

function buildReport(
  records: RunRecord[],
  meta: Record<string, unknown>
): string {
  const providerCalls = records.reduce((sum, item) => sum + item.providerCalls, 0);
  const rawDenom = records.filter((item) => item.checks.some((checkItem) => checkItem.layer === 'raw'));
  const rawPass = rawDenom.filter((item) => item.rawPass).length;
  const e2ePass = records.filter((item) => item.e2ePass).length;
  const latencies = records.flatMap((item) => item.requestLatenciesMs);
  const e2eLatencies = records.map((item) => item.latencyMs);
  const cost = records.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const p0 = records.flatMap((item) =>
    item.checks.filter((checkItem) => !checkItem.pass && checkItem.severity === 'P0')
  );
  const p1 = records.flatMap((item) =>
    item.checks.filter((checkItem) => !checkItem.pass && checkItem.severity === 'P1')
  );
  const p2 = records.flatMap((item) =>
    item.checks.filter((checkItem) => !checkItem.pass && checkItem.severity === 'P2')
  );
  const contained = records.filter((item) => item.failureClass === 'boundary_contained');
  const providerErrors = records.filter((item) => item.outcome === 'provider_error');
  const verdict = (() => {
    if (meta.blocked) return 'bloqueado';
    if (providerErrors.length > 0) return 'bloqueado';
    if (p0.length > 0) return 'reprovado';
    const rawRate = rawDenom.length ? rawPass / rawDenom.length : 0;
    const e2eRate = records.length ? e2ePass / records.length : 0;
    if (rawRate >= 0.85 && e2eRate >= 0.95) return 'aprovado para canário';
    if (e2eRate >= 0.9 && p0.length === 0) return 'aprovado para canário';
    return 'reprovado';
  })();

  const byFamily = new Map<string, RunRecord[]>();
  for (const record of records) {
    const list = byFamily.get(record.family) ?? [];
    list.push(record);
    byFamily.set(record.family, list);
  }

  return [
    '# Relatório — validação comportamental DeepSeek da Ana (cotidiano)',
    '',
    `- Gerado em: ${new Date().toISOString()}`,
    `- Runtime HEAD: ${meta.head}`,
    `- Provider: deepseek / ${DEEPSEEK_V4_FLASH_MODEL}`,
    `- Thinking recepcionista: disabled (canônico)`,
    `- Thinking retomada: enabled (canônico, teto 4096, sem tools)`,
    `- Chamadas reais ao provider: ${providerCalls}`,
    `- Execuções (caso×repetição): ${records.length}`,
    `- Taxa raw do DeepSeek: ${rawPass}/${rawDenom.length} (${rawDenom.length ? ((rawPass / rawDenom.length) * 100).toFixed(1) : '0'}%)`,
    `- Taxa safe end-to-end: ${e2ePass}/${records.length} (${records.length ? ((e2ePass / records.length) * 100).toFixed(1) : '0'}%)`,
    `- Contidas pela fronteira (raw falhou, e2e passou): ${contained.length}`,
    `- Latência request p50/p95: ${percentile(latencies, 0.5) ?? '—'} / ${percentile(latencies, 0.95) ?? '—'} ms`,
    `- Latência e2e p50/p95: ${percentile(e2eLatencies, 0.5) ?? '—'} / ${percentile(e2eLatencies, 0.95) ?? '—'} ms`,
    `- Tokens prompt/completion/cached/reasoning: ${records.reduce((s, r) => s + r.promptTokens, 0)} / ${records.reduce((s, r) => s + r.completionTokens, 0)} / ${records.reduce((s, r) => s + r.cachedPromptTokens, 0)} / ${records.reduce((s, r) => s + r.reasoningTokens, 0)}`,
    `- Custo estimado: US$ ${cost.toFixed(6)} (preço DeepSeek V4 Flash de 2026-07-28)`,
    `- Falhas P0/P1/P2 (checks): ${p0.length}/${p1.length}/${p2.length}`,
    `- Veredito: **${verdict}**`,
    `- Este harness não autoriza deploy global.`,
    '',
    '## Matriz',
    '',
    '| # | Família | Track | Casos | Repetições críticas |',
    '|---|---|---|---|---|',
    ...[...new Set(DAILY_SCENARIOS.map((item) => item.matrix))]
      .sort((a, b) => a - b)
      .map((matrix) => {
        const items = DAILY_SCENARIOS.filter((item) => item.matrix === matrix);
        return `| ${matrix} | ${items[0]?.family} | ${[...new Set(items.map((item) => item.track))].join(',')} | ${items.map((item) => item.id).join(', ')} | ${items.some((item) => item.critical) ? 5 : 3} |`;
      }),
    '',
    '## Por família',
    '',
    '| Família | Raw | E2E | Provider calls |',
    '|---|---|---|---|',
    ...[...byFamily.entries()].map(([family, list]) => {
      const rawN = list.filter((item) => item.checks.some((checkItem) => checkItem.layer === 'raw'));
      return `| ${family} | ${rawN.filter((item) => item.rawPass).length}/${rawN.length} | ${list.filter((item) => item.e2ePass).length}/${list.length} | ${list.reduce((sum, item) => sum + item.providerCalls, 0)} |`;
    }),
    '',
    ...qualitativeSample(records),
    '',
    '## Notas de interpretação',
    '',
    '- Raw mede o DeepSeek. E2E mede a fronteira (social shortcut, identity 409, outbound, pausa, fora de horário).',
    '- Uma prosa ruim suprimida conta como falha raw e sucesso e2e (`boundary_contained`). Não é qualidade do modelo.',
    '- R16 (áudio ilegível) é fail-closed determinístico e não chama o provider.',
    '- Compactos e saudações com histórico contaminado chamam o provider de propósito, mesmo quando a produção usaria atalho social.',
    '',
  ].join('\n');
}

async function main() {
  const plan = process.argv.includes('--plan');
  const idsArg = argumentValue('--ids');
  const selected = idsArg
    ? new Set(idsArg.split(',').map((item) => item.trim()).filter(Boolean))
    : null;
  const repeatOverride = argumentValue('--repeats')
    ? parsePositive(argumentValue('--repeats'), 0)
    : undefined;
  const maxCostUsd = parsePositive(argumentValue('--max-cost-usd'), 8);

  const scenarios = DAILY_SCENARIOS.filter(
    (item) => !selected || selected.has(item.id)
  );
  const planned = scenarios.flatMap((item) => {
    const repeats = repeatsFor(item, repeatOverride);
    const rows = Array.from({ length: repeats }, (_, index) => ({
      id: item.id,
      matrix: item.matrix,
      track: item.track,
      repetition: index + 1,
      bargeIn: false,
    }));
    if (item.bargeInProbe) {
      for (let index = 1; index <= repeats; index += 1) {
        rows.push({
          id: item.id,
          matrix: item.matrix,
          track: 'resume',
          repetition: index,
          bargeIn: true,
        });
      }
    }
    return rows;
  });

  console.log(
    JSON.stringify(
      {
        suite: 'ana-deepseek-daily-v1',
        provider: 'deepseek',
        model: DEEPSEEK_V4_FLASH_MODEL,
        receptionistThinking: 'disabled',
        resumeThinking: 'enabled',
        sentryDsnPresent: false,
        keyPresent: keyPresent(process.env.DEEPSEEK_API_KEY),
        cases: scenarios.length,
        plannedExecutions: planned.length,
        maxCostUsd,
      },
      null,
      2
    )
  );
  if (plan) return;

  const flight = await preflight();
  if (!flight.ok) {
    const outputDir = path.resolve(
      'benchmark-results',
      'ana-deepseek-daily',
      new Date().toISOString().replace(/[:.]/g, '-')
    );
    await mkdir(outputDir, { recursive: true });
    const report = [
      '# BLOQUEADO — validação comportamental DeepSeek da Ana',
      '',
      `- Motivo: ${flight.blockedReason}`,
      `- DEEPSEEK_API_KEY presente: ${flight.keyPresent}`,
      `- Modelo listado: ${flight.modelListed}`,
      `- Sample /models (ids deepseek): ${flight.modelsSample.join(', ') || '—'}`,
      `- Sentry DSN forçado vazio: sim`,
      `- Veredito: **bloqueado**`,
      '',
    ].join('\n');
    await writeFile(path.join(outputDir, 'report.md'), report);
    console.log(JSON.stringify({ blocked: true, reason: flight.blockedReason, outputDir }, null, 2));
    process.exitCode = 2;
    return;
  }

  const outputDir = path.resolve(
    'benchmark-results',
    'ana-deepseek-daily',
    new Date().toISOString().replace(/[:.]/g, '-')
  );
  await mkdir(outputDir, { recursive: true });
  const records: RunRecord[] = [];
  let spent = 0;

  for (const scenario of scenarios) {
    const repeats = repeatsFor(scenario, repeatOverride);
    for (let repetition = 1; repetition <= repeats; repetition += 1) {
      if (spent >= maxCostUsd) {
        console.log(`Custo atingiu o teto US$ ${maxCostUsd}`);
        break;
      }
      const record =
        scenario.track === 'resume'
          ? await runResume(scenario, repetition)
          : await runReceptionist(scenario, repetition);
      records.push(record);
      spent += record.estimatedCostUsd;
      console.log(
        `${record.outcome.toUpperCase()} ${record.id} r${repetition} raw=${record.rawPass} e2e=${record.e2ePass} calls=${record.providerCalls} ${record.latencyMs}ms US$${record.estimatedCostUsd.toFixed(4)}`
      );
      if (scenario.bargeInProbe && scenario.resumeHistory) {
        const lastCustomer =
          [...scenario.resumeHistory].reverse().find((item) => item.role === 'user')
            ?.content ?? 'Oi';
        const probe = await runReceptionist(scenario, repetition, {
          bargeIn: true,
          lastCustomerText: lastCustomer,
        });
        const bargeChecks = [
          check(
            'barge-in.e2e-silent',
            'e2e',
            'P0',
            probe.suppressed && probe.bookEffects === 0,
            `suppressed=${probe.suppressed} book=${probe.bookEffects}`
          ),
          check(
            'barge-in.raw-no-write',
            'raw',
            'P0',
            probe.bookEffects === 0 && probe.cancelEffects === 0,
            `book=${probe.bookEffects}`
          ),
        ];
        probe.checks.push(...bargeChecks);
        probe.e2ePass = probe.checks.filter((item) => item.layer === 'e2e').every((item) => item.pass);
        probe.rawPass = probe.checks.filter((item) => item.layer === 'raw').every((item) => item.pass);
        probe.outcome = probe.rawPass && probe.e2ePass ? 'pass' : 'fail';
        records.push(probe);
        spent += probe.estimatedCostUsd;
        console.log(
          `${probe.outcome.toUpperCase()} ${probe.id} barge r${repetition} raw=${probe.rawPass} e2e=${probe.e2ePass} calls=${probe.providerCalls}`
        );
      }
      if (record.outcome === 'provider_error') {
        console.log(`Provider error: ${record.error}`);
        break;
      }
    }
    if (records.some((item) => item.outcome === 'provider_error')) break;
  }

  const { execSync } = await import('node:child_process');
  let head = 'unknown';
  try {
    head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    head = 'unknown';
  }

  const report = buildReport(records, {
    head,
    blocked: false,
    models: flight.modelsSample,
  });
  await writeFile(path.join(outputDir, 'report.md'), `${report}\n`);
  await writeFile(
    path.join(outputDir, 'results.jsonl'),
    records.map((item) => JSON.stringify(item)).join('\n') + '\n'
  );
  await writeFile(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(
      {
        head,
        provider: 'deepseek',
        model: DEEPSEEK_V4_FLASH_MODEL,
        providerCalls: records.reduce((sum, item) => sum + item.providerCalls, 0),
        runs: records.length,
        rawPass: records.filter((item) => item.rawPass).length,
        e2ePass: records.filter((item) => item.e2ePass).length,
        estimatedCostUsd: records.reduce((sum, item) => sum + item.estimatedCostUsd, 0),
      },
      null,
      2
    )}\n`
  );
  console.log(`Relatório: ${path.join(outputDir, 'report.md')}`);
  if (records.some((item) => item.outcome === 'provider_error' || item.outcome === 'harness_error')) {
    process.exitCode = 2;
  } else if (records.some((item) => item.outcome === 'fail')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(sanitize(error instanceof Error ? error.message : 'harness failed'));
  process.exit(1);
});
