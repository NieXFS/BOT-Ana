import { evaluateCommunicateV2 } from './communicate';
import { evaluateEnvAssertionsV2, evaluateStateV2 } from './envAssertions';
import type {
  Tau2CanonicalState,
  Tau2CommunicateItem,
  Tau2EnvAssertion,
  Tau2Reward,
} from './types';

export function evaluateTau2RewardV2(input: {
  actual: Tau2CanonicalState;
  expected: Tau2CanonicalState;
  envAssertions: readonly Tau2EnvAssertion[];
  communicateInfo: readonly Tau2CommunicateItem[];
  deliveredPayloads: readonly string[];
}): Tau2Reward {
  const state = evaluateStateV2(input.actual, input.expected);
  const envAssertion = evaluateEnvAssertionsV2(input.actual, input.envAssertions);
  const communicate = evaluateCommunicateV2(
    input.deliveredPayloads,
    input.communicateInfo
  );
  const reward = state === 1 && envAssertion === 1 && communicate === 1 ? 1 : 0;
  return { state, envAssertion, communicate, reward };
}
