import type { TenantBotConfig } from '../../../configProvider';
import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
  resolveReceptionistAiRuntime,
} from '../../receptionistLlmProvider';
import { assertLiveVoiceModelReceiptV2 } from '../voice/liveReceipt';
import {
  TAU2_ARM_IDS,
  TAU2_ARM_VECTORS,
  type Tau2ArmId,
} from './types';

export interface Tau2ArmProviderSpecV2 {
  readonly armId: Tau2ArmId;
  readonly provider: 'deepseek' | 'luna';
  readonly requestedModel: string;
}

export interface Tau2ArmPreflightReceiptV2 extends Tau2ArmProviderSpecV2 {
  readonly resolvedProvider: 'openai' | 'deepseek' | 'luna';
  readonly resolvedModel: string;
}

export function tau2ArmProviderSpecV2(armId: Tau2ArmId): Tau2ArmProviderSpecV2 {
  const vector = TAU2_ARM_VECTORS[armId];
  if (vector.brain === 'luna') {
    return {
      armId,
      provider: 'luna',
      requestedModel: OPENAI_LUNA_MODEL,
    };
  }
  return {
    armId,
    provider: 'deepseek',
    requestedModel: DEEPSEEK_V4_FLASH_MODEL,
  };
}

export function applyTau2ArmProviderSpecV2(
  config: TenantBotConfig,
  armId: Tau2ArmId
): TenantBotConfig {
  const spec = tau2ArmProviderSpecV2(armId);
  return {
    ...config,
    aiProvider: spec.provider,
    aiModel: spec.requestedModel,
  };
}

export function preflightTau2ArmV2(
  config: TenantBotConfig,
  armId: Tau2ArmId
): Tau2ArmPreflightReceiptV2 {
  const spec = tau2ArmProviderSpecV2(armId);
  const runtime = resolveReceptionistAiRuntime(config);
  if (runtime.provider !== spec.provider || runtime.model !== spec.requestedModel) {
    throw new Error(
      `preflight τ² ${armId}: esperado ${spec.provider}/${spec.requestedModel}, ` +
        `resolvido ${runtime.provider}/${runtime.model}`
    );
  }
  return {
    ...spec,
    resolvedProvider: runtime.provider,
    resolvedModel: runtime.model,
  };
}

export function preflightTau2RealRunV2(
  configs: Readonly<Record<Tau2ArmId, TenantBotConfig>>,
  arms: readonly Tau2ArmId[] = TAU2_ARM_IDS
): Tau2ArmPreflightReceiptV2[] {
  const needsFlash = arms.some(
    (arm) => tau2ArmProviderSpecV2(arm).provider === 'deepseek'
  );
  const needsLuna = arms.some(
    (arm) => tau2ArmProviderSpecV2(arm).provider === 'luna'
  );
  if (needsFlash && !process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error('--real τ² exige DEEPSEEK_API_KEY para os braços Flash.');
  }
  if (needsLuna && !process.env.OPENAI_API_KEY_LUNA?.trim()) {
    throw new Error('--real τ² exige OPENAI_API_KEY_LUNA para os braços Luna.');
  }
  return arms.map((armId) => preflightTau2ArmV2(configs[armId], armId));
}

export function assertTau2RealVoiceReceiptV2(input: {
  armId: Tau2ArmId;
  provider?: 'openai' | 'deepseek' | 'luna';
  requestedModel?: string;
  returnedModel?: string | null;
  decision?: import('../voice/types').VoiceDecisionV2;
}): void {
  if (!TAU2_ARM_VECTORS[input.armId].voice) return;
  const spec = tau2ArmProviderSpecV2(input.armId);
  if (!input.requestedModel) {
    throw new Error(`5º braço ${input.armId} sem requestedModel no recibo de voz`);
  }
  assertLiveVoiceModelReceiptV2({
    provider: input.provider ?? spec.provider,
    requestedModel: input.requestedModel,
    returnedModel: input.returnedModel,
    decision: input.decision,
  });
}
