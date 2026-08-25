import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import {
  bookingConfirmationGate,
} from '../src/services/bookingConfirmationGate';
import type {
  DeferredAvailabilityConstraintV2,
  FlowStateV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import { serializeTurnPlanReceiptV2 } from '../src/services/conversationalV2/receipts';
import {
  isAnaV2ServiceContextEnabled,
  isAnaV2ServiceResolverEnabled,
} from '../src/services/conversationalV2/featureFlag';
import { resolveCurrentInboundDateV2 } from '../src/services/conversationalV2/currentDateResolution';
import {
  captureDeferredAvailabilityConstraintV2,
  filterSlotsByDeferredWindowV2,
  inboundHasVaguePeriodV2,
  resolveServiceCorrectionDecisionV2,
  SERVICE_CONTEXT_REJECTED_COPY_V2,
  buildDeferredOpenServiceQuestionCopyV2,
  buildPolarityAmbiguityCopyV2,
} from '../src/services/conversationalV2/serviceContext';
import {
  evaluateBoundaryV2,
  UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2,
} from '../src/services/conversationalV2/boundary';
import {
  EMPTY_OPEN_SERVICE_CLARIFICATION_V2,
  VISIBLE_HANDOFF_CANONICAL_V2,
} from '../src/services/conversationalV2/recoveryCoordinator';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import {
  flushBuffer,
  __seedFlushBufferForTest,
  __resetFlushStateForTest,
} from '../src/messageHandler';
import { SilentEscalationHoldPersistenceError } from '../src/services/silentEscalationHold';
import type { ReceptionistTurnControl } from '../src/services/receptionistTurnDecision';
import {
  MemoryConversationalV2StateStore,
  resolveLatestFlowStateV2,
  type OutboundOutboxRecordV2,
  type PendingFrameRecordV2,
} from '../src/services/conversationalV2/stateStore';

const now = new Date('2026-08-13T15:00:00.000Z');
let clockMs = now.getTime();
function tick(): Date {
  clockMs += 1000;
  return new Date(clockMs);
}
const timezone = 'America/Sao_Paulo';
let serial = 0;
const nextId = () => `svc-ctx-${++serial}`;

// Catálogo estruturalmente grande e inteiramente sintético: 7 itens-núcleo +
// 100 serviços plausíveis, sem nomes, profissionais ou dados da cliente real.
const fillers = Array.from({ length: 100 }, (_, index) => ({
  id: `svc-filler-${index + 1}`,
  name: `Preenchimento Estético ${index + 1}`,
  durationMinutes: 30,
  price: 90,
  priceFormatted: 'R$ 90,00',
  professionalIds: ['prof-ana'],
}));

const catalog: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-repo',
      name: 'Reposição de unha',
      durationMinutes: 60,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-unha-inf',
      name: 'Unha infantil',
      durationMinutes: 45,
      price: 50,
      priceFormatted: 'R$ 50,00',
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-mani',
      name: 'Manicure',
      durationMinutes: 40,
      price: 40,
      priceFormatted: 'R$ 40,00',
      professionalIds: ['prof-ana'],
      aliases: ['fazer a mao', 'so a mao', 'manicure normal'],
    },
    {
      id: 'svc-pedi',
      name: 'Pedicure',
      durationMinutes: 40,
      price: 45,
      priceFormatted: 'R$ 45,00',
      professionalIds: ['prof-ana', 'prof-bia'],
      aliases: ['fazer o pe', 'so o pe'],
    },
    {
      id: 'svc-mani-pedi',
      name: 'Manicure e pedicure',
      durationMinutes: 70,
      price: 70,
      priceFormatted: 'R$ 70,00',
      professionalIds: ['prof-ana'],
      aliases: ['pe e mao', 'mao e pe', 'fazer pe e mao', 'fazer mao e pe'],
    },
    {
      id: 'svc-mani-trad',
      name: 'Manicure tradicional',
      durationMinutes: 40,
      price: 35,
      priceFormatted: 'R$ 35,00',
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-ana'],
    },
    ...fillers,
  ],
  professionals: [
    { id: 'prof-ana', name: 'Ana Silva' },
    { id: 'prof-bia', name: 'Bia Souza' },
  ],
};

const config = {
  tenantSlug: 'studio-viti',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-invalid',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone,
  waAccessToken: 'smoke-token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-V2-SVC-CTX',
  isActive: true,
  authoritativeCatalog: {
    tenant: {
      name: 'Studio Fixture',
      address: 'Rua Fixture, 1',
      city: 'São Paulo',
      state: 'SP',
    },
    services: catalog.services!.map((service) => ({ ...service })),
    professionals: catalog.professionals!.map((professional) => ({
      ...professional,
    })),
  },
} as TenantBotConfig;

const FAMILY_INBOUND =
  'Tem horário hoje após as 17:30? unha/pé e mão';
const OPEN_SERVICE_INBOUND =
  'Boa tarde! Tem horário hoje após as 17:30?';
const DEFERRED_OPEN_SERVICE_QUESTION_COPY =
  'Para eu consultar a agenda de hoje, depois das 17h30, qual serviço você quer fazer?';
const DEFERRED_OPEN_SERVICE_QUESTION_DATE_ONLY_COPY =
  'Para eu consultar a agenda de hoje, qual serviço você quer fazer?';
const DEFERRED_OPEN_SERVICE_QUESTION_WINDOW_ONLY_COPY =
  'Para eu consultar a agenda depois das 17h30, qual serviço você quer fazer?';
const DEFERRED_OPEN_SERVICE_QUESTION_FALLBACK_COPY =
  'Para eu consultar a agenda no período que você pediu, qual serviço você quer fazer?';
const FULL_SLOTS = ['16:00', '17:00', '17:30', '18:00', '18:30', '19:00'];
const DAY_SLOTS = [
  '08:00',
  '08:30',
  '09:00',
  '16:00',
  '17:00',
  '17:30',
  '18:00',
  '18:30',
  '19:00',
];
const AFTER_EXCLUSIVE_SLOTS = ['18:00', '18:30', '19:00'];
const SERVICE_QUESTION_COPY = 'Qual serviço você prefere?';
const DATE_QUESTION_COPY = 'Qual dia você prefere?';

function dateResolutionFor(text: string) {
  return resolveCurrentInboundDateV2({
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': text },
    now,
    timezone,
  });
}

function capture(text: string, at = now) {
  return captureDeferredAvailabilityConstraintV2({
    inboundText: text,
    dateResolution: dateResolutionFor(text),
    now: at,
    turnId: 'turn-capture',
    inputSequence: 1,
  });
}

