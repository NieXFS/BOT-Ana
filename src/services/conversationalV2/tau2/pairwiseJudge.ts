import type OpenAI from 'openai';
import type { TenantBotConfig } from '../../../configProvider';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
  assertDeepSeekProductionApproved,
  buildLunaResponsesRequest,
  buildReceptionistCompletionRequest,
  createReceptionistChatCompletion,
  type ReceptionistAiProvider,
  type ReceptionistAiRuntime,
  type ReceptionistAiTransport,
  type ReceptionistCompletionInput,
} from '../../receptionistLlmProvider';
import { isVoiceCopyIdV2 } from '../voice/registry';
import type { VoiceCopyIdV2 } from '../voice/types';
import { recommendedVoiceBaselineV2, voicePairingIsValidV2 } from './pairing';
import {
  PairwiseToneAskFailedV2,
  TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
  assertToneJudgePanelV2,
  evaluatePairwiseToneV2,
  type Tau2PairwiseJudgeSpecV2,
  type Tau2PairwiseSideV2,
  type Tau2PairwiseToneItemV2,
  type Tau2PairwiseToneReportV2,
} from './pairwiseTone';
import { tau2ArmProviderSpecV2 } from './real';
import { TAU2_ARM_VECTORS, type Tau2ArmId } from './types';

export const TAU2_PAIRWISE_JUDGE_PROVIDER_ENV_V2 =
  'ANA_V2_TAU2_JUDGE_PROVIDER';
export const TAU2_PAIRWISE_JUDGE_MODEL_ENV_V2 = 'ANA_V2_TAU2_JUDGE_MODEL';
export const TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2 = 64;
export const TAU2_PAIRWISE_JUDGE_TIMEOUT_MS_V2 = 15_000;

const BLOCKED_JUDGE_MODEL_RE = /mock/i;

export type Tau2PairwiseToneStatusV2 = 'judged' | 'not_run';

export type Tau2PairwiseJudgeSkipReasonV2 =
  | 'mock_harness'
  | 'missing_credential'
  | 'self_judge'
  | 'no_available_judge'
  | 'blocked_model'
  | 'judge_call_failed';

export interface Tau2PairwiseArmTurnV2 {
  readonly taskId: string;
  readonly armId: Tau2ArmId;
  readonly trialId: number;
  readonly turnIndex: number;
  readonly payload: string;
  readonly copyId: VoiceCopyIdV2 | null;
}

