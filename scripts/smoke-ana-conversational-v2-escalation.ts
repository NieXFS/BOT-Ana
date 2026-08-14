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
  }) => {
    const store = new stateStore.MemoryConversationalV2StateStore();
    const conversationKey = context.buildConversationKey(
      config.phoneNumberId,
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
        config,
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
  const acknowledged = await success.deliver(acknowledgement);
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
  assert.equal(unavailableDelivery.receipt.pendingCommitOutcome, 'preserved');
  const failedAfter = await failed.store.loadLatestState(
    failed.conversationKey,
    now
  );
  assert.equal(
    failedAfter.pending?.snapshot.questionId,
    failed.before.pending?.snapshot.questionId
  );

  console.log(
    'PASS smoke escalada v2: ação autoritativa, boundary, pause-ack, fail-closed e pendência preservada.'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
