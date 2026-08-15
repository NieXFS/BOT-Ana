export const TAU2_SCHEMA_VERSION = 1;
export const TAU2_REPORT_SCHEMA_VERSION = 6;

export const TAU2_ARM_IDS = [
  'flash',
  'luna',
  'flash_interpreter',
  'luna_interpreter',
  'flash_interpreter_voice',
] as const;

export type Tau2ArmId = (typeof TAU2_ARM_IDS)[number];

export interface Tau2ArmVector {
  readonly brain: 'flash' | 'luna';
  readonly interpreter: boolean;
  readonly voice: boolean;
}

export const TAU2_ARM_VECTORS: Record<Tau2ArmId, Tau2ArmVector> = {
  flash: { brain: 'flash', interpreter: false, voice: false },
  luna: { brain: 'luna', interpreter: false, voice: false },
  flash_interpreter: { brain: 'flash', interpreter: true, voice: false },
  luna_interpreter: { brain: 'luna', interpreter: true, voice: false },
  flash_interpreter_voice: { brain: 'flash', interpreter: true, voice: true },
};

export type Tau2UserMode =
  | 'oracle_user'
  | 'fixed_user_replay'
  | 'simulated_user'
  | 'no_user_task';

export type Tau2CommunicateKind = 'service' | 'date' | 'time' | 'money_cents';

export interface Tau2CommunicateItem {
  readonly kind: Tau2CommunicateKind;
  readonly id?: string;
  readonly label?: string;
  readonly value?: string | number;
  readonly timezone?: string;
}

export type Tau2EnvOp = 'eq' | 'neq' | 'gte' | 'lte' | 'includes' | 'not_includes';

export interface Tau2EnvAssertion {
  readonly path: string;
  readonly op: Tau2EnvOp;
  readonly expected: string | number | boolean | null;
}

export interface Tau2Task {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly user_scenario: {
    readonly persona: string;
    readonly goal: string;
    readonly known_facts: readonly string[];
    readonly unknown_facts: readonly string[];
    readonly constraints: readonly string[];
    readonly first_act: string;
    readonly stop_conditions: readonly string[];
  };
  readonly initial_state: {
    readonly now: string;
    readonly timezone: string;
    readonly catalog: readonly unknown[];
    readonly availability: readonly unknown[];
    readonly appointments: readonly unknown[];
    readonly conversation: {
      readonly history: readonly unknown[];
      readonly pending: null;
      readonly flow: null;
      readonly humanControl: Record<string, never>;
    };
    readonly pause: Record<string, never>;
    readonly optOut: boolean;
  };
  readonly evaluation_criteria: {
    readonly target_state: Record<string, unknown>;
    readonly env_assertions: readonly Tau2EnvAssertion[];
    readonly communicate_info: readonly Tau2CommunicateItem[];
    readonly reward_basis: readonly ('STATE' | 'ENV_ASSERTION' | 'COMMUNICATE')[];
  };
  readonly oracle_acts?: readonly string[];
}

export interface Tau2CanonicalState {
  readonly appointmentCount: number;
  readonly bookEffects: number;
  readonly cancelEffects: number;
  readonly pendingKind: string | null;
  readonly flowServiceId: string | null;
  readonly optOut: boolean;
  readonly paused: boolean;
  readonly outboundCount: number;
}

export interface Tau2Reward {
  readonly state: 0 | 1;
  readonly envAssertion: 0 | 1;
  readonly communicate: 0 | 1;
  readonly reward: 0 | 1;
}

export interface Tau2ToneScores {
  readonly warmth: number;
  readonly naturalness: number;
  readonly concision: number;
  readonly contextualFit: number;
  readonly nonRepetition: number;
}
