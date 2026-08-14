import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import { evaluateBoundaryV2 } from '../src/services/conversationalV2/boundary';
import type {
  ResolutionProof,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import {
  resolvePendingOptionProofV2,
} from '../src/services/conversationalV2/fastPaths';
import {
  canonicalReadFailureCopyV2,
  hasExplicitAvailabilityReadRequestV2,
  hasExplicitUpcomingReadRequestV2,
  resolveReadFastPathV2,
} from '../src/services/conversationalV2/readFastPaths';
import { assertReceiptRedactedV2 } from '../src/services/conversationalV2/receipts';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import {
  buildSocialCompositionMessagesV2,
  detectStrictSocialRouteV2,
  resolveSocialTurnV2,
} from '../src/services/conversationalV2/social';
import {
  MemoryConversationalV2StateStore,
  type PendingFrameRecordV2,
} from '../src/services/conversationalV2/stateStore';

const now = new Date('2026-08-13T15:00:00.000Z');
let serial = 0;
const nextId = () => `social-read-v2-${++serial}`;
const config = {
  tenantSlug: 'tenant-v2-social-read',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: 'Oi! Que bom receber sua mensagem.',
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-invalid',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'smoke-token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-V2-SOCIAL-READ',
  isActive: true,
} as TenantBotConfig;

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-julia'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 45,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia', 'prof-marina'],
    },
  ],
  professionals: [
    { id: 'prof-julia', name: 'Júlia' },
    { id: 'prof-marina', name: 'Marina' },
  ],
};

function frame(overrides: Partial<TurnFrameV2> = {}): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: nextId(),
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: ['in-current'],
    pending: null,
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    ...overrides,
  };
}