function turnRuntime(text: string | readonly string[], sequence = 1, paused = false) {
  const texts = typeof text === 'string' ? [text] : [...text];
  const inboundIds = texts.map(() => nextId());
  return {
    inputSequence: sequence,
    currentInboundIds: inboundIds,
    currentInboundTextsById: Object.fromEntries(
      inboundIds.map((inboundId, index) => [inboundId, texts[index] ?? ''])
    ),
    checkpoint: async () => ({
      paused,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

function seedPending(
  store: MemoryConversationalV2StateStore,
  conversationKey: string,
  snapshot: PendingFrameSnapshotV2,
  flowState: PendingFrameRecordV2['flowState']
): void {
  store.pending.set(conversationKey, [
    {
      conversationKey,
      state: 'OPEN',
      snapshot,
      flowState,
      updatedAt: snapshot.askedAt,
    },
  ]);
}

function toolSlots(slots: readonly string[]) {
  return JSON.stringify({ success: true, slots: [...slots] });
}

function interpreterNenhumaLoop() {
  return {
    rawReply: '{"choice":"NENHUMA"}',
    exhausted: false,
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    providerReportedModels: ['gpt-4o-mini'],
    rounds: 1,
    messages: [],
    toolTrace: [],
    usage: [{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }],
  };
}

async function runTurn(input: {
  phone: string;
  text: string;
  store: MemoryConversationalV2StateStore;
  enabled: boolean;
  serviceResolverEnabled?: boolean;
  interpreterEnabled?: boolean;
  interpreterNenhuma?: boolean;
  regenerateServiceQuestion?: boolean;
  modelRawReply?: string;
  modelReply?: string;
  modelUnknownServiceText?: string | null;
  failRegenerate?: boolean;
  modelNextPending?: 'SERVICE' | 'PRESERVE';
  sequence?: number;
  slots?: readonly string[];
  toolResponse?: string;
  throwTool?: boolean;
  now?: Date;
  paused?: boolean;
  allowModel?: boolean;
  catalogOverride?: ServicesResult;
  configOverride?: TenantBotConfig;
  turnControl?: ReceptionistTurnControl;
  /** Literal multi-bubble batch used by the Laura fixture. */
  messages?: readonly string[];
  escalateSilent?: (input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string;
  }) => Promise<
    | { kind: 'created'; questionId: string }
    | { kind: 'pending' }
  >;
}) {
  const toolNames: string[] = [];
  const slotPayload = input.slots ?? FULL_SLOTS;
  const prepared = await getReceptionistReplyV2({
    phone: input.phone,
    userMessage: input.messages?.join(' ') ?? input.text,
    userName: 'Cliente',
    config: input.configOverride ?? config,
    interpreterEnabled: input.interpreterEnabled ?? false,
    serviceContextEnabled: input.enabled,
    serviceResolverEnabled: input.serviceResolverEnabled ?? false,
    ...(input.turnControl ? { turnControl: input.turnControl } : {}),
    turnRuntime: turnRuntime(
      input.messages ?? input.text,
      input.sequence ?? 1,
      input.paused ?? false
    ),
    deps: {
      store: input.store,
      now: () => input.now ?? tick(),
      id: nextId,
      loadServices: async () => input.catalogOverride ?? catalog,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: input.interpreterEnabled ?? false,
      serviceContextEnabled: input.enabled,
      serviceResolverEnabled: input.serviceResolverEnabled ?? false,
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({ success: true, appointments: [] }),
      escalateSilent:
        input.escalateSilent ??
        (async () => ({ kind: 'pending' as const })),
      runInterpreter: async () => {
        if (input.interpreterNenhuma) {
          return {
            kind: 'nenhuma' as const,
            loop: interpreterNenhumaLoop(),
            reason: 'model_nenhuma',
          };
        }
        throw new Error('planner/service-context não deve chamar o intérprete');
      },
      ...(input.regenerateServiceQuestion || input.failRegenerate
        ? {
            regenerate: async () => {
              if (input.failRegenerate) {
                return {
                  ok: false as const,
                  reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
                  providerCalls: 1 as const,
                };
              }
              return {
                ok: true as const,
                result: {
                  schemaVersion: 2 as const,
                  reply: SERVICE_QUESTION_COPY,
                  replyPurpose: 'SERVICE_QUESTION' as const,
                  pendingTransitionCandidate: { kind: 'preserve' as const },
                  resolutionCandidate: null,
                  unknownServiceEvidence: null,
                },
                resolutionProof: null,
                providerCalls: 1 as const,
              };
            },
          }
        : {}),
      runModelLoop: async () => {
        if (input.modelRawReply !== undefined) {
          return {
            rawReply: input.modelRawReply,
            exhausted: false,
            provider: 'openai',
            model: 'gpt-4o-mini',
            providerReportedModels: ['gpt-4o-mini'],
            rounds: 1,
            messages: [],
            toolTrace: [],
            usage: [{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }],
          };
        }
        if (input.allowModel) {
          return {
            rawReply: JSON.stringify({
              reply: input.modelReply ?? SERVICE_QUESTION_COPY,
              nextPending: input.modelNextPending ?? 'SERVICE',
              chosenOptionText: null,
              unknownServiceText: input.modelUnknownServiceText ?? null,
            }),
            exhausted: false,
            provider: 'openai',
            model: 'gpt-4o-mini',
            providerReportedModels: ['gpt-4o-mini'],
            rounds: 1,
            messages: [],
            toolTrace: [],
            usage: [{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }],
          };
        }
        throw new Error('planner/service-context não deve chamar o modelo');
      },
      executeTool: async (name) => {
        toolNames.push(name);
        if (name === 'getAvailableSlots') {
          if (input.throwTool) {
            throw new Error('executor_error');
          }
          if (input.toolResponse !== undefined) return input.toolResponse;
          return toolSlots(slotPayload);
        }
        if (name === 'getUpcomingAppointments') {
          return JSON.stringify({ success: true, appointments: [] });
        }
        throw new Error(`tool inesperada: ${name}`);
      },
    },
  });
  return { prepared, toolNames };
}

async function deliver(
  prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>,
  store: MemoryConversationalV2StateStore,
  sequence = 1,
  nowFactory: () => Date = tick
) {
  if (!prepared.payload) {
    throw new Error('entrega exige payload');
  }
  return deliverPreparedReceptionistTurnV2(prepared, {
    store,
    id: nextId,
    now: nowFactory,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
}

function nextFlowState(
  prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>
) {
  if (prepared.transition.kind === 'preserve') {
    return prepared.transition.nextFlowState ?? prepared.frame.flowState;
  }
  return prepared.transition.nextFlowState;
}

function openedTimeSlots(
  prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>
): string[] {
  if (prepared.transition.kind !== 'open') return [];
  if (prepared.transition.frame.kind !== 'TIME') return [];
  return prepared.transition.frame.options.map((option) => option.entityId);
}

function assertWindowOnlySlots(slots: readonly string[]): void {
  assert.deepEqual([...slots], [...AFTER_EXCLUSIVE_SLOTS]);
  for (const forbidden of ['08:00', '08:30', '09:00', '16:00', '17:00', '17:30']) {
    assert.equal(slots.includes(forbidden), false);
  }
}

function fixtureClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Simula reload do processo: nenhuma referência da instância anterior é reutilizada. */
function reloadMemoryStore(
  source: MemoryConversationalV2StateStore
): MemoryConversationalV2StateStore {
  const reloaded = new MemoryConversationalV2StateStore();
  for (const [key, rows] of source.pending) reloaded.pending.set(key, fixtureClone(rows));
  for (const [key, row] of source.outbox) reloaded.outbox.set(key, fixtureClone(row));
  for (const [key, row] of source.plans) reloaded.plans.set(key, fixtureClone(row));
  for (const [key, row] of source.deliveries) reloaded.deliveries.set(key, fixtureClone(row));
  for (const [key, row] of source.successors) reloaded.successors.set(key, fixtureClone(row));
  for (const [key, value] of source.inputSequences) reloaded.inputSequences.set(key, value);
  for (const [key, value] of source.flowStateInvalidations) {
    reloaded.flowStateInvalidations.set(key, fixtureClone(value));
  }
  for (const [key, value] of source.assistantHistory) {
    reloaded.assistantHistory.set(key, fixtureClone(value));
  }
  reloaded.transportPostCount = source.transportPostCount;
  return reloaded;
}

function assertDeferredOpenServiceQuestionCopy(copy: string): void {
  assert.doesNotMatch(copy, /tem horário/iu);
  assert.doesNotMatch(copy, /tem vaga/iu);
  assert.doesNotMatch(copy, /horários disponíveis/iu);
  assert.doesNotMatch(copy, /encontrei/iu);
  assert.doesNotMatch(copy, /verificar os horários/iu);
}

function evaluateDeferredOpenCopy(rawCandidate: string) {
  return evaluateBoundaryV2({
    rawCandidate,
    servicesResult: catalog,
    flowState: {
      flowId: 'flow-open-service',
      lastOperationalAt: now.toISOString(),
      deferredAvailability: FAMILY_SERVICE_CONSTRAINT,
      fixedByProofVersion: {},
    },
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'SERVICE',
      flowId: 'flow-open-service',
      optionEntityIds: [],
    },
    replyPurpose: 'SERVICE_QUESTION',
    source: 'CANONICAL',
    toolTrace: [],
    sourceInboundText: OPEN_SERVICE_INBOUND,
    currentInboundIds: ['in-open-service'],
    inboundTextsById: { 'in-open-service': OPEN_SERVICE_INBOUND },
    pendingSnapshot: {
      questionId: 'q-open-service',
      askedAt: now.toISOString(),
      kind: 'SERVICE',
      flowId: 'flow-open-service',
      version: 1,
      options: [],
    },
  });
}

function servicePendingFrame(
  askedAt = '2026-08-13T14:50:00.000Z'
): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: 'turn-corr',
    inputSequence: 1,
    catalogSnapshotHash: 'x',
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: ['in-corr'],
    pending: {
      questionId: 'q-corr',
      askedAt,
      kind: 'SERVICE',
      flowId: 'flow-corr',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    flowState: {
      flowId: 'flow-corr',
      lastOperationalAt: askedAt,
      fixedByProofVersion: {},
    },
  };
}

const FAMILY_SERVICE_CONSTRAINT: DeferredAvailabilityConstraintV2 = {
  schemaVersion: 1,
  capturedAt: now.toISOString(),
  capturedTurnId: 'turn-family',
  capturedInputSequence: 1,
  date: '2026-08-13',
  timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
};

function seedFamilyServicePending(
  store: MemoryConversationalV2StateStore,
  phone: string,
  flowId: string
): string {
  const key = `${config.phoneNumberId}:${phone}`;
  seedPending(
    store,
    key,
    {
      questionId: `q-${flowId}`,
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId,
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId,
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      deferredAvailability: FAMILY_SERVICE_CONSTRAINT,
      fixedByProofVersion: {},
    }
  );
  store.setInputSequence(key, 1);
  return key;
}

function assertNoSensitiveReceipt(
  prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>
) {
  const serialized = serializeTurnPlanReceiptV2(prepared.planReceipt, {
    forbiddenCatalogEntityIds: catalog.services!.map((entry) => entry.id),
    forbiddenPlaintextFragments: [
      'Reposição de unha',
      'Manicure',
      'Pedicure',
      FAMILY_INBOUND,
    ],
    forbiddenMessageIds: [...prepared.frame.currentInboundIds],
    forbiddenPhoneValues: ['5511999990000'],
  });
  assert.doesNotMatch(serialized, /wamid|svc-repo|messageId/u);
  const decision = prepared.planReceipt.serviceContextDecision;
  if (decision !== undefined) {
    assert.ok(
      [
        'disabled',
        'not_applicable',
        'temporal_deferred',
        'outside_pending_selection',
        'positive_reclarification',
        'negative_clarification',
      ].includes(decision)
    );
  }
}

async function main(): Promise<void> {
  assert.equal(isAnaV2ServiceContextEnabled('studio-viti', false), false);
  assert.equal(isAnaV2ServiceContextEnabled('studio-viti', true), true);
  assert.equal(isAnaV2ServiceResolverEnabled('studio-viti', false, true), false);
  assert.equal(isAnaV2ServiceResolverEnabled('studio-viti', true, true), true);
  assert.equal(
    isAnaV2ServiceResolverEnabled('studio-viti', undefined, true, '*'),
    false
  );
  assert.equal(
    isAnaV2ServiceResolverEnabled('studio-viti', undefined, false, 'studio-viti'),
    false
  );
  assert.equal(
    isAnaV2ServiceContextEnabled('studio-viti', undefined, '*'),
    false
  );
  assert.equal(
    isAnaV2ServiceContextEnabled('studio-viti', undefined, ''),
    false
  );
  assert.equal(
    isAnaV2ServiceContextEnabled('studio-viti', undefined, 'studio-viti'),
    false,
    'env do planner exige também a allowlist v2 no processo'
  );

  // --- LAURA_LITERAL_FLOW_2026_08_21 ---
  // Fixture independente do replay IA-22c: preserva as três bolhas reais do
  // primeiro lote, força reload entre cada turno e prova uma única leitura de
  // agenda sem qualquer write. O catálogo é deliberadamente inteiro, não o
  // subset histórico Reposição/Unha infantil.
  const LAURA_NOW = new Date('2026-08-21T15:00:00.000Z');
  const LAURA_FIRST_BUBBLES = [
    'Tem horário hoje após as 17:30?',
    'Ou amanhã de manhã pra fazer a unha?',
    'Pé e mão',
  ] as const;
  const LAURA_SLOTS = [
    '08:00',
    '10:00',
    '14:00',
    '17:00',
    '17:30',
    '18:00',
    '18:30',
    '19:00',
  ] as const;
  const LAURA_ALLOWED_SLOTS = ['18:00', '18:30', '19:00'] as const;
  const LAURA_CATALOG: ServicesResult = catalog;
  const lauraCatalogNames = new Set(catalog.services!.map((service) => service.name));
  for (const requiredName of [
    'Manicure',
    'Pedicure',
    'Manicure e pedicure',
    'Reposição de unha',
    'Unha infantil',
    'Manicure tradicional',
  ]) {
    assert.equal(lauraCatalogNames.has(requiredName), true, `Laura catalog: ${requiredName}`);
  }
  const lauraPhone = '5511000000501';
  const lauraKey = `${config.phoneNumberId}:${lauraPhone}`;
  let lauraStore = new MemoryConversationalV2StateStore();
  lauraStore.setInputSequence(lauraKey, 1);
  const lauraTurn1 = await runTurn({
    phone: lauraPhone,
    text: LAURA_FIRST_BUBBLES[0],
    messages: LAURA_FIRST_BUBBLES,
    store: lauraStore,
    enabled: true,
    serviceResolverEnabled: true,
    catalogOverride: LAURA_CATALOG,
    sequence: 1,
    now: LAURA_NOW,
  });
  assert.deepEqual(
    LAURA_FIRST_BUBBLES,
    ['Tem horário hoje após as 17:30?', 'Ou amanhã de manhã pra fazer a unha?', 'Pé e mão'],
    'Laura mantém as três bolhas e a ordem literal'
  );
  assert.equal(lauraTurn1.prepared.frame.currentInboundIds.length, 3);
  assert.ok(lauraTurn1.prepared.payload, 'Laura T1 has visible payload');
  assert.equal(lauraTurn1.toolNames.length, 0, 'Laura T1 has zero tools');
  assert.equal(lauraTurn1.prepared.hasCommittedWrite, false);
  assert.equal(
    lauraTurn1.prepared.planReceipt.toolEffects.some((effect) => effect.writeCommitted),
    false,
    'Laura T1 has zero writes'
  );
  assert.equal(
    (lauraTurn1.prepared.payload ?? '').includes('Preenchimento Estético'),
    false,
    'Laura T1 has no catalog mural'
  );
  assert.ok((lauraTurn1.prepared.payload ?? '').length < 500, 'Laura T1 remains compact');
  assert.match(
    lauraTurn1.prepared.payload ?? '',
    /hoje depois das 17h30|amanh[ãa] de manh[ãa]/iu,
    'Laura T1 names the two temporal windows'
  );
  assert.doesNotMatch(
    lauraTurn1.prepared.payload ?? '',
    /qual servi[cç]o|categoria|repetir/iu,
    'Laura T1 never asks for a service already stated'
  );
  assert.doesNotMatch(
    lauraTurn1.prepared.payload ?? '',
    /Reposi[cç][ãa]o de unha|Unha infantil/u,
    'Laura T1 never offers semantically wrong nail services'
  );
  assert.match(
    lauraTurn1.prepared.payload ?? '',
    /qual.*(janela|consultar primeiro)|hoje.*ou.*amanh[ãa]/iu,
    'Laura T1 asks only which window to consult first'
  );
  assert.equal(
    nextFlowState(lauraTurn1.prepared).fixedServiceId,
    'svc-mani-pedi',
    'Laura T1 resolves the combined service from the literal batch'
  );
  await deliver(lauraTurn1.prepared, lauraStore, 1, () => LAURA_NOW);

  // Kill-switch regression: the same conversation is re-entered with IA-24
  // OFF while its IA-24 OPEN window question still exists. The baseline route
  // must close that experimental row in the normal delivery CAS, then commit a
  // normal PendingFrame without a CAS conflict or deferred-window leakage.
  const flagOffLauraStore = reloadMemoryStore(lauraStore);
  flagOffLauraStore.setInputSequence(lauraKey, 2);
  const flagOffLaura = await runTurn({
    phone: lauraPhone,
    text: 'Quero agendar',
    store: flagOffLauraStore,
    enabled: true,
    serviceResolverEnabled: false,
    sequence: 2,
    now: LAURA_NOW,
    catalogOverride: LAURA_CATALOG,
    allowModel: true,
  });
  const flagOffDelivery = await deliver(flagOffLaura.prepared, flagOffLauraStore, 2, () => LAURA_NOW);
  assert.equal(flagOffDelivery.receipt.flowStateCommitOutcome, 'committed');
  assert.notEqual(flagOffDelivery.receipt.pendingCommitOutcome, 'cas_conflict');
  assert.equal(flagOffLauraStore.flowStateInvalidations.has(lauraKey), false);
  const flagOffState = await flagOffLauraStore.loadLatestState(lauraKey, LAURA_NOW);
  assert.notEqual(flagOffState.pending?.snapshot.kind, 'DATE');
  assert.equal(flagOffState.flowState?.deferredAvailability, undefined);

  // Reload 1: a new Memory instance is the process-restart fixture boundary.
  lauraStore = reloadMemoryStore(lauraStore);
  lauraStore.setInputSequence(lauraKey, 2);
  const lauraTurn2 = await runTurn({
    phone: lauraPhone,
    text: 'Hoje',
    store: lauraStore,
    enabled: true,
    serviceResolverEnabled: true,
    sequence: 2,
    now: LAURA_NOW,
    slots: LAURA_SLOTS,
    catalogOverride: LAURA_CATALOG,
  });
  assert.deepEqual(
    lauraTurn2.toolNames,
    ['getAvailableSlots'],
    'Laura T2 reads only the selected temporal window'
  );
  assert.ok(lauraTurn2.prepared.payload);
  assert.doesNotMatch(
    lauraTurn2.prepared.payload ?? '',
    /qual servi[cç]o|Reposi[cç][ãa]o de unha|Unha infantil/iu,
    'Laura T2 does not reopen service selection'
  );
  assert.equal(lauraTurn2.prepared.hasCommittedWrite, false);
  assert.equal(
    lauraTurn2.prepared.planReceipt.toolEffects.some((effect) => effect.writeCommitted),
    false
  );
  await deliver(lauraTurn2.prepared, lauraStore, 2, () => LAURA_NOW);

  // Reload after the single read: the pending TIME and filtered evidence must
  // survive a process boundary without reopening service selection.
  lauraStore = reloadMemoryStore(lauraStore);
  lauraStore.setInputSequence(lauraKey, 3);
  const lauraAfterReload = await lauraStore.loadLatestState(lauraKey, LAURA_NOW);
  assert.equal(lauraAfterReload.pending?.snapshot.kind, 'TIME');
  assert.deepEqual(lauraAfterReload.pending?.snapshot.options.map((option) => option.entityId), LAURA_ALLOWED_SLOTS);
  assert.deepEqual(lauraAfterReload.flowState.slotEvidence?.slots, LAURA_ALLOWED_SLOTS);
  assert.equal(
    [...lauraStore.outbox.values()].filter((record) =>
      record.transition.kind === 'open' && record.transition.frame.kind === 'TIME'
    ).length,
    1,
    'Laura has exactly one persisted TIME offer/read across restart'
  );

  // --- IA26_DEFERRED_WINDOW_LIFECYCLE ---
  // A fixture nasce do lote de inbound cru e só resolve o serviço pelo
  // catálogo. Nenhuma FlowState/PendingFrame é semeada para o caso principal.
  const IA26_NOW = new Date('2026-08-24T15:00:00.000Z');
  const IA26_FIRST_BUBBLES = [
    'Tem horário hoje após as 17:30?',
    'ou amanhã de manhã pra fazer a unha?',
    'pé e mão',
  ] as const;
  const IA26_THREE_WINDOW_BUBBLES = [
    'Tem horário hoje após as 17:30?',
    'ou amanhã de manhã pra fazer a unha?',
    'depois de amanhã à tarde',
    'pé e mão',
  ] as const;
  const IA26_MORNING_AND_LATER_SLOTS = [
    '08:00',
    '10:00',
    '11:30',
    '12:00',
    '18:00',
  ] as const;

  function assertIa26Deterministic(
    prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>,
    label: string
  ): void {
    assert.equal(prepared.planReceipt.route, 'fast_path', `${label}: route`);
    assert.equal(prepared.planReceipt.primaryProviderCalls, 0, `${label}: primary provider`);
    assert.equal(prepared.planReceipt.regenProviderCalls, 0, `${label}: regeneration provider`);
    assert.equal(prepared.hasCommittedWrite, false, `${label}: no committed write`);
    assert.equal(
      prepared.planReceipt.toolEffects.some((effect) => effect.class === 'write'),
      false,
      `${label}: no write effect`
    );
  }

  async function openIa26Batch(
    phone: string,
    messages: readonly string[]
  ): Promise<{
    store: MemoryConversationalV2StateStore;
    key: string;
    prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>;
  }> {
    const store = new MemoryConversationalV2StateStore();
    const key = `${config.phoneNumberId}:${phone}`;
    store.setInputSequence(key, 1);
    const prepared = await runTurn({
      phone,
      text: messages[0] ?? '',
      messages,
      store,
      enabled: true,
      serviceResolverEnabled: true,
      catalogOverride: catalog,
      sequence: 1,
      now: IA26_NOW,
    });
    assertIa26Deterministic(prepared.prepared, `${phone}: initial raw batch`);
    assert.equal(prepared.toolNames.length, 0, `${phone}: initial batch has no read`);
    assert.equal(
      nextFlowState(prepared.prepared).fixedServiceId,
      'svc-mani-pedi',
      `${phone}: service resolved from raw batch`
    );
    assert.ok(
      nextFlowState(prepared.prepared).deferredAvailability,
      `${phone}: deferred aggregate captured`
    );
    await deliver(prepared.prepared, store, 1, () => IA26_NOW);
    return {
      store: reloadMemoryStore(store),
      key,
      prepared: prepared.prepared,
    };
  }

  function assertIa26TwoWindowAggregate(
    state: FlowStateV2 | undefined,
    expectedDates: readonly string[],
    label: string
  ): void {
    assert.equal(state?.deferredAvailability?.schemaVersion, 2, `${label}: schemaVersion 2`);
    assert.deepEqual(
      state?.deferredAvailability?.windows?.map((window) => window.date),
      expectedDates,
      `${label}: remaining dates`
    );
  }

  // Gate mínimo, passo 1: hoje fica vazio, só amanhã de manhã sobrevive.
  const ia26Primary = await openIa26Batch('5511000000701', IA26_FIRST_BUBBLES);
  ia26Primary.store.setInputSequence(ia26Primary.key, 2);
  const ia26FirstEmpty = await runTurn({
    phone: '5511000000701',
    text: 'Pode conferir hoje primeiro',
    store: ia26Primary.store,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 2,
    now: IA26_NOW,
    slots: [],
  });
  assertIa26Deterministic(ia26FirstEmpty.prepared, 'IA26 primary empty today');
  assert.deepEqual(ia26FirstEmpty.toolNames, ['getAvailableSlots']);
  assert.equal(
    ia26FirstEmpty.prepared.planReceipt.toolEffects.filter(
      (effect) => effect.tool === 'getAvailableSlots'
    ).length,
    1,
    'IA26 primary empty: exactly one availability read'
  );
  assert.equal(ia26FirstEmpty.prepared.planReceipt.serviceContextDecision, 'temporal_deferred');
  assert.equal(ia26FirstEmpty.prepared.transition.kind, 'open');
  if (ia26FirstEmpty.prepared.transition.kind === 'open') {
    assert.equal(ia26FirstEmpty.prepared.transition.frame.kind, 'DATE');
    assert.deepEqual(
      ia26FirstEmpty.prepared.transition.frame.options.map((option) => option.entityId),
      ['window:0'],
      'IA26 primary empty: next pending points to the known alternative'
    );
  }
  const ia26AfterFirstEmpty = nextFlowState(ia26FirstEmpty.prepared);
  assert.equal(ia26AfterFirstEmpty.deferredAvailability?.schemaVersion, 1);
  assert.equal(ia26AfterFirstEmpty.deferredAvailability?.date, '2026-08-25');
  assert.deepEqual(ia26AfterFirstEmpty.deferredAvailability?.timeWindow, {
    kind: 'PERIOD',
    period: 'morning',
  });
  assert.equal(ia26AfterFirstEmpty.deferredAvailability?.windows, undefined);
  assert.match(ia26FirstEmpty.prepared.payload ?? '', /amanh[ãa] de manh[ãa]/iu);
  assert.doesNotMatch(
    ia26FirstEmpty.prepared.payload ?? '',
    /qual outro dia|date-freeform|outro dia ou per[ií]odo/iu,
    'IA26 primary empty: no generic date-freeform while alternative is known'
  );
  await deliver(ia26FirstEmpty.prepared, ia26Primary.store, 2, () => IA26_NOW);

  // Gate mínimo, reload + passo 2: “amanhã de manhã” é uma seleção conhecida,
  // portanto não cai no modelo e não oferece tarde/noite.
  const ia26Reloaded = reloadMemoryStore(ia26Primary.store);
  ia26Reloaded.setInputSequence(ia26Primary.key, 3);
  const ia26Morning = await runTurn({
    phone: '5511000000701',
    text: 'amanhã de manhã',
    store: ia26Reloaded,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 3,
    now: IA26_NOW,
    slots: IA26_MORNING_AND_LATER_SLOTS,
  });
  assertIa26Deterministic(ia26Morning.prepared, 'IA26 morning after reload');
  assert.equal(ia26Morning.prepared.planReceipt.serviceContextDecision, 'temporal_deferred');
  assert.deepEqual(ia26Morning.toolNames, ['getAvailableSlots']);
  assert.equal(
    ia26Morning.prepared.transition.kind,
    'open',
    'IA26 morning: TIME pending is visible'
  );
  if (ia26Morning.prepared.transition.kind === 'open') {
    assert.equal(ia26Morning.prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      ia26Morning.prepared.transition.frame.options.map((option) => option.entityId),
      ['08:00', '10:00', '11:30'],
      'IA26 morning: only morning slots survive the deferred filter'
    );
  }
  assert.doesNotMatch(ia26Morning.prepared.payload ?? '', /12h|18h/iu);
  assert.equal(nextFlowState(ia26Morning.prepared).deferredAvailability, undefined);

  // Primeira janela com horários: a alternativa não interfere e o lifecycle
  // avança diretamente para TIME.
  const ia26WithSlots = await openIa26Batch('5511000000702', IA26_FIRST_BUBBLES);
  ia26WithSlots.store.setInputSequence(ia26WithSlots.key, 2);
  const ia26Available = await runTurn({
    phone: '5511000000702',
    text: 'Pode conferir hoje primeiro',
    store: ia26WithSlots.store,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 2,
    now: IA26_NOW,
    slots: ['08:00', '18:00'],
  });
  assertIa26Deterministic(ia26Available.prepared, 'IA26 available first window');
  assert.deepEqual(ia26Available.toolNames, ['getAvailableSlots']);
  assert.equal(ia26Available.prepared.transition.kind, 'open');
  if (ia26Available.prepared.transition.kind === 'open') {
    assert.equal(ia26Available.prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      ia26Available.prepared.transition.frame.options.map((option) => option.entityId),
      ['18:00']
    );
  }
  assert.equal(nextFlowState(ia26Available.prepared).deferredAvailability, undefined);

  // Erro técnico: não é zero disponibilidade; o agregado original inteiro
  // continua retryable e a pergunta não abre date-freeform.
  const ia26ExecutorError = await openIa26Batch('5511000000703', IA26_FIRST_BUBBLES);
  ia26ExecutorError.store.setInputSequence(ia26ExecutorError.key, 2);
  const ia26Error = await runTurn({
    phone: '5511000000703',
    text: 'Pode conferir hoje primeiro',
    store: ia26ExecutorError.store,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 2,
    now: IA26_NOW,
    toolResponse: JSON.stringify({ success: false, reason: 'executor_error' }),
  });
  assertIa26Deterministic(ia26Error.prepared, 'IA26 executor error');
  assert.deepEqual(ia26Error.toolNames, ['getAvailableSlots']);
  assert.match(ia26Error.prepared.payload ?? '', /n[aã]o consegui consultar/iu);
  assert.doesNotMatch(ia26Error.prepared.payload ?? '', /n[aã]o encontrei/iu);
  assertIa26TwoWindowAggregate(
    nextFlowState(ia26Error.prepared),
    ['2026-08-24', '2026-08-25'],
    'IA26 executor error'
  );
  if (ia26Error.prepared.transition.kind === 'open') {
    assert.deepEqual(
      ia26Error.prepared.transition.frame.options.map((option) => option.entityId),
      ['window:0', 'window:1']
    );
  }

  // Três janelas: cada zero remove exatamente a escolhida, incluindo a
  // transição schema 2 -> schema 1; nenhuma janela consumida reaparece.
  const ia26Three = await openIa26Batch('5511000000704', IA26_THREE_WINDOW_BUBBLES);
  assert.equal(
    nextFlowState(ia26Three.prepared).deferredAvailability?.windows?.length,
    3,
    'IA26 three windows: raw batch captured all three'
  );
  ia26Three.store.setInputSequence(ia26Three.key, 2);
  const ia26ThreeFirst = await runTurn({
    phone: '5511000000704',
    text: 'hoje',
    store: ia26Three.store,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 2,
    now: IA26_NOW,
    slots: [],
  });
  assertIa26Deterministic(ia26ThreeFirst.prepared, 'IA26 three windows first empty');
  assertIa26TwoWindowAggregate(
    nextFlowState(ia26ThreeFirst.prepared),
    ['2026-08-25', '2026-08-26'],
    'IA26 three windows after first empty'
  );
  await deliver(ia26ThreeFirst.prepared, ia26Three.store, 2, () => IA26_NOW);
  const ia26ThreeReloaded = reloadMemoryStore(ia26Three.store);
  ia26ThreeReloaded.setInputSequence(ia26Three.key, 3);
  const ia26ThreeSecond = await runTurn({
    phone: '5511000000704',
    text: 'amanhã de manhã',
    store: ia26ThreeReloaded,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 3,
    now: IA26_NOW,
    slots: [],
  });
  assertIa26Deterministic(ia26ThreeSecond.prepared, 'IA26 three windows second empty');
  assert.equal(nextFlowState(ia26ThreeSecond.prepared).deferredAvailability?.schemaVersion, 1);
  assert.equal(nextFlowState(ia26ThreeSecond.prepared).deferredAvailability?.date, '2026-08-26');
  assert.deepEqual(nextFlowState(ia26ThreeSecond.prepared).deferredAvailability?.timeWindow, {
    kind: 'PERIOD',
    period: 'afternoon',
  });
  assert.equal(nextFlowState(ia26ThreeSecond.prepared).deferredAvailability?.windows, undefined);
  assert.doesNotMatch(ia26ThreeSecond.prepared.payload ?? '', /2026-08-24|hoje/iu);

  // Takeover entre consultas: o cutoff durável vence pending/outbox antigos e
  // impede que uma janela remanescente ressuscite no turno humano.
  const ia26Takeover = await openIa26Batch('5511000000705', IA26_FIRST_BUBBLES);
  ia26Takeover.store.setInputSequence(ia26Takeover.key, 2);
  const ia26TakeoverFirst = await runTurn({
    phone: '5511000000705',
    text: 'Pode conferir hoje primeiro',
    store: ia26Takeover.store,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
    catalogOverride: catalog,
    sequence: 2,
    now: IA26_NOW,
    slots: [],
  });
  await deliver(ia26TakeoverFirst.prepared, ia26Takeover.store, 2, () => IA26_NOW);
  const takeoverAt = new Date('2026-08-24T15:01:00.000Z');
  await ia26Takeover.store.recordFlowStateInvalidation({
    conversationKey: ia26Takeover.key,
    reason: 'HUMAN_OWNERSHIP',
    now: takeoverAt,
  });
  ia26Takeover.store.setInputSequence(ia26Takeover.key, 3);
  const ia26TakeoverTurn = await runTurn({
    phone: '5511000000705',
    text: 'amanhã de manhã',
    store: ia26Takeover.store,
    enabled: true,
    serviceResolverEnabled: true,
    catalogOverride: catalog,
    sequence: 3,
    now: takeoverAt,
    turnControl: {
      disposition: 'HUMAN_ACTIVE',
      resumeDecision: 'KEEP_HUMAN',
    },
  });
  assert.equal(ia26TakeoverTurn.prepared.preemption, 'HUMAN_ACTIVE');
  assert.equal(ia26TakeoverTurn.prepared.payload, null);
  assert.equal(ia26TakeoverTurn.toolNames.length, 0);
  assert.equal(nextFlowState(ia26TakeoverTurn.prepared).deferredAvailability, undefined);
  assert.equal(
    (await ia26Takeover.store.loadLatestState(ia26Takeover.key, takeoverAt)).flowState
      ?.deferredAvailability,
    undefined,
    'IA26 takeover cutoff: no deferred window resurrects'
  );

  // --- IA24_RUNTIME_DETERMINISTIC_MATRIX ---
  // Todas as rotas abaixo usam o runModelLoop/interpreter throwing da fixture;
  // uma aprovação só é válida se o planner resolver sem fabricar resposta do
  // modelo.
  async function deterministicServiceTurn(
    text: string,
    catalogOverride: ServicesResult = LAURA_CATALOG,
    configOverride?: TenantBotConfig
  ) {
    const store = new MemoryConversationalV2StateStore();
    const phone = `55110000006${String(serial).padStart(2, '0')}`;
    const key = `${config.phoneNumberId}:${phone}`;
    store.setInputSequence(key, 1);
    const turn = await runTurn({
      phone,
      text,
      store,
      enabled: true,
      serviceResolverEnabled: true,
      catalogOverride,
      configOverride,
      sequence: 1,
      now: LAURA_NOW,
    });
    assert.equal(turn.toolNames.length, 0, `${text}: no tool`);
    assert.equal(turn.prepared.planReceipt.primaryModelRounds, 0, `${text}: no model rounds`);
    assert.equal(turn.prepared.planReceipt.primaryProviderCalls, 0, `${text}: no provider calls`);
    assert.equal(turn.prepared.hasCommittedWrite, false, `${text}: no write`);
    return turn;
  }

  for (const [text, serviceId] of [
    ['pé e mão', 'svc-mani-pedi'],
    ['mão e pé', 'svc-mani-pedi'],
    ['fazer pé e mão', 'svc-mani-pedi'],
    ['fazer a mão', 'svc-mani'],
    ['fazer o pé', 'svc-pedi'],
    ['Manicure', 'svc-mani'],
    ['Manicure normal', 'svc-mani'],
    ['Manicure e pedicure', 'svc-mani-pedi'],
    ['Reposição de unha', 'svc-repo'],
    ['Unha infantil', 'svc-unha-inf'],
  ] as const) {
    const turn = await deterministicServiceTurn(text);
    assert.equal(nextFlowState(turn.prepared).fixedServiceId, serviceId, `${text}: service`);
  }
  for (const text of ['fazer a unha', 'quero fazer unha', 'serviço de unha']) {
    const turn = await deterministicServiceTurn(text);
    assert.equal(nextFlowState(turn.prepared).fixedServiceId, undefined, `${text}: ambiguous`);
    assert.match(turn.prepared.payload ?? '', /Manicure|Pedicure/u);
    assert.doesNotMatch(turn.prepared.payload ?? '', /Reposição de unha|Unha infantil/u);
    assert.equal(turn.prepared.transition.kind, 'open');
    if (turn.prepared.transition.kind === 'open') {
      assert.equal(turn.prepared.transition.frame.kind, 'SERVICE');
      assert.deepEqual(
        turn.prepared.transition.frame.options.map((option) => option.entityId),
        ['svc-mani', 'svc-pedi', 'svc-mani-pedi']
      );
    }
  }
  for (const text of ['Não é manicure normal', 'Não é só manicure mesmo', 'Não é reposição']) {
    const turn = await deterministicServiceTurn(text);
    assert.equal(nextFlowState(turn.prepared).fixedServiceId, undefined, `${text}: negative`);
    assert.match(turn.prepared.payload ?? '', /confirmar|serviço/iu);
  }
  const corrected = await deterministicServiceTurn('Não, quero pé e mão');
  assert.equal(nextFlowState(corrected.prepared).fixedServiceId, 'svc-mani-pedi');

  const duplicateAliasRuntimeCatalog: ServicesResult = {
    success: true,
    services: [
      { ...catalog.services![0]!, id: 'dup-a', name: 'Serviço A', aliases: ['termo duplicado'] },
      { ...catalog.services![1]!, id: 'dup-b', name: 'Serviço B', aliases: ['termo duplicado'] },
    ],
    professionals: catalog.professionals,
  };
  const duplicateRuntime = await deterministicServiceTurn(
    'termo duplicado',
    duplicateAliasRuntimeCatalog
  );
  assert.equal(nextFlowState(duplicateRuntime.prepared).fixedServiceId, undefined);
  assert.match(duplicateRuntime.prepared.payload ?? '', /Serviço A|Serviço B/u);

  const inactiveRuntimeCatalog: ServicesResult = {
    success: true,
    services: [{ ...catalog.services![0]!, id: 'inactive', name: 'Serviço inativo', aliases: ['termo inativo'], active: false } as ServicesResult['services'][number]],
    professionals: catalog.professionals,
  };
  const inactiveRuntime = await deterministicServiceTurn('termo inativo', inactiveRuntimeCatalog);
  assert.equal(nextFlowState(inactiveRuntime.prepared).fixedServiceId, undefined);
  assert.equal(inactiveRuntime.prepared.planReceipt.primaryModelRounds, 0);

  const noAliasesRuntime = await deterministicServiceTurn(
    'Manicure',
    { success: true, services: [{ ...catalog.services!.find((service) => service.id === 'svc-mani')!, aliases: [] }], professionals: catalog.professionals },
    {
      ...config,
      authoritativeCatalog: {
        ...config.authoritativeCatalog!,
        services: [{ ...config.authoritativeCatalog!.services.find((service) => service.id === 'svc-mani')!, aliases: [] }],
      },
    }
  );
  assert.equal(nextFlowState(noAliasesRuntime.prepared).fixedServiceId, 'svc-mani');

  const flagOffStore = new MemoryConversationalV2StateStore();
  const flagOffPhone = '5511000000650';
  flagOffStore.setInputSequence(`${config.phoneNumberId}:${flagOffPhone}`, 1);
  const flagOff = await runTurn({
    phone: flagOffPhone,
    text: 'pé e mão',
    store: flagOffStore,
    enabled: true,
    serviceResolverEnabled: false,
    catalogOverride: LAURA_CATALOG,
    sequence: 1,
    now: LAURA_NOW,
    allowModel: true,
  });
  assert.notEqual(nextFlowState(flagOff.prepared).fixedServiceId, 'svc-mani-pedi');
  assert.equal(flagOff.prepared.planReceipt.primaryModelRounds > 0, true);

  async function runLauraNegativeBranch(
    phone: string,
    text: 'Não é só manicure mesmo' | 'Não é manicure normal'
  ): Promise<void> {
    const store = new MemoryConversationalV2StateStore();
    const key = `${config.phoneNumberId}:${phone}`;
    seedPending(
      store,
      key,
      {
        questionId: `q-${phone}`,
        askedAt: LAURA_NOW.toISOString(),
        kind: 'SERVICE',
        flowId: `flow-${phone}`,
        version: 1,
        options: [
          { position: 1, entityId: 'svc-mani', displayName: 'Manicure' },
          { position: 2, entityId: 'svc-pedi', displayName: 'Pedicure' },
          { position: 3, entityId: 'svc-mani-pedi', displayName: 'Manicure e pedicure' },
          { position: 4, entityId: 'svc-mani-trad', displayName: 'Manicure tradicional' },
        ],
      },
      { flowId: `flow-${phone}`, lastOperationalAt: LAURA_NOW.toISOString(), fixedByProofVersion: {} }
    );
    store.setInputSequence(key, 1);
    const turn = await runTurn({
      phone,
      text,
      store,
      enabled: true,
      serviceResolverEnabled: true,
      interpreterEnabled: true,
      sequence: 1,
      now: LAURA_NOW,
      catalogOverride: LAURA_CATALOG,
    });
    assert.equal(turn.toolNames.length, 0, `${text}: no tool before service is unequivocal`);
    assert.ok(turn.prepared.payload, `${text}: visible clarification`);
    assert.equal(nextFlowState(turn.prepared).fixedServiceId, undefined, `${text}: negation never selects service`);
    assert.equal(turn.prepared.hasCommittedWrite, false);
    assert.equal(
      turn.prepared.planReceipt.toolEffects.some((effect) => effect.writeCommitted),
      false,
      `${text}: zero writes`
    );
    if (turn.prepared.transition.kind === 'open') {
      assert.notDeepEqual(
        turn.prepared.transition.frame.options.map((option) => option.entityId),
        ['svc-repo', 'svc-unha-inf'],
        `${text}: no historical two-item subset`
      );
    }
  }
  await runLauraNegativeBranch('5511000000502', 'Não é só manicure mesmo');
  await runLauraNegativeBranch('5511000000503', 'Não é manicure normal');

  const after = capture('Tem horário hoje após as 17:30?');
  assert.equal(after.kind, 'captured');
  if (after.kind === 'captured') {
    assert.equal(after.constraint.date, '2026-08-13');
    assert.deepEqual(after.constraint.timeWindow, {
      kind: 'AFTER_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    });
  }
  const depois = capture('hoje depois das 17:30');
  assert.equal(depois.kind, 'captured');
  if (depois.kind === 'captured') {
    assert.equal(depois.constraint.timeWindow?.kind, 'AFTER_EXCLUSIVE');
  }
  const from = capture('hoje a partir das 17:30');
  assert.equal(from.kind, 'captured');
  if (from.kind === 'captured') {
    assert.deepEqual(from.constraint.timeWindow, {
      kind: 'AT_OR_AFTER',
      minuteOfDay: 17 * 60 + 30,
    });
  }
  const before = capture('hoje antes das 17:30');
  assert.equal(before.kind, 'captured');
  if (before.kind === 'captured') {
    assert.equal(before.constraint.timeWindow?.kind, 'BEFORE_EXCLUSIVE');
  }
  const until = capture('hoje até 17:30');
  assert.equal(until.kind, 'captured');
  if (until.kind === 'captured') {
    assert.equal(until.constraint.timeWindow?.kind, 'AT_OR_BEFORE');
  }
  const between = capture('hoje entre 17:30 e 19:00');
  assert.equal(between.kind, 'captured');
  if (between.kind === 'captured') {
    assert.deepEqual(between.constraint.timeWindow, {
      kind: 'BETWEEN_INCLUSIVE',
      startMinute: 17 * 60 + 30,
      endMinute: 19 * 60,
    });
  }
  assert.deepEqual(
    filterSlotsByDeferredWindowV2(FULL_SLOTS, {
      kind: 'AFTER_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    }),
    AFTER_EXCLUSIVE_SLOTS
  );
  assert.deepEqual(
    filterSlotsByDeferredWindowV2(FULL_SLOTS, {
      kind: 'AT_OR_AFTER',
      minuteOfDay: 17 * 60 + 30,
    }),
    ['17:30', '18:00', '18:30', '19:00']
  );
  assert.deepEqual(
    filterSlotsByDeferredWindowV2(FULL_SLOTS, {
      kind: 'BEFORE_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    }),
    ['16:00', '17:00']
  );
  assert.deepEqual(
    filterSlotsByDeferredWindowV2(FULL_SLOTS, {
      kind: 'AT_OR_BEFORE',
      minuteOfDay: 17 * 60 + 30,
    }),
    ['16:00', '17:00', '17:30']
  );
  assert.deepEqual(
    filterSlotsByDeferredWindowV2(FULL_SLOTS, {
      kind: 'BETWEEN_INCLUSIVE',
      startMinute: 17 * 60 + 30,
      endMinute: 19 * 60,
    }),
    ['17:30', '18:00', '18:30', '19:00']
  );

  const ordinalDate = dateResolutionFor('segunda opção');
  assert.equal(ordinalDate.kind, 'none');
  const ordinalCapture = capture('segunda opção');
  assert.equal(ordinalCapture.kind, 'none');
  const terca = dateResolutionFor('terça');
  assert.equal(terca.kind, 'resolved');
  if (terca.kind === 'resolved') {
    assert.match(terca.date, /^\d{4}-\d{2}-\d{2}$/u);
    assert.notEqual(terca.date, '2026-08-13');
  }

  assert.equal(
    inboundHasVaguePeriodV2('Boa tarde, tem horário para unha?'),
    false
  );
  assert.equal(
    inboundHasVaguePeriodV2('Boa noite, quero agendar unha'),
    false
  );
  assert.equal(inboundHasVaguePeriodV2('Tem horário sexta à tarde?'), true);
  assert.equal(
    capture('Boa tarde, tem horário para unha?').kind,
    'none'
  );
  assert.equal(capture('Boa noite, quero agendar unha').kind, 'none');
  assert.equal(capture('Tem horário sexta à tarde?').kind, 'vague_period');

  const dateAndWindowConstraint: DeferredAvailabilityConstraintV2 = {
    schemaVersion: 1,
    capturedAt: now.toISOString(),
    capturedTurnId: 'turn-open-copy',
    capturedInputSequence: 1,
    date: '2026-08-13',
    timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
  };
  assert.equal(
    buildDeferredOpenServiceQuestionCopyV2(dateAndWindowConstraint, now, timezone),
    DEFERRED_OPEN_SERVICE_QUESTION_COPY
  );
  assert.equal(
    buildDeferredOpenServiceQuestionCopyV2(
      { ...dateAndWindowConstraint, timeWindow: undefined },
      now,
      timezone
    ),
    DEFERRED_OPEN_SERVICE_QUESTION_DATE_ONLY_COPY
  );
  assert.equal(
    buildDeferredOpenServiceQuestionCopyV2(
      { ...dateAndWindowConstraint, date: undefined },
      now,
      timezone
    ),
    DEFERRED_OPEN_SERVICE_QUESTION_WINDOW_ONLY_COPY
  );
  assert.equal(
    buildDeferredOpenServiceQuestionCopyV2(
      { ...dateAndWindowConstraint, date: undefined, timeWindow: undefined },
      now,
      timezone
    ),
    DEFERRED_OPEN_SERVICE_QUESTION_FALLBACK_COPY
  );
  assertDeferredOpenServiceQuestionCopy(DEFERRED_OPEN_SERVICE_QUESTION_COPY);
  assertDeferredOpenServiceQuestionCopy(DEFERRED_OPEN_SERVICE_QUESTION_DATE_ONLY_COPY);
  assertDeferredOpenServiceQuestionCopy(DEFERRED_OPEN_SERVICE_QUESTION_WINDOW_ONLY_COPY);
  assertDeferredOpenServiceQuestionCopy(DEFERRED_OPEN_SERVICE_QUESTION_FALLBACK_COPY);

  const pendingFrame = servicePendingFrame();
  assert.equal(
    resolveServiceCorrectionDecisionV2({
      inboundText: 'Reposição de unha',
      frame: pendingFrame,
      catalog,
      now,
    }).kind,
    'none'
  );
  assert.equal(
    resolveServiceCorrectionDecisionV2({
      inboundText: '2',
      frame: pendingFrame,
      catalog,
      now,
    }).kind,
    'none'
  );
  const manicureDecision = resolveServiceCorrectionDecisionV2({
    inboundText: 'Manicure',
    frame: pendingFrame,
    catalog,
    now,
  });
  assert.equal(manicureDecision.kind, 'select_outside_pending');
  if (manicureDecision.kind === 'select_outside_pending') {
    assert.equal(manicureDecision.serviceId, 'svc-mani');
  }

  const familyOnStore = new MemoryConversationalV2StateStore();
  const familyOnPhone = '5511000000221';
  familyOnStore.setInputSequence(
    `${config.phoneNumberId}:${familyOnPhone}`,
    1
  );
  const familyOn = await runTurn({
    phone: familyOnPhone,
    text: FAMILY_INBOUND,
    store: familyOnStore,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: true,
  });
  assert.equal(familyOn.prepared.planReceipt.route, 'fast_path');
  assert.equal(
    familyOn.prepared.planReceipt.serviceContextDecision,
    'temporal_deferred'
  );
  assert.deepEqual(familyOn.toolNames, ['getAvailableSlots']);
  assert.equal(familyOn.prepared.transition.kind, 'open');
  if (familyOn.prepared.transition.kind === 'open') {
    assert.equal(familyOn.prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      familyOn.prepared.transition.frame.options.map((option) => option.entityId),
      AFTER_EXCLUSIVE_SLOTS
    );
  }
  assert.match(familyOn.prepared.payload ?? '', /18:00/u);
  assert.doesNotMatch(familyOn.prepared.payload ?? '', /Reposição de unha|Unha infantil/u);
  assert.doesNotMatch(familyOn.prepared.payload ?? '', /Preenchimento Estético/u);
  assert.equal(familyOn.toolNames.length, 1);
  assert.equal(
    familyOn.prepared.planReceipt.toolEffects.some((entry) => entry.class === 'write'),
    false
  );
  const familyConstraint = nextFlowState(familyOn.prepared).deferredAvailability;
  assert.ok(familyConstraint);
  assert.equal(familyConstraint?.date, '2026-08-13');
  assert.equal(familyConstraint?.timeWindow?.kind, 'AFTER_EXCLUSIVE');
  assertNoSensitiveReceipt(familyOn.prepared);
  await deliver(familyOn.prepared, familyOnStore, 1);

  const familyOffStore = new MemoryConversationalV2StateStore();
  const familyOffPhone = '5511000000222';
  familyOffStore.setInputSequence(
    `${config.phoneNumberId}:${familyOffPhone}`,
    1
  );
  const familyOff = await runTurn({
    phone: familyOffPhone,
    text: FAMILY_INBOUND,
    store: familyOffStore,
    enabled: false,
  });
  assert.equal(familyOff.prepared.planReceipt.route, 'fast_path');
  assert.equal(familyOff.prepared.planReceipt.serviceContextDecision, undefined);
  assert.equal(familyOff.prepared.transition.kind, 'open');
  if (familyOff.prepared.transition.kind === 'open') {
    assert.equal(familyOff.prepared.transition.frame.kind, 'SERVICE');
    assert.deepEqual(
      familyOff.prepared.transition.frame.options.map((option) => option.entityId),
      ['svc-repo', 'svc-unha-inf']
    );
  }
  assert.doesNotMatch(familyOff.prepared.payload ?? '', /depois das 17h30/u);
  assert.equal(nextFlowState(familyOff.prepared).deferredAvailability, undefined);

  familyOnStore.setInputSequence(
    `${config.phoneNumberId}:${familyOnPhone}`,
    2
  );
  const chosen = await runTurn({
    phone: familyOnPhone,
    text: 'Reposição de unha',
    store: familyOnStore,
    enabled: true,
    serviceResolverEnabled: true,
    sequence: 2,
  });
  assert.equal(chosen.toolNames.filter((name) => name === 'getAvailableSlots').length, 1);
  assert.equal(chosen.toolNames.includes('bookAppointment'), false);
  assert.equal(chosen.prepared.transition.kind, 'open');
  if (chosen.prepared.transition.kind === 'open') {
    assert.equal(chosen.prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      chosen.prepared.transition.frame.options.map((option) => option.entityId),
      AFTER_EXCLUSIVE_SLOTS
    );
  }
  assert.doesNotMatch(chosen.prepared.payload ?? '', /16:00|17:00|17:30/u);
  assert.match(chosen.prepared.payload ?? '', /18:00/u);
  assert.notEqual(
    chosen.prepared.planReceipt.serviceContextDecision,
    'outside_pending_selection'
  );
  const offeredEvidence = nextFlowState(chosen.prepared).slotEvidence?.slots;
  assert.deepEqual(offeredEvidence, AFTER_EXCLUSIVE_SLOTS);
  assert.equal(
    chosen.prepared.planReceipt.toolEffects.some(
      (entry) => entry.tool === 'getAvailableSlots' && entry.class === 'read'
    ),
    true
  );
  assert.equal(
    chosen.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );
  assertNoSensitiveReceipt(chosen.prepared);
  await deliver(chosen.prepared, familyOnStore, 2);

  familyOnStore.setInputSequence(
    `${config.phoneNumberId}:${familyOnPhone}`,
    3
  );
  const latestBeforeTimePick = await familyOnStore.loadLatestState(
    `${config.phoneNumberId}:${familyOnPhone}`,
    new Date(clockMs)
  );
  const { resolveSelectionFastPathV2 } = await import(
    '../src/services/conversationalV2/fastPaths'
  );
  const probedTime = resolveSelectionFastPathV2({
    frame: {
      schemaVersion: 2,
      turnId: 'probe-time',
      inputSequence: 3,
      catalogSnapshotHash: 'x',
      catalogState: 'available',
      humanControl: 'NO_ACTIVE_TAKEOVER',
      currentInboundIds: ['in-time'],
      pending: latestBeforeTimePick.pending!.snapshot,
      flowState: latestBeforeTimePick.pending!.flowState,
    },
    inboundId: 'in-time',
    inboundText: '18:00',
    catalog,
    now: new Date(clockMs),
    lastAcceptedAssistantText: latestBeforeTimePick.lastAcceptedDelivery?.payload,
  });
  assert.equal(probedTime.kind, 'resolved');
  if (probedTime.kind === 'resolved') {
    assert.equal(probedTime.result.replyPurpose, 'WRITE_CONFIRMATION');
    assert.equal(probedTime.nextFlowState.bookingDraft?.time, '18:00');
  }
  assert.equal(
    bookingConfirmationGate({
      currentUserMessage: 'pode',
      history: [
        {
          role: 'assistant',
          content: latestBeforeTimePick.lastAcceptedDelivery!.payload,
        },
      ],
      confirmedDuplicate: false,
      expectedBooking: {
        date: '2026-08-13',
        time: '18:00',
        serviceName: 'Reposição de unha',
        professionalName: 'Ana Silva',
      },
      v2ConfirmationContext: {
        pending: latestBeforeTimePick.pending!.snapshot,
        flowState: latestBeforeTimePick.pending!.flowState,
        catalog,
        lastAcceptedDelivery: latestBeforeTimePick.lastAcceptedDelivery,
        now: new Date(clockMs),
      },
    }).ok,
    false,
    'oferta TIME não licencia write; confirmação continua delivery-aware'
  );

  const expiredStore = new MemoryConversationalV2StateStore();
  const expiredPhone = '5511000000223';
  const expiredKey = `${config.phoneNumberId}:${expiredPhone}`;
  const expiredAskedAt = '2026-08-13T14:00:00.000Z';
  const expiredConstraint: DeferredAvailabilityConstraintV2 = {
    schemaVersion: 1,
    capturedAt: '2026-08-13T10:50:00.000Z',
    capturedTurnId: 'turn-old',
    capturedInputSequence: 1,
    date: '2026-08-13',
    timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
  };
  seedPending(
    expiredStore,
    expiredKey,
    {
      questionId: 'q-expired',
      askedAt: expiredAskedAt,
      kind: 'SERVICE',
      flowId: 'flow-expired',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-expired',
      lastOperationalAt: expiredAskedAt,
      deferredAvailability: expiredConstraint,
      fixedByProofVersion: {},
    }
  );
  expiredStore.setInputSequence(expiredKey, 1);
  const expired = await runTurn({
    phone: expiredPhone,
    text: 'Reposição de unha',
    store: expiredStore,
    enabled: true,
  });
  assert.equal(expired.toolNames.includes('getAvailableSlots'), false);
  assert.equal(expired.prepared.transition.kind, 'open');
  if (expired.prepared.transition.kind === 'open') {
    assert.equal(expired.prepared.transition.frame.kind, 'DATE');
  }
  assert.equal(nextFlowState(expired.prepared).deferredAvailability, undefined);

  const restartStore = new MemoryConversationalV2StateStore();
  const restartPhone = '5511000000224';
  restartStore.setInputSequence(`${config.phoneNumberId}:${restartPhone}`, 1);
  const restartOpen = await runTurn({
    phone: restartPhone,
    text: FAMILY_INBOUND,
    store: restartStore,
    enabled: true,
  });
  await deliver(restartOpen.prepared, restartStore, 1);
  restartStore.setInputSequence(`${config.phoneNumberId}:${restartPhone}`, 2);
  const restarted = await runTurn({
    phone: restartPhone,
    text: 'quero agendar',
    store: restartStore,
    enabled: true,
    sequence: 2,
    allowModel: true,
  });
  assert.equal(nextFlowState(restarted.prepared).deferredAvailability, undefined);
  assert.notEqual(
    nextFlowState(restarted.prepared).flowId,
    nextFlowState(restartOpen.prepared).flowId
  );

  const dualStore = new MemoryConversationalV2StateStore();
  const dualPhone = '5511000000225';
  const dualKey = `${config.phoneNumberId}:${dualPhone}`;
  seedPending(
    dualStore,
    dualKey,
    {
      questionId: 'q-dual',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-dual',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-dual',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      deferredAvailability: {
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        capturedTurnId: 'turn-dual',
        capturedInputSequence: 1,
        date: '2026-08-13',
        timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
      },
      fixedByProofVersion: {},
    }
  );
  dualStore.setInputSequence(dualKey, 1);
  const dualAsk = await runTurn({
    phone: dualPhone,
    text: 'Pedicure',
    store: dualStore,
    enabled: true,
  });
  assert.equal(dualAsk.toolNames.length, 0);
  assert.equal(dualAsk.prepared.transition.kind, 'open');
  if (dualAsk.prepared.transition.kind === 'open') {
    assert.equal(dualAsk.prepared.transition.frame.kind, 'PROFESSIONAL');
  }
  assert.ok(nextFlowState(dualAsk.prepared).deferredAvailability);
  await deliver(dualAsk.prepared, dualStore, 1);
  dualStore.setInputSequence(dualKey, 2);
  const dualChosen = await runTurn({
    phone: dualPhone,
    text: 'Ana Silva',
    store: dualStore,
    enabled: true,
    sequence: 2,
  });
  assert.equal(dualChosen.toolNames.filter((name) => name === 'getAvailableSlots').length, 1);
  if (dualChosen.prepared.transition.kind === 'open') {
    assert.equal(dualChosen.prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      dualChosen.prepared.transition.frame.options.map((option) => option.entityId),
      AFTER_EXCLUSIVE_SLOTS
    );
  }

  const outsideStore = new MemoryConversationalV2StateStore();
  const outsidePhone = '5511000000226';
  const outsideKey = `${config.phoneNumberId}:${outsidePhone}`;
  seedPending(
    outsideStore,
    outsideKey,
    {
      questionId: 'q-out',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-out',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-out',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      deferredAvailability: {
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        capturedTurnId: 'turn-out',
        capturedInputSequence: 1,
        date: '2026-08-13',
        timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
      },
      fixedByProofVersion: {},
    }
  );
  outsideStore.setInputSequence(outsideKey, 1);
  const outside = await runTurn({
    phone: outsidePhone,
    text: 'Manicure',
    store: outsideStore,
    enabled: true,
  });
  assert.notEqual(outside.prepared.planReceipt.route, 'fallback');
  assert.equal(
    outside.prepared.planReceipt.serviceContextDecision,
    'outside_pending_selection'
  );
  assert.equal(nextFlowState(outside.prepared).fixedServiceId, 'svc-mani');
  assert.doesNotMatch(
    JSON.stringify(outside.prepared.planReceipt),
    /no_allowlisted_match/u
  );

  const wantPediStore = new MemoryConversationalV2StateStore();
  const wantPediPhone = '5511000000227';
  const wantPediKey = `${config.phoneNumberId}:${wantPediPhone}`;
  seedPending(
    wantPediStore,
    wantPediKey,
    {
      questionId: 'q-want',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-want',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-want',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      deferredAvailability: {
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        capturedTurnId: 'turn-want',
        capturedInputSequence: 1,
        date: '2026-08-13',
        timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
      },
      fixedByProofVersion: {},
    }
  );
  wantPediStore.setInputSequence(wantPediKey, 1);
  const wantPedi = await runTurn({
    phone: wantPediPhone,
    text: 'Não, quero Pedicure',
    store: wantPediStore,
    enabled: true,
  });
  assert.equal(nextFlowState(wantPedi.prepared).fixedServiceId, 'svc-pedi');
  assert.ok(nextFlowState(wantPedi.prepared).deferredAvailability);
  assert.equal(
    wantPedi.prepared.planReceipt.serviceContextDecision,
    'outside_pending_selection'
  );

  const negateStore = new MemoryConversationalV2StateStore();
  const negatePhone = '5511000000228';
  const negateKey = `${config.phoneNumberId}:${negatePhone}`;
  seedPending(
    negateStore,
    negateKey,
    {
      questionId: 'q-neg',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-neg',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-neg',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      fixedByProofVersion: {},
    }
  );
  negateStore.setInputSequence(negateKey, 1);
  const negateSelect = await runTurn({
    phone: negatePhone,
    text: 'Não quero Reposição de unha; quero Pedicure',
    store: negateStore,
    enabled: true,
  });
  assert.equal(nextFlowState(negateSelect.prepared).fixedServiceId, 'svc-pedi');
  assert.notEqual(nextFlowState(negateSelect.prepared).fixedServiceId, 'svc-repo');

  const rejectStore = new MemoryConversationalV2StateStore();
  const rejectPhone = '5511000000229';
  const rejectKey = `${config.phoneNumberId}:${rejectPhone}`;
  seedPending(
    rejectStore,
    rejectKey,
    {
      questionId: 'q-rej',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-rej',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-rej',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      fixedByProofVersion: {},
    }
  );
  rejectStore.setInputSequence(rejectKey, 1);
  const rejected = await runTurn({
    phone: rejectPhone,
    text: 'Não é Reposição de unha',
    store: rejectStore,
    enabled: true,
  });
  assert.equal(rejected.toolNames.length, 0);
  assert.equal(rejected.prepared.payload, SERVICE_CONTEXT_REJECTED_COPY_V2);
  assert.doesNotMatch(rejected.prepared.payload ?? '', /Unha infantil/u);
  assert.equal(
    rejected.prepared.planReceipt.serviceContextDecision,
    'negative_clarification'
  );
  if (rejected.prepared.transition.kind === 'open') {
    assert.notDeepEqual(
      rejected.prepared.transition.frame.options.map((option) => option.entityId),
      ['svc-repo', 'svc-unha-inf']
    );
  }

  const polarityStore = new MemoryConversationalV2StateStore();
  const polarityPhone = '5511000000230';
  const polarityKey = `${config.phoneNumberId}:${polarityPhone}`;
  seedPending(
    polarityStore,
    polarityKey,
    {
      questionId: 'q-pol',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-pol',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-mani', displayName: 'Manicure' },
        { position: 2, entityId: 'svc-pedi', displayName: 'Pedicure' },
      ],
    },
    {
      flowId: 'flow-pol',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      fixedByProofVersion: {},
    }
  );
  polarityStore.setInputSequence(polarityKey, 1);
  const polarity = await runTurn({
    phone: polarityPhone,
    text: 'Não é só Manicure mesmo',
    store: polarityStore,
    enabled: true,
  });
  assert.equal(polarity.toolNames.length, 0);
  assert.equal(
    polarity.prepared.payload,
    buildPolarityAmbiguityCopyV2('Manicure')
  );
  assert.equal(nextFlowState(polarity.prepared).fixedServiceId, undefined);
  assert.equal(
    polarity.prepared.planReceipt.serviceContextDecision,
    'negative_clarification'
  );

  const ambigStore = new MemoryConversationalV2StateStore();
  const ambigPhone = '5511000000231';
  const ambigKey = `${config.phoneNumberId}:${ambigPhone}`;
  seedPending(
    ambigStore,
    ambigKey,
    {
      questionId: 'q-amb',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-amb',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-amb',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      fixedByProofVersion: {},
    }
  );
  ambigStore.setInputSequence(ambigKey, 1);
  const ambig = await runTurn({
    phone: ambigPhone,
    text: 'agora quero Manicure tradicional ou Manicure e pedicure',
    store: ambigStore,
    enabled: true,
  });
  assert.equal(
    ambig.prepared.planReceipt.serviceContextDecision,
    'positive_reclarification'
  );
  assert.equal(nextFlowState(ambig.prepared).fixedServiceId, undefined);
  if (ambig.prepared.transition.kind === 'open') {
    assert.equal(ambig.prepared.transition.frame.kind, 'SERVICE');
    const ids = ambig.prepared.transition.frame.options.map((option) => option.entityId);
    assert.ok(ids.includes('svc-mani-trad'));
    assert.ok(ids.includes('svc-mani-pedi'));
    assert.equal(ids.includes('svc-repo'), false);
  }

  const inventedStore = new MemoryConversationalV2StateStore();
  const inventedPhone = '5511000000232';
  inventedStore.setInputSequence(`${config.phoneNumberId}:${inventedPhone}`, 1);
  const inventedOpen = await runTurn({
    phone: inventedPhone,
    text: FAMILY_INBOUND,
    store: inventedStore,
    enabled: true,
  });
  await deliver(inventedOpen.prepared, inventedStore, 1);
  inventedStore.setInputSequence(`${config.phoneNumberId}:${inventedPhone}`, 2);
  const invented = await runTurn({
    phone: inventedPhone,
    text: 'Reposição de unha',
    store: inventedStore,
    enabled: true,
    sequence: 2,
    slots: FULL_SLOTS,
  });
  const inventedPayload = invented.prepared.payload ?? '';
  assert.doesNotMatch(inventedPayload, /20:00/u);
  if (invented.prepared.transition.kind === 'open') {
    assert.equal(
      invented.prepared.transition.frame.options.some(
        (option) => option.entityId === '20:00'
      ),
      false
    );
  }

  const emptyStore = new MemoryConversationalV2StateStore();
  const emptyPhone = '5511000000233';
  emptyStore.setInputSequence(`${config.phoneNumberId}:${emptyPhone}`, 1);
  const emptyOpen = await runTurn({
    phone: emptyPhone,
    text: FAMILY_INBOUND,
    store: emptyStore,
    enabled: true,
  });
  await deliver(emptyOpen.prepared, emptyStore, 1);
  emptyStore.setInputSequence(`${config.phoneNumberId}:${emptyPhone}`, 2);
  const empty = await runTurn({
    phone: emptyPhone,
    text: 'Reposição de unha',
    store: emptyStore,
    enabled: true,
    sequence: 2,
    slots: ['16:00', '17:00'],
  });
  assert.match(
    empty.prepared.payload ?? '',
    /Não encontrei horário dentro da restrição que você pediu/u
  );
  assert.equal(empty.toolNames.includes('bookAppointment'), false);
  assert.equal(
    empty.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );

  const interpOffStore = new MemoryConversationalV2StateStore();
  const interpOffPhone = '5511000000234';
  interpOffStore.setInputSequence(`${config.phoneNumberId}:${interpOffPhone}`, 1);
  const interpOff = await runTurn({
    phone: interpOffPhone,
    text: FAMILY_INBOUND,
    store: interpOffStore,
    enabled: true,
    serviceResolverEnabled: true,
    interpreterEnabled: false,
  });
  assert.equal(interpOff.prepared.planReceipt.route, familyOn.prepared.planReceipt.route);
  assert.equal(interpOff.prepared.payload, familyOn.prepared.payload);

  const pauseStore = new MemoryConversationalV2StateStore();
  const pausePhone = '5511000000235';
  const pauseKey = `${config.phoneNumberId}:${pausePhone}`;
  seedPending(
    pauseStore,
    pauseKey,
    {
      questionId: 'q-pause',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'SERVICE',
      flowId: 'flow-pause',
      version: 1,
      options: [
        { position: 1, entityId: 'svc-repo', displayName: 'Reposição de unha' },
        { position: 2, entityId: 'svc-unha-inf', displayName: 'Unha infantil' },
      ],
    },
    {
      flowId: 'flow-pause',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      deferredAvailability: {
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        capturedTurnId: 'turn-pause',
        capturedInputSequence: 1,
        date: '2026-08-13',
        timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
      },
      fixedByProofVersion: {},
    }
  );
  pauseStore.setInputSequence(pauseKey, 1);
  const beforePause = await pauseStore.loadLatestState(pauseKey, now);
  const paused = await runTurn({
    phone: pausePhone,
    text: 'Reposição de unha',
    store: pauseStore,
    enabled: true,
    paused: true,
  });
  assert.equal(paused.prepared.payload, null);
  assert.equal(paused.prepared.transition.kind, 'preserve');
  const afterPause = await pauseStore.loadLatestState(pauseKey, now);
  assert.equal(afterPause.pending?.snapshot.questionId, beforePause.pending?.snapshot.questionId);
  assert.deepEqual(
    afterPause.pending?.flowState.deferredAvailability,
    beforePause.pending?.flowState.deferredAvailability
  );

  const greetingTardeStore = new MemoryConversationalV2StateStore();
  const greetingTardePhone = '5511000000236';
  greetingTardeStore.setInputSequence(
    `${config.phoneNumberId}:${greetingTardePhone}`,
    1
  );
  const greetingTarde = await runTurn({
    phone: greetingTardePhone,
    text: 'Boa tarde, tem horário para unha?',
    store: greetingTardeStore,
    enabled: true,
  });
  assert.equal(greetingTarde.prepared.planReceipt.route, 'fast_path');
  assert.notEqual(
    greetingTarde.prepared.planReceipt.serviceContextDecision,
    'temporal_deferred'
  );
  assert.equal(greetingTarde.toolNames.length, 0);

  const greetingNoiteStore = new MemoryConversationalV2StateStore();
  const greetingNoitePhone = '5511000000237';
  greetingNoiteStore.setInputSequence(
    `${config.phoneNumberId}:${greetingNoitePhone}`,
    1
  );
  const greetingNoite = await runTurn({
    phone: greetingNoitePhone,
    text: 'Boa noite, quero agendar unha',
    store: greetingNoiteStore,
    enabled: true,
  });
  assert.equal(greetingNoite.prepared.planReceipt.route, 'fast_path');
  assert.notEqual(
    greetingNoite.prepared.planReceipt.serviceContextDecision,
    'temporal_deferred'
  );

  const ordinalStore = new MemoryConversationalV2StateStore();
  const ordinalPhone = '5511000000238';
  seedFamilyServicePending(ordinalStore, ordinalPhone, 'flow-ordinal');
  const ordinal = await runTurn({
    phone: ordinalPhone,
    text: '2',
    store: ordinalStore,
    enabled: true,
  });
  assert.notEqual(
    ordinal.prepared.planReceipt.serviceContextDecision,
    'outside_pending_selection'
  );
  assert.equal(nextFlowState(ordinal.prepared).fixedServiceId, 'svc-unha-inf');
  if (ordinal.prepared.transition.kind === 'open') {
    assert.equal(ordinal.prepared.transition.frame.kind, 'TIME');
  }

  const flagOffConstraintStore = new MemoryConversationalV2StateStore();
  const flagOffConstraintPhone = '5511000000239';
  const flagOffConstraintKey = `${config.phoneNumberId}:${flagOffConstraintPhone}`;
  seedPending(
    flagOffConstraintStore,
    flagOffConstraintKey,
    {
      questionId: 'q-flag-off',
      askedAt: '2026-08-13T14:50:00.000Z',
      kind: 'DATE',
      flowId: 'flow-flag-off',
      version: 1,
      options: [
        {
          position: 1,
          entityId: 'date-freeform',
          displayName: 'dia desejado',
        },
      ],
    },
    {
      flowId: 'flow-flag-off',
      lastOperationalAt: '2026-08-13T14:50:00.000Z',
      fixedServiceId: 'svc-repo',
      fixedProfessionalId: 'prof-ana',
      deferredAvailability: {
        schemaVersion: 1,
        capturedAt: now.toISOString(),
        capturedTurnId: 'turn-flag-off',
        capturedInputSequence: 1,
        date: '2026-08-13',
        timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
      },
      fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
    }
  );
  flagOffConstraintStore.setInputSequence(flagOffConstraintKey, 1);
  const flagOffConstraint = await runTurn({
    phone: flagOffConstraintPhone,
    text: 'hoje',
    store: flagOffConstraintStore,
    enabled: false,
    slots: ['17:00', '18:00'],
  });
  assert.equal(
    flagOffConstraint.prepared.planReceipt.serviceContextDecision,
    undefined
  );
  assert.match(flagOffConstraint.prepared.payload ?? '', /17h/u);
  assert.match(flagOffConstraint.prepared.payload ?? '', /18h/u);
  if (flagOffConstraint.prepared.transition.kind === 'open') {
    assert.deepEqual(
      flagOffConstraint.prepared.transition.frame.options.map(
        (option) => option.entityId
      ),
      ['17:00', '18:00']
    );
  }
  const flagOffNext = nextFlowState(flagOffConstraint.prepared);
  assert.equal(flagOffNext.deferredAvailability, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(flagOffNext, 'deferredAvailability'),
    false
  );

  const QUERY_FAILURE_COPY = 'Não consegui consultar os horários agora';
  const EMPTY_FILTER_COPY =
    'Não encontrei horário dentro da restrição que você pediu';

  const executorErrorStore = new MemoryConversationalV2StateStore();
  const executorErrorPhone = '5511000000240';
  seedFamilyServicePending(executorErrorStore, executorErrorPhone, 'flow-exec-err');
  const executorError = await runTurn({
    phone: executorErrorPhone,
    text: 'Reposição de unha',
    store: executorErrorStore,
    enabled: true,
    toolResponse: JSON.stringify({ success: false, reason: 'executor_error' }),
  });
  assert.match(executorError.prepared.payload ?? '', new RegExp(QUERY_FAILURE_COPY, 'u'));
  assert.doesNotMatch(executorError.prepared.payload ?? '', new RegExp(EMPTY_FILTER_COPY, 'u'));
  assert.equal(executorError.toolNames.includes('bookAppointment'), false);
  assert.equal(
    executorError.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );
  assert.ok(nextFlowState(executorError.prepared).deferredAvailability);

  const invalidJsonStore = new MemoryConversationalV2StateStore();
  const invalidJsonPhone = '5511000000241';
  seedFamilyServicePending(invalidJsonStore, invalidJsonPhone, 'flow-bad-json');
  const invalidJson = await runTurn({
    phone: invalidJsonPhone,
    text: 'Reposição de unha',
    store: invalidJsonStore,
    enabled: true,
    toolResponse: 'not-json{{{',
  });
  assert.match(invalidJson.prepared.payload ?? '', new RegExp(QUERY_FAILURE_COPY, 'u'));
  assert.doesNotMatch(invalidJson.prepared.payload ?? '', new RegExp(EMPTY_FILTER_COPY, 'u'));
  assert.equal(invalidJson.toolNames.includes('bookAppointment'), false);
  assert.equal(
    invalidJson.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );
  assert.ok(nextFlowState(invalidJson.prepared).deferredAvailability);

  const invalidPayloadStore = new MemoryConversationalV2StateStore();
  const invalidPayloadPhone = '5511000000242';
  seedFamilyServicePending(invalidPayloadStore, invalidPayloadPhone, 'flow-bad-payload');
  const invalidPayload = await runTurn({
    phone: invalidPayloadPhone,
    text: 'Reposição de unha',
    store: invalidPayloadStore,
    enabled: true,
    toolResponse: JSON.stringify({ success: true, slots: [17, '18:00'] }),
  });
  assert.match(invalidPayload.prepared.payload ?? '', new RegExp(QUERY_FAILURE_COPY, 'u'));
  assert.doesNotMatch(
    invalidPayload.prepared.payload ?? '',
    new RegExp(EMPTY_FILTER_COPY, 'u')
  );
  assert.equal(invalidPayload.toolNames.includes('bookAppointment'), false);
  assert.equal(
    invalidPayload.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );
  assert.ok(nextFlowState(invalidPayload.prepared).deferredAvailability);

  const thrownToolStore = new MemoryConversationalV2StateStore();
  const thrownToolPhone = '5511000000243';
  seedFamilyServicePending(thrownToolStore, thrownToolPhone, 'flow-throw');
  const thrownTool = await runTurn({
    phone: thrownToolPhone,
    text: 'Reposição de unha',
    store: thrownToolStore,
    enabled: true,
    throwTool: true,
  });
  assert.match(thrownTool.prepared.payload ?? '', new RegExp(QUERY_FAILURE_COPY, 'u'));
  assert.doesNotMatch(thrownTool.prepared.payload ?? '', new RegExp(EMPTY_FILTER_COPY, 'u'));
  assert.equal(
    thrownTool.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );

  // --- IA-22e fixture C: restrição temporal sem serviço resolvido ---
  const openServiceStore = new MemoryConversationalV2StateStore();
  const openServicePhone = '5511000000401';
  const openServiceKey = `${config.phoneNumberId}:${openServicePhone}`;
  openServiceStore.setInputSequence(openServiceKey, 1);
  const openServiceTurn1 = await runTurn({
    phone: openServicePhone,
    text: OPEN_SERVICE_INBOUND,
    store: openServiceStore,
    enabled: true,
    interpreterEnabled: true,
    sequence: 1,
  });
  assert.equal(
    openServiceTurn1.prepared.planReceipt.serviceContextDecision,
    'temporal_deferred'
  );
  assert.equal(openServiceTurn1.prepared.planReceipt.route, 'fast_path');
  assert.equal(openServiceTurn1.prepared.planReceipt.recoveryKind, 'none');
  assert.notEqual(
    openServiceTurn1.prepared.planReceipt.recoveryKind,
    'silent_escalation'
  );
  assert.equal(openServiceTurn1.prepared.payload, DEFERRED_OPEN_SERVICE_QUESTION_COPY);
  assertDeferredOpenServiceQuestionCopy(openServiceTurn1.prepared.payload ?? '');
  const openServiceBoundary = evaluateDeferredOpenCopy(
    openServiceTurn1.prepared.payload ?? ''
  );
  assert.equal(openServiceBoundary.safe, true);
  assert.equal(openServiceBoundary.originalAccepted, true);
  assert.deepEqual(openServiceBoundary.reasonCodes, []);
  assert.equal(
    openServiceBoundary.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
    false
  );
  assert.equal(
    openServiceTurn1.prepared.planReceipt.boundaryAttempts.some((attempt) =>
      attempt.reasonCodes.includes('UNVERIFIED_AVAILABILITY')
    ),
    false
  );
  assert.equal(openServiceTurn1.prepared.planReceipt.primaryProviderCalls, 0);
  assert.equal(openServiceTurn1.prepared.planReceipt.regenProviderCalls, 0);
  assert.equal(openServiceTurn1.prepared.planReceipt.route.startsWith('interpreter'), false);
  assert.equal(openServiceTurn1.toolNames.length, 0);
  assert.equal(openServiceTurn1.prepared.hasCommittedWrite, false);
  assert.equal(
    openServiceTurn1.prepared.planReceipt.toolEffects.some((entry) => entry.writeCommitted),
    false
  );
  assert.equal(openServiceTurn1.prepared.preemption, null);
  assert.equal(openServiceTurn1.prepared.transition.kind, 'open');
  if (openServiceTurn1.prepared.transition.kind === 'open') {
    assert.equal(openServiceTurn1.prepared.transition.frame.kind, 'SERVICE');
    assert.equal(openServiceTurn1.prepared.transition.frame.options.length, 0);
  }
  const openServiceConstraint = nextFlowState(openServiceTurn1.prepared).deferredAvailability;
  assert.ok(openServiceConstraint);
  assert.equal(openServiceConstraint?.date, '2026-08-13');
  assert.deepEqual(openServiceConstraint?.timeWindow, {
    kind: 'AFTER_EXCLUSIVE',
    minuteOfDay: 17 * 60 + 30,
  });
  await deliver(openServiceTurn1.prepared, openServiceStore, 1);
  const openServiceAfter1 = await openServiceStore.loadLatestState(
    openServiceKey,
    new Date(clockMs)
  );
  assert.equal(openServiceAfter1.pending?.state, 'OPEN');
  assert.equal(openServiceAfter1.pending?.snapshot.kind, 'SERVICE');
  assert.equal(openServiceAfter1.pending?.snapshot.options.length, 0);
  assert.ok(
    openServiceAfter1.pending?.flowState.deferredAvailability ??
      openServiceAfter1.flowState?.deferredAvailability
  );
  assert.equal(
    (
      openServiceAfter1.pending?.flowState.deferredAvailability ??
      openServiceAfter1.flowState?.deferredAvailability
    )?.date,
    '2026-08-13'
  );
  assert.deepEqual(
    (
      openServiceAfter1.pending?.flowState.deferredAvailability ??
      openServiceAfter1.flowState?.deferredAvailability
    )?.timeWindow,
    { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 }
  );

  openServiceStore.setInputSequence(openServiceKey, 2);
  const openServiceTurn2 = await runTurn({
    phone: openServicePhone,
    text: 'Drenagem linfática',
    store: openServiceStore,
    enabled: true,
    interpreterEnabled: true,
    sequence: 2,
    slots: DAY_SLOTS,
  });
  assert.equal(
    openServiceTurn2.toolNames.filter((name) => name === 'getAvailableSlots').length,
    1
  );
  assert.doesNotMatch(
    openServiceTurn2.prepared.payload ?? '',
    new RegExp(DATE_QUESTION_COPY, 'u')
  );
  assert.equal(openServiceTurn2.prepared.transition.kind, 'open');
  if (openServiceTurn2.prepared.transition.kind === 'open') {
    assert.equal(openServiceTurn2.prepared.transition.frame.kind, 'TIME');
  }
  assertWindowOnlySlots(openedTimeSlots(openServiceTurn2.prepared));
  assertWindowOnlySlots(nextFlowState(openServiceTurn2.prepared).slotEvidence?.slots ?? []);

  // --- IA-22f: serviço fora do catálogo com SERVICE OPEN options=[] ---
  const HAIR_INBOUND = 'quero fazer o cabelo';
  const GENERIC_SERVICE_QUESTION = 'Qual serviço você prefere?';
  const NON_CANONICAL_HAIR_DENIAL =
    'A gente não faz cabelo aqui, infelizmente.';

  async function openRestrictedEmptyService(phone: string) {
    const store = new MemoryConversationalV2StateStore();
    const key = `${config.phoneNumberId}:${phone}`;
    store.setInputSequence(key, 1);
    const turn1 = await runTurn({
      phone,
      text: OPEN_SERVICE_INBOUND,
      store,
      enabled: true,
      interpreterEnabled: true,
      sequence: 1,
    });
    assert.equal(turn1.prepared.payload, DEFERRED_OPEN_SERVICE_QUESTION_COPY);
    assert.equal(turn1.prepared.transition.kind, 'open');
    if (turn1.prepared.transition.kind === 'open') {
      assert.equal(turn1.prepared.transition.frame.kind, 'SERVICE');
      assert.equal(turn1.prepared.transition.frame.options.length, 0);
    }
    await deliver(turn1.prepared, store, 1);
    const after1 = await store.loadLatestState(key, new Date(clockMs));
    assert.equal(after1.pending?.state, 'OPEN');
    assert.equal(after1.pending?.snapshot.kind, 'SERVICE');
    assert.equal(after1.pending?.snapshot.options.length, 0);
    assert.ok(
      after1.pending?.flowState.deferredAvailability ??
        after1.flowState?.deferredAvailability
    );
    return { store, key };
  }

  function assertPendingEmptyServicePreserved(
    prepared: Awaited<ReturnType<typeof getReceptionistReplyV2>>
  ): void {
    const flow = nextFlowState(prepared);
    assert.ok(flow.deferredAvailability);
    assert.equal(flow.deferredAvailability?.date, '2026-08-13');
    assert.deepEqual(flow.deferredAvailability?.timeWindow, {
      kind: 'AFTER_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    });
    if (prepared.transition.kind === 'open') {
      assert.equal(prepared.transition.frame.kind, 'SERVICE');
      assert.equal(prepared.transition.frame.options.length, 0);
    } else {
      assert.equal(prepared.transition.kind, 'preserve');
    }
  }

  const hairEvidenceStore = await openRestrictedEmptyService('5511000000402');
  hairEvidenceStore.store.setInputSequence(hairEvidenceStore.key, 2);
  const hairEvidenceTurn2 = await runTurn({
    phone: '5511000000402',
    text: HAIR_INBOUND,
    store: hairEvidenceStore.store,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    failRegenerate: true,
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: 'cabelo',
    modelNextPending: 'PRESERVE',
    sequence: 2,
  });
  assert.equal(
    hairEvidenceTurn2.prepared.payload,
    UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2
  );
  assert.notEqual(hairEvidenceTurn2.prepared.payload, GENERIC_SERVICE_QUESTION);
  assert.notEqual(
    hairEvidenceTurn2.prepared.planReceipt.recoveryKind,
    'silent_escalation'
  );
  assert.equal(hairEvidenceTurn2.toolNames.length, 0);
  assert.equal(hairEvidenceTurn2.prepared.hasCommittedWrite, false);
  assert.equal(
    hairEvidenceTurn2.prepared.planReceipt.toolEffects.some(
      (entry) => entry.writeCommitted
    ),
    false
  );
  assert.equal(hairEvidenceTurn2.prepared.planReceipt.regenProviderCalls, 0);
  assertPendingEmptyServicePreserved(hairEvidenceTurn2.prepared);
  await deliver(hairEvidenceTurn2.prepared, hairEvidenceStore.store, 2);
  const hairAfter2 = await hairEvidenceStore.store.loadLatestState(
    hairEvidenceStore.key,
    new Date(clockMs)
  );
  assert.equal(hairAfter2.pending?.state, 'OPEN');
  assert.equal(hairAfter2.pending?.snapshot.kind, 'SERVICE');
  assert.equal(hairAfter2.pending?.snapshot.options.length, 0);
  assert.ok(
    hairAfter2.pending?.flowState.deferredAvailability ??
      hairAfter2.flowState?.deferredAvailability
  );

  async function hairClarificationVariant(input: {
    phone: string;
    modelRawReply?: string;
    modelReply?: string;
    modelUnknownServiceText?: string | null;
  }) {
    const opened = await openRestrictedEmptyService(input.phone);
    opened.store.setInputSequence(opened.key, 2);
    const turn2 = await runTurn({
      phone: input.phone,
      text: HAIR_INBOUND,
      store: opened.store,
      enabled: true,
      interpreterEnabled: true,
      interpreterNenhuma: true,
      allowModel: true,
      failRegenerate: true,
      modelRawReply: input.modelRawReply,
      modelReply: input.modelReply ?? NON_CANONICAL_HAIR_DENIAL,
      modelUnknownServiceText: input.modelUnknownServiceText,
      modelNextPending: 'PRESERVE',
      sequence: 2,
    });
    assert.equal(turn2.prepared.payload, EMPTY_OPEN_SERVICE_CLARIFICATION_V2);
    assert.notEqual(turn2.prepared.payload, GENERIC_SERVICE_QUESTION);
    assert.notEqual(
      turn2.prepared.planReceipt.recoveryKind,
      'silent_escalation'
    );
    assert.equal(turn2.prepared.payload, EMPTY_OPEN_SERVICE_CLARIFICATION_V2);
    assert.ok(turn2.prepared.payload);
    assert.equal(turn2.toolNames.length, 0);
    assert.equal(turn2.prepared.hasCommittedWrite, false);
    assertPendingEmptyServicePreserved(turn2.prepared);
    return { ...opened, turn2 };
  }

  await hairClarificationVariant({
    phone: '5511000000403',
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
  });
  await hairClarificationVariant({
    phone: '5511000000404',
    modelReply: 'Pode me repetir o serviço?',
    modelUnknownServiceText: null,
  });
  await hairClarificationVariant({
    phone: '5511000000405',
    modelRawReply: 'isto nao e json {{{',
  });

  const hairRepeat = await hairClarificationVariant({
    phone: '5511000000406',
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
  });
  await deliver(hairRepeat.turn2.prepared, hairRepeat.store, 2);
  hairRepeat.store.setInputSequence(hairRepeat.key, 3);
  const hairTurn3 = await runTurn({
    phone: '5511000000406',
    text: HAIR_INBOUND,
    store: hairRepeat.store,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    failRegenerate: true,
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
    modelNextPending: 'PRESERVE',
    sequence: 3,
  });
  assert.equal(hairTurn3.prepared.payload, VISIBLE_HANDOFF_CANONICAL_V2);
  assert.notEqual(hairTurn3.prepared.payload, GENERIC_SERVICE_QUESTION);
  assert.notEqual(hairTurn3.prepared.payload, EMPTY_OPEN_SERVICE_CLARIFICATION_V2);
  assert.equal(
    hairTurn3.prepared.planReceipt.recoveryKind,
    'visible_escalation'
  );
  assert.notEqual(
    hairTurn3.prepared.planReceipt.recoveryKind,
    'silent_escalation'
  );
  assert.ok(hairTurn3.prepared.payload);
  assert.equal(hairTurn3.toolNames.length, 0);
  assert.equal(hairTurn3.prepared.hasCommittedWrite, false);

  const visibleHandoffPhone = '5511000000410';
  const visibleOpened = await openRestrictedEmptyService(visibleHandoffPhone);
  visibleOpened.store.setInputSequence(visibleOpened.key, 2);
  const visibleTurn2 = await runTurn({
    phone: visibleHandoffPhone,
    text: HAIR_INBOUND,
    store: visibleOpened.store,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    failRegenerate: true,
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
    modelNextPending: 'PRESERVE',
    sequence: 2,
  });
  assert.equal(
    visibleTurn2.prepared.payload,
    EMPTY_OPEN_SERVICE_CLARIFICATION_V2
  );
  await deliver(visibleTurn2.prepared, visibleOpened.store, 2);
  visibleOpened.store.setInputSequence(visibleOpened.key, 3);
  const oldVisibleState = await visibleOpened.store.loadLatestState(
    visibleOpened.key,
    new Date(clockMs)
  );
  const oldVisibleFlowId =
    oldVisibleState.pending?.flowState.flowId ?? oldVisibleState.flowState?.flowId;
  assert.ok(oldVisibleFlowId);

  let visibleSilentPosts = 0;
  let holdActive = false;
  const visibleTurn3 = await runTurn({
    phone: visibleHandoffPhone,
    text: HAIR_INBOUND,
    store: visibleOpened.store,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    failRegenerate: true,
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
    modelNextPending: 'PRESERVE',
    sequence: 3,
    escalateSilent: async (input) => {
      visibleSilentPosts += 1;
      holdActive = true;
      return { kind: 'created' as const, questionId: `q-${input.messageId}` };
    },
  });
  assert.equal(visibleTurn3.prepared.payload, VISIBLE_HANDOFF_CANONICAL_V2);
  assert.equal(
    visibleTurn3.prepared.planReceipt.recoveryKind,
    'visible_escalation'
  );
  assert.equal(visibleSilentPosts, 1, 'card/POST nasce no T3');
  assert.ok(visibleTurn3.prepared.authoritativeEscalationQuestionId);
  assert.equal(
    visibleOpened.store.flowStateInvalidations.get(visibleOpened.key)?.reason,
    'SILENT_ESCALATION',
    'handoff visível também grava cutoff durável'
  );

  __resetFlushStateForTest();
  let visibleT3HoldAfterPrepare = false;
  let visibleT3FlushDeliveries = 0;
  let visibleT3TransportPosts = 0;
  const visibleDeliveryNow = new Date(clockMs + 60_000);
  let visibleT3EscalationAckChecks = 0;
  const visibleT3FlushKey = __seedFlushBufferForTest(
    config,
    visibleHandoffPhone,
    [HAIR_INBOUND]
  );
  await flushBuffer(visibleT3FlushKey, {
    getReply: async () => {
      visibleT3HoldAfterPrepare = true;
      return visibleTurn3.prepared;
    },
    sendReply: async () => {
      throw new Error('T3 visível não pode usar transporte v1');
    },
    sendReplyPlain: async () => {
      throw new Error('T3 visível não pode usar transporte v1');
    },
    isPaused: async () => false,
    isPausedBeforeTransport: async () => false,
    isPausedWithoutSilentHoldBeforeTransport: async () => false,
    isPausedForEscalationAck: async () => {
      visibleT3EscalationAckChecks += 1;
      return true;
    },
    lookupSilentHold: async () =>
      visibleT3HoldAfterPrepare
        ? { kind: 'active' as const, sourceMessageId: 'wamid-visible-t3' }
        : { kind: 'inactive' as const },
    withConversationLock: async (_phoneNumberId, _customerPhone, work) =>
      work(),
    deliverV2: async (prepared, checkpoint) => {
      const state = await checkpoint();
      if (state.paused) {
        throw new Error('hold do mesmo turno suprimiu o handoff visível');
      }
      const result = await deliverPreparedReceptionistTurnV2(prepared, {
        store: visibleOpened.store,
        checkpoint,
        id: nextId,
        now: () => visibleDeliveryNow,
        sendTransport: async () => {
          visibleT3TransportPosts += 1;
          return { providerMessageId: nextId() };
        },
      });
      visibleT3FlushDeliveries += 1;
      assert.equal(prepared.payload, VISIBLE_HANDOFF_CANONICAL_V2);
      assert.equal(result.delivery, 'sent');
      assert.equal(result.receipt.transportOutcome, 'accepted_by_provider');
      assert.notEqual(result.receipt.transportStartedAt, null);
      assert.notEqual(result.receipt.pendingCommitOutcome, 'cas_conflict');
      assert.equal(result.receipt.flowStateCommitOutcome, 'committed');
      return { delivery: 'sent' as const, successor: result.successor };
    },
  });
  assert.equal(
    visibleT3FlushDeliveries,
    1,
    'T3 entrega a copy visível apesar do hold recém-criado'
  );
  assert.equal(
    visibleT3EscalationAckChecks,
    0,
    'T3 visível não usa pause-ack de escalada humana'
  );
  assert.equal(visibleSilentPosts, 1, 'flush do T3 não cria segundo POST');
  assert.equal(visibleT3TransportPosts, 1, 'delivery v2 real faz exatamente um POST');
  const visibleAfterDelivery = await visibleOpened.store.loadLatestState(
    visibleOpened.key,
    visibleDeliveryNow
  );
  assert.equal(visibleAfterDelivery.pending, null, 'handoff fecha PendingFrame antiga');
  assert.notEqual(
    visibleAfterDelivery.flowState?.flowId,
    oldVisibleFlowId,
    'handoff não projeta o flow antigo'
  );
  assert.equal(visibleAfterDelivery.flowState?.fixedServiceId, undefined);
  assert.equal(visibleAfterDelivery.flowState?.fixedProfessionalId, undefined);
  assert.equal(visibleAfterDelivery.flowState?.resolvedDate, undefined);
  assert.equal(visibleAfterDelivery.flowState?.bookingDraft, undefined);
  assert.equal(visibleAfterDelivery.flowState?.slotEvidence, undefined);
  assert.equal(visibleAfterDelivery.flowState?.deferredAvailability, undefined);
  assert.equal(visibleAfterDelivery.flowState?.cancellation, undefined);
  __resetFlushStateForTest();

  const visibleT4Key = __seedFlushBufferForTest(
    config,
    visibleHandoffPhone,
    [HAIR_INBOUND]
  );
  let visibleT4BrainCalls = 0;
  let visibleT4Outbound = 0;
  await flushBuffer(visibleT4Key, {
    getReply: async () => {
      visibleT4BrainCalls += 1;
      throw new Error('T4 em hold não pode chamar o brain');
    },
    sendReply: async () => {
      visibleT4Outbound += 1;
    },
    sendReplyPlain: async () => {
      visibleT4Outbound += 1;
    },
    isPaused: async () => false,
    isPausedBeforeTransport: async () => false,
    lookupSilentHold: async () =>
      holdActive
        ? { kind: 'active' as const, sourceMessageId: 'wamid-visible-t3' }
        : { kind: 'inactive' as const },
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.equal(visibleT4BrainCalls, 0, 'T4 é silêncio pré-brain');
  assert.equal(visibleT4Outbound, 0, 'T4 não gera outbound');
  assert.equal(visibleSilentPosts, 1, 'T4 não cria segundo POST/card');
  __resetFlushStateForTest();

  const persistFailPhone = '5511000000411';
  const persistFailOpened = await openRestrictedEmptyService(persistFailPhone);
  persistFailOpened.store.setInputSequence(persistFailOpened.key, 2);
  const persistFailTurn2 = await runTurn({
    phone: persistFailPhone,
    text: HAIR_INBOUND,
    store: persistFailOpened.store,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    failRegenerate: true,
    modelReply: NON_CANONICAL_HAIR_DENIAL,
    modelUnknownServiceText: null,
    modelNextPending: 'PRESERVE',
    sequence: 2,
  });
  await deliver(persistFailTurn2.prepared, persistFailOpened.store, 2);
  persistFailOpened.store.setInputSequence(persistFailOpened.key, 3);
  await assert.rejects(
    () =>
      runTurn({
        phone: persistFailPhone,
        text: HAIR_INBOUND,
        store: persistFailOpened.store,
        enabled: true,
        interpreterEnabled: true,
        interpreterNenhuma: true,
        allowModel: true,
        failRegenerate: true,
        modelReply: NON_CANONICAL_HAIR_DENIAL,
        modelUnknownServiceText: null,
        modelNextPending: 'PRESERVE',
        sequence: 3,
        escalateSilent: async () => {
          throw new SilentEscalationHoldPersistenceError(
            'persistência do hold visível falhou'
          );
        },
      }),
    (error: unknown) =>
      error instanceof SilentEscalationHoldPersistenceError
  );

  // --- IA-22c fixture C: round-trip real pelo store, não o consumidor direto ---
  const replayStore = new MemoryConversationalV2StateStore();
  const replayPhone = '5511000000301';
  const replayKey = `${config.phoneNumberId}:${replayPhone}`;
  replayStore.setInputSequence(replayKey, 1);
  const replayTurn1 = await runTurn({
    phone: replayPhone,
    text: 'Tem horário hoje após as 17:30?',
    store: replayStore,
    enabled: true,
    interpreterEnabled: true,
    sequence: 1,
  });
  assert.equal(replayTurn1.prepared.planReceipt.route, 'fast_path');
  assert.equal(replayTurn1.prepared.planReceipt.recoveryKind, 'none');
  assert.equal(replayTurn1.prepared.transition.kind, 'open');
  if (replayTurn1.prepared.transition.kind === 'open') {
    assert.equal(replayTurn1.prepared.transition.frame.kind, 'SERVICE');
    assert.equal(replayTurn1.prepared.transition.frame.options.length, 0);
  }
  assert.equal(replayTurn1.prepared.payload, DEFERRED_OPEN_SERVICE_QUESTION_COPY);
  await deliver(replayTurn1.prepared, replayStore, 1);
  const replayAfter1 = await replayStore.loadLatestState(replayKey, new Date(clockMs));
  assert.equal(replayAfter1.pending?.state, 'OPEN');
  assert.equal(replayAfter1.pending?.snapshot.kind, 'SERVICE');
  assert.ok(replayAfter1.flowState?.deferredAvailability ?? replayAfter1.pending?.flowState.deferredAvailability);
  assert.equal(
    (
      replayAfter1.pending?.flowState.deferredAvailability ??
      replayAfter1.flowState?.deferredAvailability
    )?.date,
    '2026-08-13'
  );
  assert.deepEqual(
    (
      replayAfter1.pending?.flowState.deferredAvailability ??
      replayAfter1.flowState?.deferredAvailability
    )?.timeWindow,
    {
      kind: 'AFTER_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    }
  );

  replayStore.setInputSequence(replayKey, 2);
  const replayTurn2 = await runTurn({
    phone: replayPhone,
    text: 'Drenagem linfática',
    store: replayStore,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    sequence: 2,
    slots: DAY_SLOTS,
  });
  assert.equal(replayTurn2.prepared.planReceipt.route, 'fast_path');
  assert.equal(nextFlowState(replayTurn2.prepared).fixedServiceId, 'svc-drenagem');
  assert.equal(
    replayTurn2.toolNames.filter((name) => name === 'getAvailableSlots').length,
    1
  );
  assert.doesNotMatch(
    replayTurn2.prepared.payload ?? '',
    new RegExp(DATE_QUESTION_COPY, 'u')
  );
  assert.equal(replayTurn2.prepared.transition.kind, 'open');
  if (replayTurn2.prepared.transition.kind === 'open') {
    assert.equal(replayTurn2.prepared.transition.frame.kind, 'TIME');
  }
  assertWindowOnlySlots(openedTimeSlots(replayTurn2.prepared));
  assertWindowOnlySlots(nextFlowState(replayTurn2.prepared).slotEvidence?.slots ?? []);
  await deliver(replayTurn2.prepared, replayStore, 2);
  const replayAfter2 = await replayStore.loadLatestState(replayKey, new Date(clockMs));
  assert.equal(replayAfter2.pending?.snapshot.kind, 'TIME');
  assertWindowOnlySlots(
    (replayAfter2.pending?.snapshot.options ?? []).map((option) => option.entityId)
  );
  assertWindowOnlySlots(
    replayAfter2.pending?.flowState.slotEvidence?.slots ??
      replayAfter2.flowState?.slotEvidence?.slots ??
      []
  );

  replayStore.setInputSequence(replayKey, 3);
  const replayTurn3 = await runTurn({
    phone: replayPhone,
    text: 'Hoje',
    store: replayStore,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    allowModel: true,
    modelReply: 'Qual horário você prefere?',
    modelNextPending: 'PRESERVE',
    sequence: 3,
    slots: DAY_SLOTS,
  });
  const replayTurn3Slots =
    openedTimeSlots(replayTurn3.prepared).length > 0
      ? openedTimeSlots(replayTurn3.prepared)
      : nextFlowState(replayTurn3.prepared).slotEvidence?.slots ??
        (replayAfter2.pending?.snapshot.options ?? []).map((option) => option.entityId);
  assertWindowOnlySlots(replayTurn3Slots);
  assert.doesNotMatch(replayTurn3.prepared.payload ?? '', /08h|8h30|17h30/u);

  const threeStepStore = new MemoryConversationalV2StateStore();
  const threeStepPhone = '5511000000302';
  const threeStepKey = `${config.phoneNumberId}:${threeStepPhone}`;
  threeStepStore.setInputSequence(threeStepKey, 1);
  const threeStepTurn1 = await runTurn({
    phone: threeStepPhone,
    text: 'Tem horário após as 17:30?',
    store: threeStepStore,
    enabled: true,
    interpreterEnabled: true,
    sequence: 1,
  });
  assert.equal(threeStepTurn1.prepared.planReceipt.route, 'fast_path');
  assert.equal(threeStepTurn1.prepared.transition.kind, 'open');
  if (threeStepTurn1.prepared.transition.kind === 'open') {
    assert.equal(threeStepTurn1.prepared.transition.frame.kind, 'SERVICE');
    assert.equal(threeStepTurn1.prepared.transition.frame.options.length, 0);
  }
  assert.equal(
    threeStepTurn1.prepared.payload,
    DEFERRED_OPEN_SERVICE_QUESTION_WINDOW_ONLY_COPY
  );
  await deliver(threeStepTurn1.prepared, threeStepStore, 1);
  const threeStepAfter1 = await threeStepStore.loadLatestState(
    threeStepKey,
    new Date(clockMs)
  );
  assert.equal(threeStepAfter1.pending?.state, 'OPEN');
  assert.equal(threeStepAfter1.pending?.snapshot.kind, 'SERVICE');
  assert.equal(
    (
      threeStepAfter1.pending?.flowState.deferredAvailability ??
      threeStepAfter1.flowState?.deferredAvailability
    )?.date,
    undefined
  );
  assert.deepEqual(
    (
      threeStepAfter1.pending?.flowState.deferredAvailability ??
      threeStepAfter1.flowState?.deferredAvailability
    )?.timeWindow,
    {
      kind: 'AFTER_EXCLUSIVE',
      minuteOfDay: 17 * 60 + 30,
    }
  );

  threeStepStore.setInputSequence(threeStepKey, 2);
  const threeStepTurn2 = await runTurn({
    phone: threeStepPhone,
    text: 'Drenagem linfática',
    store: threeStepStore,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    sequence: 2,
    slots: DAY_SLOTS,
  });
  assert.equal(threeStepTurn2.prepared.transition.kind, 'open');
  if (threeStepTurn2.prepared.transition.kind === 'open') {
    assert.equal(threeStepTurn2.prepared.transition.frame.kind, 'DATE');
  }
  assert.match(threeStepTurn2.prepared.payload ?? '', new RegExp(DATE_QUESTION_COPY, 'u'));
  assert.equal(
    threeStepTurn2.toolNames.filter((name) => name === 'getAvailableSlots').length,
    0
  );
  assert.ok(nextFlowState(threeStepTurn2.prepared).deferredAvailability?.timeWindow);
  assert.equal(nextFlowState(threeStepTurn2.prepared).deferredAvailability?.date, undefined);
  await deliver(threeStepTurn2.prepared, threeStepStore, 2);

  threeStepStore.setInputSequence(threeStepKey, 3);
  const threeStepTurn3 = await runTurn({
    phone: threeStepPhone,
    text: 'Hoje',
    store: threeStepStore,
    enabled: true,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    sequence: 3,
    slots: DAY_SLOTS,
  });
  assert.equal(
    threeStepTurn3.toolNames.filter((name) => name === 'getAvailableSlots').length,
    1
  );
  assert.equal(threeStepTurn3.prepared.transition.kind, 'open');
  if (threeStepTurn3.prepared.transition.kind === 'open') {
    assert.equal(threeStepTurn3.prepared.transition.frame.kind, 'TIME');
  }
  assertWindowOnlySlots(openedTimeSlots(threeStepTurn3.prepared));
  assertWindowOnlySlots(nextFlowState(threeStepTurn3.prepared).slotEvidence?.slots ?? []);

  // --- IA-22c D: persistência/precedência + kill-switch na hidratação ---
  const deferredFlow: FlowStateV2 = {
    flowId: 'flow-outbox-fallback',
    lastOperationalAt: now.toISOString(),
    deferredAvailability: {
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      capturedTurnId: 'turn-outbox',
      capturedInputSequence: 1,
      date: '2026-08-13',
      timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
    },
    fixedByProofVersion: {},
  };
  const outboxFallbackStore = new MemoryConversationalV2StateStore();
  const outboxFallbackPhone = '5511000000303';
  const outboxFallbackKey = `${config.phoneNumberId}:${outboxFallbackPhone}`;
  outboxFallbackStore.setInputSequence(outboxFallbackKey, 1);
  const acceptedOutbox: OutboundOutboxRecordV2 = {
    deliveryAttemptId: 'da-outbox-fallback',
    conversationKey: outboxFallbackKey,
    turnId: 'turn-outbox',
    planReceiptId: 'plan-outbox',
    state: 'accepted_by_provider',
    payload: SERVICE_QUESTION_COPY,
    transition: { kind: 'preserve', nextFlowState: deferredFlow },
    providerMessageIdHash: 'hash-outbox',
    providerStatus: null,
    providerStatusAt: null,
    providerFailureCode: null,
    providerStatusVersion: 0,
    transportStartedAt: now.toISOString(),
    commitPayload: {
      assistantText: SERVICE_QUESTION_COPY,
      transition: { kind: 'preserve', nextFlowState: deferredFlow },
      deliveryReceipt: {
        schemaVersion: 2,
        deliveryReceiptId: 'del-outbox',
        planReceiptId: 'plan-outbox',
        turnId: 'turn-outbox',
        deliveryAttemptId: 'da-outbox-fallback',
        transportStartedAt: now.toISOString(),
        transportOutcome: 'accepted_by_provider',
        providerMessageIdHash: 'hash-outbox',
        outboxState: 'accepted_by_provider',
        conversationCommitOutcome: 'committed',
        pendingCommitOutcome: 'not_applicable',
        expectedPendingVersion: null,
        observedPendingVersion: null,
        terminalAt: '2026-08-13T15:00:02.000Z',
      },
    },
    createdAt: now.toISOString(),
    updatedAt: '2026-08-13T15:00:02.000Z',
  };
  outboxFallbackStore.outbox.set(acceptedOutbox.deliveryAttemptId, acceptedOutbox);
  const restored = await outboxFallbackStore.loadLatestState(outboxFallbackKey, now);
  assert.equal(restored.pending, null);
  assert.deepEqual(
    restored.flowState?.deferredAvailability,
    deferredFlow.deferredAvailability
  );

  const flagOffHydrate = await runTurn({
    phone: outboxFallbackPhone,
    text: 'Drenagem linfática',
    store: outboxFallbackStore,
    enabled: false,
    interpreterEnabled: true,
    interpreterNenhuma: true,
    sequence: 1,
    slots: DAY_SLOTS,
  });
  assert.equal(flagOffHydrate.prepared.planReceipt.serviceContextDecision, undefined);
  assert.equal(nextFlowState(flagOffHydrate.prepared).deferredAvailability, undefined);
  assert.match(flagOffHydrate.prepared.payload ?? '', new RegExp(DATE_QUESTION_COPY, 'u'));
  if (flagOffHydrate.prepared.transition.kind === 'open') {
    assert.equal(flagOffHydrate.prepared.transition.frame.kind, 'DATE');
  }

  const helperOpen = resolveLatestFlowStateV2({
    latestPendingRecord: {
      conversationKey: 'PN:helper',
      state: 'OPEN',
      snapshot: {
        questionId: 'q-open',
        askedAt: now.toISOString(),
        kind: 'DATE',
        flowId: 'flow-open',
        version: 1,
        options: [{ position: 1, entityId: 'date-freeform', displayName: 'dia' }],
      },
      flowState: {
        flowId: 'flow-open',
        lastOperationalAt: '2026-08-13T15:00:05.000Z',
        fixedByProofVersion: {},
      },
      updatedAt: '2026-08-13T15:00:05.000Z',
    },
    lastAcceptedOutbox: {
      ...acceptedOutbox,
      commitPayload: {
        ...acceptedOutbox.commitPayload!,
        deliveryReceipt: {
          ...acceptedOutbox.commitPayload!.deliveryReceipt,
          terminalAt: '2026-08-13T15:00:01.000Z',
        },
      },
    },
    now,
  });
  assert.equal(helperOpen?.flowId, 'flow-open');
  assert.equal(helperOpen?.deferredAvailability, undefined);

  const resumeCutStore = new MemoryConversationalV2StateStore();
  const resumeCutPhone = '5511000000304';
  const resumeCutKey = `${config.phoneNumberId}:${resumeCutPhone}`;
  resumeCutStore.setInputSequence(resumeCutKey, 1);
  const resumeOutbox: OutboundOutboxRecordV2 = {
    ...acceptedOutbox,
    deliveryAttemptId: 'da-resume-cutoff',
    conversationKey: resumeCutKey,
  };
  resumeCutStore.outbox.set(resumeOutbox.deliveryAttemptId, resumeOutbox);
  assert.ok(
    (await resumeCutStore.loadLatestState(resumeCutKey, now)).flowState
      ?.deferredAvailability
  );
  const resumeHydrate = await runTurn({
    phone: resumeCutPhone,
    text: 'Tem horário hoje após as 17:30?',
    store: resumeCutStore,
    enabled: true,
    interpreterEnabled: true,
    sequence: 1,
    turnControl: {
      disposition: 'RESUME_APPROVED',
      resumeDecision: 'RESUME_ANA',
    },
  });
  assert.equal(
    resumeCutStore.flowStateInvalidations.get(resumeCutKey)?.reason,
    'EXPLICIT_CONVERSATION_RESET'
  );
  assert.notEqual(
    nextFlowState(resumeHydrate.prepared).deferredAvailability?.capturedTurnId,
    'turn-outbox'
  );
  assert.equal(
    (await resumeCutStore.loadLatestState(resumeCutKey, new Date(clockMs))).flowState,
    null
  );

  console.log('smoke-ana-conversational-v2-service-context: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
