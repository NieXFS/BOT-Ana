import type { TenantBotConfig } from '../../configProvider';
import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
  providerResponseEchoV2,
  resolveAnaResumeClassifierRuntime,
  resolveReceptionistAiRuntime,
  type ProviderFingerprintStatusV2,
  type ProviderResponseEchoV2,
  type ReceptionistAiProvider,
} from '../receptionistLlmProvider';

export const BEHAVIORAL_ROTEIROS_REPORT_SCHEMA_VERSION = 5;
export const BEHAVIORAL_ARTIFACT_FILES_V2 = [
  'raw.json',
  'summary.md',
  'comparison.md',
] as const;
export const OPENAI_GPT_4O_MINI_MODEL = 'gpt-4o-mini';

export const LUNA_PRICING_ENV = {
  cachedInput: 'OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION',
  input: 'OPENAI_LUNA_INPUT_USD_PER_MILLION',
  output: 'OPENAI_LUNA_OUTPUT_USD_PER_MILLION',
} as const;

export type BehavioralHarnessProvider = Extract<
  ReceptionistAiProvider,
  'deepseek' | 'openai' | 'luna'
>;

export type BehavioralProviderCallKindV2 =
  | 'brain'
  | 'social'
  | 'regen'
  | 'resume_thinking'
  | 'interpreter'
  | 'voice';

export interface BehavioralArmProviderSpecV2 {
  readonly provider: BehavioralHarnessProvider;
  readonly requestedModel: string;
}

export interface BehavioralArmPreflightReceiptV2 extends BehavioralArmProviderSpecV2 {
  readonly resolvedProvider: BehavioralHarnessProvider;
  readonly resolvedModel: string;
}

export interface BehavioralHarnessRatesV2 {
  readonly promptCacheHit: number;
  readonly promptCacheMiss: number;
  readonly completion: number;
}

export type BehavioralPricingStatusV2 = 'priced' | 'unpriced';

export interface BehavioralHarnessPricingV2 {
  readonly provider: BehavioralHarnessProvider;
  readonly rates: BehavioralHarnessRatesV2;
  readonly status: BehavioralPricingStatusV2;
}

export type BehavioralFingerprintStatusV2 = ProviderFingerprintStatusV2;

export interface BehavioralProviderCallReceiptV2 {
  readonly callProvider: BehavioralHarnessProvider;
  readonly kind?: BehavioralProviderCallKindV2;
  readonly requestedModel: string;
  readonly returnedModel: string | null | undefined;
  readonly systemFingerprint?: string | null;
  readonly fingerprintStatus?: BehavioralFingerprintStatusV2;
  readonly poisoned?: boolean;
  readonly antiMockReason?: string | null;
}

export interface BehavioralAntiMockLatchV2 {
  tripped: boolean;
  reasons: string[];
}

export type BehavioralAntiMockVerdictV2 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const BLOCKED_LIVE_MODEL_RE = /(?:^|[.\-_])mock(?:$|[.\-_])/iu;

/** Preços congelados do harness; Luna não entra aqui — vem do env ou aborta. */
export const BEHAVIORAL_FROZEN_RATES_USD_PER_MILLION_V2 = {
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
} as const satisfies Record<'deepseek' | 'openai', BehavioralHarnessRatesV2>;

export function behavioralArmProviderSpecV2(
  provider: BehavioralHarnessProvider
): BehavioralArmProviderSpecV2 {
  if (provider === 'luna') {
    return { provider: 'luna', requestedModel: OPENAI_LUNA_MODEL };
  }
  if (provider === 'openai') {
    return { provider: 'openai', requestedModel: OPENAI_GPT_4O_MINI_MODEL };
  }
  return { provider: 'deepseek', requestedModel: DEEPSEEK_V4_FLASH_MODEL };
}

export function expectedModelForBehavioralCallV2(
  armProvider: BehavioralHarnessProvider,
  kind: BehavioralProviderCallKindV2
): BehavioralArmProviderSpecV2 {
  if (kind === 'resume_thinking') {
    return behavioralArmProviderSpecV2('deepseek');
  }
  return behavioralArmProviderSpecV2(armProvider);
}

export function isBlockedBehavioralLiveModelV2(
  model: string | null | undefined
): boolean {
  const value = model?.trim() ?? '';
  if (!value) return false;
  return /mock/i.test(value) || BLOCKED_LIVE_MODEL_RE.test(value);
}

export function completionEchoFromProviderResponseV2(
  completion: unknown
): ProviderResponseEchoV2 {
  return providerResponseEchoV2(completion);
}

export function responseModelFromCompletionV2(completion: {
  model?: unknown;
}): string | null {
  return completionEchoFromProviderResponseV2(completion).responseModel;
}

export function systemFingerprintFromCompletionV2(completion: {
  system_fingerprint?: unknown;
  systemFingerprint?: unknown;
  metadata?: unknown;
}): string | null {
  return completionEchoFromProviderResponseV2(completion).systemFingerprint;
}

