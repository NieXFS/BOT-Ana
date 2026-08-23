import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import {
  bookingConfirmationGate,
} from '../src/services/bookingConfirmationGate';
import type {
  DeferredAvailabilityConstraintV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import { serializeTurnPlanReceiptV2 } from '../src/services/conversationalV2/receipts';
import {
  isAnaV2ServiceContextEnabled,
} from '../src/services/conversationalV2/featureFlag';
import { resolveCurrentInboundDateV2 } from '../src/services/conversationalV2/currentDateResolution';
import {
  captureDeferredAvailabilityConstraintV2,
  filterSlotsByDeferredWindowV2,
  inboundHasVaguePeriodV2,
  resolveServiceCorrectionDecisionV2,
  SERVICE_CONTEXT_REJECTED_COPY_V2,
  buildPolarityAmbiguityCopyV2,
} from '../src/services/conversationalV2/serviceContext';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import {
  MemoryConversationalV2StateStore,
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

const fillers = Array.from({ length: 40 }, (_, index) => ({
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
    },
    {
      id: 'svc-pedi',
      name: 'Pedicure',
      durationMinutes: 40,
      price: 45,
      priceFormatted: 'R$ 45,00',
      professionalIds: ['prof-ana', 'prof-bia'],
    },
    {
      id: 'svc-mani-pedi',
      name: 'Manicure e pedicure',
      durationMinutes: 70,
      price: 70,
      priceFormatted: 'R$ 70,00',
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-mani-trad',
      name: 'Manicure tradicional',
      durationMinutes: 40,
      price: 35,
      priceFormatted: 'R$ 35,00',
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
const FULL_SLOTS = ['16:00', '17:00', '17:30', '18:00', '18:30', '19:00'];
const AFTER_EXCLUSIVE_SLOTS = ['18:00', '18:30', '19:00'];

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

function turnRuntime(text: string, sequence = 1, paused = false) {
  const inboundId = nextId();
  return {
    inputSequence: sequence,
    currentInboundIds: [inboundId],
    currentInboundTextsById: { [inboundId]: text },
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

async function runTurn(input: {
  phone: string;
  text: string;
  store: MemoryConversationalV2StateStore;
  enabled: boolean;
  interpreterEnabled?: boolean;
  sequence?: number;
  slots?: readonly string[];
  toolResponse?: string;
  throwTool?: boolean;
  now?: Date;
  paused?: boolean;
  allowModel?: boolean;
}) {
  const toolNames: string[] = [];
  const slotPayload = input.slots ?? FULL_SLOTS;
  const prepared = await getReceptionistReplyV2({
    phone: input.phone,
    userMessage: input.text,
    userName: 'Cliente',
    config,
    interpreterEnabled: input.interpreterEnabled ?? false,
    serviceContextEnabled: input.enabled,
    turnRuntime: turnRuntime(
      input.text,
      input.sequence ?? 1,
      input.paused ?? false
    ),
    deps: {
      store: input.store,
      now: () => input.now ?? tick(),
      id: nextId,
      loadServices: async () => catalog,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: input.interpreterEnabled ?? false,
      serviceContextEnabled: input.enabled,
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({ success: true, appointments: [] }),
      escalateSilent: async () => ({ kind: 'pending' as const }),
      runInterpreter: async () => {
        throw new Error('planner/service-context não deve chamar o intérprete');
      },
      runModelLoop: async () => {
        if (input.allowModel) {
          return {
            rawReply: JSON.stringify({
              reply: 'Qual serviço você prefere?',
              nextPending: 'SERVICE',
              chosenOptionText: null,
              unknownServiceText: null,
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
  sequence = 1
) {
  if (!prepared.payload) {
    throw new Error('entrega exige payload');
  }
  await deliverPreparedReceptionistTurnV2(prepared, {
    store,
    id: nextId,
    now: () => tick(),
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
    interpreterEnabled: true,
  });
  assert.equal(familyOn.prepared.planReceipt.route, 'fast_path');
  assert.equal(
    familyOn.prepared.planReceipt.serviceContextDecision,
    'temporal_deferred'
  );
  assert.equal(familyOn.prepared.transition.kind, 'open');
  if (familyOn.prepared.transition.kind === 'open') {
    assert.equal(familyOn.prepared.transition.frame.kind, 'SERVICE');
    assert.deepEqual(
      familyOn.prepared.transition.frame.options.map((option) => option.entityId),
      ['svc-repo', 'svc-unha-inf']
    );
  }
  assert.match(
    familyOn.prepared.payload ?? '',
    /Para eu verificar hoje depois das 17h30, qual destes serviços você quer: Reposição de unha ou Unha infantil\?/u
  );
  assert.doesNotMatch(familyOn.prepared.payload ?? '', /Preenchimento Estético/u);
  assert.equal(familyOn.toolNames.length, 0);
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

  console.log('smoke-ana-conversational-v2-service-context: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
