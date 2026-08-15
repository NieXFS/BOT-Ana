import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
} from '../../receptionistLlmProvider';
import type { VoiceDecisionV2, VoiceReceiptV2 } from './types';

const BLOCKED_LIVE_VOICE_MODEL_RE = /(?:^|[.\-_])mock(?:$|[.\-_])|^gpt-4o-mini$/iu;

export function isBlockedLiveVoiceModelV2(model: string | null | undefined): boolean {
  const value = model?.trim() ?? '';
  if (!value) return false;
  const normalized = value.toLowerCase();
  return (
    normalized.includes('mock') ||
    normalized === 'gpt-4o-mini' ||
    BLOCKED_LIVE_VOICE_MODEL_RE.test(value)
  );
}

export function assertLiveVoiceModelReceiptV2(input: {
  provider: VoiceReceiptV2['provider'] | 'openai' | 'deepseek' | 'luna';
  requestedModel: string;
  returnedModel?: string | null;
  decision?: VoiceDecisionV2;
}): void {
  if (!input.provider) {
    throw new Error('recibo de voz real sem provider');
  }
  const requested = input.requestedModel.trim();
  const returned = input.returnedModel?.trim() ?? '';
  if (!requested) {
    throw new Error('recibo de voz real sem requestedModel');
  }
  if (input.provider === 'openai' || isBlockedLiveVoiceModelV2(requested)) {
    throw new Error(
      `recibo de voz real rejeitado (requestedModel=${requested})`
    );
  }
  if (input.provider === 'deepseek' && requested !== DEEPSEEK_V4_FLASH_MODEL) {
    throw new Error(
      `5º braço exige ${DEEPSEEK_V4_FLASH_MODEL}; requestedModel=${requested}`
    );
  }
  if (input.provider === 'luna' && requested !== OPENAI_LUNA_MODEL) {
    throw new Error(
      `voz luna exige ${OPENAI_LUNA_MODEL}; requestedModel=${requested}`
    );
  }
  const accepted =
    input.decision === 'accepted' || input.decision === 'unchanged';
  if (!returned) {
    if (accepted) {
      throw new Error('voz aceita sem returnedModel no recibo');
    }
    return;
  }
  if (isBlockedLiveVoiceModelV2(returned)) {
    throw new Error(`recibo de voz real rejeitado (returnedModel=${returned})`);
  }
  if (input.provider === 'deepseek' && returned !== DEEPSEEK_V4_FLASH_MODEL) {
    throw new Error(
      `5º braço exige ${DEEPSEEK_V4_FLASH_MODEL}; returnedModel=${returned}`
    );
  }
  if (input.provider === 'luna' && returned !== OPENAI_LUNA_MODEL) {
    throw new Error(
      `voz luna exige ${OPENAI_LUNA_MODEL}; returnedModel=${returned}`
    );
  }
}
