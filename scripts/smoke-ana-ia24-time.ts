import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  TurnDeliveryReceiptV2,
} from '../src/services/conversationalV2/contracts';
import type {
  MaterializedPendingTransitionV2,
  MemoryConversationalV2StateStore,
  OutboundOutboxRecordV2,
} from '../src/services/conversationalV2/stateStore';
import type { RegenerationResultV2 } from '../src/services/conversationalV2/regenerator';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:1/ia24-time';
process.env.OPENAI_API_KEY ??= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN ??= 'smoke-invalid';

const NOW = new Date('2026-08-24T20:00:00.000Z');
const OFFERED_AT = new Date(NOW.getTime() - 45 * 60 * 1000);
const PHONE_NUMBER_ID = 'ia24-time-fixture';
const CUSTOMER_PHONE = '5511999999999';
const CONVERSATION_KEY = `${PHONE_NUMBER_ID}:${CUSTOMER_PHONE}`;
const SERVICE_ID = 'svc-manicure-pedicure';
const PROFESSIONAL_ID = 'prof-viti';
const FLOW_ID = 'flow-ia24-time';
const QUESTION_ID = 'question-ia24-time';
const SLOT_TURN_ID = 'turn-slots-ia24-time';
const OFFER_COPY =
  'Para 24/08/2026, encontrei estes horários: 18h. Qual você prefere?';

type MemoryStoreConstructor = typeof import('../src/services/conversationalV2/stateStore').MemoryConversationalV2StateStore;
let MemoryStore: MemoryStoreConstructor;
let hashReceipt: typeof import('../src/services/conversationalV2/receipts').opaqueReceiptHashV2;
let runtimeReply: typeof import('../src/services/conversationalV2/runtime').getReceptionistReplyV2;
let resolvePendingProof: typeof import('../src/services/conversationalV2/fastPaths').resolvePendingOptionProofV2;
let buildPendingQuestion: typeof import('../src/services/conversationalV2/pendingQuestion').buildPendingQuestionV2;

const SERVICES: ServicesResult = {
  success: true,
  services: [
    {
      id: SERVICE_ID,
      name: 'Manicure e pedicure',
      durationMinutes: 120,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: [PROFESSIONAL_ID],
    },
    {
      id: 'svc-manicure',
      name: 'Manicure',
      durationMinutes: 50,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: [PROFESSIONAL_ID],
    },
    {
      id: 'svc-pedicure',
      name: 'Pedicure',
      durationMinutes: 50,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: [PROFESSIONAL_ID],
    },
  ],
  professionals: [{ id: PROFESSIONAL_ID, name: 'Viti' }],
};

const CONFIG: TenantBotConfig = {
  tenantSlug: 'studio-viti',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 700,
  openaiApiKey: 'sk-smoke-invalid',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: PHONE_NUMBER_ID,
  isActive: true,
  authoritativeCatalog: {
    tenant: { name: 'Studio Viti', address: null, city: 'São Paulo', state: 'SP' },
    services: SERVICES.services!.map((service) => ({ ...service })),
    professionals: SERVICES.professionals!.map((professional) => ({
      ...professional,
      active: true,
    })),
  },
};

const FLOW_STATE: FlowStateV2 = {
  flowId: FLOW_ID,
  lastOperationalAt: OFFERED_AT.toISOString(),
  fixedServiceId: SERVICE_ID,
  fixedProfessionalId: PROFESSIONAL_ID,
  resolvedDate: '2026-08-24',
  slotEvidence: {
    turnId: SLOT_TURN_ID,
    serviceId: SERVICE_ID,
    professionalId: PROFESSIONAL_ID,
    date: '2026-08-24',
    slots: ['18:00'],
  },
  fixedByProofVersion: {
    fixedServiceId: 1,
    fixedProfessionalId: 1,
    resolvedDate: 1,
  },
};

const PENDING: PendingFrameSnapshotV2 = {
  questionId: QUESTION_ID,
  askedAt: OFFERED_AT.toISOString(),
  kind: 'TIME',
  flowId: FLOW_ID,
  version: 1,
  options: [{ position: 1, entityId: '18:00', displayName: '18h' }],
};

function acceptedReceipt(): TurnDeliveryReceiptV2 {
  return {
    schemaVersion: 2,
    deliveryReceiptId: 'receipt-ia24-time-offer',
    planReceiptId: 'plan-ia24-time-offer',
    turnId: 'turn-ia24-time-offer',
    deliveryAttemptId: 'attempt-ia24-time-offer',
    transportStartedAt: OFFERED_AT.toISOString(),
    transportOutcome: 'accepted_by_provider',
    providerMessageIdHash: hashReceipt('provider-ia24-time-offer'),
    outboxState: 'accepted_by_provider',
    flowStateCommitOutcome: 'committed',
    conversationCommitOutcome: 'committed',
    pendingCommitOutcome: 'opened',
    expectedPendingVersion: null,
    observedPendingVersion: null,
    terminalAt: OFFERED_AT.toISOString(),
  };
}