export interface Tau2PairwiseJudgeCallReceiptV2 {
  readonly itemId: string;
  readonly judgeId: string;
  readonly order: 'ab' | 'ba';
  readonly provider: string;
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface Tau2PairwiseToneCostV2 {
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface Tau2PairwiseToneHarnessReportV2
  extends Tau2PairwiseToneReportV2 {
  readonly status: Tau2PairwiseToneStatusV2;
  readonly reason: Tau2PairwiseJudgeSkipReasonV2 | null;
  readonly inconclusive: boolean;
  readonly nPairedItems: number;
  readonly generatorModels: readonly string[];
  readonly receipts: readonly Tau2PairwiseJudgeCallReceiptV2[];
  readonly cost: Tau2PairwiseToneCostV2;
  /** Provider tentado; presente também em `not_run`. Nunca uma credencial. */
  readonly attemptedProvider: string | null;
  /** Modelo tentado; presente também em `not_run`. Nunca uma credencial. */
  readonly attemptedModel: string | null;
  /** Detalhe scrubbed de 4xx/5xx/timeout. Null fora de `judge_call_failed`. */
  readonly judgeError: string | null;
}

export type Tau2PairwiseJudgeCompletionFactoryV2 = (input: {
  judge: Tau2PairwiseJudgeSpecV2;
  left: string;
  right: string;
  order: 'ab' | 'ba';
  itemId: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  completionInput: ReceptionistCompletionInput;
  resolvedApiKey: string | null;
  /** Runtime exato que o adapter real receberia; null só em factory sem credencial. */
  runtime: ReceptionistAiRuntime | null;
  /** Config correspondente; prova que `openaiApiKey` recebeu a resolução do gate. */
  runtimeConfig: TenantBotConfig | null;
  runtimeProvider: ReceptionistAiProvider;
  runtimeTransport: ReceptionistAiTransport;
}) => Promise<OpenAI.Chat.Completions.ChatCompletion>;

export function isBlockedTau2JudgeModelV2(
  model: string | null | undefined
): boolean {
  const value = model?.trim() ?? '';
  return value.length > 0 && BLOCKED_JUDGE_MODEL_RE.test(value);
}

export function assertTau2RealJudgeReceiptV2(input: {
  requestedModel: string;
  returnedModel?: string | null;
}): void {
  if (isBlockedTau2JudgeModelV2(input.requestedModel)) {
    throw new Error(
      `juiz pairwise real rejeitado (requestedModel=${input.requestedModel})`
    );
  }
  if (isBlockedTau2JudgeModelV2(input.returnedModel)) {
    throw new Error(
      `juiz pairwise real rejeitado (returnedModel=${input.returnedModel})`
    );
  }
}

export function generatorModelsForVoicePairV2(
  baselineArm: Tau2ArmId = recommendedVoiceBaselineV2().baseline,
  voicedArm: Tau2ArmId = recommendedVoiceBaselineV2().voiced
): string[] {
  const models = [
    tau2ArmProviderSpecV2(baselineArm).requestedModel,
    tau2ArmProviderSpecV2(voicedArm).requestedModel,
  ];
  return [...new Set(models)];
}

export function defaultPairwiseJudgeSpecV2(
  generatorModels: readonly string[]
): Tau2PairwiseJudgeSpecV2 | null {
  const generators = new Set(
    generatorModels.map((model) => model.trim().toLowerCase()).filter(Boolean)
  );
  const luna = OPENAI_LUNA_MODEL.toLowerCase();
  const flash = DEEPSEEK_V4_FLASH_MODEL.toLowerCase();
  if (!generators.has(luna)) {
    return {
      id: 'luna',
      provider: 'luna',
      model: OPENAI_LUNA_MODEL,
    };
  }
  if (!generators.has(flash)) {
    return {
      id: 'flash',
      provider: 'deepseek',
      model: DEEPSEEK_V4_FLASH_MODEL,
    };
  }
  return null;
}

export function pairVoiceArmTurnsForToneV2(input: {
  turns: readonly Tau2PairwiseArmTurnV2[];
  baselineArm: Tau2ArmId;
  voicedArm: Tau2ArmId;
  catalog: {
    readonly services: readonly string[];
    readonly professionals: readonly string[];
  };
}): Tau2PairwiseToneItemV2[] {
  if (
    !voicePairingIsValidV2(
      TAU2_ARM_VECTORS[input.baselineArm],
      TAU2_ARM_VECTORS[input.voicedArm]
    )
  ) {
    throw new Error(
      `pareamento de voz τ² inválido para o juiz pairwise (${input.baselineArm} vs ${input.voicedArm})`
    );
  }
  const baselineByKey = new Map<string, Tau2PairwiseArmTurnV2>();
  for (const turn of input.turns) {
    if (turn.armId !== input.baselineArm) continue;
    baselineByKey.set(
      `${turn.taskId}\0${turn.trialId}\0${turn.turnIndex}`,
      turn
    );
  }
  const items: Tau2PairwiseToneItemV2[] = [];
  for (const turn of input.turns) {
    if (turn.armId !== input.voicedArm) continue;
    const copyId = turn.copyId;
    if (!copyId || !isVoiceCopyIdV2(copyId)) continue;
    const baseline = baselineByKey.get(
      `${turn.taskId}\0${turn.trialId}\0${turn.turnIndex}`
    );
    if (!baseline?.payload.trim() || !turn.payload.trim()) continue;
    items.push({
      id: `${turn.taskId}:${turn.trialId}:${copyId}:${turn.turnIndex}`,
      copyId,
      template: baseline.payload,
      variant: turn.payload,
      catalog: {
        services: [...input.catalog.services],
        professionals: [...input.catalog.professionals],
      },
    });
  }
  return items;
}

const FIXTURE_LLM_CREDENTIAL_RE =
  /(?:smoke|fixture|no-network|mock-provider|mock-luna)/i;
const HARNESS_OPENAI_KEY_PREFIX_RE =
  /^sk-(?:smoke|fixture|mock|luna-smoke)/i;
const LIVE_OPENAI_PROJECT_KEY_RE = /^sk-proj-[A-Za-z0-9_-]+$/i;
const LIVE_OPENAI_SECRET_KEY_RE = /^sk-[A-Za-z0-9_-]+$/i;

/** Project keys in the wild are ~164 chars; never treat the random payload as fixture. */
export const LIVE_OPENAI_PROJECT_KEY_MIN_LENGTH_V2 = 80;
const LIVE_OPENAI_SECRET_KEY_MIN_LENGTH_V2 = 48;

export function isLiveOpenAiCredentialShapeV2(
  value: string | null | undefined
): boolean {
  const key = value?.trim() ?? '';
  if (!key) return false;
  if (
    LIVE_OPENAI_PROJECT_KEY_RE.test(key) &&
    key.length >= LIVE_OPENAI_PROJECT_KEY_MIN_LENGTH_V2
  ) {
    return true;
  }
  return (
    LIVE_OPENAI_SECRET_KEY_RE.test(key) &&
    key.length >= LIVE_OPENAI_SECRET_KEY_MIN_LENGTH_V2 &&
    !HARNESS_OPENAI_KEY_PREFIX_RE.test(key)
  );
}

export function isFixtureLlmCredentialV2(
  value: string | null | undefined
): boolean {
  const key = value?.trim() ?? '';
  if (!key) return false;
  if (isLiveOpenAiCredentialShapeV2(key)) return false;
  return FIXTURE_LLM_CREDENTIAL_RE.test(key);
}

export function liveLlmCredentialV2(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? '';
    if (trimmed && !isFixtureLlmCredentialV2(trimmed)) return trimmed;
  }
  return null;
}

export function scrubFixtureLlmCredentialsFromEnvV2(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_API_KEY_LUNA',
    'DEEPSEEK_API_KEY',
  ] as const) {
    if (isFixtureLlmCredentialV2(env[key])) delete env[key];
  }
}

