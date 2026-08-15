import type {
  Tau2CommunicateItem,
  Tau2EnvAssertion,
  Tau2Task,
} from './types';

const COMMUNICATE_KINDS = new Set(['service', 'date', 'time', 'money_cents']);
const ENV_OPS = new Set(['eq', 'neq', 'gte', 'lte', 'includes', 'not_includes']);
const REWARD_BASIS = new Set(['STATE', 'ENV_ASSERTION', 'COMMUNICATE']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseEnvAssertion(value: unknown): Tau2EnvAssertion | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string' || !ENV_OPS.has(String(value.op))) {
    return null;
  }
  const expected = value.expected;
  if (
    typeof expected !== 'string' &&
    typeof expected !== 'number' &&
    typeof expected !== 'boolean' &&
    expected !== null
  ) {
    return null;
  }
  return {
    path: value.path,
    op: value.op as Tau2EnvAssertion['op'],
    expected,
  };
}

function parseCommunicateItem(value: unknown): Tau2CommunicateItem | null {
  if (!isRecord(value) || !COMMUNICATE_KINDS.has(String(value.kind))) return null;
  return {
    kind: value.kind as Tau2CommunicateItem['kind'],
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.value === 'string' || typeof value.value === 'number'
      ? { value: value.value }
      : {}),
    ...(typeof value.timezone === 'string' ? { timezone: value.timezone } : {}),
  };
}

export function parseTau2TaskV2(raw: unknown): Tau2Task {
  if (!isRecord(raw)) {
    throw new Error('task τ² inválida: raiz');
  }
  if (raw.schemaVersion !== 1 || typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error('task τ² inválida: schema/id');
  }
  if (!isRecord(raw.user_scenario) || typeof raw.user_scenario.first_act !== 'string') {
    throw new Error(`task τ² inválida: user_scenario (${raw.id})`);
  }
  if (!isRecord(raw.initial_state) || typeof raw.initial_state.now !== 'string') {
    throw new Error(`task τ² inválida: initial_state (${raw.id})`);
  }
  if (!isRecord(raw.evaluation_criteria)) {
    throw new Error(`task τ² inválida: evaluation_criteria (${raw.id})`);
  }
  const criteria = raw.evaluation_criteria;
  if (!isRecord(criteria.target_state) || !Array.isArray(criteria.env_assertions)) {
    throw new Error(`task τ² inválida: target/env (${raw.id})`);
  }
  if (!Array.isArray(criteria.communicate_info) || !Array.isArray(criteria.reward_basis)) {
    throw new Error(`task τ² inválida: communicate/reward_basis (${raw.id})`);
  }
  const envAssertions = criteria.env_assertions.map((entry, index) => {
    const parsed = parseEnvAssertion(entry);
    if (!parsed) throw new Error(`task τ² inválida: env_assertions[${index}] (${raw.id})`);
    return parsed;
  });
  const communicateInfo = criteria.communicate_info.map((entry, index) => {
    const parsed = parseCommunicateItem(entry);
    if (!parsed) throw new Error(`task τ² inválida: communicate_info[${index}] (${raw.id})`);
    return parsed;
  });
  const rewardBasis = criteria.reward_basis.filter(
    (entry): entry is 'STATE' | 'ENV_ASSERTION' | 'COMMUNICATE' =>
      REWARD_BASIS.has(String(entry))
  );
  if (rewardBasis.length !== 3) {
    throw new Error(`task τ² inválida: reward_basis incompleto (${raw.id})`);
  }
  const scenario = raw.user_scenario;
  const initial = raw.initial_state;
  const conversation = isRecord(initial.conversation) ? initial.conversation : {};
  return {
    schemaVersion: 1,
    id: raw.id,
    user_scenario: {
      persona: String(scenario.persona ?? ''),
      goal: String(scenario.goal ?? ''),
      known_facts: Array.isArray(scenario.known_facts)
        ? scenario.known_facts.map(String)
        : [],
      unknown_facts: Array.isArray(scenario.unknown_facts)
        ? scenario.unknown_facts.map(String)
        : [],
      constraints: Array.isArray(scenario.constraints)
        ? scenario.constraints.map(String)
        : [],
      first_act: String(scenario.first_act),
      stop_conditions: Array.isArray(scenario.stop_conditions)
        ? scenario.stop_conditions.map(String)
        : [],
    },
    initial_state: {
      now: String(initial.now),
      timezone: String(initial.timezone ?? 'America/Sao_Paulo'),
      catalog: Array.isArray(initial.catalog) ? initial.catalog : [],
      availability: Array.isArray(initial.availability) ? initial.availability : [],
      appointments: Array.isArray(initial.appointments) ? initial.appointments : [],
      conversation: {
        history: Array.isArray(conversation.history) ? conversation.history : [],
        pending: null,
        flow: null,
        humanControl: {},
      },
      pause: isRecord(initial.pause) ? {} : {},
      optOut: Boolean(initial.optOut),
    },
    evaluation_criteria: {
      target_state: { ...criteria.target_state },
      env_assertions: envAssertions,
      communicate_info: communicateInfo,
      reward_basis: rewardBasis,
    },
    ...(Array.isArray(raw.oracle_acts)
      ? { oracle_acts: raw.oracle_acts.map(String) }
      : {}),
  };
}