async function seedAcceptedOffer(store: InstanceType<MemoryStoreConstructor>): Promise<void> {
  const transition: MaterializedPendingTransitionV2 = {
    kind: 'open',
    frame: PENDING,
    expectedQuestionId: null,
    expectedVersion: null,
    nextFlowState: FLOW_STATE,
  };
  const record: OutboundOutboxRecordV2 = {
    deliveryAttemptId: 'attempt-ia24-time-offer',
    conversationKey: CONVERSATION_KEY,
    turnId: 'turn-ia24-time-offer',
    planReceiptId: 'plan-ia24-time-offer',
    state: 'accepted_by_provider',
    payload: OFFER_COPY,
    transition,
    providerMessageIdHash: hashReceipt('provider-ia24-time-offer'),
    providerStatus: null,
    providerStatusAt: null,
    providerFailureCode: null,
    providerStatusVersion: 0,
    transportStartedAt: OFFERED_AT.toISOString(),
    commitPayload: {
      assistantText: OFFER_COPY,
      transition,
      deliveryReceipt: acceptedReceipt(),
      copyVariant: 'slots_offer_2',
    },
    createdAt: OFFERED_AT.toISOString(),
    updatedAt: OFFERED_AT.toISOString(),
  };
  store.pending.set(CONVERSATION_KEY, [
    {
      conversationKey: CONVERSATION_KEY,
      state: 'OPEN',
      snapshot: PENDING,
      flowState: FLOW_STATE,
      updatedAt: OFFERED_AT.toISOString(),
    },
  ]);
  store.outbox.set(record.deliveryAttemptId, record);
  store.assistantHistory.set(CONVERSATION_KEY, [OFFER_COPY]);
  store.setInputSequence(CONVERSATION_KEY, 2);
}