function readEnvCredentialV2(
  env: NodeJS.Dict<string> | NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const direct = env[key];
  if (typeof direct === 'string') return direct;
  return undefined;
}

/** Live process.env at call time. Never spread/clone this for the juiz. */
export function livePairwiseJudgeEnvV2(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Credencial única do juiz OpenAI/Luna: mesma ordem do adapter Luna
 * (`OPENAI_API_KEY_LUNA` → `OPENAI_API_KEY`). Uma lista só — o valor resolvido
 * flui para o runtime (`openaiApiKey`), então gate e adapter não divergem.
 */
export function resolvePairwiseJudgeCredentialV2(
  provider: string,
  env: NodeJS.Dict<string> = process.env
): string | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'luna' || normalized === 'openai') {
    return liveLlmCredentialV2(
      readEnvCredentialV2(env, 'OPENAI_API_KEY_LUNA'),
      readEnvCredentialV2(env, 'OPENAI_API_KEY')
    );
  }
  if (normalized === 'deepseek' || normalized === 'flash') {
    return liveLlmCredentialV2(readEnvCredentialV2(env, 'DEEPSEEK_API_KEY'));
  }
  return null;
}

export function pairwiseJudgeCredentialPresentV2(
  provider: string,
  env: NodeJS.Dict<string> = process.env
): boolean {
  return Boolean(resolvePairwiseJudgeCredentialV2(provider, env));
}

