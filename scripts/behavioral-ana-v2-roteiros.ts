#!/usr/bin/env ts-node

/**
 * Matriz comportamental dos 10 roteiros aprovados da Ana v2.
 *
 * Segurança do harness:
 * - banco, ERP, WhatsApp e Sentry são neutralizados antes dos imports do runtime;
 * - fixtures de catálogo, agenda, transporte e estado são totalmente sintéticas;
 * - --mock-provider usa o loop nativo de tools, sem rede;
 * - --real é a única modalidade que pode chamar o provider selecionado.
 */

import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import type OpenAI from 'openai';
import type { TimestampedMessage } from '../src/services/contextManager';
import type {
  FlatModelTurnV2,
  ModelTurnResultV2,
  BoundaryReasonCodeV2,
} from '../src/services/conversationalV2/contracts';
import type {
  ModelResultValidationCodeV2,
  ModelResultValidationContextV2,
} from '../src/services/conversationalV2/modelResultParser';
import {
  MODEL_TURN_RESULT_V2_BOOKING_RULE,
  MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER,
  MODEL_TURN_PROSE_V2_POST_TOOL_REMINDER,
} from '../src/services/conversationalV2/modelResultContract';
import type { ElicitationVariantV2 } from '../src/services/conversationalV2/elicitation';
import type { PreparedReceptionistTurnV2 } from '../src/services/conversationalV2/runtimeTypes';
import type { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';
import {
  ALL_ROTEIROS_SLOTS,
  ROTEIROS_FIXED_NOW,
  ROTEIROS_IDS,
  ROTEIROS_SERVICES,
  ROTEIROS_TENANT_SLUG,
  buildRoteirosConfig,
  createRoteirosFixtureHarness,
  type RoteirosFixtureState,
  type RoteirosToolCall,
} from './benchmarks/ana-v2-roteiros/fixtures';
import {
  ANA_V2_ROTEIROS,
  type MockBehavior,
  type RoteiroScenario,
  type RoteiroStep,
} from './benchmarks/ana-v2-roteiros/scenarios';

type ProviderMode = 'mock' | 'real';
type HarnessProvider = 'deepseek' | 'openai' | 'luna';
type CheckStatus = 'PASS' | 'FAIL' | 'REVIEW';

interface CliOptions {
  mode: ProviderMode;
  repeats: number;
  scenarioIds: Set<string> | null;
  maxCostUsd: number | null;
  thinking: boolean;
  elicitation: ElicitationVariantV2;
  provider: HarnessProvider;
  interpreter: boolean;
}

interface ProviderCallMetric {
  provider: HarnessProvider;
  kind: 'brain' | 'social' | 'regen' | 'resume_thinking' | 'interpreter';
  scenarioId: string;
  stepId: string;
  repetition: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | null;
  cacheMissPromptTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  estimatedCostUsd: number;
}

interface ParseFailureArtifact {
  stage: 'primary' | 'regen';
  codes: ModelResultValidationCodeV2[];
  rawRejectedOutput: string;
  finishReason: string | null;
}

interface ModelOutputArtifact {
  stage: 'primary' | 'regen' | 'social' | 'interpreter';
  loopInvocation: number | null;
  round: number | null;
  completionAttempt: number;
  responseFormat: 'json_object' | null;
  finishReason: string | null;
  toolCallNames: string[];
  /** Conteúdo final sintético; reasoning_content nunca é lido nem persistido. */
  rawContent: string | null;
}

interface BoundaryRejectionArtifact {
  stage: 'primary' | 'regen';
  rawRejectedOutput: string;
  reasonCodes: BoundaryReasonCodeV2[];
}

interface MatrixCheck {
  id: string;
  status: CheckStatus;
  reason: string;
}

interface HistoryEntry extends TimestampedMessage {
  role: 'user' | 'assistant';
}

interface HumanForkSnapshot {
  history: HistoryEntry[];
  sequence: number;
  nowMs: number;
}

interface ScenarioSession {
  scenarioId: string;
  repetition: number;
  phone: string;
  conversationKey: string;
  store: MemoryConversationalV2StateStore;
  history: HistoryEntry[];
  sequence: number;
  idSequence: number;
  transportPayloads: string[];
  fixtureState: RoteirosFixtureState;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  activeStep: RoteiroStep | null;
  now: Date;
  humanFork: HumanForkSnapshot | null;
  priorStepPayloads: Map<string, string>;
  parseFailures: ParseFailureArtifact[];
  modelOutputs: ModelOutputArtifact[];
  boundaryRejections: BoundaryRejectionArtifact[];
}

interface StepRun {
  scenarioId: string;
  scenarioTitle: string;
  stepId: string;
  stepLabel: string;
  repetition: number;
  mode: ProviderMode;
  inputMessages: string[];
  response: string | null;
  route: string;
  preemption: string | null;
  delivery: string | null;
  deliveryReceipt: unknown;
  planReceipt: unknown;
  frame: unknown;
  transition: unknown;
  pendingBefore: unknown;
  pendingAfter: unknown;
  toolCalls: RoteirosToolCall[];
  outboundCount: number;
  receiptReconciliation: unknown;
  classifier: unknown;
  turnLatencyMs: number;
  providerCalls: ProviderCallMetric[];
  parseFailures: ParseFailureArtifact[];
  modelOutputs: ModelOutputArtifact[];
  boundaryRejections: BoundaryRejectionArtifact[];
  checks: MatrixCheck[];
}

interface HarnessBoundaryAttemptArtifact {
  index?: unknown;
  reasonCodes?: unknown;
  candidateHash?: unknown;
  rejectionStage?: 'primary' | 'regen';
  rejectedCandidateText?: string;
}

interface ReportStepSummary {
  scenarioId: string;
  scenarioTitle: string;
  stepId: string;
  stepLabel: string;
  status: CheckStatus;
  reason: string;
  repetitions: number;
  failedRepetitions: number[];
  reviewItems: string[];
}

type MockUnwrapVariant =
  | 'plain_json'
  | 'markdown_fence'
  | 'residual_prose'
  | 'contract_marker'
  | 'schema_echo_recovered'
  | 'empty_zero_tools_reinvoked'
  | 'empty_tools_regen_without_json_object'
  | 'empty_tools_regen_with_json_object'
  | 'empty_same_round_retried'
  | 'v3_safe_prose_happy_path'
  | 'boundary_rejection_captured'
  | 'safe_primary_prose_preserve'
  | 'safe_regen_prose_preserve'
  | 'canonical_write_over_unparsed_prose';

interface RunContext {
  options: CliOptions;
  runtime: {
    MemoryConversationalV2StateStore: typeof MemoryConversationalV2StateStore;
    getReceptionistReplyV2: typeof import('../src/services/conversationalV2/runtime').getReceptionistReplyV2;
    deliverPreparedReceptionistTurnV2: typeof import('../src/services/conversationalV2/delivery').deliverPreparedReceptionistTurnV2;
    runReceptionistModelLoop: typeof import('../src/services/brainService').runReceptionistModelLoop;
    RECEPTIONIST_TOOLS: typeof import('../src/services/brainService').RECEPTIONIST_TOOLS;
    composeSocialReplyV2: typeof import('../src/services/conversationalV2/social').composeSocialReplyV2;
    regenerateReceptionistCopyV2: typeof import('../src/services/conversationalV2/regenerator').regenerateReceptionistCopyV2;
    createReceptionistChatCompletion: typeof import('../src/services/receptionistLlmProvider').createReceptionistChatCompletion;
    createAnaResumeClassifierCompletion: typeof import('../src/services/receptionistLlmProvider').createAnaResumeClassifierCompletion;
    resolveReceptionistAiRuntime: typeof import('../src/services/receptionistLlmProvider').resolveReceptionistAiRuntime;
    resolveAnaResumeClassifierRuntime: typeof import('../src/services/receptionistLlmProvider').resolveAnaResumeClassifierRuntime;
    classifyAnaResume: typeof import('../src/services/anaResumeClassifier').classifyAnaResume;
    isAnaConversationalV2Enabled: typeof import('../src/services/conversationalV2/featureFlag').isAnaConversationalV2Enabled;
    HUMAN_ECHO_PREFIX: string;
    buildConversationKey: typeof import('../src/services/contextManager').buildConversationKey;
    parseModelTurnResultV2: typeof import('../src/services/conversationalV2/modelResultParser').parseModelTurnResultV2;
    interpretPowerZeroV2: typeof import('../src/services/conversationalV2/powerZeroInterpreter').interpretPowerZeroV2;
  };
  calls: ProviderCallMetric[];
  mockUnwrapVariants: Set<MockUnwrapVariant>;
}

const PRICE_PER_MILLION = {
  deepseek: {
    promptCacheHit: 0.0028,
    promptCacheMiss: 0.14,
    completion: 0.28,
  },
  openai: {
    promptCacheHit: 0.075,
    promptCacheMiss: 0.15,
    completion: 0.6,
  },
  luna: {
    promptCacheHit: Number(process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION ?? 0),
    promptCacheMiss: Number(process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION ?? 0),
    completion: Number(process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION ?? 0),
  },
} as const;

const OLD_DRY_DENIAL =
  'Esse tipo de atendimento não está disponível neste estabelecimento.';
const V2_UNKNOWN_DENIAL =
  'Esse procedimento não está disponível no momento. Posso te ajudar com outro serviço?';
const MOCK_REASONING_SENTINEL =
  '__ANA_V2_SYNTHETIC_REASONING_MUST_NEVER_LEAK__';
const ALLOWED_ROUTES = new Set([
  'fast_path',
  'model',
  'regen',
  'fallback',
  'preempted',
  'interpreter_hit',
  'interpreter_nenhuma',
  'interpreter_error',
]);
const OPERATIONAL_PROGRESS_STEP_IDS = new Set([
  'R1.1',
  'R1.2',
  'R1.3',
  'R2.1',
  'R2.2',
  'R2.3',
  'R2.4',
  'R2.5',
  'R3.1',
  'R3.2',
  'R4.1',
  'R4.2',
  'R4.3',
  'R6.2',
  'R6.4',
  'R8.1',
  'R9.1',
  'R9.2',
  'R10.1',
  'R10.4',
]);

function parseArgs(argv: string[]): CliOptions {
  let mode: ProviderMode | null = null;
  let repeats = 3;
  let scenarioIds: Set<string> | null = null;
  let maxCostUsd: number | null = null;
  let thinking = false;
  let provider: HarnessProvider = 'deepseek';
  let interpreter = false;
  let elicitation: ElicitationVariantV2 = 'v1';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--mock-provider') {
      if (mode) throw new Error('Use apenas um modo de provider.');
      mode = 'mock';
    } else if (arg === '--real') {
      if (mode) throw new Error('Use apenas um modo de provider.');
      mode = 'real';
    } else if (arg === '--repeats') {
      repeats = Number(argv[++index]);
    } else if (arg === '--ids') {
      const raw = argv[++index] ?? '';
      scenarioIds = new Set(
        raw
          .split(',')
          .map((entry) => entry.trim().toUpperCase())
          .filter(Boolean)
      );
    } else if (arg === '--max-cost-usd') {
      maxCostUsd = Number(argv[++index]);
    } else if (arg === '--thinking') {
      thinking = true;
    } else if (arg === '--interpreter') {
      const value = (argv[++index] ?? '').toLowerCase();
      if (value === 'on') interpreter = true;
      else if (value === 'off') interpreter = false;
      else throw new Error('--interpreter deve ser on ou off.');
    } else if (arg.startsWith('--interpreter=')) {
      const value = arg.slice('--interpreter='.length).toLowerCase();
      if (value === 'on') interpreter = true;
      else if (value === 'off') interpreter = false;
      else throw new Error('--interpreter deve ser on ou off.');
    } else if (arg === '--provider') {
      const value = (argv[++index] ?? '').toLowerCase();
      if (value === 'gpt-4o-mini') provider = 'openai';
      else if (value === 'flash') provider = 'deepseek';
      else if (value === 'deepseek' || value === 'openai' || value === 'luna') provider = value;
      else throw new Error('--provider deve ser flash, deepseek, openai, gpt-4o-mini ou luna.');
    } else if (arg.startsWith('--provider=')) {
      const value = arg.slice('--provider='.length).toLowerCase();
      if (value === 'gpt-4o-mini') provider = 'openai';
      else if (value === 'flash') provider = 'deepseek';
      else if (value === 'deepseek' || value === 'openai' || value === 'luna') provider = value;
      else throw new Error('--provider deve ser flash, deepseek, openai, gpt-4o-mini ou luna.');
    } else if (arg === '--elicitation') {
      const value = (argv[++index] ?? '').toLowerCase();
      if (!['v1', 'v2', 'v3', 'v4'].includes(value)) {
        throw new Error('--elicitation deve ser v1, v2, v3 ou v4.');
      }
      elicitation = value as ElicitationVariantV2;
    } else if (arg.startsWith('--elicitation=')) {
      const value = arg.slice('--elicitation='.length).toLowerCase();
      if (!['v1', 'v2', 'v3', 'v4'].includes(value)) {
        throw new Error('--elicitation deve ser v1, v2, v3 ou v4.');
      }
      elicitation = value as ElicitationVariantV2;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Uso: npm run behavioral:ana-v2-roteiros -- --mock-provider|--real [--provider flash|deepseek|openai|gpt-4o-mini|luna] [--interpreter on|off] [--thinking] [--elicitation v1|v2|v3|v4] [--repeats N] [--ids R1,R2] [--max-cost-usd N]'
      );
      process.exit(0);
    } else {
      throw new Error(`Flag desconhecida: ${arg}`);
    }
  }
  if (!mode) {
    throw new Error('Informe obrigatoriamente --mock-provider ou --real.');
  }
  if (provider !== 'deepseek' && thinking) {
    throw new Error('--thinking é exclusivo do braço DeepSeek.');
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error('--repeats deve ser inteiro entre 1 e 20.');
  }
  if (
    maxCostUsd !== null &&
    (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)
  ) {
    throw new Error('--max-cost-usd deve ser positivo.');
  }
  const known = new Set(ANA_V2_ROTEIROS.map((scenario) => scenario.id));
  for (const id of scenarioIds ?? []) {
    if (!known.has(id as RoteiroScenario['id'])) {
      throw new Error(`Roteiro desconhecido em --ids: ${id}`);
    }
  }
  return {
    mode,
    repeats,
    scenarioIds,
    maxCostUsd,
    thinking,
    elicitation,
    provider,
    interpreter,
  };
}