function turnRuntime(input: { text: string; forceUpcomingRead?: boolean }) {
  return {
    inputSequence: 2,
    currentInboundIds: ['in-ia24-time'],
    currentInboundTextsById: { 'in-ia24-time': input.text },
    forceUpcomingRead: input.forceUpcomingRead,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 2,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

function adversarialModelLoop() {
  return async () => ({
    rawReply: JSON.stringify({
      reply: 'Vi que você já tem outro agendamento de Manicure e pedicure em 24/08/2026 às 18:00. Temos Manicure, Pedicure e Manicure e pedicure. Qual serviço você prefere?',
      nextPending: 'PRESERVE',
      chosenOptionText: null,
      unknownServiceText: null,
    }),
    exhausted: false,
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    providerReportedModels: ['gpt-4o-mini'],
    rounds: 1,
    messages: [],
    toolTrace: [],
    usage: [{ inputTokens: 1, outputTokens: 1 }],
  });
}

function adversarialRegenerator(): (
  reasonCodes: readonly never[],
  input: unknown
) => Promise<RegenerationResultV2> {
  return async () => ({
    ok: true,
    result: {
      schemaVersion: 2,
      reply: 'Vi que você já tem outro agendamento de Manicure e pedicure em 24/08/2026 às 18:00. Temos Manicure, Pedicure e Manicure e pedicure. Qual serviço você prefere?',
      replyPurpose: 'SERVICE_QUESTION',
      pendingTransitionCandidate: {
        kind: 'preserve',
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
    providerCalls: 1,
    providerReportedModel: 'gpt-4o-mini',
    systemFingerprint: null,
  });
}

async function prepare(input: {
  store: InstanceType<MemoryStoreConstructor>;
  model?: boolean;
  regenerate?: boolean;
  forceUpcomingRead?: boolean;
  readFailure?: boolean;
}) {
  const modelCalls: string[] = [];
  const readCalls: string[] = [];
  const rejected: Array<{ stage: string; candidate: string; reasonCodes: readonly string[] }> = [];
  const result = await runtimeReply({
    phone: CUSTOMER_PHONE,
    userMessage: 'Pode ser 18h',
    userName: 'Cliente fixture',
    config: CONFIG,
    serviceContextEnabled: true,
    serviceResolverEnabled: true,
    turnRuntime: turnRuntime({ text: 'Pode ser 18h', forceUpcomingRead: input.forceUpcomingRead }),
    deps: {
      store: input.store,
      now: () => NOW,
      id: () => 'ia24-time-id',
      loadServices: async () => SERVICES,
      loadHistory: async () => [{ role: 'assistant', content: OFFER_COPY }],
      isPaused: async () => false,
      executeProactiveDuplicateRead: async () => {
        readCalls.push('getUpcomingAppointments');
        if (input.readFailure) {
          return JSON.stringify({ success: false, reason: 'executor_error' });
        }
        return JSON.stringify({ success: true, appointments: [] });
      },
      ...(input.model ? { runModelLoop: async (...args: Parameters<ReturnType<typeof adversarialModelLoop>>) => {
        modelCalls.push('model');
        return adversarialModelLoop()(...args);
      } } : {
        runModelLoop: async () => {
          modelCalls.push('model');
          throw new Error('model não deveria rodar');
        },
      }),
      ...(input.regenerate ? { regenerate: async (...args: Parameters<ReturnType<typeof adversarialRegenerator>>) => adversarialRegenerator()(...args) } : {}),
      escalateSilent: async () => ({ kind: 'pending' as const }),
      onRejectedBoundaryCandidate: ({ stage, candidate, reasonCodes }) => {
        rejected.push({ stage, candidate, reasonCodes });
      },
    },
  });
  return { result, modelCalls, readCalls, rejected };
}

async function main(): Promise<void> {
  const stateStore = await import('../src/services/conversationalV2/stateStore');
  const receipts = await import('../src/services/conversationalV2/receipts');
  const runtime = await import('../src/services/conversationalV2/runtime');
  const fastPaths = await import('../src/services/conversationalV2/fastPaths');
  const pendingQuestion = await import('../src/services/conversationalV2/pendingQuestion');
  MemoryStore = stateStore.MemoryConversationalV2StateStore;
  hashReceipt = receipts.opaqueReceiptHashV2;
  runtimeReply = runtime.getReceptionistReplyV2;
  resolvePendingProof = fastPaths.resolvePendingOptionProofV2;
  buildPendingQuestion = pendingQuestion.buildPendingQuestionV2;

  const proof = resolvePendingProof({
    frame: {
      schemaVersion: 2,
      turnId: 'turn-ia24-time',
      inputSequence: 2,
      catalogSnapshotHash: 'a'.repeat(64),
      catalogState: 'available',
      humanControl: 'NO_ACTIVE_TAKEOVER',
      currentInboundIds: ['in-ia24-time'],
      pending: PENDING,
      flowState: FLOW_STATE,
    },
    inboundId: 'in-ia24-time',
    inboundText: 'Pode ser 18h',
    now: NOW,
  });
  assert.equal(proof?.entityId, '18:00', 'TIME proof aceita a resposta elicitada');

  const store = new MemoryStore();
  await seedAcceptedOffer(store);
  const first = await prepare({ store, forceUpcomingRead: false });
  assert.equal(
    first.result.planReceipt.boundaryAttempts.some((attempt) =>
      attempt.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT')
    ),
    false
  );
  assert.equal(first.modelCalls.length, 0);
  assert.deepEqual(first.readCalls, ['getUpcomingAppointments']);
  assert.equal(first.result.planReceipt.route, 'fast_path');
  assert.equal(first.result.planReceipt.primaryModelRounds, 0);
  assert.equal(first.result.planReceipt.regenProviderCalls, 0);
  assert.equal(first.result.planReceipt.toolEffects.length, 1);
  assert.equal(first.result.planReceipt.toolEffects[0]?.tool, 'getUpcomingAppointments');
  assert.equal(first.result.planReceipt.primaryProviderCalls, 0);
  assert.equal(first.result.hasCommittedWrite, false);
  assert.equal(first.result.transition.kind, 'open');
  if (first.result.transition.kind === 'open') {
    assert.equal(first.result.transition.frame.kind, 'CONFIRMATION');
    assert.equal(
      first.result.transition.frame.options[0]?.entityId,
      `booking-confirmation:${FLOW_ID}`
    );
    assert.equal(first.result.transition.nextFlowState.bookingDraft?.time, '18:00');
  }
  assert.equal(
    first.result.planReceipt.toolEffects.filter((effect) => effect.class === 'write').length,
    0
  );
  assert.match(first.result.payload ?? '', /^Confirmando:/u);

  const progress = await import('../src/services/conversationalV2/bookingProgressFastPaths');
  const boundary = await import('../src/services/conversationalV2/boundary');
  const conflictingAppointment = {
    id: 'appt-ia24-conflict',
    startTime: '2026-08-24T21:00:00.000Z',
    endTime: '2026-08-24T23:00:00.000Z',
    serviceName: 'Manicure e pedicure',
    professionalName: 'Viti',
    status: 'CONFIRMED',
  };
  const conflict = await progress.resolveTimeDuplicatePreflightV2({
    frame: {
      schemaVersion: 2,
      turnId: 'turn-ia24-time-conflict',
      inputSequence: 2,
      catalogSnapshotHash: 'b'.repeat(64),
      catalogState: 'available',
      humanControl: 'NO_ACTIVE_TAKEOVER',
      currentInboundIds: ['in-ia24-time'],
      pending: PENDING,
      flowState: FLOW_STATE,
    },
    inboundId: 'in-ia24-time',
    inboundText: 'Pode ser 18h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: SERVICES,
    config: CONFIG,
    now: NOW,
    lastAcceptedAssistantText: OFFER_COPY,
    executeTool: async () =>
      JSON.stringify({ success: true, appointments: [conflictingAppointment] }),
  });
  assert.equal(conflict.kind, 'resolved');
  if (conflict.kind === 'resolved') {
    assert.match(conflict.result.reply, /^Vi que você já tem outro agendamento/u);
    const conflictBoundary = boundary.evaluateBoundaryV2({
      rawCandidate: conflict.result.reply,
      servicesResult: SERVICES,
      toolTrace: conflict.loop.toolTrace,
      sourceInboundText: 'Pode ser 18h',
      currentInboundIds: ['in-ia24-time'],
      inboundTextsById: { 'in-ia24-time': 'Pode ser 18h' },
      flowState: conflict.nextFlowState,
      pendingTransitionCandidate: conflict.result.pendingTransitionCandidate,
      replyPurpose: conflict.result.replyPurpose,
      source: 'CANONICAL',
      route: 'model',
      pendingAnaOpen: true,
      pendingSnapshot: PENDING,
      temporalContext: { now: NOW, timezone: CONFIG.timezone },
    });
    assert.equal(
      conflictBoundary.safe && conflictBoundary.originalAccepted,
      true,
      conflictBoundary.reasonCodes.join(',')
    );
    const unlicensedConflict = boundary.evaluateBoundaryV2({
      rawCandidate: conflict.result.reply,
      servicesResult: SERVICES,
      sourceInboundText: 'Pode ser 18h',
      flowState: conflict.nextFlowState,
      pendingTransitionCandidate: conflict.result.pendingTransitionCandidate,
      replyPurpose: conflict.result.replyPurpose,
      source: 'GENERATED',
      route: 'model',
      pendingAnaOpen: true,
      pendingSnapshot: PENDING,
      temporalContext: { now: NOW, timezone: CONFIG.timezone },
    });
    assert.equal(
      unlicensedConflict.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
      true
    );
    const staleReadBoundary = boundary.evaluateBoundaryV2({
      rawCandidate: conflict.result.reply,
      servicesResult: SERVICES,
      toolTrace: [
        {
          name: 'getUpcomingAppointments',
          userTurn: 1,
          result: JSON.stringify({ success: true, appointments: [conflictingAppointment] }),
        },
        {
          name: 'getUpcomingAppointments',
          userTurn: 2,
          result: JSON.stringify({ success: true, appointments: [] }),
        },
      ],
      sourceInboundText: 'Pode ser 18h',
      flowState: conflict.nextFlowState,
      pendingTransitionCandidate: conflict.result.pendingTransitionCandidate,
      replyPurpose: conflict.result.replyPurpose,
      source: 'GENERATED',
      route: 'model',
      pendingAnaOpen: true,
      pendingSnapshot: PENDING,
      temporalContext: { now: NOW, timezone: CONFIG.timezone },
    });
    assert.equal(
      staleReadBoundary.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
      true,
      'read de turno anterior não licencia duplicidade'
    );
  }

  const adversarialStore = new MemoryStore();
  await seedAcceptedOffer(adversarialStore);
  const adversarial = await prepare({
    store: adversarialStore,
    model: true,
    regenerate: true,
    forceUpcomingRead: false,
    readFailure: true,
  });
  assert.equal(adversarial.modelCalls.length, 1);
  assert.equal(adversarial.result.planReceipt.route, 'fallback');
  assert.equal(adversarial.result.planReceipt.regenProviderCalls, 1);
  assert.equal(adversarial.result.planReceipt.boundaryAttempts.length, 3);
  assert.ok(
    adversarial.result.planReceipt.boundaryAttempts.slice(0, 2).every((attempt) =>
      attempt.reasonCodes.includes('SERVICE_RELIST_AFTER_FIXED') &&
      attempt.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT')
    )
  );
  assert.match(
    adversarial.result.payload ?? '',
    /^A gente estava marcando Manicure e pedicure para 24\/08\/2026 — qual horário você prefere\?$/u
  );

  assert.equal(
    buildPendingQuestion({
      pending: PENDING,
      flowState: FLOW_STATE,
      catalog: SERVICES,
      reanchor: true,
    }),
    'A gente estava marcando Manicure e pedicure para 24/08/2026 — qual horário você prefere?'
  );
  console.log('smoke-ana-ia24-time: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