/**
 * Modelo Luna usa o provider/transporte Luna (Responses API), mesmo se o env
 * pediu `JUDGE_PROVIDER=openai`. Um protocolo por provider: o 400 de
 * `max_tokens` no Chat Completions veio exatamente desse descompasso.
 */
export function canonicalPairwiseJudgeProviderV2(
  spec: Tau2PairwiseJudgeSpecV2
): ReceptionistAiProvider {
  const model = spec.model.trim();
  const provider = spec.provider.trim().toLowerCase();
  if (model === OPENAI_LUNA_MODEL) return 'luna';
  if (provider === 'luna') {
    throw new Error(
      `Provider luna exige o modelo ${OPENAI_LUNA_MODEL}; recebido ${model || '(vazio)'}.`
    );
  }
  if (provider === 'deepseek' || provider === 'flash') return 'deepseek';
  if (provider === 'openai') return 'openai';
  throw new Error(`Provider de juiz pairwise não suportado: ${spec.provider}`);
}

export function pairwiseJudgeRuntimeTransportV2(
  spec: Tau2PairwiseJudgeSpecV2
): ReceptionistAiTransport {
  return canonicalPairwiseJudgeProviderV2(spec) === 'luna'
    ? 'responses'
    : 'chat_completions';
}

export function resolvePairwiseJudgeRuntimeV2(
  spec: Tau2PairwiseJudgeSpecV2,
  apiKey: string
): ReceptionistAiRuntime {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('Credencial resolvida do juiz pairwise está vazia.');
  }
  const config = pairwiseJudgeRuntimeConfigV2(spec, key);
  const provider = canonicalPairwiseJudgeProviderV2(spec);
  const configuredKey = config.openaiApiKey?.trim();
  if (!configuredKey) {
    throw new Error('Credencial resolvida não alcançou openaiApiKey do juiz pairwise.');
  }
  const configuredModel = config.aiModel?.trim();
  if (!configuredModel) {
    throw new Error('Modelo do juiz pairwise não alcançou o runtime.');
  }
  if (provider === 'luna') {
    return {
      provider: 'luna',
      model: configuredModel,
      apiKey: configuredKey,
      transport: 'responses',
      supportsJsonObjectResponseFormat: true,
      supportsStrictTools: true,
      strictToolsUseBetaEndpoint: false,
      supportsToolChoiceRequired: true,
    };
  }
  if (provider === 'openai') {
    return {
      provider: 'openai',
      model: configuredModel,
      apiKey: configuredKey,
      transport: 'chat_completions',
      supportsJsonObjectResponseFormat: true,
      supportsStrictTools: true,
      strictToolsUseBetaEndpoint: false,
      supportsToolChoiceRequired: true,
    };
  }
  assertDeepSeekProductionApproved();
  return {
    provider: 'deepseek',
    model: configuredModel,
    baseURL: DEEPSEEK_BASE_URL,
    apiKey: configuredKey,
    transport: 'chat_completions',
    supportsJsonObjectResponseFormat: true,
    supportsStrictTools: true,
    strictToolsUseBetaEndpoint: true,
    supportsToolChoiceRequired: true,
  };
}

export function pairwiseJudgeCompletionInputV2(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): ReceptionistCompletionInput {
  return {
    messages,
    tools: [],
    temperature: 0,
    maxTokens: TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2,
    thinkingMode: 'disabled',
    timeoutMs: TAU2_PAIRWISE_JUDGE_TIMEOUT_MS_V2,
    responseFormat: 'json_object',
  };
}

