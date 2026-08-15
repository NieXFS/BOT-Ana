import type { Tau2ArmVector } from './types';

/**
 * O quinto braço só é comparável ao Flash correspondente. Qualquer outra
 * diferença no vetor invalida o pareamento.
 */
export function voicePairingIsValidV2(
  baseline: Tau2ArmVector,
  voiced: Tau2ArmVector
): boolean {
  return (
    baseline.brain === voiced.brain &&
    baseline.interpreter === voiced.interpreter &&
    baseline.voice === false &&
    voiced.voice === true
  );
}

export function recommendedVoiceBaselineV2(): {
  baseline: 'flash_interpreter';
  voiced: 'flash_interpreter_voice';
} {
  return {
    baseline: 'flash_interpreter',
    voiced: 'flash_interpreter_voice',
  };
}
