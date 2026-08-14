import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_escalation';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'true';

const now = new Date('2026-08-14T12:00:00.000Z');
let serial = 0;
const nextId = () => `escalation-v2-${++serial}`;

const config = {
  tenantSlug: 'fixture-escalation-v2',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-no-network',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-ESCALATION-V2',
  isActive: true,
} as TenantBotConfig;

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-limpeza',
      name: 'Limpeza de Pele Profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

async function main(): Promise<void> {
  const runtime = await import('../src/services/conversationalV2/runtime');
  const delivery = await import('../src/services/conversationalV2/delivery');
  const stateStore = await import('../src/services/conversationalV2/stateStore');
  const context = await import('../src/services/contextManager');
  const escalation = await import('../src/services/questionEscalation');
  const escalationCache = await import('../src/services/escalationCache');
  const pause = await import('../src/services/pauseService');

  escalationCache.__resetEscalationCacheForTest();
  pause.__resetPauseCacheForTest();

  for (const text of [
    'posso falar com a dona?',
    'chama a responsável',
    'quero falar com uma pessoa',
  ]) {
    assert.equal(escalation.detectEscalationReason(text), 'HUMAN_REQUEST');
  }

  const runConversation = async (input: {
    phone: string;
    escalationPost: () => Promise<unknown>;
    botConfig?: TenantBotConfig;
  }) => {
    const activeConfig = input.botConfig ?? config;
    const store = new stateStore.MemoryConversationalV2StateStore();
    const conversationKey = context.buildConversationKey(
      activeConfig.phoneNumberId,
      input.phone
    );
    let sequence = 0;
    const prepare = async (text: string) => {
      sequence += 1;
      store.setInputSequence(conversationKey, sequence);
      const inboundId = nextId();
      return runtime.getReceptionistReplyV2({
        phone: input.phone,
        userMessage: text,
        userName: 'Cliente Fixture',
        config: activeConfig,
        turnRuntime: {
          turnId: nextId(),
          inputSequence: sequence,
          currentInboundIds: [inboundId],
          currentInboundTextsById: { [inboundId]: text },
          checkpoint: async () => ({
            paused: false,
            latestInputSequence: sequence,
            successorInputSequence: null,
            successorInboundMessageIds: [],
          }),
        },
        deps: {
          store,
          now: () => now,
          id: nextId,
          loadServices: async () => services,
          loadHistory: async () => [],
          isPaused: async () => false,
          runModelLoop: async () => {
            throw new Error('O smoke de escalada não pode chamar modelo.');
          },
          executeTool: async () => {
            throw new Error('O smoke de escalada não pode chamar tool do modelo.');
          },
          escalate: (candidate) =>
            escalation.maybeEscalateReceptionistQuestionV2(candidate, {
              post: input.escalationPost,
            }),
        },
      });
    };
    const deliver = async (
      prepared: Awaited<ReturnType<typeof prepare>>
    ) =>
      delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store,
        now: () => now,
        id: nextId,
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: sequence,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
        sendTransport: async () => ({ providerMessageId: nextId() }),
      });

    const initial = await prepare('quero agendar');
    assert.equal(initial.planReceipt.route, 'fast_path');
    await deliver(initial);
    const before = await store.loadLatestState(conversationKey, now);
    assert.equal(before.pending?.state, 'OPEN');
    assert.equal(before.pending?.snapshot.kind, 'SERVICE');
    return { store, conversationKey, prepare, deliver, before };
  };

  const success = await runConversation({
    phone: '+5511999000101',
    escalationPost: async () => ({
      questionId: 'question-authoritative-fixture',
      escalation: {
        active: true,
        questionId: 'question-authoritative-fixture',
        version: 4,
      },
    }),
  });
  const acknowledgement = await success.prepare('posso falar com a dona?');
  assert.equal(acknowledgement.planReceipt.route, 'fast_path');
  assert.equal(
    acknowledgement.authoritativeEscalationQuestionId,
    'question-authoritative-fixture'
  );
  assert.match(acknowledgement.payload ?? '', /^Vou avisar /u);
  assert.deepEqual(
    acknowledgement.planReceipt.boundaryAttempts[0]?.reasonCodes,
    [],
    'questionId autoritativo licencia a promessa na boundary'
  );

  const outbound = await import('../src/services/receptionistOutbound');
  const unlicensedEnvelope = outbound.validateReceptionistOutbound(
    outbound.buildReceptionistEnvelope({
      purpose: 'ESCALATION',
      blocks: [{ source: 'CANONICAL', text: acknowledgement.payload! }],
      authoritativeCatalog: outbound.catalogFromConfig(config),
    })
  );
  assert.equal(unlicensedEnvelope.originalAccepted, false);
  assert.ok(
    unlicensedEnvelope.reasonCodes.includes('UNRECORDED_HANDOFF'),
    'copy de escalada sem questionId é UNRECORDED_HANDOFF no validador final'
  );
  const licensedEnvelope = outbound.validateReceptionistOutbound(
    outbound.buildReceptionistEnvelope({
      purpose: 'ESCALATION',
      blocks: [{ source: 'CANONICAL', text: acknowledgement.payload! }],
      authoritativeCatalog: outbound.catalogFromConfig(config),
      evidence: {
        actionRecorded: true,
        authoritativeEscalationQuestionId:
          acknowledgement.authoritativeEscalationQuestionId,
      },
    })
  );
  assert.equal(
    licensedEnvelope.originalAccepted,
    true,
    'questionId confirmado licencia a mesma copy no validador final'
  );

  const stripped = {
    ...acknowledgement,
    authoritativeEscalationQuestionId: undefined,
  };
  const leaked = await success.deliver(stripped);
  assert.equal(leaked.delivery, 'suppressed');
  assert.equal(leaked.receipt.transportStartedAt, null);
  assert.equal(
    leaked.receipt.transportOutcome,
    'suppressed_pause',
    'promessa sem questionId não chega ao transporte'
  );

  const acknowledged = await success.deliver(acknowledgement);
  assert.equal(acknowledged.delivery, 'sent');
  assert.equal(acknowledged.receipt.transportOutcome, 'accepted_by_provider');
  assert.equal(acknowledged.receipt.pendingCommitOutcome, 'preserved');
  const after = await success.store.loadLatestState(success.conversationKey, now);
  assert.equal(
    after.pending?.snapshot.questionId,
    success.before.pending?.snapshot.questionId
  );
  assert.equal(
    after.pending?.snapshot.version,
    success.before.pending?.snapshot.version
  );

  const namedConfig = {
    ...config,
    phoneNumberId: 'PN-ESCALATION-V2-NAMED',
    escalationResponsibleName: 'Heloísa',
  } as TenantBotConfig;
  const named = await runConversation({
    phone: '+5511999000303',
    botConfig: namedConfig,
    escalationPost: async () => ({
      questionId: 'question-named-responsible',
      escalation: {
        active: true,
        questionId: 'question-named-responsible',
        version: 4,
      },
    }),
  });
  const namedAck = await named.prepare('posso falar com a dona?');
  assert.equal(
    namedAck.payload,
    'Vou avisar Heloísa, responsável por este atendimento.'
  );
  assert.equal(
    namedAck.authoritativeEscalationQuestionId,
    'question-named-responsible'
  );
  const namedUnlicensed = outbound.validateReceptionistOutbound(
    outbound.buildReceptionistEnvelope({
      purpose: 'ESCALATION',
      blocks: [{ source: 'CANONICAL', text: namedAck.payload! }],
      authoritativeCatalog: outbound.catalogFromConfig(namedConfig),
    })
  );
  assert.equal(namedUnlicensed.originalAccepted, false);
  assert.ok(namedUnlicensed.reasonCodes.includes('UNRECORDED_HANDOFF'));
  const namedLicensed = outbound.validateReceptionistOutbound(
    outbound.buildReceptionistEnvelope({
      purpose: 'ESCALATION',
      blocks: [{ source: 'CANONICAL', text: namedAck.payload! }],
      authoritativeCatalog: outbound.catalogFromConfig(namedConfig),
      evidence: {
        actionRecorded: true,
        authoritativeEscalationQuestionId:
          namedAck.authoritativeEscalationQuestionId,
      },
    })
  );
  assert.equal(namedLicensed.originalAccepted, true);
  const namedLeaked = await named.deliver({
    ...namedAck,
    authoritativeEscalationQuestionId: undefined,
  });
  assert.equal(
    namedLeaked.delivery,
    'suppressed',
    'promessa nominal sem questionId não chega ao transporte'
  );
  const namedDelivered = await named.deliver(namedAck);
  assert.equal(namedDelivered.delivery, 'sent');
  assert.equal(namedDelivered.receipt.transportOutcome, 'accepted_by_provider');
  assert.equal(namedDelivered.receipt.pendingCommitOutcome, 'preserved');

  assert.equal(
    await pause.isConversationPausedForEscalationAcknowledgement(
      config.phoneNumberId,
      '+5511999000101',
      'question-authoritative-fixture',
      {
        now: () => now.getTime(),
        fetchState: async () => ({
          globalPausedUntil: null,
          conversationPausedUntil: null,
          schedulePausedUntil: null,
          escalation: {
            active: true,
            questionId: 'question-authoritative-fixture',
            version: 4,
          },
        }),
      }
    ),
    false,
    'somente a confirmação da ação recém-registrada atravessa a pausa criada por ela'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(
      config.phoneNumberId,
      '+5511999000101'
    )?.questionId,
    'question-authoritative-fixture'
  );
  assert.equal(
    await pause.isConversationPausedForEscalationAcknowledgement(
      config.phoneNumberId,
      '+5511999000101',
      'question-authoritative-fixture',
      {
        now: () => now.getTime(),
        fetchState: async () => ({
          globalPausedUntil: null,
          conversationPausedUntil: null,
          schedulePausedUntil: null,
        }),
      }
    ),
    false,
    'pause-state sem campo escalation não apaga o questionId local nem silencia o ack'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(
      config.phoneNumberId,
      '+5511999000101'
    )?.active,
    true,
    'campo aditivo ausente preserva o snapshot local'
  );
  assert.equal(
    await pause.isConversationPausedForEscalationAcknowledgement(
      config.phoneNumberId,
      '+5511999000101',
      'question-different',
      {
        now: () => now.getTime(),
        fetchState: async () => null,
      }
    ),
    true,
    'questionId divergente falha fechado'
  );

  const ackPnid = 'PN-ESCALATION-ACK-BRANCHES';
  const ackPhone = '+5511999000999';
  const ackQuestion = 'question-ack-fixture';
  const idlePause = {
    globalPausedUntil: null,
    conversationPausedUntil: null,
    schedulePausedUntil: null,
  };
  const seedAckLocal = () =>
    escalationCache.updateEscalationCache(
      ackPnid,
      ackPhone,
      { active: true, questionId: ackQuestion, version: 4 },
      now.getTime(),
      true
    );
  const ackPaused = (
    state: {
      globalPausedUntil: string | null;
      conversationPausedUntil: string | null;
      schedulePausedUntil: string | null;
      escalation?: unknown;
    } | null
  ) =>
    pause.isConversationPausedForEscalationAcknowledgement(
      ackPnid,
      ackPhone,
      ackQuestion,
      {
        now: () => now.getTime(),
        fetchState: async () =>
          state as import('../src/services/pauseDecision').PauseState | null,
      }
    );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: null,
    }),
    true,
    'escalation:null é valor presente e falha fechado'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(ackPnid, ackPhone)?.active,
    true,
    'escalation:null não apaga o snapshot local ativo'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(ackPnid, ackPhone)?.questionId,
    ackQuestion
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: { active: false },
    }),
    true,
    '{active:false} incompleto falha fechado'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(ackPnid, ackPhone)?.active,
    true,
    '{active:false} incompleto não grava inactive no snapshot local'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: 'inactive',
    }),
    true,
    'escalation primitivo falha fechado'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: [{ active: false, questionId: null, version: 8 }],
    }),
    true,
    'escalation array falha fechado'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: { active: true, questionId: null, version: 4 },
    }),
    true,
    'active:true sem questionId falha fechado'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: { active: true, questionId: 'question-other', version: 9 },
    }),
    true,
    'active:true com questionId remoto divergente falha fechado'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      escalation: { active: false, questionId: null, version: 8 },
    }),
    false,
    'active:false atualiza o cache e aplica a decisão ordinária sem fingir ack'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(ackPnid, ackPhone)?.active,
    false,
    'active:false grava inactive no snapshot local'
  );

  seedAckLocal();
  assert.equal(
    await ackPaused({
      ...idlePause,
      conversationPausedUntil: new Date(now.getTime() + 60_000).toISOString(),
      escalation: { active: false, questionId: null, version: 8 },
    }),
    true,
    'active:false não fura pausa ordinária de conversa'
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(ackPnid, ackPhone)?.active,
    false
  );

  seedAckLocal();
  assert.equal(
    await ackPaused(null),
    true,
    'fetch de pause-state nulo continua fail-closed'
  );

  const failed = await runConversation({
    phone: '+5511999000202',
    escalationPost: async () => {
      throw new Error('Receps sinteticamente indisponível');
    },
  });
  const unavailable = await failed.prepare('quero falar com uma pessoa');
  assert.equal(unavailable.authoritativeEscalationQuestionId, undefined);
  assert.doesNotMatch(unavailable.payload ?? '', /vou avisar/iu);
  assert.match(unavailable.payload ?? '', /falar diretamente com a equipe/iu);
  const unavailableDelivery = await failed.deliver(unavailable);
  assert.equal(unavailableDelivery.delivery, 'sent');
  assert.equal(unavailableDelivery.receipt.transportOutcome, 'accepted_by_provider');
  assert.equal(unavailableDelivery.receipt.pendingCommitOutcome, 'preserved');
  const failedAfter = await failed.store.loadLatestState(
    failed.conversationKey,
    now
  );
  assert.equal(
    failedAfter.pending?.snapshot.questionId,
    failed.before.pending?.snapshot.questionId
  );

  const handler = await import('../src/messageHandler');
  const runFlushEscalationChain = async (input: {
    phone: string;
    phoneNumberId: string;
    responsibleName: string;
    escalationPost: () => Promise<unknown>;
  }) => {
    handler.__resetFlushStateForTest();
    escalationCache.__resetEscalationCacheForTest();
    pause.__resetPauseCacheForTest();
    const store = new stateStore.MemoryConversationalV2StateStore();
    const chainConfig = {
      ...config,
      phoneNumberId: input.phoneNumberId,
      escalationResponsibleName: input.responsibleName,
    } as TenantBotConfig;
    const conversationKey = context.buildConversationKey(
      chainConfig.phoneNumberId,
      input.phone
    );
    let sequence = 0;
    const transported: string[] = [];
    const pauseStateWithoutEscalation = {
      globalPausedUntil: null,
      conversationPausedUntil: null,
      schedulePausedUntil: null,
    };
    const flushDeps = {
      getReply: async (
        from: string,
        text: string,
        userName: string,
        cfg: TenantBotConfig
      ) => {
        sequence += 1;
        store.setInputSequence(conversationKey, sequence);
        const inboundId = nextId();
        return runtime.getReceptionistReplyV2({
          phone: from,
          userMessage: text,
          userName,
          config: cfg,
          turnRuntime: {
            turnId: nextId(),
            inputSequence: sequence,
            currentInboundIds: [inboundId],
            currentInboundTextsById: { [inboundId]: text },
            checkpoint: async () => ({
              paused: false,
              latestInputSequence: sequence,
              successorInputSequence: null,
              successorInboundMessageIds: [],
            }),
          },
          deps: {
            store,
            now: () => now,
            id: nextId,
            loadServices: async () => services,
            loadHistory: async () => [],
            isPaused: async () => false,
            runModelLoop: async () => {
              throw new Error('O E2E de escalada não pode chamar modelo.');
            },
            executeTool: async () => {
              throw new Error('O E2E de escalada não pode chamar tool do modelo.');
            },
            escalate: (candidate) =>
              escalation.maybeEscalateReceptionistQuestionV2(candidate, {
                post: input.escalationPost,
              }),
          },
        });
      },
      sendReply: async () => {
        throw new Error('Confirmação v2 não pode usar o transporte v1.');
      },
      isPaused: async () => false,
      isPausedForEscalationAck: (
        phoneNumberId: string,
        customerPhone: string,
        questionId: string
      ) =>
        pause.isConversationPausedForEscalationAcknowledgement(
          phoneNumberId,
          customerPhone,
          questionId,
          {
            now: () => now.getTime(),
            fetchState: async () => pauseStateWithoutEscalation,
          }
        ),
      recordPausedInbound: async () => {},
      withConversationLock: async (
        _phoneNumberId: string,
        _customerPhone: string,
        work: () => Promise<void>
      ) => work(),
      deliverV2: (
        prepared: Awaited<ReturnType<typeof runtime.getReceptionistReplyV2>>,
        checkpoint: () => Promise<{
          paused: boolean;
          latestInputSequence: number;
          successorInputSequence: number | null;
          successorInboundMessageIds: string[];
        }>
      ) =>
        delivery.deliverPreparedReceptionistTurnV2(prepared, {
          store,
          now: () => now,
          id: nextId,
          checkpoint,
          sendTransport: async (payload: string) => {
            transported.push(payload);
            return { providerMessageId: nextId() };
          },
        }),
    };
    const openKey = handler.__seedFlushBufferForTest(chainConfig, input.phone, [
      'quero agendar',
    ]);
    await handler.flushBuffer(openKey, flushDeps);
    const before = await store.loadLatestState(conversationKey, now);
    const escalateKey = handler.__seedFlushBufferForTest(
      chainConfig,
      input.phone,
      ['posso falar com a dona?']
    );
    await handler.flushBuffer(escalateKey, flushDeps);
    const afterState = await store.loadLatestState(conversationKey, now);
    return { store, conversationKey, transported, before, afterState };
  };

  const e2e = await runFlushEscalationChain({
    phone: '+5511999000404',
    phoneNumberId: 'PN-ESCALATION-V2-E2E',
    responsibleName: 'Heloísa',
    escalationPost: async () => ({
      questionId: 'question-e2e-flush',
      escalation: {
        active: true,
        questionId: 'question-e2e-flush',
        version: 4,
      },
    }),
  });
  assert.equal(e2e.before.pending?.state, 'OPEN');
  assert.equal(e2e.before.pending?.snapshot.kind, 'SERVICE');
  assert.equal(e2e.transported.length, 2);
  assert.equal(
    e2e.transported[1],
    'Vou avisar Heloísa, responsável por este atendimento.'
  );
  assert.equal(e2e.afterState.pending?.state, 'OPEN');
  assert.equal(
    e2e.afterState.pending?.snapshot.questionId,
    e2e.before.pending?.snapshot.questionId
  );
  assert.equal(
    e2e.afterState.pending?.snapshot.version,
    e2e.before.pending?.snapshot.version
  );
  assert.equal(
    escalationCache.getEscalationSnapshot(
      'PN-ESCALATION-V2-E2E',
      '+5511999000404'
    )?.questionId,
    'question-e2e-flush',
    'pause-state sem campo aditivo preserva o snapshot local no E2E do flush'
  );

  const e2eFailed = await runFlushEscalationChain({
    phone: '+5511999000505',
    phoneNumberId: 'PN-ESCALATION-V2-E2E-DOWN',
    responsibleName: 'Heloísa',
    escalationPost: async () => {
      throw new Error('Receps sinteticamente indisponível');
    },
  });
  assert.equal(e2eFailed.transported.length, 2);
  assert.doesNotMatch(e2eFailed.transported[1] ?? '', /vou avisar/iu);
  assert.match(
    e2eFailed.transported[1] ?? '',
    /falar diretamente com a equipe/iu
  );
  assert.equal(e2eFailed.afterState.pending?.state, 'OPEN');
  assert.equal(
    e2eFailed.afterState.pending?.snapshot.questionId,
    e2eFailed.before.pending?.snapshot.questionId
  );

  console.log(
    'PASS smoke escalada v2: ação autoritativa, validador final, transporte, pause-ack, fail-closed, E2E flushBuffer e pendência preservada.'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