export function fingerprintStatusFromCompletionV2(
  completion: unknown
): BehavioralFingerprintStatusV2 {
  return completionEchoFromProviderResponseV2(completion).fingerprintStatus;
}

export function createBehavioralAntiMockLatchV2(): BehavioralAntiMockLatchV2 {
  return { tripped: false, reasons: [] };
}

export function tripBehavioralAntiMockLatchV2(
  latch: BehavioralAntiMockLatchV2,
  reason: string
): void {
  latch.tripped = true;
  latch.reasons.push(reason);
}

export function evaluateBehavioralAntiMockCallV2(
  input: BehavioralProviderCallReceiptV2
): BehavioralAntiMockVerdictV2 {
  try {
    assertBehavioralRealProviderCallV2(input);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Recibo entra em `calls` ANTES de qualquer throw. O veredito anti-mock fica
 * no latch do contexto; o sweep final reprova independente de camadas
 * resilientes engolirem a exceção.
 */
export function recordBehavioralTrackedCallV2<
  T extends BehavioralProviderCallReceiptV2,
>(input: {
  mode: 'mock' | 'real';
  latch: BehavioralAntiMockLatchV2;
  calls: T[];
  receipt: T;
}): T {
  if (input.mode !== 'real') {
    input.calls.push(input.receipt);
    return input.receipt;
  }
  const verdict = evaluateBehavioralAntiMockCallV2(input.receipt);
  if (verdict.ok) {
    input.calls.push(input.receipt);
    return input.receipt;
  }
  tripBehavioralAntiMockLatchV2(input.latch, verdict.reason);
  const poisoned = {
    ...input.receipt,
    poisoned: true,
    antiMockReason: verdict.reason,
  } as T;
  input.calls.push(poisoned);
  throw new Error(verdict.reason);
}

export function assertBehavioralPublishAllowedV2(input: {
  mode: 'mock' | 'real';
  armProvider: BehavioralHarnessProvider;
  latch: BehavioralAntiMockLatchV2;
  calls: readonly BehavioralProviderCallReceiptV2[];
}): void {
  if (input.mode !== 'real') return;
  if (input.latch.tripped) {
    throw new Error(
      `behavioral --real abortado: latch anti-mock (${input.latch.reasons.join('; ')})`
    );
  }
  const poisoned = input.calls.filter((call) => call.poisoned);
  if (poisoned.length > 0) {
    throw new Error(
      `behavioral --real abortado: ${poisoned.length} chamada(s) poisoned (${
        poisoned[0]?.antiMockReason ?? poisoned[0]?.kind ?? 'anti-mock'
      })`
    );
  }
  assertBehavioralRealCallLogV2(input.calls, input.armProvider);
}

export async function writeBehavioralArtifactsIfAllowedV2(input: {
  mode: 'mock' | 'real';
  armProvider: BehavioralHarnessProvider;
  latch: BehavioralAntiMockLatchV2;
  calls: readonly BehavioralProviderCallReceiptV2[];
  outputDir: string;
  files: Readonly<Record<string, string>>;
  mkdir: (
    path: string,
    options?: { recursive?: boolean }
  ) => Promise<void> | void;
  writeFile: (path: string, contents: string) => Promise<void> | void;
}): Promise<void> {
  assertBehavioralPublishAllowedV2(input);
  await input.mkdir(input.outputDir, { recursive: true });
  for (const [name, contents] of Object.entries(input.files)) {
    await input.writeFile(`${input.outputDir}/${name}`, contents);
  }
}

export function estimatedBehavioralCostUsdV2(input: {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number | null;
  cacheMissPromptTokens: number | null;
  rates: BehavioralHarnessRatesV2;
}): number {
  const cached = Math.max(0, input.cachedPromptTokens ?? 0);
  const miss = Math.max(
    0,
    input.cacheMissPromptTokens ?? input.promptTokens - cached
  );
  return (
    (cached * input.rates.promptCacheHit +
      miss * input.rates.promptCacheMiss +
      Math.max(0, input.completionTokens) * input.rates.completion) /
    1_000_000
  );
}

function envUsdPerMillion(
  env: NodeJS.ProcessEnv,
  key: string
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function resolveLunaHarnessPricingV2(
  env: NodeJS.ProcessEnv = process.env
): BehavioralHarnessPricingV2 {
  const rates: BehavioralHarnessRatesV2 = {
    promptCacheHit: envUsdPerMillion(env, LUNA_PRICING_ENV.cachedInput),
    promptCacheMiss: envUsdPerMillion(env, LUNA_PRICING_ENV.input),
    completion: envUsdPerMillion(env, LUNA_PRICING_ENV.output),
  };
  const priced = rates.promptCacheMiss > 0 && rates.completion > 0;
  return {
    provider: 'luna',
    rates,
    status: priced ? 'priced' : 'unpriced',
  };
}

export function resolveBehavioralHarnessPricingV2(
  provider: BehavioralHarnessProvider,
  env: NodeJS.ProcessEnv = process.env
): BehavioralHarnessPricingV2 {
  if (provider === 'luna') return resolveLunaHarnessPricingV2(env);
  return {
    provider,
    rates: BEHAVIORAL_FROZEN_RATES_USD_PER_MILLION_V2[provider],
    status: 'priced',
  };
}

export function preflightBehavioralArmV2(
  config: TenantBotConfig,
  provider: BehavioralHarnessProvider
): BehavioralArmPreflightReceiptV2 {
  const spec = behavioralArmProviderSpecV2(provider);
  const runtime = resolveReceptionistAiRuntime(config);
  if (runtime.provider !== spec.provider || runtime.model !== spec.requestedModel) {
    throw new Error(
      `preflight behavioral ${provider}: esperado ${spec.provider}/${spec.requestedModel}, ` +
        `resolvido ${runtime.provider}/${runtime.model}`
    );
  }
  return {
    ...spec,
    resolvedProvider: runtime.provider,
    resolvedModel: runtime.model,
  };
}

export function preflightBehavioralRealRunV2(input: {
  provider: BehavioralHarnessProvider;
  config: TenantBotConfig;
  includesResumeClassifier: boolean;
  env?: NodeJS.ProcessEnv;
}): BehavioralArmPreflightReceiptV2 {
  const env = input.env ?? process.env;
  if (input.provider === 'deepseek' && !env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error('--real --provider deepseek exige DEEPSEEK_API_KEY.');
  }
  if (input.provider === 'luna' && !env.OPENAI_API_KEY_LUNA?.trim()) {
    throw new Error('--real --provider luna exige OPENAI_API_KEY_LUNA.');
  }
  if (input.provider === 'openai' && !env.OPENAI_API_KEY?.trim()) {
    throw new Error('--real --provider openai exige OPENAI_API_KEY.');
  }
  if (input.includesResumeClassifier && !env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      'R10 real mantém o chefe Thinking e exige DEEPSEEK_API_KEY.'
    );
  }
  const pricing = resolveBehavioralHarnessPricingV2(input.provider, env);
  if (input.provider === 'luna' && pricing.status === 'unpriced') {
    throw new Error(
      '--real --provider luna abortado: tabela ' +
        `${LUNA_PRICING_ENV.input}/${LUNA_PRICING_ENV.output} está 0; ` +
        'recusando publicar custo US$0 (não inventa preço; defina o contrato comercial).'
    );
  }
  const receipt = preflightBehavioralArmV2(input.config, input.provider);
  if (isBlockedBehavioralLiveModelV2(receipt.resolvedModel)) {
    throw new Error(
      `preflight behavioral ${input.provider}: modelo resolvido mock (${receipt.resolvedModel})`
    );
  }
  if (input.includesResumeClassifier) {
    const classifier = resolveAnaResumeClassifierRuntime();
    if (
      classifier.provider !== 'deepseek' ||
      classifier.model !== DEEPSEEK_V4_FLASH_MODEL ||
      isBlockedBehavioralLiveModelV2(classifier.model)
    ) {
      throw new Error(
        `preflight behavioral R10: chefe Thinking exige deepseek/${DEEPSEEK_V4_FLASH_MODEL}, ` +
          `resolvido ${classifier.provider}/${classifier.model}`
      );
    }
  }
  return receipt;
}

export function assertBehavioralRealProviderCallV2(
  input: BehavioralProviderCallReceiptV2
): void {
  const spec = expectedModelForBehavioralCallV2(
    input.callProvider,
    input.kind ?? 'brain'
  );
  const requested = input.requestedModel?.trim() ?? '';
  const returned = input.returnedModel?.trim() ?? '';
  if (!requested) {
    throw new Error(
      `behavioral --real abortado: requestedModel ausente (kind=${input.kind ?? 'brain'})`
    );
  }
  if (isBlockedBehavioralLiveModelV2(requested)) {
    throw new Error(
      `behavioral --real abortado: recibo mock (requestedModel=${requested})`
    );
  }
  if (requested !== spec.requestedModel) {
    throw new Error(
      `behavioral --real abortado: modelo divergente do braço ${spec.provider} ` +
        `(esperado ${spec.requestedModel}, requested=${requested})`
    );
  }
  if (!returned) {
    throw new Error(
      `behavioral --real abortado: response.model ausente (kind=${input.kind ?? 'brain'})`
    );
  }
  if (isBlockedBehavioralLiveModelV2(returned)) {
    throw new Error(
      `behavioral --real abortado: recibo mock (response.model=${returned})`
    );
  }
  if (returned !== spec.requestedModel) {
    throw new Error(
      `behavioral --real abortado: modelo divergente do braço ${spec.provider} ` +
        `(esperado ${spec.requestedModel}, returned=${returned})`
    );
  }
}

export function assertBehavioralRealCallLogV2(
  calls: readonly BehavioralProviderCallReceiptV2[],
  armProvider: BehavioralHarnessProvider
): void {
  for (const call of calls) {
    assertBehavioralRealProviderCallV2({
      ...call,
      callProvider: call.callProvider || armProvider,
    });
  }
}