export function buildPairwiseJudgeProviderRequestV2(
  spec: Tau2PairwiseJudgeSpecV2,
  completionInput: ReceptionistCompletionInput,
  apiKey = 'sk-judge-preview-not-sent'
): { transport: ReceptionistAiTransport; request: Record<string, unknown> } {
  const runtime = resolvePairwiseJudgeRuntimeV2(spec, apiKey);
  if (runtime.transport === 'responses') {
    return {
      transport: 'responses',
      request: buildLunaResponsesRequest(runtime, completionInput) as unknown as Record<
        string,
        unknown
      >,
    };
  }
  return {
    transport: 'chat_completions',
    request: buildReceptionistCompletionRequest(
      runtime,
      completionInput
    ) as unknown as Record<string, unknown>,
  };
}

const JUDGE_ERROR_CREDENTIAL_RE =
  /sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Bearer\s+\S+/gi;

function judgeErrorStatusV2(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  return undefined;
}

function judgeErrorMessageV2(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error !== null && typeof error === 'object') {
    const record = error as { error?: { message?: unknown }; message?: unknown };
    if (typeof record.error?.message === 'string' && record.error.message.trim()) {
      return record.error.message.trim();
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
  }
  return String(error);
}

export function sanitizePairwiseJudgeErrorV2(error: unknown): string {
  const status = judgeErrorStatusV2(error);
  const message = judgeErrorMessageV2(error);
  const combined = status != null ? `${status} ${message}` : message;
  return combined.replace(JUDGE_ERROR_CREDENTIAL_RE, '[redacted]').slice(0, 400);
}

export function tau2PairwiseToneFailsProcessV2(
  report: Tau2PairwiseToneHarnessReportV2
): boolean {
  return report.reason === 'judge_call_failed';
}

function attemptedIdentityV2(
  spec: Tau2PairwiseJudgeSpecV2 | null,
  env: NodeJS.Dict<string>
): { attemptedProvider: string | null; attemptedModel: string | null } {
  if (spec) {
    return { attemptedProvider: spec.provider, attemptedModel: spec.model };
  }
  return {
    attemptedProvider:
      env[TAU2_PAIRWISE_JUDGE_PROVIDER_ENV_V2]?.trim().toLowerCase() || null,
    attemptedModel: env[TAU2_PAIRWISE_JUDGE_MODEL_ENV_V2]?.trim() || null,
  };
}

export function resolvePairwiseJudgeSpecV2(input: {
  generatorModels: readonly string[];
  env?: NodeJS.Dict<string>;
  judges?: readonly Tau2PairwiseJudgeSpecV2[];
  requireCredential?: boolean;
}):
  | { ok: true; spec: Tau2PairwiseJudgeSpecV2 }
  | {
      ok: false;
      reason: Exclude<
        Tau2PairwiseJudgeSkipReasonV2,
        'mock_harness' | 'judge_call_failed'
      >;
      attemptedProvider: string | null;
      attemptedModel: string | null;
    } {
  const env = input.env ?? livePairwiseJudgeEnvV2();
  const spec = input.judges?.[0] ?? specFromEnvOrDefaultV2(input.generatorModels, env);
  const attempted = attemptedIdentityV2(spec, env);
  if (!spec) {
    return { ok: false, reason: 'no_available_judge', ...attempted };
  }
  if (isBlockedTau2JudgeModelV2(spec.model)) {
    return { ok: false, reason: 'blocked_model', ...attempted };
  }
  try {
    assertToneJudgePanelV2({
      judges: [spec],
      generatorModels: input.generatorModels,
      lengthBandMaxRelativeDelta: TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
    });
  } catch {
    return { ok: false, reason: 'self_judge', ...attempted };
  }
  if (
    input.requireCredential !== false &&
    !pairwiseJudgeCredentialPresentV2(spec.provider, env)
  ) {
    return { ok: false, reason: 'missing_credential', ...attempted };
  }
  return { ok: true, spec };
}

