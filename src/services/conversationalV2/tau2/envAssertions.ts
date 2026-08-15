import type { Tau2CanonicalState, Tau2EnvAssertion } from './types';
import { canonicalStateHashV2 } from './stateProjection';

function readPath(
  state: Tau2CanonicalState,
  path: string
): { ok: true; value: string | number | boolean | null } | { ok: false } {
  switch (path) {
    case 'appointmentCount':
    case 'appointments.length':
      return { ok: true, value: state.appointmentCount };
    case 'bookEffects':
    case 'writes.bookAppointment':
      return { ok: true, value: state.bookEffects };
    case 'cancelEffects':
    case 'writes.cancelAppointment':
      return { ok: true, value: state.cancelEffects };
    case 'pendingKind':
    case 'pending.kind':
      return { ok: true, value: state.pendingKind };
    case 'flowServiceId':
    case 'flow.fixedServiceId':
      return { ok: true, value: state.flowServiceId };
    case 'optOut':
      return { ok: true, value: state.optOut };
    case 'paused':
      return { ok: true, value: state.paused };
    case 'outboundCount':
      return { ok: true, value: state.outboundCount };
    default:
      return { ok: false };
  }
}

function compare(
  actual: string | number | boolean | null,
  op: Tau2EnvAssertion['op'],
  expected: Tau2EnvAssertion['expected']
): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'includes':
      return String(actual ?? '').includes(String(expected ?? ''));
    case 'not_includes':
      return !String(actual ?? '').includes(String(expected ?? ''));
  }
}

export function evaluateEnvAssertionsV2(
  state: Tau2CanonicalState,
  assertions: readonly Tau2EnvAssertion[]
): 0 | 1 {
  if (assertions.length === 0) return 1;
  return assertions.every((assertion) => {
    const actual = readPath(state, assertion.path);
    return actual.ok && compare(actual.value, assertion.op, assertion.expected);
  })
    ? 1
    : 0;
}

export function evaluateStateV2(
  actual: Tau2CanonicalState,
  expected: Tau2CanonicalState
): 0 | 1 {
  return canonicalStateHashV2(actual) === canonicalStateHashV2(expected) ? 1 : 0;
}