function neutralizeEnvironment(options: CliOptions): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    'postgresql://fixture:fixture@127.0.0.1:1/ana_v2_roteiros';
  process.env.ERP_API_TOKEN = 'fixture-no-erp-token';
  process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
  process.env.RECEPS_IA_INTERNAL_API_URL = 'http://127.0.0.1:1';
  process.env.WHATSAPP_API_BASE_URL = 'http://127.0.0.1:1';
  process.env.SENTRY_DSN = '';
  process.env.SENTRY_AUTH_TOKEN = '';
  process.env.DEEPSEEK_PRODUCTION_APPROVED = 'false';
  process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS = ROTEIROS_TENANT_SLUG;
  process.env.ANA_CONVERSATIONAL_V2_ELICITATION = options.elicitation;
  process.env.ANA_CONVERSATIONAL_V2_INTERPRETER_ENABLED = options.interpreter
    ? 'true'
    : 'false';
  if (options.mode === 'mock') {
    process.env.OPENAI_API_KEY = 'sk-mock-provider-no-network';
    process.env.OPENAI_API_KEY_LUNA = 'sk-mock-luna-no-network';
    process.env.DEEPSEEK_API_KEY = 'mock-provider-no-network';
  } else if (options.provider === 'deepseek') {
    process.env.OPENAI_API_KEY ||= 'sk-fixture-no-openai-network';
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error('--real --provider deepseek exige DEEPSEEK_API_KEY.');
    }
  } else if (options.provider === 'luna') {
    if (!process.env.OPENAI_API_KEY_LUNA?.trim()) {
      throw new Error('--real --provider luna exige OPENAI_API_KEY_LUNA.');
    }
    process.env.OPENAI_API_KEY ||= 'sk-fixture-no-openai-network';
    const includesR10 =
      !options.scenarioIds || options.scenarioIds.has('R10');
    if (includesR10 && !process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error('R10 real mantém o chefe Thinking e exige DEEPSEEK_API_KEY.');
    }
  } else {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error('--real --provider openai exige OPENAI_API_KEY.');
    }
    const includesR10 =
      !options.scenarioIds || options.scenarioIds.has('R10');
    if (includesR10 && !process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error('R10 real mantém o chefe Thinking e exige DEEPSEEK_API_KEY.');
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Projeção exclusiva do artefato sintético. O recibo normativo salvo pelo
 * runtime continua hash-only; o harness cruza o hook em memória com os attempts
 * depois da entrega e publica a copy rejeitada para auditoria humana.
 */
function planReceiptForHarness(
  planReceipt: unknown,
  rejections: readonly BoundaryRejectionArtifact[]
): unknown {
  const artifact = clone(planReceipt) as {
    boundaryAttempts?: HarnessBoundaryAttemptArtifact[];
  };
  const attempts = artifact.boundaryAttempts ?? [];
  let rejectionIndex = 0;
  for (const attempt of attempts) {
    const reasonCodes = Array.isArray(attempt.reasonCodes)
      ? attempt.reasonCodes.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (reasonCodes.length === 0) continue;
    const next = rejections[rejectionIndex];
    if (!next) continue;
    const sameReasons =
      reasonCodes.length === next.reasonCodes.length &&
      reasonCodes.every((reason, index) => reason === next.reasonCodes[index]);
    if (!sameReasons) continue;
    rejectionIndex += 1;
    attempt.rejectionStage = next.stage;
    attempt.rejectedCandidateText = next.rawRejectedOutput;
  }
  return artifact;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return Number((sorted[index] ?? 0).toFixed(2));
}

function estimatedCost(input: {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number | null;
  cacheMissPromptTokens: number | null;
  provider: HarnessProvider;
}): number {
  const cached = Math.max(0, input.cachedPromptTokens ?? 0);
  const miss = Math.max(
    0,
    input.cacheMissPromptTokens ?? input.promptTokens - cached
  );
  const pricing = PRICE_PER_MILLION[input.provider];
  return (
    (cached * pricing.promptCacheHit +
      miss * pricing.promptCacheMiss +
      Math.max(0, input.completionTokens) * pricing.completion) /
    1_000_000
  );
}

function metricFromCompletion(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  durationMs: number,
  kind: ProviderCallMetric['kind'],
  scenarioId: string,
  stepId: string,
  repetition: number,
  provider: HarnessProvider = 'deepseek'
): ProviderCallMetric {
  const usage = completion.usage as
    | (NonNullable<OpenAI.Chat.Completions.ChatCompletion['usage']> & {
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      })
    | undefined;
  const cached =
    usage?.prompt_cache_hit_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    null;
  const metric: ProviderCallMetric = {
    provider,
    kind,
    scenarioId,
    stepId,
    repetition,
    durationMs,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    cachedPromptTokens: cached,
    cacheMissPromptTokens: usage?.prompt_cache_miss_tokens ?? null,
    reasoningTokens:
      usage?.completion_tokens_details?.reasoning_tokens ?? null,
    finishReason: completion.choices[0]?.finish_reason ?? null,
    estimatedCostUsd: 0,
  };
  metric.estimatedCostUsd = estimatedCost(metric);
  return metric;
}

function syntheticCompletion(input: {
  content?: string | null;
  tool?: { name: string; args: Record<string, unknown> };
  model?: string;
  reasoningContent?: string;
}): OpenAI.Chat.Completions.ChatCompletion {
  const toolCall = input.tool
    ? [
        {
          id: `fixture-call-${input.tool.name}`,
          type: 'function' as const,
          function: {
            name: input.tool.name,
            arguments: JSON.stringify(input.tool.args),
          },
        },
      ]
    : undefined;
  return {
    id: 'fixture-completion',
    object: 'chat.completion',
    created: 0,
    model: input.model ?? 'deepseek-v4-flash-mock',
    system_fingerprint: 'fp_ana_v2_mock',
    choices: [
      {
        index: 0,
        finish_reason: toolCall ? 'tool_calls' : 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: input.content ?? null,
          refusal: null,
          ...(input.reasoningContent
            ? { reasoning_content: input.reasoningContent }
            : {}),
          ...(toolCall ? { tool_calls: toolCall } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: input.reasoningContent ? 7 : 0,
      total_tokens: input.reasoningContent ? 7 : 0,
      ...(input.reasoningContent
        ? { completion_tokens_details: { reasoning_tokens: 7 } }
        : {}),
    },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function mockStructuredOutput(
  result: FlatModelTurnV2,
  repetition: number
): {
  raw: string;
  variants: MockUnwrapVariant[];
} {
  const json = JSON.stringify(result);
  if (repetition % 3 === 1) {
    return { raw: json, variants: ['plain_json'] };
  }
  if (repetition % 3 === 2) {
    return {
      raw: `\`\`\`json\n${json}\n\`\`\``,
      variants: ['markdown_fence'],
    };
  }
  const identifiedInstance = JSON.stringify({
    contract: 'FlatModelTurnV2',
    ...result,
  });
  return {
    raw: `Segue o único objeto final solicitado:\n\`\`\`json\n${identifiedInstance}\n\`\`\``,
    variants: ['residual_prose', 'contract_marker'],
  };
}

function spanTextFromInternalResult(
  data: ReturnType<typeof frameFromMessages>,
  inboundId: string,
  span: { start: number; end: number }
): string | null {
  const inbound = data.currentInbounds.find((entry) => entry.inboundId === inboundId);
  if (!inbound) return null;
  const points = Array.from(inbound.text);
  if (span.start < 0 || span.end <= span.start || span.end > points.length) return null;
  return points.slice(span.start, span.end).join('');
}

/**
 * O mock roteiriza intenção sem pré-resolver IDs no fio. Esta conversão existe
 * somente no harness: o runtime recebe exatamente o envelope plano externo.
 */
function flatMockResult(
  result: ModelTurnResultV2,
  data: ReturnType<typeof frameFromMessages>
): FlatModelTurnV2 {
  const transition = result.pendingTransitionCandidate;
  const nextPending = transition.kind === 'open'
    ? transition.pendingKind
    : transition.kind === 'preserve'
      ? 'PRESERVE'
      : 'RESOLVED';
  const resolution = result.resolutionCandidate;
  const chosenOptionText =
    resolution?.kind === 'catalog_entity'
      ? spanTextFromInternalResult(data, resolution.inboundId, resolution.span)
      : null;
  const unknownServiceText = result.unknownServiceEvidence
    ? spanTextFromInternalResult(
        data,
        result.unknownServiceEvidence.inboundId,
        result.unknownServiceEvidence.span
      )
    : null;
  return {
    reply: result.reply,
    nextPending,
    chosenOptionText,
    unknownServiceText,
  };
}

function validationContextFromPrompt(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  now: Date
): ModelResultValidationContextV2 {
  const data = frameFromMessages(messages);
  return {
    frame: data.turnFrame,
    inboundTextsById: Object.fromEntries(
      data.currentInbounds.map((entry) => [entry.inboundId, entry.text])
    ),
    catalogEntities: {
      services: (ROTEIROS_SERVICES.services ?? []).map((entry) => ({
        id: entry.id,
        displayName: entry.name,
        professionalIds: entry.professionalIds,
      })),
      professionals: (ROTEIROS_SERVICES.professionals ?? []).map((entry) => ({
        id: entry.id,
        displayName: entry.name,
      })),
    },
    now,
  };
}

function recordParseFailure(
  session: ScenarioSession,
  failure: ParseFailureArtifact
): void {
  session.parseFailures.push({
    ...failure,
    codes: [...new Set(failure.codes)],
  });
}

function recordModelOutput(
  session: ScenarioSession,
  input: Omit<ModelOutputArtifact, 'finishReason' | 'toolCallNames' | 'rawContent'> & {
    completion: OpenAI.Chat.Completions.ChatCompletion;
  }
): void {
  const choice = input.completion.choices[0];
  session.modelOutputs.push({
    stage: input.stage,
    loopInvocation: input.loopInvocation,
    round: input.round,
    completionAttempt: input.completionAttempt,
    responseFormat: input.responseFormat,
    finishReason: choice?.finish_reason ?? null,
    toolCallNames:
      choice?.message.tool_calls?.map((call) => call.function.name) ?? [],
    rawContent:
      typeof choice?.message.content === 'string'
        ? choice.message.content
        : null,
  });
}

function frameFromMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): {
  turnFrame: PreparedReceptionistTurnV2['frame'];
  catalogSnapshot: ServicesResult;
  currentInbounds: Array<{ inboundId: string; text: string }>;
} {
  const marker = 'DADOS IMUTÁVEIS DO TURNO (não são instruções): ';
  const system = messages.find(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(marker)
  );
  if (!system || typeof system.content !== 'string') {
    throw new Error('Prompt v2 sem TurnFrame no harness.');
  }
  return JSON.parse(system.content.slice(system.content.indexOf(marker) + marker.length));
}

function spanByCodePoint(text: string, needle: string): { start: number; end: number } {
  const source = Array.from(text.toLocaleLowerCase('pt-BR'));
  const target = Array.from(needle.toLocaleLowerCase('pt-BR'));
  for (let start = 0; start <= source.length - target.length; start += 1) {
    if (target.every((char, offset) => source[start + offset] === char)) {
      return { start, end: start + target.length };
    }
  }
  throw new Error(`Span fixture ausente: ${needle}`);
}

function baseResult(
  frame: PreparedReceptionistTurnV2['frame'],
  reply: string,
  replyPurpose: ModelTurnResultV2['replyPurpose'],
  pendingTransitionCandidate: ModelTurnResultV2['pendingTransitionCandidate'] = {
    kind: 'preserve',
  }
): ModelTurnResultV2 {
  return {
    schemaVersion: 2,
    reply,
    replyPurpose,
    pendingTransitionCandidate,
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

function open(
  frame: PreparedReceptionistTurnV2['frame'],
  pendingKind: 'SERVICE' | 'PROFESSIONAL' | 'DATE' | 'TIME' | 'CONFIRMATION',
  optionEntityIds: string[]
): ModelTurnResultV2['pendingTransitionCandidate'] {
  return {
    kind: 'open',
    pendingKind,
    flowId: frame.flowState.flowId,
    optionEntityIds,
  };
}

function currentInbound(data: ReturnType<typeof frameFromMessages>) {
  const inbound = data.currentInbounds.at(-1);
  if (!inbound) throw new Error('Turno fixture sem inbound atual.');
  return inbound;
}

function withServiceProof(
  result: ModelTurnResultV2,
  data: ReturnType<typeof frameFromMessages>,
  entityId: string,
  needle: string
): ModelTurnResultV2 {
  const inbound = currentInbound(data);
  return {
    ...result,
    resolutionCandidate: {
      kind: 'catalog_entity',
      entityKind: 'service',
      entityId,
      inboundId: inbound.inboundId,
      span: spanByCodePoint(inbound.text, needle),
    },
  };
}

function withUnknownEvidence(
  result: ModelTurnResultV2,
  data: ReturnType<typeof frameFromMessages>,
  needle: string
): ModelTurnResultV2 {
  const inbound = currentInbound(data);
  return {
    ...result,
    unknownServiceEvidence: {
      inboundId: inbound.inboundId,
      span: spanByCodePoint(inbound.text, needle),
    },
  };
}

function mockModelResult(
  behavior: MockBehavior,
  data: ReturnType<typeof frameFromMessages>
): ModelTurnResultV2 {
  const frame = data.turnFrame;
  const options = ROTEIROS_SERVICES.services!.map((service) => service.id);
  switch (behavior) {
    case 'R1_REOPEN':
    case 'R2_LIST':
    case 'R6_LIST':
      return baseResult(
        frame,
        'Claro! Temos Drenagem linfática, Limpeza de pele profunda e Peeling facial. Qual serviço você prefere?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R1_MORNING':
      return baseResult(
        frame,
        'Claro! Podemos procurar opções pela manhã. Qual serviço você gostaria de agendar?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R1_RETURN':
      return baseResult(
        frame,
        'Claro! Para eu te orientar certinho, qual procedimento você gostaria de agendar?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R2_SLOTS':
      return baseResult(
        frame,
        'Na quinta à tarde, a Limpeza de pele profunda tem horários às 14h, 15h e 17h com a Carla. Qual você prefere?',
        'DATE_TIME_QUESTION',
        open(frame, 'TIME', ['14:00', '15:00', '17:00'])
      );
    case 'R2_SUMMARY':
      return baseResult(
        frame,
        'Resumo: Limpeza de pele profunda na quinta-feira, às 15h, com Carla Mendes. Está tudo certo para confirmar?',
        'WRITE_CONFIRMATION',
        open(frame, 'CONFIRMATION', ['confirm-booking'])
      );
    case 'R2_BOOK':
      return baseResult(
        frame,
        'Prontinho! Seu agendamento de Limpeza de pele profunda foi confirmado para quinta-feira às 15h com Carla Mendes. 😊',
        'OPERATIONAL_ANSWER',
        {
          kind: 'invalidate',
          questionId: frame.pending?.questionId ?? 'missing-confirmation',
          reason: 'booking_committed',
        }
      );
    case 'R3_CLEANING':
      return withServiceProof(
        baseResult(
          frame,
          'Perfeito! Para qual dia você quer marcar a Limpeza de pele profunda?',
          'DATE_TIME_QUESTION',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.limpeza,
        'limpeza de pele'
      );
    case 'R3_MONDAY':
      return baseResult(
        frame,
        'Entendi: segunda-feira. Qual serviço você deseja agendar?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R4_DRAINAGE_TYPO':
      return withServiceProof(
        baseResult(
          frame,
          'Boa tarde! Sim, fazemos drenajem. Qual dia seria melhor para você?',
          'DATE_TIME_QUESTION',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.drenagem,
        'drenajem'
      );
    case 'R4_PEELING':
      return withServiceProof(
        baseResult(
          frame,
          'Temos Peeling facial, sim, com Carla Mendes. Qual dia você prefere?',
          'DATE_TIME_QUESTION',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.peeling,
        'peeling'
      );
    case 'R4_PRICE':
      return withServiceProof(
        baseResult(
          frame,
          'A Limpeza de pele profunda custa R$ 180,00 e dura 60 minutos. Quer escolher um dia?',
          'OPERATIONAL_ANSWER',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.limpeza,
        'limpeza'
      );
    case 'R5_UNKNOWN': {
      const inbound = currentInbound(data).text;
      const needle = inbound.toLocaleLowerCase('pt-BR').includes('botox')
        ? 'botox'
        : 'micropigmentação de sobrancelha';
      return withUnknownEvidence(
        baseResult(frame, V2_UNKNOWN_DENIAL, 'OPERATIONAL_ANSWER'),
        data,
        needle
      );
    }
    case 'R6_COMPLIMENT':
      return baseResult(
        frame,
        'Muito obrigada! Ficamos felizes com seu carinho 🥰 Qual serviço você prefere?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R7_PARTY':
      return baseResult(
        frame,
        'Que demais! Aproveite muito essa festa 🎉',
        'SOCIAL'
      );
    case 'R8_SLOTS':
      return withServiceProof(
        baseResult(
          frame,
          'Obrigada pelo carinho! Amanhã há horários para Drenagem linfática às 9h, 10h30 e 15h com Carla Mendes. Qual você prefere?',
          'DATE_TIME_QUESTION',
          open(frame, 'TIME', ['09:00', '10:30', '15:00'])
        ),
        data,
        ROTEIROS_IDS.service.drenagem,
        'drenagem'
      );
    case 'R8_DEFER':
      return baseResult(
        frame,
        'Tudo bem! Quando quiser, é só me chamar que eu verifico os horários. Obrigada e tenha um ótimo dia! ❤️',
        'SOCIAL'
      );
    case 'R9_PEELING_CORRECTION':
      return withServiceProof(
        baseResult(
          frame,
          'Perfeito, vamos de Peeling facial com Carla Mendes. Qual dia você prefere?',
          'DATE_TIME_QUESTION',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.peeling,
        'peeling'
      );
    case 'R9_FRIDAY_MORNING':
      return baseResult(
        frame,
        'Perfeito: Peeling facial com Carla Mendes, sexta-feira pela manhã.',
        'OPERATIONAL_ANSWER'
      );
    case 'R10_SATURDAY':
      return baseResult(
        frame,
        'Sim, atendemos aos sábados. Qual serviço você procura?',
        'SERVICE_QUESTION',
        open(frame, 'SERVICE', options)
      );
    case 'R10_RESUME_CLEANING':
      return withServiceProof(
        baseResult(
          frame,
          'Claro! Para qual dia da próxima semana você quer marcar a Limpeza de pele profunda?',
          'DATE_TIME_QUESTION',
          open(frame, 'DATE', ['date-freeform'])
        ),
        data,
        ROTEIROS_IDS.service.limpeza,
        'limpeza de pele'
      );
    default:
      return baseResult(
        frame,
        'Pode me contar um pouco mais para eu te ajudar?',
        'CLARIFICATION'
      );
  }
}

function mockRegeneratedModelResult(
  behavior: MockBehavior,
  data: ReturnType<typeof frameFromMessages>
): ModelTurnResultV2 {
  const result = mockModelResult(behavior, data);
  if (behavior === 'R2_SLOTS') {
    return {
      ...result,
      reply:
        'Para quinta-feira à tarde temos horários às 14h, 15h e 17h. Qual prefere?',
    };
  }
  if (behavior === 'R2_SUMMARY') {
    return {
      ...result,
      reply:
        'Ótimo, tenho horário às 15h disponível hoje. Confirmando: Limpeza de pele profunda, hoje (quinta, 13/08) às 15h, com a Carla. Posso marcar?',
    };
  }
  return result;
}

function mockCompletionForBehavior(
  behavior: MockBehavior,
  stepId: string,
  round: number,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  thinking: boolean,
  repetition: number,
  loopInvocation: number,
  completionAttempt: number,
  elicitation: ElicitationVariantV2,
  observedVariants: RunContext['mockUnwrapVariants']
): OpenAI.Chat.Completions.ChatCompletion {
  const data = frameFromMessages(messages);
  if (
    round > 1 &&
    ['R2_SLOTS', 'R2_SUMMARY', 'R2_BOOK', 'R5_UNKNOWN', 'R8_SLOTS'].includes(behavior) &&
    !(
      messages.at(-1)?.role === 'system' &&
      messages.at(-1)?.content ===
        (elicitation === 'v3'
          ? MODEL_TURN_PROSE_V2_POST_TOOL_REMINDER
          : MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER)
    )
  ) {
    throw new Error(`${behavior}: rodada pós-tool sem lembrete final v2.`);
  }
  if (
    behavior === 'R5_UNKNOWN' &&
    stepId === 'R5.1' &&
    repetition === 1 &&
    loopInvocation === 1 &&
    completionAttempt === 1
  ) {
    observedVariants.add(
      elicitation === 'v4'
        ? 'empty_same_round_retried'
        : 'empty_zero_tools_reinvoked'
    );
    return syntheticCompletion({
      content: '',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (
    behavior === 'R5_UNKNOWN' &&
    stepId === 'R5.2' &&
    repetition === 1
  ) {
    if (round === 1) {
      return syntheticCompletion({
        content: ' \n ',
        ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
        tool: { name: 'getUpcomingAppointments', args: {} },
      });
    }
    if (completionAttempt === 1) {
      if (elicitation === 'v4') observedVariants.add('empty_same_round_retried');
      return syntheticCompletion({
        content: '',
        ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      });
    }
  }
  if (behavior === 'R2_SLOTS' && round === 1) {
    return syntheticCompletion({
      content: ' \n ',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      tool: {
        name: 'getAvailableSlots',
        args: {
          date: '2026-08-13',
          serviceId: ROTEIROS_IDS.service.limpeza,
          professionalId: ROTEIROS_IDS.professional.carla,
        },
      },
    });
  }
  if (behavior === 'R2_SUMMARY' && round === 1) {
    return syntheticCompletion({
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      tool: {
        name: 'getAvailableSlots',
        args: {
          date: '2026-08-13',
          serviceId: ROTEIROS_IDS.service.limpeza,
          professionalId: ROTEIROS_IDS.professional.carla,
        },
      },
    });
  }
  if (behavior === 'R2_BOOK' && round === 1) {
    const hasBookingRule = messages.some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes(MODEL_TURN_RESULT_V2_BOOKING_RULE)
    );
    if (data.turnFrame.pending?.kind !== 'CONFIRMATION' || !hasBookingRule) {
      throw new Error(
        `R2_BOOK: pending=${data.turnFrame.pending?.kind ?? 'null'} bookingRule=${hasBookingRule}.`
      );
    }
    return syntheticCompletion({
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      tool: {
        name: 'bookAppointment',
        args: {
          date: '2026-08-13',
          time: '15:00',
          serviceId: ROTEIROS_IDS.service.limpeza,
          professionalId: ROTEIROS_IDS.professional.carla,
        },
      },
    });
  }
  if (behavior === 'R2_BOOK' && round > 1) {
    observedVariants.add('canonical_write_over_unparsed_prose');
    return syntheticCompletion({
      content: 'Pronto, ficou marcado.',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R8_SLOTS' && round === 1) {
    return syntheticCompletion({
      content: '\t \n',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      tool: {
        name: 'getAvailableSlots',
        args: {
          date: '2026-08-14',
          serviceId: ROTEIROS_IDS.service.drenagem,
          professionalId: ROTEIROS_IDS.professional.carla,
        },
      },
    });
  }
  if (behavior === 'R5_UNKNOWN' && repetition === 2) {
    observedVariants.add('schema_echo_recovered');
    return syntheticCompletion({
      content: JSON.stringify({
        contract: 'FlatModelTurnV2',
        type: 'object',
        properties: {
          reply: { type: 'string' },
          nextPending: { type: 'string' },
          chosenOptionText: { type: ['string', 'null'] },
          unknownServiceText: { type: ['string', 'null'] },
        },
        required: [
          'reply',
          'nextPending',
          'chosenOptionText',
          'unknownServiceText',
        ],
      }),
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R9_FRIDAY_MORNING') {
    if (repetition === 2) {
      return syntheticCompletion({
        content: JSON.stringify({
          ...flatMockResult(mockModelResult(behavior, data), data),
          nextPending: 'INVENTED',
        }),
        ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      });
    }
    if (repetition === 3) {
      return syntheticCompletion({
        content: JSON.stringify({
          ...flatMockResult(mockModelResult(behavior, data), data),
          extra: 'campo-proibido',
        }),
        ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
      });
    }
    return syntheticCompletion({
      content:
        'Perfeito: sexta-feira pela manhã. Vou considerar esse período para o Peeling facial.',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R4_DRAINAGE_TYPO' && repetition === 3) {
    observedVariants.add('boundary_rejection_captured');
    const rejected = mockModelResult(behavior, data);
    const structured = mockStructuredOutput(
      flatMockResult(
        { ...rejected, reply: 'Fazemos drenagem a vapor.' },
        data
      ),
      repetition
    );
    return syntheticCompletion({
      content: structured.raw,
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R4_DRAINAGE_TYPO' && repetition === 2) {
    const faithful = mockModelResult(behavior, data);
    const structured = mockStructuredOutput(
      flatMockResult(
        {
          ...faithful,
          reply:
            'Boa tarde! Sim, fazemos drenagem linfática, que dura 50 minutos e custa R$ 160,00. Gostaria de agendar?',
        },
        data
      ),
      repetition
    );
    return syntheticCompletion({
      content: structured.raw,
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R10_SATURDAY' && repetition === 1) {
    observedVariants.add('safe_primary_prose_preserve');
    if (elicitation === 'v3') {
      observedVariants.add('v3_safe_prose_happy_path');
    }
    return syntheticCompletion({
      content: 'Sim, atendemos aos sábados. Qual serviço você procura?',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  if (behavior === 'R10_SATURDAY' && repetition === 2) {
    return syntheticCompletion({
      content: 'Seu horário está confirmado.',
      ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
    });
  }
  const structured = mockStructuredOutput(
    flatMockResult(mockModelResult(behavior, data), data),
    repetition
  );
  structured.variants.forEach((variant) => observedVariants.add(variant));
  return syntheticCompletion({
    content: structured.raw,
    ...(thinking ? { reasoningContent: MOCK_REASONING_SENTINEL } : {}),
  });
}

function mockSocialReply(step: RoteiroStep): string {
  if (step.mockBehavior === 'R6_GREETING') {
    return 'Oi, boa tarde! Que bom falar com você 😊';
  }
  if (step.mockBehavior === 'R7_THANKS') {
    return 'Imagina! Adorei conversar com você.';
  }
  return 'Obrigada! Estou por aqui 😊';
}

function buildArmConfig(options: CliOptions) {
  const config = buildRoteirosConfig();
  if (options.provider === 'openai') {
    config.aiProvider = 'openai';
    config.aiModel = 'gpt-4o-mini';
    config.openaiApiKey = null;
  }
  if (options.provider === 'luna') {
    config.aiProvider = 'luna';
    config.aiModel = 'gpt-5.6-luna';
    config.openaiApiKey = null;
  }
  if (options.thinking) config.aiMaxTokens = 8_192;
  return config;
}

function createSession(
  ctx: RunContext,
  scenarioId: string,
  repetition: number,
  suffix = 'main'
): ScenarioSession {
  const store = new ctx.runtime.MemoryConversationalV2StateStore();
  const suffixCode = [...suffix].reduce(
    (sum, char) => (sum + char.codePointAt(0)!) % 100,
    0
  );
  const phone = `+5511999${scenarioId.slice(1).padStart(2, '0')}${String(
    repetition
  ).padStart(2, '0')}${String(suffixCode).padStart(2, '0')}`;
  const config = buildRoteirosConfig();
  const fixture = createRoteirosFixtureHarness();
  return {
    scenarioId,
    repetition,
    phone,
    conversationKey: ctx.runtime.buildConversationKey(config.phoneNumberId, phone),
    store,
    history: [],
    sequence: 0,
    idSequence: 0,
    transportPayloads: [],
    fixtureState: fixture.state,
    executeTool: fixture.execute,
    activeStep: null,
    now: new Date(ROTEIROS_FIXED_NOW),
    humanFork: null,
    priorStepPayloads: new Map(),
    parseFailures: [],
    modelOutputs: [],
    boundaryRejections: [],
  };
}

function nextId(session: ScenarioSession, prefix: string): string {
  session.idSequence += 1;
  return `${prefix}-${session.scenarioId}-${session.repetition}-${session.idSequence}`;
}

function seedServiceQuestion(
  session: ScenarioSession,
  freshness: 'fresh' | 'stale'
): void {
  const askedAt = new Date(
    session.now.getTime() -
      (freshness === 'fresh' ? 60_000 : 25 * 60 * 60 * 1_000)
  );
  const flowId = nextId(session, 'seed-flow');
  session.store.pending.set(session.conversationKey, [
    {
      conversationKey: session.conversationKey,
      state: 'OPEN',
      snapshot: {
        questionId: nextId(session, 'seed-question'),
        askedAt: askedAt.toISOString(),
        kind: 'SERVICE',
        flowId,
        version: 1,
        options: ROTEIROS_SERVICES.services!.map((service, index) => ({
          position: index + 1,
          entityId: service.id,
          displayName: service.name,
        })),
      },
      flowState: { flowId, fixedByProofVersion: {} },
      updatedAt: askedAt.toISOString(),
    },
  ]);
  session.history.push({
    role: 'assistant',
    content:
      'Temos Drenagem linfática, Limpeza de pele profunda e Peeling facial. Qual opção você prefere?',
    createdAt: askedAt.toISOString(),
  });
}

function forkSessionFromHumanSnapshot(
  ctx: RunContext,
  source: ScenarioSession
): ScenarioSession {
  if (!source.humanFork) {
    throw new Error('R10.5 sem snapshot do takeover humano.');
  }
  const fork = createSession(ctx, source.scenarioId, source.repetition, 'fork');
  fork.history = clone(source.humanFork.history);
  fork.sequence = source.humanFork.sequence;
  fork.now = new Date(source.humanFork.nowMs);
  fork.priorStepPayloads = new Map(source.priorStepPayloads);
  fork.parseFailures = [...source.parseFailures];
  fork.modelOutputs = [...source.modelOutputs];
  fork.boundaryRejections = [...source.boundaryRejections];
  return fork;
}

function currentPendingRecord(state: Awaited<ReturnType<MemoryConversationalV2StateStore['loadLatestState']>>) {
  return state.pending
    ? {
        state: state.pending.state,
        snapshot: state.pending.snapshot,
        flowState: state.pending.flowState,
      }
    : null;
}

async function trackedCompletion(
  ctx: RunContext,
  session: ScenarioSession,
  kind: ProviderCallMetric['kind'],
  complete: () => Promise<OpenAI.Chat.Completions.ChatCompletion>
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const step = session.activeStep!;
  const startedAt = Date.now();
  const response = await complete();
  const metric = metricFromCompletion(
    response,
    Date.now() - startedAt,
    kind,
    session.scenarioId,
    step.id,
    session.repetition,
    kind === 'resume_thinking' ? 'deepseek' : ctx.options.provider
  );
  ctx.calls.push(metric);
  return response;
}

async function resolveTurnControlForStep(
  ctx: RunContext,
  session: ScenarioSession,
  step: RoteiroStep
): Promise<{ control: { disposition: 'HUMAN_ACTIVE' | 'RESUME_APPROVED' | 'NO_ACTIVE_TAKEOVER'; resumeDecision: 'RESUME_ANA' | 'KEEP_HUMAN' | 'NONE' }; classifier: unknown }> {
  if (step.mockBehavior === 'R10_ACK_SILENCE') {
    return {
      control: { disposition: 'HUMAN_ACTIVE', resumeDecision: 'KEEP_HUMAN' },
      classifier: { decision: 'KEEP_HUMAN', source: 'active_takeover' },
    };
  }
  if (
    step.mockBehavior !== 'R10_RESUME_CLEANING' &&
    step.mockBehavior !== 'R10_CONTINUATION_SILENCE'
  ) {
    return {
      control: { disposition: 'NO_ACTIVE_TAKEOVER', resumeDecision: 'NONE' },
      classifier: null,
    };
  }
  const expectedResume = step.mockBehavior === 'R10_RESUME_CLEANING';
  const classification = await ctx.runtime.classifyAnaResume(
    {
      history: session.history,
      config: buildRoteirosConfig(),
      customerName: 'Aline Sintética',
    },
    {
      now: Date.now,
      complete: async (messages) => {
        if (ctx.options.mode === 'mock') {
          const startedAt = Date.now();
          const raw = expectedResume
            ? '{"decision":"RESUME_ANA","reasonCode":"NEW_INDEPENDENT_REQUEST"}'
            : '{"decision":"KEEP_HUMAN","reasonCode":"HUMAN_CONVERSATION_CONTINUES"}';
          // O chefe do R10 é Thinking nos dois braços.
          const completion = syntheticCompletion({
            content: raw,
            reasoningContent: MOCK_REASONING_SENTINEL,
          });
          const metric = metricFromCompletion(
            completion,
            Date.now() - startedAt,
            'resume_thinking',
            session.scenarioId,
            step.id,
            session.repetition,
            'deepseek'
          );
          ctx.calls.push(metric);
          return raw;
        }
        const completion = await trackedCompletion(
          ctx,
          session,
          'resume_thinking',
          () =>
            ctx.runtime.createAnaResumeClassifierCompletion(
              ctx.runtime.resolveAnaResumeClassifierRuntime(),
              { messages }
            )
        );
        return completion.choices[0]?.message?.content ?? '';
      },
    }
  );
  return {
    control:
      classification.decision === 'RESUME_ANA'
        ? { disposition: 'RESUME_APPROVED', resumeDecision: 'RESUME_ANA' }
        : { disposition: 'HUMAN_ACTIVE', resumeDecision: 'KEEP_HUMAN' },
    classifier: classification,
  };
}

function pass(id: string, ok: boolean, reason: string): MatrixCheck {
  return { id, status: ok ? 'PASS' : 'FAIL', reason };
}

function review(id: string, reason: string): MatrixCheck {
  return { id, status: 'REVIEW', reason };
}

function includesOperationalSpontaneous(payload: string): boolean {
  return /\b(?:R\$|hor[aá]rio|agenda|servi[cç]o|profissional|endere[cç]o|pagamento|dura[cç][aã]o|minutos?|atendemos|funcionamento)\b/iu.test(
    payload
  );
}

function normalizeHarnessText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('pt-BR');
}

function hasConcreteOperationalInsistence(payload: string): boolean {
  const normalized = normalizeHarnessText(payload);
  if (mentionedFixtureTimes(payload).length > 0) return true;
  if (/\bque\s+tal\b/u.test(normalized)) return true;
  const operationalQuestion =
    /\?/u.test(payload) &&
    /\b(?:agend|marc|horario|vaga|dia|data|servico|procedimento|profissional|prefere)\w*\b/u.test(
      normalized
    );
  const bareRequestion =
    /^(?:qual|quais|que\s+dia|voce\s+prefere|quer\s+(?:agendar|marcar))\b/u.test(
      normalized.trim()
    );
  return operationalQuestion || bareRequestion;
}

function hasNewOperationalContentBeyondPending(
  payload: string,
  pendingBefore: any
): boolean {
  const normalized = normalizeHarnessText(payload);
  if (
    mentionedFixtureTimes(payload).length > 0 ||
    /(?:R\$|\b(?:preco|valor|custa|pagamento|pix|cartao|duracao|minutos?|endereco|funcionamento|atendemos|temos?\s+(?:vaga|horario)|disponibilidade)\b)/iu.test(
      payload
    )
  ) {
    return true;
  }
  const allowedIds = new Set(
    (pendingBefore?.snapshot?.options ?? []).map(
      (option: { entityId?: string }) => option.entityId
    )
  );
  return (ROTEIROS_SERVICES.services ?? []).some((service) => {
    const name = normalizeHarnessText(service.name);
    return normalized.includes(name) && !allowedIds.has(service.id);
  });
}

function assertPostMatrixHarnessFixtures(): void {
  if (
    hasConcreteOperationalInsistence(
      'Quando quiser, é só me chamar que eu verifico os horários.'
    ) ||
    !hasConcreteOperationalInsistence('Que tal sexta às 15h?') ||
    !hasConcreteOperationalInsistence('Qual horário você prefere?')
  ) {
    throw new Error('Fixture R8.2 do predicado de insistência concreta falhou.');
  }
  const servicePending = {
    snapshot: {
      kind: 'SERVICE',
      options: (ROTEIROS_SERVICES.services ?? []).map((service) => ({
        entityId: service.id,
        displayName: service.name,
      })),
    },
  };
  if (
    hasNewOperationalContentBeyondPending(
      'Que bom que gostou! Qual serviço você prefere: Drenagem linfática, Limpeza de pele profunda ou Peeling facial?',
      servicePending
    ) ||
    !hasNewOperationalContentBeyondPending('A Limpeza custa R$ 180,00.', servicePending) ||
    !hasNewOperationalContentBeyondPending('Temos horário às 15h.', servicePending)
  ) {
    throw new Error('Fixture R6.3 do eco de pendência aberta falhou.');
  }
}

function mentionedFixtureTimes(payload: string): string[] {
  const values = new Set<string>();
  const regex = /\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)?\b/giu;
  for (const match of payload.matchAll(regex)) {
    if (!match[2] && !match[3] && !/h/iu.test(match[0])) continue;
    const hour = String(Number(match[1])).padStart(2, '0');
    const minute = (match[2] ?? match[3] ?? '00').padStart(2, '0');
    values.add(`${hour}:${minute}`);
  }
  return [...values];
}

function deterministicChecks(input: {
  session: ScenarioSession;
  step: RoteiroStep;
  prepared: PreparedReceptionistTurnV2 | null;
  deliveryResult: Awaited<ReturnType<RunContext['runtime']['deliverPreparedReceptionistTurnV2']>> | null;
  response: string | null;
  outboundCount: number;
  pendingBefore: any;
  pendingAfter: any;
  toolCalls: RoteirosToolCall[];
  reconciliation: any;
  classifier: any;
}): MatrixCheck[] {
  const {
    session,
    step,
    prepared,
    deliveryResult,
    response,
    outboundCount,
    pendingBefore,
    pendingAfter,
    toolCalls,
    reconciliation,
    classifier,
  } = input;
  const payload = response ?? '';
  const shouldSilence =
    step.kind === 'human_echo' ||
    step.mockBehavior === 'R10_ACK_SILENCE' ||
    step.mockBehavior === 'R10_CONTINUATION_SILENCE';
  const checks: MatrixCheck[] = [
    pass(
      'outbound_cardinality',
      outboundCount === (shouldSilence ? 0 : 1),
      shouldSilence
        ? 'turno silencioso sem transporte'
        : 'um único payload aceito pelo transporte fake'
    ),
  ];
  if (step.kind === 'human_echo') {
    checks.push(
      pass(
        'human_echo_prefix',
        session.history.some(
          (entry) =>
            entry.role === 'assistant' &&
            entry.content.startsWith(session.activeStep ? '[atendente] ' : '__never__')
        ),
        'echo sintético persistido com HUMAN_ECHO_PREFIX'
      )
    );
    return checks;
  }
  if (!prepared || !deliveryResult) {
    checks.push(pass('prepared_turn', false, 'turno não chegou à rota v2'));
    return checks;
  }
  const accepted = !shouldSilence;
  const finalBoundary = prepared.planReceipt.boundaryAttempts.at(-1);
  const outboxForTurn = [...session.store.outbox.values()].filter(
    (entry) => entry.turnId === prepared.frame.turnId
  );
  checks.push(
    pass('route_registered', ALLOWED_ROUTES.has(prepared.planReceipt.route), `rota ${prepared.planReceipt.route}`),
    pass(
      'receipt_reconciliation',
      reconciliation?.ok === true &&
        reconciliation.planCount === 1 &&
        reconciliation.deliveryCount === 1,
      'reconciliação plano×entrega 1:1'
    ),
    pass(
      'delivery_receipt',
      accepted
        ? deliveryResult.receipt.transportOutcome === 'accepted_by_provider'
        : deliveryResult.receipt.transportOutcome === 'suppressed_pause',
      `transporte terminal ${deliveryResult.receipt.transportOutcome}`
    ),
    pass(
      'outbox_state',
      accepted
        ? outboxForTurn.length === 1 &&
            outboxForTurn[0]?.state === 'accepted_by_provider'
        : outboxForTurn.length === 0,
      accepted ? 'outbox aceito e commitado' : 'silêncio sem outbox preparado'
    ),
    pass(
      'nonempty_policy',
      accepted ? Boolean(payload.trim()) : !payload,
      accepted ? 'payload aceito não vazio' : 'payload vazio no silêncio'
    ),
    pass(
      'accepted_boundary',
      !accepted || !finalBoundary || finalBoundary.reasonCodes.length === 0,
      'nenhuma violação de boundary foi enviada'
    ),
    pass(
      'no_internal_markers',
      !/(?:INTERNAL_HINT|\[atendente\]|rv2-(?:svc|prof|appointment)|fixture-ana-v2)/u.test(
        payload
      ),
      'payload sem marker/ID técnico'
    ),
    pass(
      'no_reasoning_content',
      !payload.includes(MOCK_REASONING_SENTINEL) &&
        !/reasoning_content/iu.test(payload),
      'reasoning_content nunca atravessou para o payload'
    ),
    pass(
      'pending_transition_coherent',
      !accepted ||
        (prepared.transition.kind === 'open'
          ? deliveryResult.receipt.pendingCommitOutcome === 'opened'
          : prepared.transition.kind === 'resolve'
            ? deliveryResult.receipt.pendingCommitOutcome === 'resolved'
            : prepared.transition.kind === 'invalidate'
              ? deliveryResult.receipt.pendingCommitOutcome === 'invalidated'
              : ['preserved', 'not_applicable'].includes(
                  deliveryResult.receipt.pendingCommitOutcome
                )),
      `transição ${prepared.transition.kind} reconciliada com ${deliveryResult.receipt.pendingCommitOutcome}`
    )
  );
  if (OPERATIONAL_PROGRESS_STEP_IDS.has(step.id)) {
    checks.push(
      pass(
        'operational_progress_route',
        prepared.planReceipt.route !== 'fallback' &&
          prepared.planReceipt.route !== 'preempted' &&
          prepared.planReceipt.recoveryKind !== 'direct_fallback' &&
          prepared.preemption === null,
        `progresso operacional pela rota ${prepared.planReceipt.route}, sem fallback/preempção`
      )
    );
  }

  const writeWords = /\b(?:confirmad[oa]|agendad[oa]|marcad[oa])\b/iu.test(payload);
  const successfulBook = toolCalls.some(
    (entry) => entry.name === 'bookAppointment' && entry.result.success === true
  );
  checks.push(
    pass(
      'write_claim_grounding',
      !writeWords || successfulBook,
      writeWords
        ? 'claim de agendamento licenciado por bookAppointment success:true no turno'
        : 'sem claim prematuro de escrita'
    )
  );

  switch (step.id) {
    case 'R1.1':
      checks.push(pass('stale_pending_reopened', pendingBefore === null || pendingBefore?.state !== 'OPEN', 'pendência >24h não foi reutilizada'));
      break;
    case 'R1.2':
    case 'R1.3':
      checks.push(pass('no_dry_denial', !payload.includes(OLD_DRY_DENIAL), 'frase canônica v1 proibida ausente'));
      break;
    case 'R2.2':
      checks.push(
        pass('fast_path', prepared.planReceipt.route === 'fast_path', 'ordinal resolvido no fast-path exato'),
        pass('fixed_cleaning', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.limpeza, 'flowState fixou Limpeza'),
        pass('no_service_relist', !(payload.includes('Drenagem') && payload.includes('Peeling')), 'não relistou catálogo após escolha')
      );
      break;
    case 'R2.3':
      checks.push(
        pass('slots_read', toolCalls.some((entry) => entry.name === 'getAvailableSlots' && entry.result.success === true), 'slots vieram da tool fixture'),
        pass('fixture_slots_only', mentionedFixtureTimes(payload).every((time) => ALL_ROTEIROS_SLOTS.includes(time)), 'horários enviados pertencem ao fixture'),
        pass('time_pending', pendingAfter?.snapshot?.kind === 'TIME', 'slots abriram pendência TIME')
      );
      break;
    case 'R2.4':
      checks.push(
        pass('validated_time_fast_path', prepared.planReceipt.route === 'fast_path', 'horário escolhido resolveu pelo PendingFrame TIME'),
        pass('confirmation_pending', pendingAfter?.snapshot?.kind === 'CONFIRMATION', 'resumo abriu pendência CONFIRMATION'),
        pass(
          'booking_draft_from_slot_evidence',
          pendingAfter?.flowState?.bookingDraft?.serviceId === ROTEIROS_IDS.service.limpeza &&
            pendingAfter?.flowState?.bookingDraft?.professionalId === ROTEIROS_IDS.professional.carla &&
            pendingAfter?.flowState?.bookingDraft?.date === '2026-08-13' &&
            pendingAfter?.flowState?.bookingDraft?.time === '15:00' &&
            pendingAfter?.flowState?.bookingDraft?.slotEvidenceTurnId ===
              pendingAfter?.flowState?.slotEvidence?.turnId,
          'BookingDraftV2 foi derivado da opção TIME e da evidência de slots'
        ),
        pass(
          'complete_booking_summary',
          /Limpeza de pele profunda/iu.test(payload) &&
            /\b15h|15:00\b/iu.test(payload) &&
            /Carla(?:\s+Mendes)?/iu.test(payload),
          'resumo contém serviço, horário e profissional da fixture'
        )
      );
      break;
    case 'R2.5':
      checks.push(
        pass('book_success', successfulBook, 'bookAppointment success:true no trace'),
        pass('write_effect_receipt', prepared.planReceipt.toolEffects.some((entry) => entry.tool === 'bookAppointment' && entry.writeCommitted), 'recibo registrou write commitado'),
        pass('confirmation_closed', pendingAfter?.state !== 'OPEN', 'write concluído fechou a pendência CONFIRMATION')
      );
      break;
    case 'R3.1':
      checks.push(pass('partial_cleaning_fixed', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.limpeza, 'nome parcial fixou Limpeza'));
      break;
    case 'R3.2':
      checks.push(pass('weekday_not_service', pendingAfter?.flowState?.fixedServiceId !== ROTEIROS_IDS.service.limpeza, 'segunda nua não fixou a segunda opção'));
      break;
    case 'R4.1':
      checks.push(
        review(
          'semantic:typo_drainage_state',
          pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.drenagem
            ? 'pergunta informacional com typo também fixou Drenagem; revisar continuidade'
            : 'fixação de serviço não é requisito determinístico para responder à pergunta informacional; revisar continuidade'
        )
      );
      break;
    case 'R4.2':
      checks.push(pass('partial_peeling_fixed', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.peeling, 'token peeling fixou Peeling'));
      break;
    case 'R4.3': {
      const money = payload.match(/R\$\s*\d+(?:[.,]\d{2})?/g) ?? [];
      checks.push(
        pass('cleaning_price', money.length === 1 && /R\$\s*180(?:[.,]00)?/.test(money[0]!), 'preço fixture de Limpeza sem outro valor'),
        review(
          'semantic:price_service_state',
          pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.limpeza
            ? 'consulta de preço também fixou Limpeza; revisar naturalidade'
            : 'fixação de serviço não é requisito determinístico para responder preço; revisar continuidade humana'
        )
      );
      break;
    }
    case 'R5.1':
    case 'R5.2':
      checks.push(
        pass('unknown_not_offered', !/(?:fazemos|temos|oferecemos).{0,35}(?:botox|micropigmenta)/iu.test(payload), 'não ofertou serviço fora do catálogo'),
        pass('unknown_reply_not_suppressed', Boolean(payload.trim()), 'negação licenciada foi enviada'),
        pass('no_dry_denial', !payload.includes(OLD_DRY_DENIAL), 'template seco v1 ausente')
      );
      break;
    case 'R6.3':
      checks.push(
        pass('pending_preserved', pendingBefore?.snapshot?.questionId === pendingAfter?.snapshot?.questionId && pendingBefore?.snapshot?.version === pendingAfter?.snapshot?.version, 'elogio preservou pergunta operacional'),
        pass('no_spontaneous_operations', !hasNewOperationalContentBeyondPending(payload, pendingBefore), 'permitiu apenas eco da pendência OPEN, sem fato operacional novo'),
        pass('social_boundary_zero', !finalBoundary || finalBoundary.reasonCodes.length === 0, 'boundary social aceito sem reasons')
      );
      break;
    case 'R6.4':
      checks.push(pass('first_option_still_anchored', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.drenagem, 'primeira opção resolveu Drenagem após social'));
      break;
    case 'R7.1':
    case 'R7.2': {
      const otherId = step.id === 'R7.1' ? 'R7.2' : 'R7.1';
      const other = session.priorStepPayloads.get(otherId);
      checks.push(
        pass('no_dry_social_template', !/^(?:Que legal!|Entendi!|Certo!|Tudo bem!)$/u.test(payload.trim()), 'sem template social seco'),
        pass('no_spontaneous_operations', !includesOperationalSpontaneous(payload), 'social sem fato operacional'),
        pass('no_identical_repeat', !other || other.trim() !== payload.trim(), 'respostas dos dois passos não são idênticas')
      );
      break;
    }
    case 'R8.1':
      checks.push(
        pass('mixed_turn_acknowledged', /obrigad/iu.test(payload), 'acolheu o agradecimento'),
        pass('mixed_turn_slots_read', toolCalls.some((entry) => entry.name === 'getAvailableSlots' && entry.result.success === true), 'consultou slots fixture'),
        pass('fixture_slots_only', mentionedFixtureTimes(payload).every((time) => ALL_ROTEIROS_SLOTS.includes(time)), 'não enviou horário fora do fixture')
      );
      break;
    case 'R8.2':
      checks.push(pass('no_operational_insistence', !hasConcreteOperationalInsistence(payload), 'não ofereceu horário concreto nem re-perguntou agendamento'));
      break;
    case 'R9.1':
      checks.push(
        pass('batch_supersession_single_outbound', outboundCount === 1, 'lote de duas bolhas gerou um outbound'),
        pass('final_service_peeling', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.peeling, 'última correção fixou Peeling')
      );
      break;
    case 'R9.2':
      checks.push(
        pass('batch_single_outbound', outboundCount === 1, 'lote de três bolhas gerou um outbound'),
        pass('peeling_still_fixed', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.peeling, 'consolidação preservou Peeling')
      );
      break;
    case 'R10.3':
    case 'R10.5':
      checks.push(
        pass('human_active_silence', prepared.frame.humanControl === 'HUMAN_ACTIVE' && deliveryResult.receipt.transportOutcome === 'suppressed_pause', 'HUMAN_ACTIVE suprimiu a entrega'),
        pass('classifier_keep_human', classifier?.decision === 'KEEP_HUMAN', 'chefe manteve conversa humana')
      );
      break;
    case 'R10.4':
      checks.push(
        pass('classifier_resume', classifier?.decision === 'RESUME_ANA', 'chefe autorizou novo pedido independente'),
        pass('resume_fixed_cleaning', pendingAfter?.flowState?.fixedServiceId === ROTEIROS_IDS.service.limpeza, 'retomada fixou Limpeza')
      );
      break;
  }
  return checks;
}

async function runHumanEcho(
  session: ScenarioSession,
  step: RoteiroStep
): Promise<StepRun> {
  const startedAt = Date.now();
  const beforeTransport = session.transportPayloads.length;
  const content = `${'[atendente] '}${step.messages[0] ?? ''}`;
  session.history.push({
    role: 'assistant',
    content,
    createdAt: session.now.toISOString(),
  });
  await session.store.invalidateOpenPendingByHuman(session.conversationKey, session.now);
  session.humanFork = {
    history: clone(session.history),
    sequence: session.sequence,
    nowMs: session.now.getTime(),
  };
  const checks = deterministicChecks({
    session,
    step,
    prepared: null,
    deliveryResult: null,
    response: null,
    outboundCount: session.transportPayloads.length - beforeTransport,
    pendingBefore: null,
    pendingAfter: null,
    toolCalls: [],
    reconciliation: null,
    classifier: null,
  });
  for (const item of step.review ?? []) checks.push(review(`semantic:${item}`, item));
  return {
    scenarioId: session.scenarioId,
    scenarioTitle: ANA_V2_ROTEIROS.find((entry) => entry.id === session.scenarioId)!.title,
    stepId: step.id,
    stepLabel: step.label,
    repetition: session.repetition,
    mode: 'mock',
    inputMessages: [...step.messages],
    response: null,
    route: 'human_echo',
    preemption: 'HUMAN_ACTIVE',
    delivery: null,
    deliveryReceipt: null,
    planReceipt: null,
    frame: null,
    transition: null,
    pendingBefore: null,
    pendingAfter: null,
    toolCalls: [],
    outboundCount: 0,
    receiptReconciliation: null,
    classifier: null,
    turnLatencyMs: Date.now() - startedAt,
    providerCalls: [],
    parseFailures: [],
    modelOutputs: [],
    boundaryRejections: [],
    checks,
  };
}

async function runCustomerTurn(
  ctx: RunContext,
  session: ScenarioSession,
  scenario: RoteiroScenario,
  step: RoteiroStep
): Promise<StepRun> {
  session.activeStep = step;
  if (step.id === 'R10.4' || step.id === 'R10.5') {
    session.now = new Date(ROTEIROS_FIXED_NOW.getTime() + 25 * 60 * 60 * 1_000);
  } else {
    session.now = new Date(
      ROTEIROS_FIXED_NOW.getTime() +
        (Number(step.id.split('.')[1] ?? 1) - 1) * 5 * 60_000
    );
  }
  const startedAt = Date.now();
  const callStart = ctx.calls.length;
  const parseFailureStart = session.parseFailures.length;
  const modelOutputStart = session.modelOutputs.length;
  const boundaryRejectionStart = session.boundaryRejections.length;
  const toolStart = session.fixtureState.calls.length;
  const outboundStart = session.transportPayloads.length;
  const pendingBeforeState = await session.store.loadLatestState(
    session.conversationKey,
    session.now
  );
  const pendingBefore = currentPendingRecord(pendingBeforeState);
  session.sequence += step.messages.length;
  const inboundIds = step.messages.map(() => nextId(session, 'inbound'));
  const inboundTextsById = Object.fromEntries(
    inboundIds.map((id, index) => [id, step.messages[index]!])
  );
  step.messages.forEach((content, index) => {
    session.history.push({
      role: 'user',
      content,
      createdAt: new Date(session.now.getTime() + index * 100).toISOString(),
    });
  });
  session.store.setInputSequence(session.conversationKey, session.sequence);
  if (step.id === 'R10.3' && session.humanFork) {
    session.humanFork = {
      history: clone(session.history),
      sequence: session.sequence,
      nowMs: session.now.getTime(),
    };
  }
  const turnControl = await resolveTurnControlForStep(ctx, session, step);
  const config = buildArmConfig(ctx.options);
  let brainLoopInvocation = 0;
  const runModelLoop: typeof ctx.runtime.runReceptionistModelLoop = async (input) => {
    brainLoopInvocation += 1;
    const currentLoopInvocation = brainLoopInvocation;
    const completionAttemptsByRound = new Map<number, number>();
    const result = await ctx.runtime.runReceptionistModelLoop({
      ...input,
      retryOnFailure: false,
      completionFactory: async ({ round, messages, responseFormat, tools }) => {
        const expectedResponseFormat =
          ctx.options.elicitation === 'v1' ? 'json_object' : undefined;
        if (responseFormat !== expectedResponseFormat) {
          throw new Error(
            `Brain v2 ${ctx.options.elicitation}: response_format=${responseFormat ?? 'ausente'}, esperado=${expectedResponseFormat ?? 'ausente'}.`
          );
        }
        const completionAttempt =
          (completionAttemptsByRound.get(round) ?? 0) + 1;
        completionAttemptsByRound.set(round, completionAttempt);
        if (ctx.options.mode === 'mock') {
          if (
            ctx.options.thinking &&
            round > 1 &&
            messages.some((message) => message.role === 'tool') &&
            !messages.some(
              (message) =>
                message.role === 'assistant' &&
                (message as unknown as { reasoning_content?: unknown })
                  .reasoning_content === MOCK_REASONING_SENTINEL
            )
          ) {
            throw new Error('reasoning_content não foi preservado no replay pós-tool.');
          }
          const started = Date.now();
          const completion = mockCompletionForBehavior(
            step.mockBehavior,
            step.id,
            round,
            messages,
            ctx.options.thinking,
            session.repetition,
            currentLoopInvocation,
            completionAttempt,
            ctx.options.elicitation,
            ctx.mockUnwrapVariants
          );
          completion.model =
            ctx.options.provider === 'luna'
              ? 'gpt-5.6-luna-mock'
              : ctx.options.provider === 'openai'
                ? 'gpt-4o-mini-mock'
                : 'deepseek-v4-flash-mock';
          ctx.calls.push(
            metricFromCompletion(
              completion,
              Date.now() - started,
              'brain',
              session.scenarioId,
              step.id,
              session.repetition,
              ctx.options.provider
            )
          );
          recordModelOutput(session, {
            stage: 'primary',
            loopInvocation: currentLoopInvocation,
            round,
            completionAttempt,
            responseFormat: responseFormat ?? null,
            completion,
          });
          return completion;
        }
        const completion = await trackedCompletion(ctx, session, 'brain', () =>
          ctx.runtime.createReceptionistChatCompletion(
            ctx.runtime.resolveReceptionistAiRuntime(config),
            {
              messages,
              tools,
              temperature: config.aiTemperature,
              maxTokens: config.aiMaxTokens,
              userId: input.userId,
              thinkingMode: ctx.options.thinking ? 'enabled' : 'disabled',
              ...(responseFormat ? { responseFormat } : {}),
            }
          )
        );
        recordModelOutput(session, {
          stage: 'primary',
          loopInvocation: currentLoopInvocation,
          round,
          completionAttempt,
          responseFormat: responseFormat ?? null,
          completion,
        });
        return completion;
      },
      thinkingMode: ctx.options.thinking ? 'enabled' : 'disabled',
    });
    if (result.terminalFailure === 'AI_RESPONSE_TRUNCATED') {
      recordParseFailure(session, {
        stage: 'primary',
        codes: ['TRUNCATED_OUTPUT'],
        rawRejectedOutput: result.rawReply ?? '',
        finishReason: 'length',
      });
    } else if (result.rawReply !== null) {
      const parsed = ctx.runtime.parseModelTurnResultV2(
        result.rawReply,
        validationContextFromPrompt(input.messages, session.now)
      );
      if (!parsed.ok) {
        recordParseFailure(session, {
          stage: 'primary',
          codes: parsed.issues.map((issue) => issue.code),
          rawRejectedOutput: result.rawReply,
          finishReason: result.usage.at(-1)?.finishReason ?? null,
        });
      }
    }
    return result;
  };

  const runInterpreter: typeof ctx.runtime.interpretPowerZeroV2 = async (input) =>
    ctx.runtime.interpretPowerZeroV2({
      ...input,
      completionFactory: async (completionInput) => {
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        if (ctx.options.mode === 'mock') {
          const started = Date.now();
          completion = syntheticCompletion({
            content: JSON.stringify({ choice: 'NENHUMA' }),
          });
          completion.model =
            ctx.options.provider === 'luna'
              ? 'gpt-5.6-luna-mock'
              : ctx.options.provider === 'openai'
                ? 'gpt-4o-mini-mock'
                : 'deepseek-v4-flash-mock';
          ctx.calls.push(
            metricFromCompletion(
              completion,
              Date.now() - started,
              'interpreter',
              session.scenarioId,
              step.id,
              session.repetition,
              ctx.options.provider
            )
          );
        } else {
          completion = await trackedCompletion(ctx, session, 'interpreter', () =>
            ctx.runtime.createReceptionistChatCompletion(
              ctx.runtime.resolveReceptionistAiRuntime(config),
              {
                messages: completionInput.messages,
                tools: [],
                temperature: 0,
                maxTokens: 160,
                thinkingMode: 'disabled',
                responseFormat: 'json_object',
                timeoutMs: completionInput.timeoutMs,
              }
            )
          );
        }
        recordModelOutput(session, {
          stage: 'interpreter',
          loopInvocation: null,
          round: 1,
          completionAttempt: 1,
          responseFormat: 'json_object',
          completion,
        });
        return completion;
      },
    });

  const composeSocial: typeof ctx.runtime.composeSocialReplyV2 = (input) =>
    ctx.runtime.composeSocialReplyV2({
      ...input,
      completionFactory: async (completionInput) => {
        if (ctx.options.mode === 'mock') {
          const started = Date.now();
          const completion = syntheticCompletion({
            content: mockSocialReply(step),
            ...(ctx.options.thinking
              ? { reasoningContent: MOCK_REASONING_SENTINEL }
              : {}),
          });
          completion.model =
            ctx.options.provider === 'luna'
              ? 'gpt-5.6-luna-mock'
              : ctx.options.provider === 'openai'
                ? 'gpt-4o-mini-mock'
                : 'deepseek-v4-flash-mock';
          ctx.calls.push(
            metricFromCompletion(
              completion,
              Date.now() - started,
              'social',
              session.scenarioId,
              step.id,
              session.repetition,
              ctx.options.provider
            )
          );
          recordModelOutput(session, {
            stage: 'social',
            loopInvocation: null,
            round: null,
            completionAttempt: 1,
            responseFormat: null,
            completion,
          });
          return completion;
        }
        const completion = await trackedCompletion(ctx, session, 'social', () =>
          ctx.runtime.createReceptionistChatCompletion(
            ctx.runtime.resolveReceptionistAiRuntime(config),
            completionInput
          )
        );
        recordModelOutput(session, {
          stage: 'social',
          loopInvocation: null,
          round: null,
          completionAttempt: 1,
          responseFormat: null,
          completion,
        });
        return completion;
      },
      thinkingMode: ctx.options.thinking ? 'enabled' : 'disabled',
      maxTokens: ctx.options.thinking ? 4_096 : undefined,
    });

  const regenerate = async (
    reasonCodes: any,
    input: any
  ): Promise<any> => {
    let rawFinal = '';
    let finishReason: string | null = null;
    const regenerated = await ctx.runtime.regenerateReceptionistCopyV2({
      config: input.config,
      snapshot: {
        frame: input.frame,
        catalogSnapshot: {
          services: input.services.services ?? [],
          professionals: input.services.professionals ?? [],
        },
        messages: input.messages,
        rejectedCandidate: input.rejectedCandidate,
      },
      reasonCodes,
      validationContext: input.validationContext,
      useJsonObjectResponseFormat: input.useJsonObjectResponseFormat,
      thinkingMode: ctx.options.thinking ? 'enabled' : 'disabled',
      maxTokens: ctx.options.thinking ? 8_192 : undefined,
      completionFactory: async (completionInput) => {
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        if (ctx.options.mode === 'mock') {
          const data = {
            turnFrame: input.frame,
            currentInbounds: input.frame.currentInboundIds.map(
              (inboundId: string) => ({
                inboundId,
                text: input.validationContext.inboundTextsById[inboundId] ?? '',
              })
            ),
          };
          const structured = mockStructuredOutput(
            flatMockResult(
              mockRegeneratedModelResult(step.mockBehavior, data),
              data
            ),
            session.repetition
          );
          structured.variants.forEach((variant) =>
            ctx.mockUnwrapVariants.add(variant)
          );
          const emptyAfterTools =
            step.id === 'R5.2' && session.repetition === 1;
          const safeProseAfterRejectedPrimary =
            step.id === 'R10.1' && session.repetition === 2;
          if (emptyAfterTools) {
            const expectedRegenResponseFormat =
              ctx.options.elicitation === 'v1'
                ? undefined
                : 'json_object';
            if (
              completionInput.responseFormat !== expectedRegenResponseFormat
            ) {
              throw new Error(
                `R5.2 ${ctx.options.elicitation}: response_format da regen=${completionInput.responseFormat ?? 'ausente'}, esperado=${expectedRegenResponseFormat ?? 'ausente'}.`
              );
            }
            ctx.mockUnwrapVariants.add(
              ctx.options.elicitation === 'v1'
                ? 'empty_tools_regen_without_json_object'
                : 'empty_tools_regen_with_json_object'
            );
          }
          if (safeProseAfterRejectedPrimary) {
            ctx.mockUnwrapVariants.add('safe_regen_prose_preserve');
          }
          completion = syntheticCompletion({
            content: safeProseAfterRejectedPrimary
              ? 'Sim, atendemos aos sábados. Qual serviço você procura?'
              : emptyAfterTools
              ? `Saída final:\n\`\`\`json\n${JSON.stringify(
                  flatMockResult(
                    mockRegeneratedModelResult(step.mockBehavior, data),
                    data
                  )
                )}\n\`\`\``
              : structured.raw,
            ...(ctx.options.thinking
              ? { reasoningContent: MOCK_REASONING_SENTINEL }
              : {}),
          });
          completion.model =
            ctx.options.provider === 'luna'
              ? 'gpt-5.6-luna-mock'
              : ctx.options.provider === 'openai'
                ? 'gpt-4o-mini-mock'
                : 'deepseek-v4-flash-mock';
          ctx.calls.push(
            metricFromCompletion(
              completion,
              0,
              'regen',
              session.scenarioId,
              step.id,
              session.repetition,
              ctx.options.provider
            )
          );
        } else {
          completion = await trackedCompletion(ctx, session, 'regen', () =>
            ctx.runtime.createReceptionistChatCompletion(
              ctx.runtime.resolveReceptionistAiRuntime(config),
              completionInput
            )
          );
        }
        rawFinal =
          typeof completion.choices[0]?.message?.content === 'string'
            ? completion.choices[0]!.message.content
            : '';
        finishReason = completion.choices[0]?.finish_reason ?? null;
        recordModelOutput(session, {
          stage: 'regen',
          loopInvocation: null,
          round: null,
          completionAttempt: 1,
          responseFormat: completionInput.responseFormat ?? null,
          completion,
        });
        return completion;
      },
    });
    if (
      !regenerated.ok &&
      regenerated.reasonCode === 'REGEN_MODEL_RESULT_INVALID'
    ) {
      recordParseFailure(session, {
        stage: 'regen',
        codes:
          regenerated.validationIssues?.map((issue) => issue.code) ?? [
            'INVALID_JSON',
          ],
        rawRejectedOutput: rawFinal,
        finishReason,
      });
    }
    return regenerated;
  };

  const prepared = await ctx.runtime.getReceptionistReplyV2({
    phone: session.phone,
    userMessage: step.messages.join(' '),
    userName: 'Cliente sintética',
    config,
    elicitationVariant: ctx.options.elicitation,
    thinkingMode: ctx.options.thinking ? 'enabled' : 'disabled',
    interpreterEnabled: ctx.options.interpreter,
    turnControl: turnControl.control,
    turnRuntime: {
      turnId: nextId(session, 'turn'),
      inputSequence: session.sequence,
      currentInboundIds: inboundIds,
      currentInboundTextsById: inboundTextsById,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: session.sequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: session.store,
      now: () => new Date(session.now),
      id: () => nextId(session, 'runtime'),
      loadServices: async () => clone(ROTEIROS_SERVICES),
      loadHistory: async () =>
        session.history.map(({ role, content }) => ({ role, content })),
      isPaused: async () => false,
      runModelLoop,
      interpreterEnabled: ctx.options.interpreter,
      runInterpreter,
      executeTool: session.executeTool,
      composeSocial,
      regenerate,
      onRejectedBoundaryCandidate: (rejection) => {
        session.boundaryRejections.push({
          stage: rejection.stage,
          rawRejectedOutput: rejection.candidate,
          reasonCodes: [...rejection.reasonCodes],
        });
      },
    },
  });

  const deliveryResult = await ctx.runtime.deliverPreparedReceptionistTurnV2(
    prepared,
    {
      store: session.store,
      now: () => new Date(session.now),
      id: () => nextId(session, 'delivery'),
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: session.sequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async (payload) => {
        session.transportPayloads.push(payload);
        return { providerMessageId: nextId(session, 'wamid-synthetic') };
      },
    }
  );
  const response =
    deliveryResult.receipt.transportOutcome === 'accepted_by_provider'
      ? prepared.payload
      : null;
  if (response) {
    session.history.push({
      role: 'assistant',
      content: response,
      createdAt: new Date(session.now.getTime() + 1_000).toISOString(),
    });
    session.priorStepPayloads.set(step.id, response);
  }
  const pendingAfterState = await session.store.loadLatestState(
    session.conversationKey,
    session.now
  );
  const pendingAfter = currentPendingRecord(pendingAfterState);
  const reconciliation = await session.store.verifyReceiptReconciliation([
    prepared.frame.turnId,
  ]);
  const toolCalls = clone(session.fixtureState.calls.slice(toolStart));
  const outboundCount = session.transportPayloads.length - outboundStart;
  const checks = deterministicChecks({
    session,
    step,
    prepared,
    deliveryResult,
    response,
    outboundCount,
    pendingBefore,
    pendingAfter,
    toolCalls,
    reconciliation,
    classifier: turnControl.classifier,
  });
  for (const item of step.review ?? []) checks.push(review(`semantic:${item}`, item));
  const providerCalls = clone(ctx.calls.slice(callStart));
  const parseFailures = clone(session.parseFailures.slice(parseFailureStart));
  const modelOutputs = clone(session.modelOutputs.slice(modelOutputStart));
  const boundaryRejections = clone(
    session.boundaryRejections.slice(boundaryRejectionStart)
  );
  const harnessPlanReceipt = planReceiptForHarness(
    prepared.planReceipt,
    boundaryRejections
  );
  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    stepId: step.id,
    stepLabel: step.label,
    repetition: session.repetition,
    mode: ctx.options.mode,
    inputMessages: [...step.messages],
    response,
    route: prepared.planReceipt.route,
    preemption: prepared.preemption,
    delivery: deliveryResult.delivery,
    deliveryReceipt: deliveryResult.receipt,
    planReceipt: harnessPlanReceipt,
    frame: prepared.frame,
    transition: prepared.transition,
    pendingBefore,
    pendingAfter,
    toolCalls,
    outboundCount,
    receiptReconciliation: reconciliation,
    classifier: turnControl.classifier,
    turnLatencyMs: Date.now() - startedAt,
    providerCalls,
    parseFailures,
    modelOutputs,
    boundaryRejections,
    checks,
  };
}

async function runScenarioRepeat(
  ctx: RunContext,
  scenario: RoteiroScenario,
  repetition: number
): Promise<StepRun[]> {
  let session = createSession(ctx, scenario.id, repetition);
  const results: StepRun[] = [];
  for (const step of scenario.steps) {
    if (step.forkFromHumanTakeover) {
      session = forkSessionFromHumanSnapshot(ctx, session);
    } else if (step.newConversation) {
      session = createSession(ctx, scenario.id, repetition, step.id);
    }
    session.activeStep = step;
    if (step.seedServiceQuestion) {
      seedServiceQuestion(session, step.seedServiceQuestion);
    }
    if (step.kind === 'human_echo') {
      const result = await runHumanEcho(session, step);
      result.mode = ctx.options.mode;
      results.push(result);
    } else {
      results.push(await runCustomerTurn(ctx, session, scenario, step));
    }
  }
  return results;
}

function summarizeSteps(runs: readonly StepRun[]): ReportStepSummary[] {
  const groups = new Map<string, StepRun[]>();
  for (const run of runs) {
    const group = groups.get(run.stepId) ?? [];
    group.push(run);
    groups.set(run.stepId, group);
  }
  return [...groups.values()].map((group) => {
    const failed = group.filter((run) =>
      run.checks.some((check) => check.status === 'FAIL')
    );
    const reviewItems = [
      ...new Set(
        group.flatMap((run) =>
          run.checks
            .filter((check) => check.status === 'REVIEW')
            .map((check) => check.reason)
        )
      ),
    ];
    const status: CheckStatus = failed.length
      ? 'FAIL'
      : reviewItems.length
        ? 'REVIEW'
        : 'PASS';
    const failures = [
      ...new Set(
        failed.flatMap((run) =>
          run.checks
            .filter((check) => check.status === 'FAIL')
            .map((check) => check.id)
        )
      ),
    ];
    return {
      scenarioId: group[0]!.scenarioId,
      scenarioTitle: group[0]!.scenarioTitle,
      stepId: group[0]!.stepId,
      stepLabel: group[0]!.stepLabel,
      status,
      reason: failed.length
        ? `Falhou: ${failures.join(', ')}`
        : reviewItems.length
          ? `Determinístico aprovado; revisão humana: ${reviewItems.join('; ')}`
          : 'Todas as asserções determinísticas passaram.',
      repetitions: group.length,
      failedRepetitions: failed.map((run) => run.repetition),
      reviewItems,
    };
  });
}

function parseFailureCounts(
  runs: readonly StepRun[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of runs.flatMap((run) => run.parseFailures)) {
    for (const code of failure.codes) {
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function boundaryRejectionCounts(
  runs: readonly StepRun[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rejection of runs.flatMap((run) => run.boundaryRejections)) {
    for (const code of rejection.reasonCodes) {
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function markdownReport(input: {
  startedAt: string;
  finishedAt: string;
  options: CliOptions;
  summaries: ReportStepSummary[];
  runs: StepRun[];
  calls: ProviderCallMetric[];
}): string {
  const turnLatencies = input.runs.map((run) => run.turnLatencyMs);
  const callLatencies = input.calls.map((call) => call.durationMs);
  const cost = input.calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
  const tokens = input.calls.reduce(
    (totals, call) => ({
      prompt: totals.prompt + call.promptTokens,
      completion: totals.completion + call.completionTokens,
      reasoning: totals.reasoning + (call.reasoningTokens ?? 0),
      total: totals.total + call.totalTokens,
    }),
    { prompt: 0, completion: 0, reasoning: 0, total: 0 }
  );
  const parseCodes = parseFailureCounts(input.runs);
  const parseFailureTotal = input.runs.reduce(
    (total, run) => total + run.parseFailures.length,
    0
  );
  const rejectedBoundaryTotal = input.runs.reduce(
    (total, run) => total + run.boundaryRejections.length,
    0
  );
  const rejectedBoundaryCodes = boundaryRejectionCounts(input.runs);
  const rows = input.summaries
    .map(
      (step) =>
        `| ${step.scenarioId} | ${step.stepId} | ${step.status} | ${step.reason.replace(/\|/g, '\\|')} |`
    )
    .join('\n');
  return `# Matriz comportamental Ana v2 — roteiros aprovados

- Início: ${input.startedAt}
- Fim: ${input.finishedAt}
- Provider: ${input.options.mode === 'mock' ? `mock offline (${input.options.provider})` : `${input.options.provider} real`}
- Braço: ${
    input.options.provider === 'openai'
      ? 'gpt-4o-mini'
      : input.options.provider === 'luna'
        ? 'Luna Responses'
        : input.options.thinking
          ? 'Thinking enabled'
          : 'Flash non-thinking'
  }
- Elicitação: ${input.options.elicitation}
- Intérprete poder-zero: ${input.options.interpreter ? 'on' : 'off'}
- Repetições: ${input.options.repeats}
- Chamadas: ${input.calls.length}
- Tokens: prompt ${tokens.prompt} · completion ${tokens.completion} · reasoning ${tokens.reasoning} · total ${tokens.total}
- Custo estimado: US$ ${cost.toFixed(6)}
- Latência por chamada: p50 ${percentile(callLatencies, 0.5)} ms · p95 ${percentile(callLatencies, 0.95)} ms
- Latência por turno: p50 ${percentile(turnLatencies, 0.5)} ms · p95 ${percentile(turnLatencies, 0.95)} ms
- Saídas finais rejeitadas por parse/truncamento: ${parseFailureTotal}
- Códigos de falha de parse: ${Object.keys(parseCodes).length > 0 ? Object.entries(parseCodes).map(([code, count]) => `${code}=${count}`).join(' · ') : 'nenhum'}
- Candidatos rejeitados pela boundary: ${rejectedBoundaryTotal}
- Reasons de rejeição boundary: ${Object.keys(rejectedBoundaryCodes).length > 0 ? Object.entries(rejectedBoundaryCodes).map(([code, count]) => `${code}=${count}`).join(' · ') : 'nenhum'}

| Roteiro | Passo | Status | Motivo |
| --- | --- | --- | --- |
${rows}

## Convenção

- PASS: todas as asserções determinísticas passaram em todas as repetições.
- FAIL: ao menos uma repetição falhou em uma asserção determinística.
- REVIEW: determinístico aprovado; o item é genuinamente semântico e requer leitura humana da resposta registrada no JSON.
`;
}

function scenarioStatuses(
  summaries: readonly ReportStepSummary[]
): Map<string, CheckStatus> {
  const result = new Map<string, CheckStatus>();
  for (const summary of summaries) {
    const current = result.get(summary.scenarioId);
    const next =
      current === 'FAIL' || summary.status === 'FAIL'
        ? 'FAIL'
        : current === 'REVIEW' || summary.status === 'REVIEW'
          ? 'REVIEW'
          : 'PASS';
    result.set(summary.scenarioId, next);
  }
  return result;
}

function comparativeMarkdown(flash: any, thinking: any): string {
  const flashStatuses = scenarioStatuses(flash.summaries);
  const thinkingStatuses = scenarioStatuses(thinking.summaries);
  const ids = [
    ...new Set([
      ...flash.selectedScenarioIds,
      ...thinking.selectedScenarioIds,
    ]),
  ];
  const rows = ids
    .map(
      (id) =>
        `| ${id} | ${flashStatuses.get(id) ?? '—'} | ${thinkingStatuses.get(id) ?? '—'} |`
    )
    .join('\n');
  const metricRows = [
    ['Chamadas', flash.metrics.calls, thinking.metrics.calls],
    ['Latência chamada p50 (ms)', flash.metrics.callLatencyMs.p50, thinking.metrics.callLatencyMs.p50],
    ['Latência chamada p95 (ms)', flash.metrics.callLatencyMs.p95, thinking.metrics.callLatencyMs.p95],
    ['Latência turno p50 (ms)', flash.metrics.turnLatencyMs.p50, thinking.metrics.turnLatencyMs.p50],
    ['Latência turno p95 (ms)', flash.metrics.turnLatencyMs.p95, thinking.metrics.turnLatencyMs.p95],
    ['Prompt tokens', flash.metrics.tokens.prompt, thinking.metrics.tokens.prompt],
    ['Completion tokens', flash.metrics.tokens.completion, thinking.metrics.tokens.completion],
    ['Reasoning tokens', flash.metrics.tokens.reasoning, thinking.metrics.tokens.reasoning],
    ['Total tokens', flash.metrics.tokens.total, thinking.metrics.tokens.total],
    ['Custo estimado (US$)', flash.metrics.estimatedCostUsd.toFixed(6), thinking.metrics.estimatedCostUsd.toFixed(6)],
    ['Saídas rejeitadas por parse', flash.metrics.parseFailures?.total ?? 0, thinking.metrics.parseFailures?.total ?? 0],
  ]
    .map(([metric, left, right]) => `| ${metric} | ${left} | ${right} |`)
    .join('\n');
  return `# Comparativo Ana v2 — Flash × Thinking

- Provider: ${flash.mode === 'mock' ? 'mock offline' : 'DeepSeek real'}
- Elicitação: ${flash.elicitationVariant}
- Repetições por braço: ${flash.repeats}
- Flash: ${flash.startedAt}
- Thinking: ${thinking.startedAt}

| Roteiro | Flash | Thinking |
| --- | --- | --- |
${rows}

| Métrica | Flash | Thinking |
| --- | ---: | ---: |
${metricRows}
`;
}

async function findComparableArmReport(
  parentDir: string,
  arm: 'flash' | 'thinking',
  current: any
): Promise<any | null> {
  const entries = await readdir(parentDir, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith(
          `-${arm}-interpreter-${current.interpreterEnabled ? 'on' : 'off'}`
        )
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(parentDir, candidate, 'raw.json'), 'utf8')
      );
      if (
        parsed.mode === current.mode &&
        (parsed.provider ?? 'deepseek') === current.provider &&
        parsed.schemaVersion === current.schemaVersion &&
        parsed.repeats === current.repeats &&
        parsed.elicitationVariant === current.elicitationVariant &&
        parsed.interpreterEnabled === current.interpreterEnabled &&
        JSON.stringify(parsed.selectedScenarioIds) ===
          JSON.stringify(current.selectedScenarioIds)
      ) {
        return parsed;
      }
    } catch {
      // Artefato parcial/antigo não participa do par A/B.
    }
  }
  return null;
}

async function loadRuntime(): Promise<RunContext['runtime']> {
  const [
    stateStore,
    runtime,
    delivery,
    brain,
    social,
    regenerator,
    provider,
    classifier,
    flags,
    contextManager,
    interpreter,
  ] = await Promise.all([
    import('../src/services/conversationalV2/stateStore'),
    import('../src/services/conversationalV2/runtime'),
    import('../src/services/conversationalV2/delivery'),
    import('../src/services/brainService'),
    import('../src/services/conversationalV2/social'),
    import('../src/services/conversationalV2/regenerator'),
    import('../src/services/receptionistLlmProvider'),
    import('../src/services/anaResumeClassifier'),
    import('../src/services/conversationalV2/featureFlag'),
    import('../src/services/contextManager'),
    import('../src/services/conversationalV2/powerZeroInterpreter'),
  ]);
  return {
    MemoryConversationalV2StateStore: stateStore.MemoryConversationalV2StateStore,
    getReceptionistReplyV2: runtime.getReceptionistReplyV2,
    deliverPreparedReceptionistTurnV2: delivery.deliverPreparedReceptionistTurnV2,
    runReceptionistModelLoop: brain.runReceptionistModelLoop,
    RECEPTIONIST_TOOLS: brain.RECEPTIONIST_TOOLS,
    composeSocialReplyV2: social.composeSocialReplyV2,
    regenerateReceptionistCopyV2: regenerator.regenerateReceptionistCopyV2,
    createReceptionistChatCompletion: provider.createReceptionistChatCompletion,
    createAnaResumeClassifierCompletion: provider.createAnaResumeClassifierCompletion,
    resolveReceptionistAiRuntime: provider.resolveReceptionistAiRuntime,
    resolveAnaResumeClassifierRuntime: provider.resolveAnaResumeClassifierRuntime,
    classifyAnaResume: classifier.classifyAnaResume,
    isAnaConversationalV2Enabled: flags.isAnaConversationalV2Enabled,
    HUMAN_ECHO_PREFIX: contextManager.HUMAN_ECHO_PREFIX,
    buildConversationKey: contextManager.buildConversationKey,
    parseModelTurnResultV2: (
      await import('../src/services/conversationalV2/modelResultParser')
    ).parseModelTurnResultV2,
    interpretPowerZeroV2: interpreter.interpretPowerZeroV2,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertPostMatrixHarnessFixtures();
  neutralizeEnvironment(options);
  const runtime = await loadRuntime();
  if (!runtime.isAnaConversationalV2Enabled(ROTEIROS_TENANT_SLUG)) {
    throw new Error('Flag v2 não ficou ligada para o tenant fixture.');
  }
  const selected = ANA_V2_ROTEIROS.filter(
    (scenario) => !options.scenarioIds || options.scenarioIds.has(scenario.id)
  );
  if (options.mode === 'real') {
    runtime.resolveReceptionistAiRuntime(buildArmConfig(options));
    if (selected.some((scenario) => scenario.id === 'R10')) {
      runtime.resolveAnaResumeClassifierRuntime();
    }
  }
  const startedAt = new Date().toISOString();
  const ctx: RunContext = {
    options,
    runtime,
    calls: [],
    mockUnwrapVariants: new Set(),
  };
  const runs: StepRun[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (!first.startsWith('[ana-conversational-v2')) originalInfo(...args);
  };
  try {
    for (const scenario of selected) {
      for (let repetition = 1; repetition <= options.repeats; repetition += 1) {
        if (
          options.maxCostUsd !== null &&
          ctx.calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0) >=
            options.maxCostUsd
        ) {
          throw new Error('Teto --max-cost-usd atingido antes da próxima repetição.');
        }
        runs.push(...(await runScenarioRepeat(ctx, scenario, repetition)));
      }
    }
  } finally {
    console.info = originalInfo;
  }
  const summaries = summarizeSteps(runs);
  // As meta-provas de variantes pertencem à matriz inteira. `--ids` continua
  // útil para sondas focadas sem fingir que um subconjunto exerceu cenários
  // que deliberadamente não foram selecionados.
  if (options.mode === 'mock' && selected.length === ANA_V2_ROTEIROS.length) {
    const expectedVariants = new Set<MockUnwrapVariant>(['plain_json']);
    expectedVariants.add('safe_primary_prose_preserve');
    // A confirmação inequívoca com CONFIRMATION OPEN é executada pelo
    // fast-path server-owned. Portanto o turno de write não chama mais o
    // provider para produzir uma prosa pós-tool; a confirmação canônica é
    // coberta pelo smoke E2E da rota.
    if (options.repeats >= 2) {
      expectedVariants.add('markdown_fence');
      expectedVariants.add('schema_echo_recovered');
      expectedVariants.add('safe_regen_prose_preserve');
    }
    if (options.repeats >= 3) {
      expectedVariants.add('residual_prose');
      expectedVariants.add('contract_marker');
      expectedVariants.add('boundary_rejection_captured');
    }
    if (options.elicitation === 'v4') {
      expectedVariants.add('empty_same_round_retried');
    } else {
      expectedVariants.add('empty_zero_tools_reinvoked');
      expectedVariants.add(
        options.elicitation === 'v1'
          ? 'empty_tools_regen_without_json_object'
          : 'empty_tools_regen_with_json_object'
      );
    }
    if (options.elicitation === 'v3') {
      expectedVariants.add('v3_safe_prose_happy_path');
    }
    for (const variant of expectedVariants) {
      if (!ctx.mockUnwrapVariants.has(variant)) {
        throw new Error(`Mock não exercitou desembrulho ${variant}.`);
      }
    }
    if (options.repeats >= 3) {
      const boundaryProbe = runs.find(
        (run) => run.stepId === 'R4.1' && run.repetition === 3
      );
      const rejection = boundaryProbe?.boundaryRejections.find(
        (entry) =>
          entry.stage === 'primary' &&
          entry.rawRejectedOutput === 'Fazemos drenagem a vapor.'
      );
      if (!rejection?.reasonCodes.includes('UNKNOWN_SERVICE_OFFER')) {
        throw new Error(
          'Mock não persistiu candidato boundary rejeitado com texto/reason.'
        );
      }
      const planAttempts = (
        boundaryProbe?.planReceipt as {
          boundaryAttempts?: HarnessBoundaryAttemptArtifact[];
        } | undefined
      )?.boundaryAttempts ?? [];
      const capturedAttempt = planAttempts.find(
        (attempt) =>
          attempt.rejectionStage === 'primary' &&
          attempt.rejectedCandidateText === 'Fazemos drenagem a vapor.' &&
          Array.isArray(attempt.reasonCodes) &&
          attempt.reasonCodes.includes('UNKNOWN_SERVICE_OFFER')
      );
      if (!capturedAttempt) {
        throw new Error(
          'Mock não projetou rejectedCandidateText no plan receipt do harness.'
        );
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const timestamp = startedAt.replace(/[:.]/g, '-');
  const arm = options.provider === 'openai'
    ? 'gpt-4o-mini'
    : options.provider === 'luna'
      ? 'luna'
      : options.thinking
      ? 'thinking'
      : 'flash';
  const outputParent = path.resolve(
    process.cwd(),
    'benchmark-results',
    'ana-v2-roteiros'
  );
  const outputDir = path.join(
    outputParent,
    `${timestamp}-${options.elicitation}-${arm}-interpreter-${options.interpreter ? 'on' : 'off'}`
  );
  await mkdir(outputDir, { recursive: true });
  const callLatencies = ctx.calls.map((call) => call.durationMs);
  const turnLatencies = runs.map((run) => run.turnLatencyMs);
  const cost = ctx.calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
  const tokens = ctx.calls.reduce(
    (totals, call) => ({
      prompt: totals.prompt + call.promptTokens,
      completion: totals.completion + call.completionTokens,
      reasoning: totals.reasoning + (call.reasoningTokens ?? 0),
      total: totals.total + call.totalTokens,
    }),
    { prompt: 0, completion: 0, reasoning: 0, total: 0 }
  );
  if (
    options.mode === 'mock' &&
    options.thinking &&
    ctx.calls.some((call) => call.kind !== 'resume_thinking') &&
    !ctx.calls.some(
      (call) => call.kind !== 'resume_thinking' && (call.reasoningTokens ?? 0) > 0
    )
  ) {
    throw new Error('Mock Thinking não comprovou reasoning tokens nas chamadas v2.');
  }
  const rawReport = {
    schemaVersion: 2,
    harness: 'ana-v2-roteiros',
    startedAt,
    finishedAt,
    mode: options.mode,
    provider: options.provider,
    arm,
    elicitationVariant: options.elicitation,
    interpreterEnabled: options.interpreter,
    thinkingMode: options.thinking ? 'enabled' : 'disabled',
    repeats: options.repeats,
    selectedScenarioIds: selected.map((scenario) => scenario.id),
    syntheticFixture: true,
    pricingUsdPerMillionTokens: PRICE_PER_MILLION[options.provider],
    ...(options.mode === 'mock'
      ? { mockUnwrapVariants: [...ctx.mockUnwrapVariants].sort() }
      : {}),
    metrics: {
      calls: ctx.calls.length,
      turns: runs.length,
      estimatedCostUsd: cost,
      tokens,
      callLatencyMs: {
        p50: percentile(callLatencies, 0.5),
        p95: percentile(callLatencies, 0.95),
      },
      turnLatencyMs: {
        p50: percentile(turnLatencies, 0.5),
        p95: percentile(turnLatencies, 0.95),
      },
      parseFailures: {
        total: runs.reduce(
          (total, run) => total + run.parseFailures.length,
          0
        ),
        byCode: parseFailureCounts(runs),
      },
      boundaryRejections: {
        total: runs.reduce(
          (total, run) => total + run.boundaryRejections.length,
          0
        ),
        byCode: boundaryRejectionCounts(runs),
      },
    },
    summaries,
    providerCalls: ctx.calls,
    runs,
  };
  const serializedRaw = `${JSON.stringify(rawReport, null, 2)}\n`;
  if (
    serializedRaw.includes(MOCK_REASONING_SENTINEL) ||
    /"reasoning_content"/iu.test(serializedRaw)
  ) {
    throw new Error('reasoning_content vazou para o artefato bruto.');
  }
  await writeFile(
    path.join(outputDir, 'raw.json'),
    serializedRaw,
    'utf8'
  );
  const oppositeArm = arm === 'flash' ? 'thinking' : 'flash';
  const counterpart = options.provider === 'deepseek'
    ? await findComparableArmReport(
        outputParent,
        oppositeArm,
        rawReport
      )
    : null;
  let comparisonPath: string | null = null;
  if (counterpart) {
    const flash = arm === 'flash' ? rawReport : counterpart;
    const thinking = arm === 'thinking' ? rawReport : counterpart;
    const comparison = comparativeMarkdown(flash, thinking);
    comparisonPath = path.join(outputParent, `comparison-${timestamp}.md`);
    await writeFile(comparisonPath, comparison, 'utf8');
    await writeFile(path.join(outputDir, 'comparison.md'), comparison, 'utf8');
  }
  await writeFile(
    path.join(outputDir, 'summary.md'),
    markdownReport({ startedAt, finishedAt, options, summaries, runs, calls: ctx.calls }),
    'utf8'
  );
  const failures = summaries.filter((entry) => entry.status === 'FAIL');
  console.log(`Artefatos: ${outputDir}`);
  if (comparisonPath) console.log(`Comparativo: ${comparisonPath}`);
  console.log(
    `Passos: ${summaries.length} | FAIL: ${failures.length} | REVIEW: ${summaries.filter((entry) => entry.status === 'REVIEW').length} | chamadas: ${ctx.calls.length} | custo estimado: US$ ${cost.toFixed(6)}`
  );
  if (failures.length) {
    for (const failure of failures) {
      console.error(`${failure.stepId}: ${failure.reason}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `Harness ana-v2-roteiros falhou: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 2;
});