export function notRunPairwiseToneReportV2(
  reason: Tau2PairwiseJudgeSkipReasonV2,
  generatorModels: readonly string[] = [],
  nPairedItems = 0,
  extras: {
    attemptedProvider?: string | null;
    attemptedModel?: string | null;
    judges?: readonly string[];
    judgeError?: string | null;
    nComparisons?: number;
    nEligible?: number;
    nConsistent?: number;
    nExcludedFidelity?: number;
    nExcludedLength?: number;
    nInconsistent?: number;
    templateWins?: number;
    variantWins?: number;
    receipts?: readonly Tau2PairwiseJudgeCallReceiptV2[];
    cost?: Tau2PairwiseToneCostV2;
  } = {}
): Tau2PairwiseToneHarnessReportV2 {
  return {
    status: 'not_run',
    reason,
    inconclusive: true,
    nPairedItems,
    nComparisons: extras.nComparisons ?? 0,
    nEligible: extras.nEligible ?? 0,
    nConsistent: extras.nConsistent ?? 0,
    nExcludedFidelity: extras.nExcludedFidelity ?? 0,
    nExcludedLength: extras.nExcludedLength ?? 0,
    nInconsistent: extras.nInconsistent ?? 0,
    templateWins: extras.templateWins ?? 0,
    variantWins: extras.variantWins ?? 0,
    preferenceRate: null,
    judges: extras.judges ? [...extras.judges] : [],
    generatorModels: [...generatorModels],
    receipts: extras.receipts ? [...extras.receipts] : [],
    cost: extras.cost ?? {
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    attemptedProvider:
      extras.attemptedProvider !== undefined
        ? extras.attemptedProvider
        : null,
    attemptedModel:
      extras.attemptedModel !== undefined
        ? extras.attemptedModel
        : null,
    judgeError: extras.judgeError ?? null,
  };
}

export function parsePairwiseJudgeSideV2(
  raw: string | null | undefined
): Tau2PairwiseSideV2 | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/u, '')
    .trim();
  try {
    const parsed = JSON.parse(stripped) as { side?: unknown; choice?: unknown };
    const side = String(parsed.side ?? parsed.choice ?? '')
      .trim()
      .toLowerCase();
    if (side === 'left' || side === 'right' || side === 'tie') return side;
  } catch {
    const lower = stripped.toLowerCase();
    if (lower === 'left' || lower === 'right' || lower === 'tie') return lower;
  }
  return null;
}

export function buildPairwiseJudgeMessagesV2(
  left: string,
  right: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content:
        'Você é um juiz cego de tom para mensagens de recepcionista de clínica no WhatsApp, em pt-BR. ' +
        'Compare só naturalidade, calor e concisão. Não avalie correção factual. ' +
        'Não prefira um lado só por ser mais longo. ' +
        'Responda APENAS JSON {"side":"left"} ou {"side":"right"} ou {"side":"tie"}.',
    },
    {
      role: 'user',
      content:
        `MENSAGEM_ESQUERDA:\n<<<\n${left}\n>>>\n\n` +
        `MENSAGEM_DIREITA:\n<<<\n${right}\n>>>`,
    },
  ];
}

export function pairwiseJudgeRuntimeConfigV2(
  spec: Tau2PairwiseJudgeSpecV2,
  openaiApiKey: string | null
): TenantBotConfig {
  const provider = canonicalPairwiseJudgeProviderV2(spec);
  return {
    tenantSlug: 'tenant-v2-tau2-judge',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Atenda.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: provider,
    aiModel: provider === 'luna' ? OPENAI_LUNA_MODEL : spec.model,
    aiTemperature: 0,
    aiMaxTokens: TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2,
    openaiApiKey,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'tau2-judge',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN-TAU2-JUDGE',
    isActive: true,
  } as TenantBotConfig;
}

