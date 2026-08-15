import type OpenAI from 'openai';
import type { TenantBotConfig } from '../../../configProvider';
import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
  createReceptionistChatCompletion,
  resolveReceptionistAiRuntime,
  type ReceptionistAiProvider,
  type ReceptionistCompletionInput,
} from '../../receptionistLlmProvider';
import { isVoiceCopyIdV2 } from '../voice/registry';
import type { VoiceCopyIdV2 } from '../voice/types';
import { recommendedVoiceBaselineV2, voicePairingIsValidV2 } from './pairing';
import {
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
  | 'blocked_model';

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
}

export type Tau2PairwiseJudgeCompletionFactoryV2 = (input: {
  judge: Tau2PairwiseJudgeSpecV2;
  left: string;
  right: string;
  order: 'ab' | 'ba';
  itemId: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  completionInput: ReceptionistCompletionInput;
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

export function pairwiseJudgeCredentialPresentV2(
  provider: string,
  env: NodeJS.Dict<string> = process.env
): boolean {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'luna') return Boolean(env.OPENAI_API_KEY_LUNA?.trim());
  if (normalized === 'deepseek') return Boolean(env.DEEPSEEK_API_KEY?.trim());
  if (normalized === 'openai') return Boolean(env.OPENAI_API_KEY?.trim());
  return false;
}

export function resolvePairwiseJudgeSpecV2(input: {
  generatorModels: readonly string[];
  env?: NodeJS.Dict<string>;
  judges?: readonly Tau2PairwiseJudgeSpecV2[];
  requireCredential?: boolean;
}):
  | { ok: true; spec: Tau2PairwiseJudgeSpecV2 }
  | { ok: false; reason: Exclude<Tau2PairwiseJudgeSkipReasonV2, 'mock_harness'> } {
  const env = input.env ?? process.env;
  const spec = input.judges?.[0] ?? specFromEnvOrDefaultV2(input.generatorModels, env);
  if (!spec) {
    return { ok: false, reason: 'no_available_judge' };
  }
  if (isBlockedTau2JudgeModelV2(spec.model)) {
    return { ok: false, reason: 'blocked_model' };
  }
  try {
    assertToneJudgePanelV2({
      judges: [spec],
      generatorModels: input.generatorModels,
      lengthBandMaxRelativeDelta: TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
    });
  } catch {
    return { ok: false, reason: 'self_judge' };
  }
  if (
    input.requireCredential !== false &&
    !pairwiseJudgeCredentialPresentV2(spec.provider, env)
  ) {
    return { ok: false, reason: 'missing_credential' };
  }
  return { ok: true, spec };
}

export function notRunPairwiseToneReportV2(
  reason: Tau2PairwiseJudgeSkipReasonV2,
  generatorModels: readonly string[] = [],
  nPairedItems = 0
): Tau2PairwiseToneHarnessReportV2 {
  return {
    status: 'not_run',
    reason,
    inconclusive: true,
    nPairedItems,
    nComparisons: 0,
    nEligible: 0,
    nConsistent: 0,
    nExcludedFidelity: 0,
    nExcludedLength: 0,
    nInconsistent: 0,
    templateWins: 0,
    variantWins: 0,
    preferenceRate: null,
    judges: [],
    generatorModels: [...generatorModels],
    receipts: [],
    cost: {
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
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
  spec: Tau2PairwiseJudgeSpecV2
): TenantBotConfig {
  return {
    tenantSlug: 'tenant-v2-tau2-judge',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Atenda.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: spec.provider,
    aiModel: spec.model,
    aiTemperature: 0,
    aiMaxTokens: TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2,
    openaiApiKey: null,
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
  lengthBandMaxRelativeDelta?: number;
}): Promise<Tau2PairwiseToneHarnessReportV2> {
  const resolved = resolvePairwiseJudgeSpecV2({
    generatorModels: input.generatorModels,
    env: input.env,
    judges: input.judges,
    requireCredential: input.completionFactory ? false : true,
  });
  if (!resolved.ok) {
    return notRunPairwiseToneReportV2(
      resolved.reason,
      input.generatorModels,
      input.items.length
    );
  }
  const spec = resolved.spec;
  const receipts: Tau2PairwiseJudgeCallReceiptV2[] = [];
  const complete =
    input.completionFactory ?? defaultPairwiseJudgeCompletionV2;
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
      const completionInput: ReceptionistCompletionInput = {
        messages,
        tools: [],
        temperature: 0,
        maxTokens: TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2,
        thinkingMode: 'disabled',
        timeoutMs: TAU2_PAIRWISE_JUDGE_TIMEOUT_MS_V2,
        responseFormat: 'json_object',
      };
      const started = Date.now();
      const completion = await complete({
        judge,
        left,
        right,
        order,
        itemId,
        messages,
        completionInput,
      });
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
  };
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
}): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const runtime = resolveReceptionistAiRuntime(
    pairwiseJudgeRuntimeConfigV2(input.judge)
  );
  return createReceptionistChatCompletion(runtime, input.completionInput);
}
