import type { Tau2ToneScores } from './types';

/**
 * Juiz de tom experimental. Fora do reward binário. Não reavalia correção.
 * A matriz mock não o invoca; existe para o protocolo, não como gate.
 */
export function isToneJudgeAttachedToRewardV2(): false {
  return false;
}

export function emptyToneScoresV2(): Tau2ToneScores {
  return {
    warmth: 0,
    naturalness: 0,
    concision: 0,
    contextualFit: 0,
    nonRepetition: 0,
  };
}