export async function runPairwiseToneHarnessV2(input: {
  items: readonly Tau2PairwiseToneItemV2[];
  generatorModels: readonly string[];
  env?: NodeJS.Dict<string>;
  judges?: readonly Tau2PairwiseJudgeSpecV2[];
  completionFactory?: Tau2PairwiseJudgeCompletionFactoryV2;
  requireCredential?: boolean;
  lengthBandMaxRelativeDelta?: number;
}): Promise<Tau2PairwiseToneHarnessReportV2> {
  const env = input.env ?? livePairwiseJudgeEnvV2();
  const requireCredential =
    input.requireCredential ??
    !(input.completionFactory != null && input.env === undefined);
  const resolved = resolvePairwiseJudgeSpecV2({
    generatorModels: input.generatorModels,
    env,
    judges: input.judges,
    requireCredential,
  });
  if (!resolved.ok) {
    return notRunPairwiseToneReportV2(
      resolved.reason,
      input.generatorModels,
      input.items.length,
      {
        attemptedProvider: resolved.attemptedProvider,
        attemptedModel: resolved.attemptedModel,
      }
    );
  }
  const spec = resolved.spec;
  const resolvedApiKey = resolvePairwiseJudgeCredentialV2(spec.provider, env);
  const runtimeConfig = resolvedApiKey
    ? pairwiseJudgeRuntimeConfigV2(spec, resolvedApiKey)
    : null;
  const runtime = resolvedApiKey
    ? resolvePairwiseJudgeRuntimeV2(spec, resolvedApiKey)
    : null;
  const runtimeProvider =
    runtime?.provider ?? canonicalPairwiseJudgeProviderV2(spec);
  const runtimeTransport =
    runtime?.transport ?? pairwiseJudgeRuntimeTransportV2(spec);
  const receipts: Tau2PairwiseJudgeCallReceiptV2[] = [];
  const complete =
    input.completionFactory ?? defaultPairwiseJudgeCompletionV2;

  const failedReport = (
    error: unknown,
    partial?: Tau2PairwiseToneReportV2
  ): Tau2PairwiseToneHarnessReportV2 => {
    const cost = receipts.reduce<Tau2PairwiseToneCostV2>(
      (sum, receipt) => ({
        latencyMs: sum.latencyMs + receipt.latencyMs,
        promptTokens: sum.promptTokens + receipt.promptTokens,
        completionTokens: sum.completionTokens + receipt.completionTokens,
        totalTokens: sum.totalTokens + receipt.totalTokens,
      }),
      { latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );
    return notRunPairwiseToneReportV2(
      'judge_call_failed',
      input.generatorModels,
      input.items.length,
      {
        attemptedProvider: spec.provider,
        attemptedModel: spec.model,
        judges: partial?.judges ?? [spec.id],
        judgeError: sanitizePairwiseJudgeErrorV2(error),
        nComparisons: partial?.nComparisons ?? receipts.length,
        nEligible: partial?.nEligible ?? 0,
        nConsistent: partial?.nConsistent ?? 0,
        nExcludedFidelity: partial?.nExcludedFidelity ?? 0,
        nExcludedLength: partial?.nExcludedLength ?? 0,
        nInconsistent: partial?.nInconsistent ?? 0,
        templateWins: partial?.templateWins ?? 0,
        variantWins: partial?.variantWins ?? 0,
        receipts,
        cost,
      }
    );
  };

  try {
    const report = await evaluatePairwiseToneV2({
      items: input.items,
      config: {
        judges: [spec],
        generatorModels: input.generatorModels,
        lengthBandMaxRelativeDelta:
          input.lengthBandMaxRelativeDelta ??
          TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
      },
      askJudge: async ({ judge, left, right, order, itemId }) => {
        const messages = buildPairwiseJudgeMessagesV2(left, right);
        const completionInput = pairwiseJudgeCompletionInputV2(messages);
        const started = Date.now();
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        try {
          completion = await complete({
            judge,
            left,
            right,
            order,
            itemId,
            messages,
            completionInput,
            resolvedApiKey,
            runtime,
            runtimeConfig,
            runtimeProvider,
            runtimeTransport,
          });
        } catch (error) {
          throw new PairwiseToneAskFailedV2(sanitizePairwiseJudgeErrorV2(error), {
            nComparisons: receipts.length,
            nEligible: 0,
            nConsistent: 0,
            nExcludedFidelity: 0,
            nExcludedLength: 0,
            nInconsistent: 0,
            templateWins: 0,
            variantWins: 0,
            preferenceRate: null,
            judges: [spec.id],
          });
        }
        const latencyMs = Math.max(0, Date.now() - started);
        const returnedModel = completion.model?.trim() || null;
        assertTau2RealJudgeReceiptV2({
          requestedModel: judge.model,
          returnedModel,
        });
        const usage = completion.usage;
        receipts.push({
          itemId,
          judgeId: judge.id,
          order,
          provider: judge.provider,
          requestedModel: judge.model,
          returnedModel,
          latencyMs,
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        });
        if (completion.choices[0]?.message.tool_calls?.length) {
          return 'tie';
        }
        return (
          parsePairwiseJudgeSideV2(completion.choices[0]?.message.content) ?? 'tie'
        );
      },
    });
    const cost = receipts.reduce<Tau2PairwiseToneCostV2>(
      (sum, receipt) => ({
        latencyMs: sum.latencyMs + receipt.latencyMs,
        promptTokens: sum.promptTokens + receipt.promptTokens,
        completionTokens: sum.completionTokens + receipt.completionTokens,
        totalTokens: sum.totalTokens + receipt.totalTokens,
      }),
      { latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );
    return {
      ...report,
      status: 'judged',
      reason: null,
      inconclusive: report.nComparisons === 0,
      nPairedItems: input.items.length,
      generatorModels: [...input.generatorModels],
      receipts,
      cost,
      attemptedProvider: spec.provider,
      attemptedModel: spec.model,
      judgeError: null,
    };
  } catch (error) {
    if (error instanceof PairwiseToneAskFailedV2) {
      return failedReport(error, error.partial);
    }
    throw error;
  }
}

function specFromEnvOrDefaultV2(
  generatorModels: readonly string[],
  env: NodeJS.Dict<string>
): Tau2PairwiseJudgeSpecV2 | null {
  const providerRaw = env[TAU2_PAIRWISE_JUDGE_PROVIDER_ENV_V2]?.trim().toLowerCase();
  const modelRaw = env[TAU2_PAIRWISE_JUDGE_MODEL_ENV_V2]?.trim();
  if (!providerRaw && !modelRaw) {
    return defaultPairwiseJudgeSpecV2(generatorModels);
  }
  const provider = normalizeJudgeProviderV2(providerRaw);
  if (!provider) return null;
  const model = modelRaw || defaultModelForJudgeProviderV2(provider);
  if (!model) return null;
  return {
    id: provider === 'deepseek' ? 'flash' : provider,
    provider,
    model,
  };
}

function normalizeJudgeProviderV2(
  raw: string | undefined
): ReceptionistAiProvider | null {
  if (!raw) return null;
  if (raw === 'flash') return 'deepseek';
  if (raw === 'luna' || raw === 'deepseek' || raw === 'openai') return raw;
  return null;
}

function defaultModelForJudgeProviderV2(
  provider: ReceptionistAiProvider
): string | null {
  if (provider === 'luna') return OPENAI_LUNA_MODEL;
  if (provider === 'deepseek') return DEEPSEEK_V4_FLASH_MODEL;
  return null;
}

async function defaultPairwiseJudgeCompletionV2(input: {
  judge: Tau2PairwiseJudgeSpecV2;
  completionInput: ReceptionistCompletionInput;
  resolvedApiKey: string | null;
  runtime: ReceptionistAiRuntime | null;
}): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (!input.resolvedApiKey?.trim() || !input.runtime) {
    throw new Error('Credencial resolvida do juiz pairwise está ausente no runtime.');
  }
  return createReceptionistChatCompletion(input.runtime, input.completionInput);
}
