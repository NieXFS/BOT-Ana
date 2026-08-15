import { createHash } from 'crypto';
import type { Tau2CanonicalState, Tau2Task } from './types';

export const TAU2_CANONICAL_STATE_KEYS = [
  'appointmentCount',
  'bookEffects',
  'cancelEffects',
  'pendingKind',
  'flowServiceId',
  'optOut',
  'paused',
  'outboundCount',
] as const satisfies readonly (keyof Tau2CanonicalState)[];

export function emptyCanonicalStateV2(): Tau2CanonicalState {
  return {
    appointmentCount: 0,
    bookEffects: 0,
    cancelEffects: 0,
    pendingKind: null,
    flowServiceId: null,
    optOut: false,
    paused: false,
    outboundCount: 0,
  };
}

export function cloneInitialStateV2(
  initial: Tau2Task['initial_state']
): Tau2Task['initial_state'] {
  return JSON.parse(JSON.stringify(initial)) as Tau2Task['initial_state'];
}

export function projectInitialStateV2(
  initial: Tau2Task['initial_state']
): Tau2CanonicalState {
  const appointments = Array.isArray(initial.appointments)
    ? initial.appointments.length
    : 0;
  return {
    appointmentCount: appointments,
    bookEffects: 0,
    cancelEffects: 0,
    pendingKind: null,
    flowServiceId: null,
    optOut: Boolean(initial.optOut),
    paused: false,
    outboundCount: 0,
  };
}

function isCanonicalStateKey(
  key: string
): key is keyof Tau2CanonicalState {
  return (TAU2_CANONICAL_STATE_KEYS as readonly string[]).includes(key);
}

export function expectedCanonicalStateV2(
  initial: Tau2Task['initial_state'],
  target: Record<string, unknown>
): Tau2CanonicalState {
  const expected = projectInitialStateV2(initial);
  for (const [key, value] of Object.entries(target)) {
    if (!isCanonicalStateKey(key)) continue;
    (expected as unknown as Record<string, unknown>)[key] = value;
  }
  return expected;
}

export function canonicalStateHashV2(state: Tau2CanonicalState): string {
  const canonical = TAU2_CANONICAL_STATE_KEYS.map((key) => [key, state[key]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function projectSessionStateV2(input: {
  appointmentCount: number;
  bookEffects: number;
  cancelEffects: number;
  pendingKind: string | null;
  flowServiceId: string | null;
  optOut: boolean;
  paused: boolean;
  outboundCount: number;
}): Tau2CanonicalState {
  return {
    appointmentCount: input.appointmentCount,
    bookEffects: input.bookEffects,
    cancelEffects: input.cancelEffects,
    pendingKind: input.pendingKind,
    flowServiceId: input.flowServiceId,
    optOut: input.optOut,
    paused: input.paused,
    outboundCount: input.outboundCount,
  };
}