function socialBoundary(
  rawCandidate: string,
  extra: Record<string, unknown> = {}
) {
  return evaluateBoundaryV2({
    rawCandidate,
    servicesResult: services,
    sourceInboundText: 'Oi',
    currentInboundIds: ['in-current'],
    inboundTextsById: { 'in-current': 'Oi' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'SOCIAL',
    ...extra,
  });
}

async function main(): Promise<void> {
  for (const [text, expectedKind] of [
    ['Oi, tudo bem?', 'greeting'],
    ['Muito obrigada pela ajuda!', 'courtesy'],
    ['O atendimento foi maravilhoso!', 'compliment'],
    ['Tchau, até mais!', 'farewell'],
    ['Até sexta às 20h!', 'farewell'],
    ['kkk', 'smalltalk'],
  ] as const) {
    const detected = detectStrictSocialRouteV2({
      inboundId: 'in-current',
      inboundText: text,
      servicesResult: services,
    });
    assert.equal(detected.matched, true, text);
    assert.equal(detected.matched && detected.kind, expectedKind, text);
  }
  for (const text of [
    'Obrigada! E amanhã tem horário?',
    'kkk drenagem',
    'Oi Júlia',
    'Valeu, quero agendar',
  ]) {
    assert.equal(
      detectStrictSocialRouteV2({
        inboundId: 'in-current',
        inboundText: text,
        servicesResult: services,
      }).matched,
      false,
      text
    );
  }

  const prompt = buildSocialCompositionMessagesV2({ inboundText: 'Oi' });
  assert.equal(prompt.length, 2);
  assert.doesNotMatch(JSON.stringify(prompt), /Drenagem|Peeling|svc-/);
  assert.match(JSON.stringify(prompt), /1 ou 2 frases/);

  const socialBlocklist: Array<[string, string]> = [
    ['Temos Peeling Facial.', 'SOCIAL_OPERATIONAL_FACT'],
    ['Custa R$ 100,00.', 'SOCIAL_PRICE_FACT'],
    ['É 120,00.', 'SOCIAL_PRICE_FACT'],
    ['Fica 120.', 'SOCIAL_PRICE_FACT'],
    ['São cento e vinte reais.', 'SOCIAL_PRICE_FACT'],
    ['Fica cento e vinte.', 'SOCIAL_PRICE_FACT'],
    ['É baratinho.', 'SOCIAL_PRICE_FACT'],
    ['Funcionamos das 8 às 18.', 'SOCIAL_BUSINESS_HOURS_FACT'],
    ['Atendemos de segunda a sexta.', 'SOCIAL_BUSINESS_HOURS_FACT'],
    ['Tem promoção e pagamento por Pix.', 'SOCIAL_COMMERCE_FACT'],
    ['Nosso endereço fica na Avenida Central.', 'SOCIAL_ADDRESS_FACT'],
    ['A agenda está cheia, mas tento encaixe.', 'SOCIAL_CAPACITY_FACT'],
    ['Dura 30 minutos.', 'SOCIAL_DURATION_FACT'],
    ['A gerente vai falar com você.', 'SOCIAL_STAFF_FACT'],
    ['Chama no Instagram.', 'SOCIAL_PARALLEL_CHANNEL'],
    ['Esse tratamento garante resultado.', 'SOCIAL_CLINICAL_CLAIM'],
    ['Chegue 15 minutos antes e venha em jejum.', 'SOCIAL_ATTENDANCE_INSTRUCTION'],
    ['A dona já te conhece.', 'SOCIAL_PERSON_IDENTITY_FACT'],
    ['A equipe vai retornar para você.', 'SOCIAL_HUMAN_RETURN_PROMISE'],
  ];
  for (const [candidate, reason] of socialBlocklist) {
    const result = socialBoundary(candidate);
    assert.equal(result.safe, false, candidate);
    assert.equal(result.reasonCodes.includes(reason as never), true, `${candidate}: ${result.reasonCodes}`);
  }
  const handoffBoundary = socialBoundary('A equipe vai retornar para você.');
  assert.equal(
    handoffBoundary.stages[0]?.reasonCodes.includes('UNRECORDED_HANDOFF'),
    true,
    'UNRECORDED_HANDOFF global roda antes da fronteira específica da rota social'
  );
  assert.equal(
    socialBoundary('Oi! Tudo bem? Como você está?').reasonCodes.includes(
      'SOCIAL_FORMAT_VIOLATION'
    ),
    true
  );
  assert.equal(
    socialBoundary('Oi! 😊✨').reasonCodes.includes('SOCIAL_FORMAT_VIOLATION'),
    true
  );
  assert.equal(
    socialBoundary('Oi! Estou por aqui.', {
      recentAssistantReplies: ['Oi! Estou por aqui.'],
    }).reasonCodes.includes('SOCIAL_RECENT_REPLY_REPETITION'),
    true
  );

  const temporalInbound = 'sexta às 20h';
  const temporalEvidence = {
    inboundId: 'in-current',
    start: 0,
    end: Array.from(temporalInbound).length,
  };
  assert.equal(
    socialBoundary('Sexta às 20h então!', {
      sourceInboundText: temporalInbound,
      inboundTextsById: { 'in-current': temporalInbound },
      socialTemporalEvidence: temporalEvidence,
    }).safe,
    true
  );
  for (const extra of [
    {
      candidate: 'Sexta às 21h então!',
      inboundTextsById: { 'in-current': temporalInbound },
      socialTemporalEvidence: temporalEvidence,
    },
    {
      candidate: 'Sexta às 20h então!',
      inboundTextsById: { 'in-history': temporalInbound },
      socialTemporalEvidence: {
        inboundId: 'in-history',
        start: 0,
        end: Array.from(temporalInbound).length,
      },
    },
    {
      candidate: 'Sexta às 20h então!',
      inboundTextsById: { 'in-current': 'Tchau!' },
      socialTemporalEvidence: null,
    },
  ]) {
    assert.equal(
      socialBoundary(extra.candidate, {
        sourceInboundText: 'Tchau',
        inboundTextsById: extra.inboundTextsById,
        socialTemporalEvidence: extra.socialTemporalEvidence,
      }).reasonCodes.includes('UNLICENSED_SOCIAL_TEMPORAL_ECHO'),
      true
    );
  }

  const socialFrame = frame();
  const detection = detectStrictSocialRouteV2({
    inboundId: 'in-current',
    inboundText: 'Oi',
    servicesResult: services,
  });
  assert.equal(detection.matched, true);
  if (!detection.matched) throw new Error('fixture social inválida');
  let socialCalls = 0;
  const regenerated = await resolveSocialTurnV2({
    config,
    frame: socialFrame,
    servicesResult: services,
    inboundText: 'Oi',
    inboundTextsById: { 'in-current': 'Oi' },
    detection,
    recentAssistantReplies: [],
    compose: async (input) => {
      socialCalls += 1;
      assert.equal(input.regenerationReasonCodes !== undefined, socialCalls === 2);
      return {
        ok: true,
        candidate:
          socialCalls === 1
            ? 'Funcionamos das 8 às 18.'
            : 'Oi! Que bom falar com você 😊',
        providerCalls: 1,
      };
    },
  });
  assert.equal(regenerated.status, 'accepted');
  assert.equal(regenerated.status === 'accepted' && regenerated.recoveryKind, 'regen');
  assert.equal(socialCalls, 2);

  let fallbackCalls = 0;
  const tenantGreetingFallback = await resolveSocialTurnV2({
    config,
    frame: socialFrame,
    servicesResult: services,
    inboundText: 'Oi',
    inboundTextsById: { 'in-current': 'Oi' },
    detection,
    recentAssistantReplies: [],
    compose: async () => {
      fallbackCalls += 1;
      return {
        ok: true,
        candidate: 'Atendemos de segunda a sexta.',
        providerCalls: 1,
      };
    },
  });
  assert.equal(fallbackCalls, 2, 'fallback só ocorre depois da única regen no-tools');
  assert.equal(tenantGreetingFallback.status, 'accepted');
  assert.equal(
    tenantGreetingFallback.status === 'accepted' && tenantGreetingFallback.payload,
    config.greetingMessage,
    'greetingMessage é fallback literal, sem reinterpretação ou prepend'
  );
  assert.equal(
    tenantGreetingFallback.status === 'accepted' && tenantGreetingFallback.recoveryKind,
    'direct_fallback'
  );

  const pendingSnapshot = {
    questionId: 'question-social',
    askedAt: now.toISOString(),
    kind: 'SERVICE' as const,
    flowId: 'flow-social',
    version: 3,
    options: [
      { position: 1, entityId: 'svc-drenagem', displayName: 'Drenagem Linfática' },
      { position: 2, entityId: 'svc-peeling', displayName: 'Peeling Facial' },
    ],
  };
  const socialStore = new MemoryConversationalV2StateStore();
  const socialKey = `${config.phoneNumberId}:5511000000001`;
  socialStore.pending.set(socialKey, [
    {
      conversationKey: socialKey,
      state: 'OPEN',
      snapshot: pendingSnapshot,
      flowState: { flowId: pendingSnapshot.flowId, fixedByProofVersion: {} },
      updatedAt: now.toISOString(),
    },
  ]);
  socialStore.setInputSequence(socialKey, 1);
  let operationalModelCalls = 0;
  const preparedSocial = await getReceptionistReplyV2({
    phone: '5511000000001',
    userMessage: 'Oi',
    userName: 'Cliente',
    config,
    turnRuntime: {
      inputSequence: 1,
      currentInboundIds: ['in-current'],
      currentInboundTextsById: { 'in-current': 'Oi' },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: socialStore,
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      runModelLoop: async () => {
        operationalModelCalls += 1;
        throw new Error('social não usa loop operacional');
      },
      composeSocial: async () => ({
        ok: true,
        candidate: 'Oi! Que bom falar com você 😊',
        providerCalls: 1,
      }),
    },
  });
  assert.equal(operationalModelCalls, 0);
  assert.equal(
    preparedSocial.planReceipt.route,
    'model',
    'rota social usa a rota normativa model do TurnPlanReceiptV2'
  );
  assert.deepEqual(preparedSocial.transition, { kind: 'preserve' });
  assert.equal(preparedSocial.payload, 'Oi! Que bom falar com você 😊');
  assert.notEqual(preparedSocial.payload, config.greetingMessage);
  assert.deepEqual(preparedSocial.planReceipt.pendingTransitionCandidate, { kind: 'preserve' });
  const deliveredSocial = await deliverPreparedReceptionistTurnV2(preparedSocial, {
    store: socialStore,
    now: () => now,
    id: nextId,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  assert.equal(deliveredSocial.receipt.pendingCommitOutcome, 'preserved');
  assert.equal(
    (await socialStore.verifyReceiptReconciliation([preparedSocial.frame.turnId])).ok,
    true,
    'rota social persiste exatamente um recibo de plano e um de entrega'
  );
  assert.equal(
    (await socialStore.loadLatestState(socialKey, now)).pending?.snapshot.version,
    pendingSnapshot.version
  );

  assert.equal(hasExplicitUpcomingReadRequestV2('Quero ver meus agendamentos'), true);
  assert.equal(hasExplicitUpcomingReadRequestV2('Não quero ver meus agendamentos'), false);
  assert.equal(hasExplicitAvailabilityReadRequestV2('Tem horários nessa data?'), true);
  assert.equal(hasExplicitAvailabilityReadRequestV2('Não tem horários nessa data?'), false);

  let forcedSuccessorReadCalls = 0;
  const forcedSuccessorRead = await resolveReadFastPathV2({
    frame: frame(),
    inboundText: 'E agora?',
    servicesResult: services,
    config,
    forceUpcomingRead: true,
    executeTool: async (name) => {
      forcedSuccessorReadCalls += 1;
      assert.equal(name, 'getUpcomingAppointments');
      return JSON.stringify({ success: true, appointments: [] });
    },
  });
  assert.equal(forcedSuccessorRead.kind, 'resolved');
  assert.equal(forcedSuccessorReadCalls, 1);

  const forcedRuntimeStore = new MemoryConversationalV2StateStore();
  const forcedRuntimePhone = '5511000000002';
  const forcedRuntimeKey = `${config.phoneNumberId}:${forcedRuntimePhone}`;
  forcedRuntimeStore.setInputSequence(forcedRuntimeKey, 2);
  let forcedRuntimeModelCalls = 0;
  let forcedRuntimeToolCalls = 0;
  const forcedRuntimePrepared = await getReceptionistReplyV2({
    phone: forcedRuntimePhone,
    userMessage: 'E agora?',
    userName: 'Cliente',
    config,
    turnRuntime: {
      turnId: 'successor-after-write',
      inputSequence: 2,
      currentInboundIds: ['in-successor'],
      currentInboundTextsById: { 'in-successor': 'E agora?' },
      forceUpcomingRead: true,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 2,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: forcedRuntimeStore,
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      executeTool: async (name) => {
        forcedRuntimeToolCalls += 1;
        assert.equal(name, 'getUpcomingAppointments');
        return JSON.stringify({ success: true, appointments: [] });
      },
      runModelLoop: async () => {
        forcedRuntimeModelCalls += 1;
        throw new Error('sucessor pós-write não pode chegar ao modelo antes do read');
      },
    },
  });
  assert.equal(forcedRuntimePrepared.planReceipt.route, 'fast_path');
  assert.equal(forcedRuntimeToolCalls, 1);
  assert.equal(forcedRuntimeModelCalls, 0);
  await deliverPreparedReceptionistTurnV2(forcedRuntimePrepared, {
    store: forcedRuntimeStore,
    now: () => now,
    id: nextId,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 2,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  assert.equal(
    (
      await forcedRuntimeStore.verifyReceiptReconciliation([
        forcedRuntimePrepared.frame.turnId,
      ])
    ).ok,
    true,
    'sucessor pós-write persiste recibos do read fast-path 1:1'
  );
  for (const receipt of [
    ...socialStore.plans.values(),
    ...socialStore.deliveries.values(),
    ...forcedRuntimeStore.plans.values(),
    ...forcedRuntimeStore.deliveries.values(),
  ]) {
    assert.doesNotThrow(() =>
      assertReceiptRedactedV2(receipt, {
        forbiddenCatalogEntityIds: [
          'svc-drenagem',
          'svc-peeling',
          'prof-julia',
          'prof-marina',
        ],
        forbiddenPlaintextFragments: [
          'Oi! Que bom falar com você 😊',
          'E agora?',
        ],
        forbiddenMessageIds: ['in-current', 'in-successor'],
        forbiddenPhoneValues: [socialKey.split(':').at(-1)!, forcedRuntimePhone],
      })
    );
  }

  const leakage =
    'INTERNAL_HINT: cliente +5511999999999, wamid.abc, 18:30, svc-drenagem';
  let upcomingCalls = 0;
  const failedUpcoming = await resolveReadFastPathV2({
    frame: frame(),
    inboundText: 'Quero ver meus agendamentos',
    servicesResult: services,
    config,
    executeTool: async () => {
      upcomingCalls += 1;
      return JSON.stringify({ success: false, reason: 'other', message: leakage });
    },
  });
  assert.equal(failedUpcoming.kind, 'resolved');
  assert.equal(upcomingCalls, 1);
  const failedUpcomingReply =
    failedUpcoming.kind === 'resolved' ? failedUpcoming.result.reply : '';
  assert.equal(failedUpcomingReply, canonicalReadFailureCopyV2('upcoming', 'other'));
  assert.doesNotMatch(failedUpcomingReply, /INTERNAL_HINT|551199|wamid|18:30|svc-/);

  const successUpcoming = await resolveReadFastPathV2({
    frame: frame(),
    inboundText: 'Quero ver meus agendamentos',
    servicesResult: services,
    config,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'appointment-secret-id',
            startTime: '2026-08-14T12:00:00.000Z',
            endTime: '2026-08-14T13:00:00.000Z',
            serviceName: 'Drenagem Linfática',
            professionalName: 'Júlia',
            status: 'CONFIRMED',
          },
        ],
      }),
  });
  assert.equal(successUpcoming.kind, 'resolved');
  const successUpcomingReply =
    successUpcoming.kind === 'resolved' ? successUpcoming.result.reply : '';
  assert.match(successUpcomingReply, /Drenagem Linfática/);
  assert.match(successUpcomingReply, /Júlia/);
  assert.doesNotMatch(successUpcomingReply, /appointment-secret-id|CONFIRMED/);
  if (successUpcoming.kind !== 'resolved') throw new Error('fixture upcoming inválida');
  const upcomingBoundary = evaluateBoundaryV2({
    rawCandidate: successUpcoming.result.reply,
    servicesResult: services,
    sourceInboundText: 'Quero ver meus agendamentos',
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: successUpcoming.result.pendingTransitionCandidate,
    replyPurpose: successUpcoming.result.replyPurpose,
    toolTrace: successUpcoming.loop.toolTrace,
    forbiddenAppointmentIds: ['appointment-secret-id'],
  });
  assert.equal(upcomingBoundary.safe, true, upcomingBoundary.reasonCodes.join(','));

  const duplicatePending = {
    questionId: 'question-duplicate',
    askedAt: now.toISOString(),
    kind: 'CONFIRMATION' as const,
    flowId: 'flow-duplicate',
    version: 4,
    options: [
      {
        position: 1,
        entityId: 'duplicate-resolution:keep-both',
        displayName: 'manter os dois',
      },
      {
        position: 2,
        entityId: 'duplicate-resolution:reschedule',
        displayName: 'remarcar',
      },
    ],
  };
  const duplicateFrame = frame({
    pending: duplicatePending,
    flowState: { flowId: duplicatePending.flowId, fixedByProofVersion: {} },
  });
  const duplicateProof = resolvePendingOptionProofV2({
    frame: duplicateFrame,
    inboundId: 'in-current',
    inboundText: 'opção 2',
    now,
  });
  assert.ok(duplicateProof);
  let duplicateReads = 0;
  const duplicateRead = await resolveReadFastPathV2({
    frame: duplicateFrame,
    inboundText: 'opção 2',
    servicesResult: services,
    config,
    duplicateResolutionProof: duplicateProof,
    executeTool: async () => {
      duplicateReads += 1;
      return JSON.stringify({ success: true, appointments: [] });
    },
  });
  assert.equal(duplicateRead.kind, 'resolved');
  assert.equal(duplicateReads, 1);
  const wrongFlowProof = duplicateProof
    ? ({ ...duplicateProof, flowId: 'other-flow' } as ResolutionProof)
    : null;
  const wrongFlowRead = await resolveReadFastPathV2({
    frame: duplicateFrame,
    inboundText: 'opção 2',
    servicesResult: services,
    config,
    duplicateResolutionProof: wrongFlowProof,
    executeTool: async () => {
      throw new Error('proof inválido não lê');
    },
  });
  assert.equal(wrongFlowRead.kind, 'continue_model');

  const availabilityFrame = frame({
    flowState: {
      flowId: 'flow-availability',
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-julia',
      resolvedDate: '2026-08-14',
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    },
  });
  let availabilityArgs: Record<string, unknown> | null = null;
  const availability = await resolveReadFastPathV2({
    frame: availabilityFrame,
    inboundText: 'Tem horários nessa data?',
    servicesResult: services,
    config,
    executeTool: async (_name, args) => {
      availabilityArgs = args;
      return JSON.stringify({ success: true, slots: ['09:00', '10:30'] });
    },
  });
  assert.equal(availability.kind, 'resolved');
  assert.deepEqual(availabilityArgs, {
    date: '2026-08-14',
    serviceId: 'svc-drenagem',
    professionalId: 'prof-julia',
  });
  if (availability.kind !== 'resolved') throw new Error('fixture de disponibilidade');
  assert.match(availability.result.reply, /09:00, 10:30/);
  assert.equal(availability.result.pendingTransitionCandidate.kind, 'open');
  assert.equal(
    availability.result.pendingTransitionCandidate.kind === 'open' &&
      availability.result.pendingTransitionCandidate.pendingKind,
    'TIME'
  );
  const availabilityBoundary = evaluateBoundaryV2({
    rawCandidate: availability.result.reply,
    servicesResult: services,
    sourceInboundText: 'Tem horários nessa data?',
    flowState: availabilityFrame.flowState,
    pendingTransitionCandidate: availability.result.pendingTransitionCandidate,
    replyPurpose: availability.result.replyPurpose,
    toolTrace: availability.loop.toolTrace,
  });
  assert.equal(availabilityBoundary.safe, true, availabilityBoundary.reasonCodes.join(','));

  const failedAvailability = await resolveReadFastPathV2({
    frame: availabilityFrame,
    inboundText: 'Tem horários nessa data?',
    servicesResult: services,
    config,
    executeTool: async () =>
      JSON.stringify({
        success: false,
        reason: 'outside_hours',
        message: leakage,
        hint: leakage,
      }),
  });
  assert.equal(failedAvailability.kind, 'resolved');
  const failedAvailabilityReply =
    failedAvailability.kind === 'resolved' ? failedAvailability.result.reply : '';
  assert.equal(
    failedAvailabilityReply,
    canonicalReadFailureCopyV2('availability', 'outside_hours')
  );
  assert.doesNotMatch(failedAvailabilityReply, /INTERNAL_HINT|551199|wamid|18:30|svc-/);

  const negativeAvailability = await resolveReadFastPathV2({
    frame: availabilityFrame,
    inboundText: 'Não quero consultar horários nessa data',
    servicesResult: services,
    config,
    executeTool: async () => {
      throw new Error('negação não executa read');
    },
  });
  assert.equal(negativeAvailability.kind, 'continue_model');

  console.log('smoke ana conversational v2 social reads: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
