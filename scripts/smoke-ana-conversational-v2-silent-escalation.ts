import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type { TurnPlanReceiptV2 } from '../src/services/conversationalV2/contracts';
import { buildUnderstandingFailureDivergenceV2 } from '../src/services/conversationalV2/divergence';
import { hashTurnPlanReceiptV2 } from '../src/services/conversationalV2/receipts';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_silent_escalation';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'true';

const now = new Date('2026-08-19T16:00:00.000Z');
let serial = 0;
const nextId = () => `silent-esc-${++serial}`;

const config = {
  tenantSlug: 'fixture-silent-escalation',
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
  phoneNumberId: 'PN-SILENT-ESC',
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
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

const invalidEnvelope = {
  ok: false as const,
  issues: [{ code: 'INVALID_JSON' as const, path: '$' }],
};

async function main(): Promise<void> {
  const recoveryMod = await import(
    '../src/services/conversationalV2/recoveryCoordinator'
  );
  const holdMod = await import('../src/services/silentEscalationHold');
  const escalation = await import('../src/services/questionEscalation');
  const runtime = await import('../src/services/conversationalV2/runtime');
  const delivery = await import('../src/services/conversationalV2/delivery');
  const stateStore = await import('../src/services/conversationalV2/stateStore');
  const context = await import('../src/services/contextManager');

  holdMod.__resetSilentEscalationHoldForTest();

  const frame = {
    schemaVersion: 2 as const,
    turnId: 'turn-silent',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available' as const,
    humanControl: 'NO_ACTIVE_TAKEOVER' as const,
    currentInboundIds: ['in-silent'],
    pending: null,
    flowState: { flowId: 'flow-silent', fixedByProofVersion: {} },
  };

  const recovered = await recoveryMod.coordinateRecoveryV2({
    frame,
    fallbackIntent: 'OTHER',
    primaryResult: invalidEnvelope,
    boundaryContext: {
      servicesResult: services,
      sourceInboundText: 'blergh xyzzy',
      currentInboundIds: ['in-silent'],
      inboundTextsById: { 'in-silent': 'blergh xyzzy' },
    },
    toolTrace: [],
    regenerate: async () => ({
      ok: false,
      reasonCode: 'REGEN_MODEL_RESULT_INVALID',
      providerCalls: 1,
    }),
  });
  assert.equal(recovered.status, 'silent_escalation');
  if (recovered.status !== 'silent_escalation') {
    throw new Error('expected silent_escalation');
  }
  assert.equal(recovered.payload, null);
  assert.equal(recovered.recoveryKind, 'silent_escalation');
  assert.equal(recovered.regenCount, 1);
  assert.equal(recovered.fallbackIntent, 'OTHER');
  assert.ok(recovered.primaryReasonCodes.includes('MODEL_RESULT_INVALID'));
  assert.ok(
    recovered.regenerationReasonCodes.includes('REGEN_MODEL_RESULT_INVALID')
  );

  const catalogFrame = { ...frame, catalogState: 'unavailable' as const };
  const catalogFallback = await recoveryMod.coordinateRecoveryV2({
    frame: catalogFrame,
    fallbackIntent: 'INFORMATION_QUESTION',
    primaryResult: invalidEnvelope,
    boundaryContext: {
      servicesResult: { success: false },
      sourceInboundText: 'quanto custa?',
      currentInboundIds: ['in-catalog'],
      inboundTextsById: { 'in-catalog': 'quanto custa?' },
    },
    toolTrace: [],
    regenerate: async () => ({
      ok: false,
      reasonCode: 'REGEN_MODEL_RESULT_INVALID',
      providerCalls: 1,
    }),
  });
  assert.equal(catalogFallback.status, 'accepted');
  if (catalogFallback.status === 'accepted') {
    assert.equal(
      catalogFallback.payload,
      recoveryMod.CATALOG_UNAVAILABLE_FALLBACK_V2
    );
  }

  const copyVariation = await recoveryMod.coordinateRecoveryV2({
    frame,
    fallbackIntent: 'OTHER',
    primaryResult: invalidEnvelope,
    boundaryContext: {
      servicesResult: services,
      sourceInboundText: 'blergh xyzzy de novo',
      currentInboundIds: ['in-copy-var'],
      inboundTextsById: { 'in-copy-var': 'blergh xyzzy de novo' },
      recentAssistantReplies: [
        recoveryMod.OTHER_FALLBACK_V2,
        'Não consegui entender. Pode repetir de outro jeito?',
      ],
    },
    toolTrace: [],
    regenerate: async () => ({
      ok: false,
      reasonCode: 'REGEN_MODEL_RESULT_INVALID',
      providerCalls: 1,
    }),
  });
  assert.equal(copyVariation.status, 'silent_escalation');

  const holdStore = new holdMod.MemorySilentEscalationHoldStore();
  let posts: Array<Record<string, unknown>> = [];
  let questionSerial = 0;
  const post = async (input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string;
    reasonCode: string;
    requiredAction?: string;
    divergence?: unknown;
  }) => {
    posts.push({ ...input });
    questionSerial += 1;
    return {
      questionId: `q-silent-${input.messageId}`,
      version: questionSerial,
      requiredAction: input.requiredAction,
      escalation: {
        active: true,
        questionId: `q-silent-${input.messageId}`,
        version: questionSerial,
      },
    };
  };

  const divergence = buildUnderstandingFailureDivergenceV2({
    fallbackIntent: recovered.fallbackIntent,
    primaryReasonCodes: recovered.primaryReasonCodes,
    regenerationReasonCodes: recovered.regenerationReasonCodes,
    turnReceiptHash: hashTurnPlanReceiptV2({
      schemaVersion: 2,
      planReceiptId: 'plan-silent-fixture',
      turnId: 'turn-silent',
      frameHash: 'a'.repeat(64),
      inputSequence: 1,
      route: 'fallback',
      provider: 'openai',
      requestedModel: 'gpt-4o-mini',
      response: { model: 'gpt-4o-mini', systemFingerprint: null },
      thinkingMode: 'disabled',
      strictTools: false,
      primaryModelRounds: 1,
      primaryProviderCalls: 1,
      regenProviderCalls: 1,
      pendingTransitionCandidate: { kind: 'preserve' },
      toolEffects: [],
      boundaryAttempts: [],
      recoveryKind: 'silent_escalation',
      result: 'accepted_for_delivery',
    } satisfies TurnPlanReceiptV2),
  });
  assert.equal(divergence.schemaVersion, 1);
  assert.equal(divergence.kind, 'UNDERSTANDING_FAILURE');
  assert.equal(divergence.stage, 'AFTER_INTERNAL_REGENERATION');
  assert.match(divergence.turnReceiptHash, /^[a-f0-9]{64}$/);

  const first = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: config.phoneNumberId,
      customerPhone: '+5511999000101',
      messageId: 'wamid-silent-1',
      divergence,
    },
    { holdStore, post, now: () => now, wait: async () => undefined }
  );
  assert.equal(first.kind, 'created');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.reasonCode, 'REPEATED_FAILURE');
  assert.equal(posts[0]?.requiredAction, 'TAKE_OVER_WHATSAPP');
  assert.deepEqual(posts[0]?.divergence, divergence);
  const confirmedHold = await holdStore.loadByMessageId('wamid-silent-1');
  assert.equal(confirmedHold?.status, 'confirmed');
  assert.equal(
    await holdMod.isSilentEscalationHoldActive(
      config.phoneNumberId,
      '+5511999000101',
      holdStore
    ),
    false,
    'depois do POST a pausa ESCALATION do ERP é autoritativa'
  );

  const retrySame = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: config.phoneNumberId,
      customerPhone: '+5511999000101',
      messageId: 'wamid-silent-1',
      divergence,
    },
    { holdStore, post, now: () => now, wait: async () => undefined }
  );
  assert.equal(retrySame.kind, 'deduplicated');
  if (retrySame.kind === 'deduplicated' && first.kind === 'created') {
    assert.equal(retrySame.questionId, first.questionId);
  }
  assert.equal(posts.length, 1, 'retry do mesmo messageId não dispara novo POST');

  const secondInbound = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: config.phoneNumberId,
      customerPhone: '+5511999000101',
      messageId: 'wamid-silent-2',
      divergence,
    },
    { holdStore, post, now: () => now, wait: async () => undefined }
  );
  assert.equal(secondInbound.kind, 'active_elsewhere');
  assert.equal(posts.length, 1, 'inbound seguinte não cria novo evento');

  const otherTenantHold = new holdMod.MemorySilentEscalationHoldStore();
  const other = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: 'PN-OTHER-TENANT',
      customerPhone: '+5511999000101',
      messageId: 'wamid-silent-other',
      divergence,
    },
    {
      holdStore: otherTenantHold,
      post,
      now: () => now,
      wait: async () => undefined,
    }
  );
  assert.equal(other.kind, 'created');
  assert.equal(posts.length, 2, 'mesmo telefone em outro phoneNumberId isola');

  const failStore = new holdMod.MemorySilentEscalationHoldStore();
  let failAttempts = 0;
  const failingPost = async () => {
    failAttempts += 1;
    if (failAttempts < 4) {
      const error = new Error('network');
      throw error;
    }
    return {
      questionId: 'q-after-retry',
      version: 1,
      escalation: { active: true, questionId: 'q-after-retry', version: 1 },
    };
  };
  const pending = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: 'PN-FAIL',
      customerPhone: '+5511999000102',
      messageId: 'wamid-silent-fail',
      divergence,
    },
    {
      holdStore: failStore,
      post: failingPost,
      now: () => now,
      wait: async () => undefined,
    }
  );
  assert.equal(pending.kind, 'pending');
  assert.equal(
    await holdMod.isSilentEscalationHoldActive(
      'PN-FAIL',
      '+5511999000102',
      failStore
    ),
    true
  );
  const holdRow = await failStore.loadByMessageId('wamid-silent-fail');
  assert.equal(holdRow?.status, 'pending');
  holdRow!.nextRetryAt = new Date(0);
  const swept = await escalation.sweepSilentEscalationHolds(
    {
      holdStore: failStore,
      post: failingPost,
      now: () => now,
      wait: async () => undefined,
    },
    10
  );
  assert.equal(swept.confirmed, 1);
  const confirmed = await failStore.loadByMessageId('wamid-silent-fail');
  assert.equal(confirmed?.status, 'confirmed');
  assert.equal(confirmed?.questionId, 'q-after-retry');

  await holdMod.releaseSilentEscalationHold(
    'PN-FAIL',
    '+5511999000102',
    failStore
  );
  assert.equal(
    await holdMod.isSilentEscalationHoldActive(
      'PN-FAIL',
      '+5511999000102',
      failStore
    ),
    false
  );

  const store = new stateStore.MemoryConversationalV2StateStore();
  const conversationKey = context.buildConversationKey(
    config.phoneNumberId,
    '+5511999000200'
  );
  store.setInputSequence(conversationKey, 1);
  const runtimeHold = new holdMod.MemorySilentEscalationHoldStore();
  const runtimePosts: unknown[] = [];
  const prepared = await runtime.getReceptionistReplyV2({
    phone: '+5511999000200',
    userMessage: 'blergh xyzzy sem sentido',
    userName: 'Cliente Fixture',
    config,
    turnRuntime: {
      turnId: nextId(),
      inputSequence: 1,
      currentInboundIds: ['wamid-runtime-silent'],
      currentInboundTextsById: {
        'wamid-runtime-silent': 'blergh xyzzy sem sentido',
      },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
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
      interpreterEnabled: false,
      runModelLoop: async () => ({
        rawReply: '{',
        exhausted: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
      regenerate: async () => ({
        ok: false,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID',
        providerCalls: 1,
      }),
      executeTool: async () => {
        throw new Error('silent escalation smoke não executa tools');
      },
      escalateSilent: (input, deps) =>
        escalation.escalateSilentUnderstandingFailure(input, {
          ...deps,
          holdStore: runtimeHold,
          post: async (candidate) => {
            runtimePosts.push(candidate);
            return {
              questionId: 'q-runtime-silent',
              version: 1,
              escalation: {
                active: true,
                questionId: 'q-runtime-silent',
                version: 1,
              },
            };
          },
          now: () => now,
          wait: async () => undefined,
        }),
    },
  });
  assert.equal(prepared.planReceipt.recoveryKind, 'silent_escalation');
  assert.equal(prepared.payload, null);
  assert.equal(runtimePosts.length, 1);

  const delivered = await delivery.deliverPreparedReceptionistTurnV2(prepared, {
    store,
    now: () => now,
    id: nextId,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => {
      throw new Error('silent escalation não pode chamar transporte');
    },
  });
  assert.equal(delivered.delivery, 'silent');
  assert.equal(delivered.receipt.transportOutcome, 'silent_escalation');
  assert.equal(delivered.receipt.conversationCommitOutcome, 'not_applicable');

  const humanPosts: unknown[] = [];
  const human = await runtime.getReceptionistReplyV2({
    phone: '+5511999000300',
    userMessage: 'quero falar com uma pessoa',
    userName: 'Cliente Fixture',
    config,
    turnRuntime: {
      turnId: nextId(),
      inputSequence: 1,
      currentInboundIds: ['wamid-human'],
      currentInboundTextsById: {
        'wamid-human': 'quero falar com uma pessoa',
      },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: new stateStore.MemoryConversationalV2StateStore(),
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: false,
      runModelLoop: async () => {
        throw new Error('pedido explícito não pode chamar modelo');
      },
      escalate: (candidate) =>
        escalation.maybeEscalateReceptionistQuestionV2(candidate, {
          post: async (input) => {
            humanPosts.push(input);
            return {
              questionId: 'q-human',
              version: 1,
              escalation: { active: true, questionId: 'q-human', version: 1 },
            };
          },
        }),
    },
  });
  assert.equal(human.planReceipt.route, 'fast_path');
  assert.match(human.payload ?? '', /^Vou avisar /u);
  assert.equal(human.authoritativeEscalationQuestionId, 'q-human');
  assert.equal(humanPosts.length, 1);
  assert.equal(
    (humanPosts[0] as { reasonCode?: string }).reasonCode,
    'HUMAN_REQUEST'
  );
  assert.equal(
    (humanPosts[0] as { divergence?: unknown }).divergence,
    undefined
  );

  const echoHold = new holdMod.MemorySilentEscalationHoldStore();
  const echoActive = await escalation.escalateSilentUnderstandingFailure(
    {
      phoneNumberId: 'PN-ECHO',
      customerPhone: '+5511999000500',
      messageId: 'wamid-silent-echo',
      divergence,
    },
    {
      holdStore: echoHold,
      post: async () => {
        const error = Object.assign(new Error('echo human active'), {
          isAxiosError: true,
          response: {
            status: 409,
            data: { code: 'ECHO_HUMAN_ACTIVE' },
          },
        });
        throw error;
      },
      now: () => now,
      wait: async () => undefined,
    }
  );
  assert.equal(echoActive.kind, 'released');
  assert.equal(
    (await echoHold.loadByMessageId('wamid-silent-echo'))?.status,
    'released'
  );

  const persistFailStore = new holdMod.MemorySilentEscalationHoldStore();
  persistFailStore.ensure = async () => {
    throw new Error('hold store ensure failed');
  };
  persistFailStore.loadActiveByConversation = async () => {
    throw new Error('hold store loadActive failed');
  };
  const persistFailPosts: unknown[] = [];
  await assert.rejects(
    () =>
      escalation.escalateSilentUnderstandingFailure(
        {
          phoneNumberId: 'PN-HOLD-FAIL',
          customerPhone: '+5511999000600',
          messageId: 'wamid-hold-fail',
          divergence,
        },
        {
          holdStore: persistFailStore,
          post: async (input) => {
            persistFailPosts.push(input);
            return {
              questionId: 'q-should-not-exist',
              version: 1,
              escalation: {
                active: true,
                questionId: 'q-should-not-exist',
                version: 1,
              },
            };
          },
          now: () => now,
          wait: async () => undefined,
        }
      ),
    (error: unknown) =>
      error instanceof holdMod.SilentEscalationHoldPersistenceError
  );
  assert.equal(persistFailPosts.length, 0, 'persistência falha não POSTA ao ERP');

  const persistFailRuntimeStore = new holdMod.MemorySilentEscalationHoldStore();
  persistFailRuntimeStore.ensure = async () => {
    throw new Error('hold store ensure failed');
  };
  persistFailRuntimeStore.loadActiveByConversation = async () => {
    throw new Error('hold store loadActive failed');
  };
  const persistFailRuntimePosts: unknown[] = [];
  await assert.rejects(
    () =>
      runtime.getReceptionistReplyV2({
        phone: '+5511999000601',
        userMessage: 'blergh xyzzy hold fail',
        userName: 'Cliente Fixture',
        config,
        turnRuntime: {
          turnId: nextId(),
          inputSequence: 1,
          currentInboundIds: ['wamid-runtime-hold-fail'],
          currentInboundTextsById: {
            'wamid-runtime-hold-fail': 'blergh xyzzy hold fail',
          },
          checkpoint: async () => ({
            paused: false,
            latestInputSequence: 1,
            successorInputSequence: null,
            successorInboundMessageIds: [],
          }),
        },
        deps: {
          store: new stateStore.MemoryConversationalV2StateStore(),
          now: () => now,
          id: nextId,
          loadServices: async () => services,
          loadHistory: async () => [],
          isPaused: async () => false,
          interpreterEnabled: false,
          runModelLoop: async () => ({
            rawReply: '{',
            exhausted: false,
            provider: 'openai',
            model: 'gpt-4o-mini',
            providerReportedModels: ['gpt-4o-mini'],
            rounds: 1,
            messages: [],
            toolTrace: [],
            usage: [],
          }),
          regenerate: async () => ({
            ok: false,
            reasonCode: 'REGEN_MODEL_RESULT_INVALID',
            providerCalls: 1,
          }),
          executeTool: async () => {
            throw new Error('hold persist fail não executa tools');
          },
          escalateSilent: (input, deps) =>
            escalation.escalateSilentUnderstandingFailure(input, {
              ...deps,
              holdStore: persistFailRuntimeStore,
              post: async (candidate) => {
                persistFailRuntimePosts.push(candidate);
                return {
                  questionId: 'q-runtime-hold-fail',
                  version: 1,
                  escalation: {
                    active: true,
                    questionId: 'q-runtime-hold-fail',
                    version: 1,
                  },
                };
              },
              now: () => now,
              wait: async () => undefined,
            }),
        },
      }),
    (error: unknown) =>
      error instanceof holdMod.SilentEscalationHoldPersistenceError
  );
  assert.equal(persistFailRuntimePosts.length, 0);

  const handler = await import('../src/messageHandler');

  // --- Fixture 1: pending + cache vazio + lookup desconhecido ---------------
  // O hold existe no store, mas a leitura da conversa falha depois de um
  // restart/cache reset. A recepcionista deve registrar o inbound e parar
  // antes de buffer/brain/model/tool/outbound; o erro não pode virar inactive.
  const unknownStore = new holdMod.MemorySilentEscalationHoldStore();
  const unknownPhone = '+5511999000590';
  await holdMod.persistSilentEscalationHold({
    phoneNumberId: 'PN-HOLD-UNKNOWN',
    customerPhone: unknownPhone,
    sourceMessageId: 'wamid-hold-unknown',
    divergence,
    store: unknownStore,
    now,
  });
  holdMod.__resetSilentEscalationHoldForTest();
  unknownStore.loadActiveByConversation = async () => {
    throw new Error('lookup transitório indisponível');
  };
  let unknownInboundLookups = 0;
  let unknownInboundOutbound = 0;
  const unknownConfig = {
    ...config,
    phoneNumberId: 'PN-HOLD-UNKNOWN',
  } as TenantBotConfig;
  const unknownKey = context.buildConversationKey(
    unknownConfig.phoneNumberId,
    unknownPhone
  );
  await handler.handleIncomingMessage(
    {
      id: 'wamid-inbound-hold-unknown',
      from: unknownPhone,
      timestamp: String(Math.floor(now.getTime() / 1000)),
      type: 'text',
      text: { body: 'oi' },
    } as any,
    { profile: { name: 'Cliente' } } as any,
    unknownConfig,
    {
      persistInbound: async () => ({
        fresh: true,
        conversationKey: unknownKey,
        sequence: 1,
      }),
      deliverInbound: async () => ({ delivered: true } as any),
      updateInboundContent: async () => undefined,
      markTranscriptionFailed: async () => undefined,
      downloadAudio: async () => Buffer.alloc(0),
      transcribeAudio: async () => '',
      handleOptOut: async () => false,
      shouldSuspend: async () => false,
      isPaused: async () => false,
      resumeGate: async () => true,
      lookupSilentHold: async (phoneNumberId, customerPhone) => {
        unknownInboundLookups += 1;
        return holdMod.lookupSilentEscalationHold(
          phoneNumberId,
          customerPhone,
          unknownStore
        );
      },
      sendReply: async () => {
        unknownInboundOutbound += 1;
      },
    }
  );
  assert.equal(unknownInboundLookups, 1);
  assert.equal(unknownInboundOutbound, 0);
  assert.equal(
    handler.__hasBufferForTest(unknownKey),
    false,
    'lookup unknown não chega ao buffer/brain'
  );
  // A subsequent readable lookup must still reach the store: the exception
  // above did not poison the cache with a negative result.
  unknownStore.loadActiveByConversation = async () =>
    (await unknownStore.loadByMessageId('wamid-hold-unknown'))!;
  const recoveredUnknownLookup = await holdMod.lookupSilentEscalationHold(
    unknownConfig.phoneNumberId,
    unknownPhone,
    unknownStore
  );
  assert.equal(recoveredUnknownLookup.kind, 'active');

  // --- Fixture 2: unknown na fronteira final antes do transporte -------------
  // A falha é observada antes da digitação, portanto não há typing nem POST.
  holdMod.__resetSilentEscalationHoldForTest();
  let finalLookupCalls = 0;
  let finalTypingCalls = 0;
  let finalTransportCalls = 0;
  let finalErpPauseCalls = 0;
  const finalBoundary = await handler.sendConfiguredReply(
    '+5511999000591',
    'Resposta segura',
    { ...config, phoneNumberId: 'PN-HOLD-FINAL' } as TenantBotConfig,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => undefined,
      waitTyping: async () => {
        finalTypingCalls += 1;
      },
      sendText: async () => {
        finalTransportCalls += 1;
      },
      isPausedBeforeTransport: async () => {
        finalErpPauseCalls += 1;
        return false;
      },
      lookupSilentHold: async () => {
        finalLookupCalls += 1;
        return { kind: 'unknown', errorKind: 'store_unavailable' };
      },
    }
  );
  assert.equal(finalBoundary, 'suppressed');
  assert.equal(finalLookupCalls, 1);
  assert.equal(finalTypingCalls, 0);
  assert.equal(finalTransportCalls, 0);
  assert.equal(finalErpPauseCalls, 0);

  // --- Fixture 3: Renata nunca consulta/libera hold --------------------------
  holdMod.__resetSilentEscalationHoldForTest();
  const salesUnknownConfig = {
    ...config,
    botRole: 'sales' as const,
    tenantSlug: 'receps-vendas',
    phoneNumberId: 'PN-HOLD-SALES',
  } as TenantBotConfig;
  const salesUnknownPhone = '+5511999000592';
  const salesUnknownKey = context.buildConversationKey(
    salesUnknownConfig.phoneNumberId,
    salesUnknownPhone
  );
  await handler.handleIncomingMessage(
    {
      id: 'wamid-sales-hold-unknown',
      from: salesUnknownPhone,
      timestamp: String(Math.floor(now.getTime() / 1000)),
      type: 'text',
      text: { body: 'oi' },
    } as any,
    { profile: { name: 'Lead' } } as any,
    salesUnknownConfig,
    {
      persistInbound: async () => {
        throw new Error('sales não usa intake Ana');
      },
      deliverInbound: async () => ({ delivered: true } as any),
      updateInboundContent: async () => undefined,
      markTranscriptionFailed: async () => undefined,
      downloadAudio: async () => Buffer.alloc(0),
      transcribeAudio: async () => '',
      handleOptOut: async () => false,
      shouldSuspend: async () => false,
      isPaused: async () => false,
      lookupSilentHold: async () => {
        throw new Error('Renata não pode consultar silent hold');
      },
    }
  );
  assert.equal(handler.__hasBufferForTest(salesUnknownKey), true);
  handler.__resetFlushStateForTest();

  handler.__resetFlushStateForTest();
  const m24From = '+5511999000602';
  const m24Sent: string[] = [];
  const deliveryReceipts: string[] = [];
  const m24Key = handler.__seedFlushBufferForTest(config, m24From, [
    'blergh xyzzy hold fail',
  ]);
  await handler.flushBuffer(m24Key, {
      getReply: async (from, text, userName, cfg) =>
        runtime.getReceptionistReplyV2({
          phone: from,
          userMessage: text,
          userName,
          config: cfg,
          turnRuntime: {
            turnId: nextId(),
            inputSequence: 1,
            currentInboundIds: ['wamid-m24-hold-fail'],
            currentInboundTextsById: { 'wamid-m24-hold-fail': text },
            checkpoint: async () => ({
              paused: false,
              latestInputSequence: 1,
              successorInputSequence: null,
              successorInboundMessageIds: [],
            }),
          },
          deps: {
            store: new stateStore.MemoryConversationalV2StateStore(),
            now: () => now,
            id: nextId,
            loadServices: async () => services,
            loadHistory: async () => [],
            isPaused: async () => false,
            interpreterEnabled: false,
            runModelLoop: async () => ({
              rawReply: '{',
              exhausted: false,
              provider: 'openai',
              model: 'gpt-4o-mini',
              providerReportedModels: ['gpt-4o-mini'],
              rounds: 1,
              messages: [],
              toolTrace: [],
              usage: [],
            }),
            regenerate: async () => ({
              ok: false,
              reasonCode: 'REGEN_MODEL_RESULT_INVALID',
              providerCalls: 1,
            }),
            executeTool: async () => {
              throw new Error('M24 hold fail não executa tools');
            },
            escalateSilent: (input, deps) =>
              escalation.escalateSilentUnderstandingFailure(input, {
                ...deps,
                holdStore: persistFailRuntimeStore,
                post: async (candidate) => {
                  persistFailRuntimePosts.push(candidate);
                  return {
                    questionId: 'q-m24-hold-fail',
                    version: 1,
                    escalation: {
                      active: true,
                      questionId: 'q-m24-hold-fail',
                      version: 1,
                    },
                  };
                },
                now: () => now,
                wait: async () => undefined,
              }),
          },
        }),
      sendReply: async (_from, text) => {
        m24Sent.push(String(text));
      },
      sendReplyPlain: async (_from, text) => {
        m24Sent.push(String(text));
      },
      isPaused: async () => false,
      isPausedBeforeTransport: async () => false,
      withConversationLock: async (_phoneNumberId, _customerPhone, work) =>
        work(),
      deliverV2: async () => {
        deliveryReceipts.push('silent_escalation');
        throw new Error('hold persist fail não entrega silent_escalation');
      },
    }
  );
  assert.deepEqual(m24Sent, [
    'Tive um probleminha aqui. Pode repetir sua última mensagem?',
  ]);
  assert.equal(deliveryReceipts.length, 0);
  handler.__resetFlushStateForTest();

  // --- Fixture 4: falha de persistência inicial -> M24 uma vez ---------------
  // O bypass ignora somente o lookup local; a leitura ERP continua sendo feita
  // sob a lock. Não há receipt silent_escalation nem POST de escalada residual.
  let persistFailFreshChecks = 0;
  let persistFailLookupCalls = 0;
  const persistFailM24: string[] = [];
  const persistFailKey = handler.__seedFlushBufferForTest(
    config,
    '+5511999000603',
    ['erro de persistência']
  );
  await handler.flushBuffer(persistFailKey, {
    getReply: async () => {
      throw new holdMod.SilentEscalationHoldPersistenceError(
        'persistência inicial indisponível'
      );
    },
    sendReply: async (_from, text) => {
      persistFailM24.push(String(text));
    },
    sendReplyPlain: async (_from, text) => {
      persistFailM24.push(String(text));
    },
    isPaused: async () => false,
    isPausedBeforeTransport: async () => {
      persistFailFreshChecks += 1;
      return false;
    },
    lookupSilentHold: async () => {
      persistFailLookupCalls += 1;
      return persistFailLookupCalls === 1
        ? { kind: 'inactive' }
        : { kind: 'unknown', errorKind: 'store_unavailable' };
    },
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.deepEqual(persistFailM24, [
    'Tive um probleminha aqui. Pode repetir sua última mensagem?',
  ]);
  assert.equal(persistFailM24.length, 1);
  assert.equal(persistFailFreshChecks, 1);
  assert.equal(
    persistFailLookupCalls,
    1,
    'bypass não faz lookup local adicional após o erro tipado'
  );
  handler.__resetFlushStateForTest();

  // --- Fixture 5: falha de persistência + pausa ERP ativa --------------------
  let persistFailPausedFreshChecks = 0;
  const persistFailPausedM24: string[] = [];
  const persistFailPausedKey = handler.__seedFlushBufferForTest(
    config,
    '+5511999000604',
    ['erro com pausa ativa']
  );
  await handler.flushBuffer(persistFailPausedKey, {
    getReply: async () => {
      throw new holdMod.SilentEscalationHoldPersistenceError(
        'persistência inicial indisponível'
      );
    },
    sendReply: async (_from, text) => {
      persistFailPausedM24.push(String(text));
    },
    sendReplyPlain: async (_from, text) => {
      persistFailPausedM24.push(String(text));
    },
    isPaused: async () => false,
    isPausedBeforeTransport: async () => {
      persistFailPausedFreshChecks += 1;
      return true;
    },
    lookupSilentHold: (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'inactive' as const }
          : { kind: 'unknown' as const, errorKind: 'store_unavailable' };
      };
    })(),
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.deepEqual(persistFailPausedM24, []);
  assert.equal(persistFailPausedFreshChecks, 1);
  handler.__resetFlushStateForTest();

  // Regra de não-bypass: erro genérico + lookup unknown continua suprimido.
  let genericLookupCalls = 0;
  const genericM24: string[] = [];
  const genericKey = handler.__seedFlushBufferForTest(
    config,
    '+5511999000605',
    ['erro não tipado']
  );
  await handler.flushBuffer(genericKey, {
    getReply: async () => {
      throw new Error('falha genérica de flush');
    },
    sendReply: async (_from, text) => {
      genericM24.push(String(text));
    },
    sendReplyPlain: async (_from, text) => {
      genericM24.push(String(text));
    },
    isPaused: async () => false,
    isPausedBeforeTransport: async () => false,
    lookupSilentHold: async () => {
      genericLookupCalls += 1;
      return genericLookupCalls === 1
        ? { kind: 'inactive' }
        : { kind: 'unknown', errorKind: 'store_unavailable' };
    },
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.deepEqual(genericM24, []);
  assert.equal(
    genericLookupCalls,
    2,
    'erro genérico faz somente o lookup pré-flush e o lookup fail-closed do M24'
  );
  handler.__resetFlushStateForTest();

  const pendingPostStore = new holdMod.MemorySilentEscalationHoldStore();
  const pendingPostRuntimePosts: unknown[] = [];
  const pendingPrepared = await runtime.getReceptionistReplyV2({
    phone: '+5511999000700',
    userMessage: 'blergh xyzzy pending post',
    userName: 'Cliente Fixture',
    config,
    turnRuntime: {
      turnId: nextId(),
      inputSequence: 1,
      currentInboundIds: ['wamid-pending-post'],
      currentInboundTextsById: {
        'wamid-pending-post': 'blergh xyzzy pending post',
      },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: new stateStore.MemoryConversationalV2StateStore(),
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: false,
      runModelLoop: async () => ({
        rawReply: '{',
        exhausted: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
      regenerate: async () => ({
        ok: false,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID',
        providerCalls: 1,
      }),
      executeTool: async () => {
        throw new Error('pending post não executa tools');
      },
      escalateSilent: (input, deps) =>
        escalation.escalateSilentUnderstandingFailure(input, {
          ...deps,
          holdStore: pendingPostStore,
          post: async () => {
            pendingPostRuntimePosts.push('failed');
            throw new Error('erp unavailable');
          },
          now: () => now,
          wait: async () => undefined,
        }),
    },
  });
  assert.equal(pendingPrepared.payload, null);
  assert.equal(pendingPrepared.planReceipt.recoveryKind, 'silent_escalation');
  assert.equal(
    (await pendingPostStore.loadByMessageId('wamid-pending-post'))?.status,
    'pending'
  );
  const pendingRow = await pendingPostStore.loadByMessageId('wamid-pending-post');
  pendingRow!.nextRetryAt = new Date(0);
  pendingPostRuntimePosts.length = 0;
  const pendingSwept = await escalation.sweepSilentEscalationHolds(
    {
      holdStore: pendingPostStore,
      post: async () => {
        pendingPostRuntimePosts.push('swept');
        return {
          questionId: 'q-swept-pending',
          version: 1,
          escalation: {
            active: true,
            questionId: 'q-swept-pending',
            version: 1,
          },
        };
      },
      now: () => now,
      wait: async () => undefined,
    },
    10
  );
  assert.equal(pendingSwept.confirmed, 1);
  assert.equal(
    (await pendingPostStore.loadByMessageId('wamid-pending-post'))?.status,
    'confirmed'
  );

  const postPersistThrowStore = new holdMod.MemorySilentEscalationHoldStore();
  postPersistThrowStore.loadByMessageId = async () => {
    throw new Error('load after persist failed');
  };
  const postPersistPrepared = await runtime.getReceptionistReplyV2({
    phone: '+5511999000701',
    userMessage: 'blergh xyzzy post persist throw',
    userName: 'Cliente Fixture',
    config,
    turnRuntime: {
      turnId: nextId(),
      inputSequence: 1,
      currentInboundIds: ['wamid-post-persist-throw'],
      currentInboundTextsById: {
        'wamid-post-persist-throw': 'blergh xyzzy post persist throw',
      },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: new stateStore.MemoryConversationalV2StateStore(),
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: false,
      runModelLoop: async () => ({
        rawReply: '{',
        exhausted: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
      regenerate: async () => ({
        ok: false,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID',
        providerCalls: 1,
      }),
      executeTool: async () => {
        throw new Error('post persist throw não executa tools');
      },
      escalateSilent: (input, deps) =>
        escalation.escalateSilentUnderstandingFailure(input, {
          ...deps,
          holdStore: postPersistThrowStore,
          post: async () => {
            throw new Error('post persist throw não POSTA');
          },
          now: () => now,
          wait: async () => undefined,
        }),
    },
  });
  assert.equal(postPersistPrepared.payload, null);
  assert.equal(postPersistPrepared.planReceipt.recoveryKind, 'silent_escalation');
  let postPersistTransportCalls = 0;
  const postPersistDelivery = await delivery.deliverPreparedReceptionistTurnV2(
    postPersistPrepared,
    {
      store: new stateStore.MemoryConversationalV2StateStore(),
      now: () => now,
      id: nextId,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        postPersistTransportCalls += 1;
        throw new Error('falha pós-persistência não pode transportar');
      },
    }
  );
  assert.equal(postPersistDelivery.delivery, 'silent');
  assert.equal(postPersistTransportCalls, 0);

  const restartStore = new holdMod.MemorySilentEscalationHoldStore();
  await holdMod.persistSilentEscalationHold({
    phoneNumberId: 'PN-RESTART',
    customerPhone: '+5511999000800',
    sourceMessageId: 'wamid-restart-pending',
    divergence,
    store: restartStore,
    now,
  });
  holdMod.__resetSilentEscalationHoldForTest();
  assert.equal(
    await holdMod.isSilentEscalationHoldActive(
      'PN-RESTART',
      '+5511999000800',
      restartStore
    ),
    true,
    'cache vazio relê hold pending do store e bloqueia inbound'
  );

  const echoHandler = await import('../src/echoHandler');
  const echoLockHold = new holdMod.MemorySilentEscalationHoldStore();
  await holdMod.persistSilentEscalationHold({
    phoneNumberId: 'PN-ECHO-LOCK',
    customerPhone: '5511999000900',
    sourceMessageId: 'wamid-echo-lock',
    divergence,
    store: echoLockHold,
    now,
  });
  const lockTrace: string[] = [];
  await echoHandler.handleSmbMessageEchoes(
    {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'PN-ECHO-LOCK' },
      message_echoes: [
        {
          from: '5511BIZ',
          to: '5511999000900',
          id: 'wamid.echo.lock',
          timestamp: '1',
          type: 'text',
          text: { body: 'ok' },
        },
      ],
    },
    'PN-ECHO-LOCK',
    {
      pauseConversation: async () => undefined,
      markEchoProcessed: async () => true,
      unmarkEcho: async () => undefined,
      recordMessage: async () => undefined,
      withConversationLock: async (_phoneNumberId, _customerPhone, work) => {
        lockTrace.push('lock');
        await work();
        lockTrace.push('unlock');
      },
      loadConfig: async () => config,
      downloadAudio: async () => Buffer.from([]),
      transcribeAudio: async () => '',
      shouldTranscribeHumanAudio: () => false,
      invalidatePendingByHuman: async () => undefined,
      releaseSilentHold: async (phoneNumberId, customerPhone) => {
        assert.equal(lockTrace.at(-1), 'lock');
        lockTrace.push('release');
        await holdMod.releaseSilentEscalationHold(
          phoneNumberId,
          customerPhone,
          echoLockHold
        );
      },
    }
  );
  assert.equal(lockTrace[0], 'lock');
  assert.equal(lockTrace[1], 'release');
  assert.equal(lockTrace[2], 'unlock');
  assert.equal(
    (await echoLockHold.loadByMessageId('wamid-echo-lock'))?.status,
    'released'
  );

  const salesConfig = {
    ...config,
    botRole: 'sales' as const,
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    phoneNumberId: 'PN-SALES',
  };
  holdMod.__resetSilentEscalationHoldForTest();
  handler.__resetFlushStateForTest();
  const salesFrom = '+5511999000400';
  const salesKey = handler.__seedFlushBufferForTest(salesConfig, salesFrom, [
    'oi, quero conhecer o plano',
  ]);
  await handler.flushBuffer(salesKey, {
    getReply: async () => 'Posso te explicar o plano.',
    sendReply: async () => undefined,
    sendReplyPlain: async () => undefined,
    isPaused: async () => false,
    isPausedBeforeTransport: async () => false,
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  handler.__resetFlushStateForTest();
  assert.deepEqual(holdMod.__silentHoldEventCountsForTest(), {
    lookups: 0,
    releases: 0,
  });

  let salesReleaseCalls = 0;
  await echoHandler.handleSmbMessageEchoes(
    {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'PN-SALES' },
      message_echoes: [
        {
          from: '5511BIZ',
          to: '5511999000400',
          id: 'wamid.echo.sales',
          timestamp: '1',
          type: 'text',
          text: { body: 'ok' },
        },
      ],
    },
    'PN-SALES',
    {
      pauseConversation: async () => undefined,
      markEchoProcessed: async () => true,
      unmarkEcho: async () => undefined,
      recordMessage: async () => undefined,
      withConversationLock: async (_phoneNumberId, _customerPhone, work) =>
        work(),
      loadConfig: async () => salesConfig,
      downloadAudio: async () => Buffer.from([]),
      transcribeAudio: async () => '',
      shouldTranscribeHumanAudio: () => false,
      invalidatePendingByHuman: async () => undefined,
      releaseSilentHold: async () => {
        salesReleaseCalls += 1;
      },
    }
  );
  assert.equal(salesReleaseCalls, 0);
  assert.equal(holdMod.__silentHoldEventCountsForTest().releases, 0);

  console.log('smoke ana conversational v2 silent escalation: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
