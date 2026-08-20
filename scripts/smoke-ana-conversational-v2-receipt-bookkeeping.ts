import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  PendingFrameSnapshotV2,
  TurnPlanReceiptV2,
} from '../src/services/conversationalV2/contracts';
import {
  hashTurnPlanReceiptV2,
  serializeTurnPlanReceiptV2,
} from '../src/services/conversationalV2/receipts';
import type { PreparedReceptionistTurnV2 } from '../src/services/conversationalV2/runtimeTypes';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_receipt_bookkeeping';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'true';

const now = new Date('2026-08-20T16:00:00.000Z');
let serial = 0;
const nextId = () => `receipt-bookkeeping-${++serial}`;

const config = {
  tenantSlug: 'fixture-receipt-bookkeeping',
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
  phoneNumberId: 'PN-RECEIPT-BOOKKEEPING',
  isActive: true,
} as TenantBotConfig;

const services = {
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

const invalidModelResult = {
  rawReply: '{',
  exhausted: false,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  providerReportedModels: ['gpt-4o-mini'],
  rounds: 1,
  messages: [],
  toolTrace: [],
  usage: [],
};

type RuntimeModules = {
  runtime: typeof import('../src/services/conversationalV2/runtime');
  delivery: typeof import('../src/services/conversationalV2/delivery');
  stateStore: typeof import('../src/services/conversationalV2/stateStore');
  hold: typeof import('../src/services/silentEscalationHold');
  escalation: typeof import('../src/services/questionEscalation');
  handler: typeof import('../src/messageHandler');
};

async function main(): Promise<void> {
  const modules: RuntimeModules = {
    runtime: await import('../src/services/conversationalV2/runtime'),
    delivery: await import('../src/services/conversationalV2/delivery'),
    stateStore: await import('../src/services/conversationalV2/stateStore'),
    hold: await import('../src/services/silentEscalationHold'),
    escalation: await import('../src/services/questionEscalation'),
    handler: await import('../src/messageHandler'),
  };
  const { runtime, delivery, stateStore, hold, escalation, handler } = modules;

  hold.__resetSilentEscalationHoldForTest();
  handler.__resetFlushStateForTest();

  async function makeSilent(label: string): Promise<{
    prepared: PreparedReceptionistTurnV2;
    store: InstanceType<typeof stateStore.MemoryConversationalV2StateStore>;
    holdStore: InstanceType<typeof hold.MemorySilentEscalationHoldStore>;
    posts: Array<Record<string, unknown>>;
    inboundId: string;
    phone: string;
  }> {
    const store = new stateStore.MemoryConversationalV2StateStore();
    const holdStore = new hold.MemorySilentEscalationHoldStore();
    const inboundId = `inbound-${label}`;
    const phone = `+551199${String(serial + 1000).padStart(7, '0')}`;
    const posts: Array<Record<string, unknown>> = [];
    const prepared = await runtime.getReceptionistReplyV2({
      phone,
      userMessage: `mensagem inválida ${label}`,
      userName: 'Cliente Fixture',
      config,
      turnRuntime: {
        turnId: nextId(),
        inputSequence: 1,
        currentInboundIds: [inboundId],
        currentInboundTextsById: {
          [inboundId]: `mensagem inválida ${label}`,
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
        runModelLoop: async () => invalidModelResult,
        regenerate: async () => ({
          ok: false as const,
          reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
          providerCalls: 1,
        }),
        executeTool: async () => {
          throw new Error('fixture silent não executa tools');
        },
        escalateSilent: (input, deps) =>
          escalation.escalateSilentUnderstandingFailure(input, {
            ...deps,
            holdStore,
            post: async (candidate) => {
              posts.push(candidate);
              return {
                questionId: `question-${label}`,
                version: 1,
                requiredAction: 'TAKE_OVER_WHATSAPP',
                escalation: {
                  active: true,
                  questionId: `question-${label}`,
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
    assert.equal(posts.length, 1, `${label}: exactly one divergence POST`);
    const holdRow = await holdStore.loadByMessageId(inboundId);
    assert.equal(holdRow?.status, 'confirmed', `${label}: hold confirmed before delivery`);
    return { prepared, store, holdStore, posts, inboundId, phone };
  }

  async function deliverPrepared(
    prepared: PreparedReceptionistTurnV2,
    store: InstanceType<typeof stateStore.MemoryConversationalV2StateStore>,
    options: {
      paused?: boolean;
      latestInputSequence?: number;
      successorInputSequence?: number | null;
      successorInboundMessageIds?: string[];
      sendTransport?: () => Promise<{ providerMessageId: string }>;
    } = {}
  ) {
    let transportCalls = 0;
    const result = await delivery.deliverPreparedReceptionistTurnV2(prepared, {
      store,
      now: () => now,
      id: nextId,
      checkpoint: async () => ({
        paused: options.paused ?? false,
        latestInputSequence:
          options.latestInputSequence ?? prepared.frame.inputSequence,
        successorInputSequence: options.successorInputSequence ?? null,
        successorInboundMessageIds: options.successorInboundMessageIds ?? [],
      }),
      sendTransport: async (payload) => {
        transportCalls += 1;
        if (options.sendTransport) return options.sendTransport();
        throw new Error(`transporte proibido para fixture silent: ${payload.length}`);
      },
    });
    return { result, transportCalls };
  }

  // F1: reprodução integrada. O flush observa o hold/pausa somente depois de
  // o runtime ter materializado o Prepared; a única passagem é delivery
  // contábil, sob a mesma lock usada pelo transporte real.
  const f1 = await makeSilent('f1');
  const f1Key = handler.__seedFlushBufferForTest(config, f1.phone, [
    'mensagem inválida f1',
  ]);
  let pauseReads = 0;
  let deliverCalls = 0;
  let transportCalls = 0;
  let outboundCalls = 0;
  const f1Delivery = await handler.flushBuffer(f1Key, {
    getReply: async () => f1.prepared,
    sendReply: async () => {
      outboundCalls += 1;
    },
    sendReplyPlain: async () => {
      outboundCalls += 1;
    },
    isPaused: async () => {
      pauseReads += 1;
      // A pausa nasce durante getReply; a primeira leitura é pré-brain.
      return pauseReads >= 2;
    },
    lookupSilentHold: async () => ({ kind: 'inactive' as const }),
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
    deliverV2: async (prepared, checkpoint) => {
      deliverCalls += 1;
      const holdRow = await f1.holdStore.loadByMessageId(f1.inboundId);
      assert.equal(holdRow?.status, 'confirmed', 'hold ativo antes do delivery');
      const result = await delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store: f1.store,
        now: () => now,
        id: nextId,
        checkpoint,
        sendTransport: async () => {
          transportCalls += 1;
          throw new Error('F1 não pode transportar');
        },
      });
      assert.equal(result.delivery, 'silent');
      return result;
    },
  });
  assert.equal(f1Delivery, undefined, 'flushBuffer permanece void');
  assert.equal(deliverCalls, 1, 'F1 chama deliverV2 exatamente uma vez');
  assert.equal(transportCalls, 0, 'F1 não chama Meta/WhatsApp');
  assert.equal(outboundCalls, 0, 'F1 não chama fallback/M24');

  // F2/F3: as duas linhas de recibo existem, com o mesmo turno/plano e sem
  // outbox/provider/assistant history.
  assert.equal(f1.store.plans.size, 1);
  assert.equal(f1.store.deliveries.size, 1);
  const f1Plan = [...f1.store.plans.values()][0]!;
  const f1DeliveryReceipt = [...f1.store.deliveries.values()][0]!;
  assert.equal(f1Plan.route, 'fallback');
  assert.equal(f1Plan.recoveryKind, 'silent_escalation');
  assert.equal(f1Plan.result, 'accepted_for_delivery');
  assert.equal(f1Plan.planReceiptId, f1.prepared.planReceipt.planReceiptId);
  assert.equal(f1Plan.turnId, f1.prepared.frame.turnId);
  assert.equal(f1DeliveryReceipt.planReceiptId, f1Plan.planReceiptId);
  assert.equal(f1DeliveryReceipt.turnId, f1Plan.turnId);
  assert.equal(f1DeliveryReceipt.transportStartedAt, null);
  assert.equal(f1DeliveryReceipt.transportOutcome, 'silent_escalation');
  assert.equal(f1DeliveryReceipt.outboxState, 'prepared');
  assert.equal(f1DeliveryReceipt.conversationCommitOutcome, 'not_applicable');
  assert.equal(f1DeliveryReceipt.pendingCommitOutcome, 'not_applicable');
  assert.equal(f1DeliveryReceipt.providerMessageIdHash, undefined);
  assert.equal(f1.store.outbox.size, 0);
  assert.doesNotThrow(() =>
    serializeTurnPlanReceiptV2(f1Plan, {
      forbiddenPlaintextFragments: ['mensagem inválida f1'],
      forbiddenPhoneValues: [f1.phone],
    })
  );

  const pendingSnapshot: PendingFrameSnapshotV2 = {
    questionId: 'pending-question-f3',
    askedAt: now.toISOString(),
    kind: 'SERVICE',
    flowId: 'pending-flow-f3',
    version: 7,
    options: [{ position: 1, entityId: 'svc-drenagem', displayName: 'serviço' }],
  };
  const f3PendingPrepared = {
    ...f1.prepared,
    frame: { ...f1.prepared.frame, pending: pendingSnapshot },
  } satisfies PreparedReceptionistTurnV2;
  const f3PendingStore = new stateStore.MemoryConversationalV2StateStore();
  const f3Pending = await deliverPrepared(f3PendingPrepared, f3PendingStore, {
    paused: true,
  });
  assert.equal(f3Pending.result.delivery, 'silent');
  assert.equal(f3Pending.result.receipt.pendingCommitOutcome, 'preserved');
  assert.equal(f3Pending.result.receipt.expectedPendingVersion, 7);
  assert.equal(f3Pending.result.receipt.observedPendingVersion, 7);
  assert.equal(f3Pending.transportCalls, 0);

  // F4: a divergência aponta para o plan persistido, não para um hash de id.
  const capturedDivergence = f1.posts[0]?.divergence as {
    turnReceiptHash: string;
  };
  assert.equal(capturedDivergence.turnReceiptHash, hashTurnPlanReceiptV2(f1Plan));
  const changedPlan = {
    ...f1Plan,
    primaryProviderCalls: f1Plan.primaryProviderCalls + 1,
  } satisfies TurnPlanReceiptV2;
  assert.notEqual(
    hashTurnPlanReceiptV2(changedPlan),
    capturedDivergence.turnReceiptHash,
    'alterar um campo técnico altera o hash canônico'
  );
  assert.equal(
    JSON.stringify(f1Plan).includes(capturedDivergence.turnReceiptHash),
    false,
    'o hash não é autorreferente dentro do receipt_json'
  );

  // F5: pausa/hold/ECHO concorrente não impedem o bookkeeping silent. O
  // receipt não consulta nem enfraquece a autoridade; apenas atravessa para
  // registrar o silêncio. A mesma matriz mantém o não-silent suprimido.
  const f5Cases = [
    'hold-pending',
    'hold-confirmed',
    'pause-escalation',
    'echo-concurrent',
    'lookup-unknown',
  ] as const;
  for (const caseName of f5Cases) {
    const fixture = await makeSilent(`f5-${caseName}`);
    const row = await fixture.holdStore.loadByMessageId(fixture.inboundId);
    if (caseName === 'hold-pending') {
      assert.ok(row);
      row.status = 'pending';
      row.questionId = null;
    }
    if (caseName === 'hold-confirmed') {
      assert.equal(row?.status, 'confirmed');
    }
    const result = await deliverPrepared(fixture.prepared, fixture.store, {
      paused: true,
    });
    assert.equal(result.result.delivery, 'silent', caseName);
    assert.equal(result.transportCalls, 0, `${caseName}: zero transporte`);
    assert.equal(fixture.store.plans.size, 1, `${caseName}: plan persistido`);
    assert.equal(fixture.store.deliveries.size, 1, `${caseName}: delivery persistido`);

    const nonSilentStore = new stateStore.MemoryConversationalV2StateStore();
    const nonSilent = {
      ...fixture.prepared,
      payload: 'Pergunta normal fixture',
      planReceipt: {
        ...fixture.prepared.planReceipt,
        recoveryKind: 'none' as const,
      },
    } satisfies PreparedReceptionistTurnV2;
    const nonSilentResult = await deliverPrepared(nonSilent, nonSilentStore, {
      paused: true,
    });
    assert.equal(nonSilentResult.result.delivery, 'suppressed', `${caseName}: não-silent protegido`);
    assert.equal(nonSilentResult.result.receipt.transportOutcome, 'suppressed_pause');
    assert.equal(nonSilentResult.transportCalls, 0, `${caseName}: não-silent zero transporte`);
  }

  // Lookup unknown continua bloqueando uma resposta não-silent antes do
  // brain; um prepared silent já materializado não passa por essa supressão.
  handler.__resetFlushStateForTest();
  const unknownKey = handler.__seedFlushBufferForTest(config, '+5511990000001', [
    'inbound protegido',
  ]);
  let unknownBrainCalls = 0;
  let unknownOutboundCalls = 0;
  await handler.flushBuffer(unknownKey, {
    getReply: async () => {
      unknownBrainCalls += 1;
      return 'resposta não-silent';
    },
    sendReply: async () => {
      unknownOutboundCalls += 1;
    },
    sendReplyPlain: async () => {
      unknownOutboundCalls += 1;
    },
    isPaused: async () => false,
    lookupSilentHold: async () => ({
      kind: 'unknown' as const,
      errorKind: 'store_unavailable',
    }),
    recordPausedInbound: async () => undefined,
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.equal(unknownBrainCalls, 0, 'lookup unknown não libera brain não-silent');
  assert.equal(unknownOutboundCalls, 0, 'lookup unknown não libera outbound não-silent');

  handler.__resetFlushStateForTest();
  const silentUnknown = await makeSilent('f5-lookup-unknown-after-prepared');
  const silentUnknownKey = handler.__seedFlushBufferForTest(
    config,
    silentUnknown.phone,
    ['inbound lookup unknown depois do Prepared']
  );
  let silentUnknownLookupCalls = 0;
  let silentUnknownDeliveryCalls = 0;
  await handler.flushBuffer(silentUnknownKey, {
    getReply: async () => silentUnknown.prepared,
    sendReply: async () => {
      throw new Error('lookup unknown silent não pode chamar reply');
    },
    sendReplyPlain: async () => {
      throw new Error('lookup unknown silent não pode chamar M24');
    },
    isPaused: async () => false,
    lookupSilentHold: async () => {
      silentUnknownLookupCalls += 1;
      if (silentUnknownLookupCalls === 1) return { kind: 'inactive' as const };
      throw new Error('lookup unknown depois do Prepared');
    },
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
    deliverV2: async (prepared, checkpoint) => {
      silentUnknownDeliveryCalls += 1;
      return delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store: silentUnknown.store,
        now: () => now,
        id: nextId,
        checkpoint,
        sendTransport: async () => {
          throw new Error('lookup unknown silent não pode transportar');
        },
      });
    },
  });
  assert.equal(silentUnknownLookupCalls, 1, 'silent Prepared não faz lookup de hold adicional');
  assert.equal(silentUnknownDeliveryCalls, 1);
  assert.equal(silentUnknown.store.plans.size, 1);
  assert.equal(silentUnknown.store.deliveries.size, 1);
  handler.__resetFlushStateForTest();

  // F6: successor concorrente é durável, o silentTurn não reprocessa o brain,
  // e a metade pendente do buffer é limpa uma única vez.
  handler.__resetFlushStateForTest();
  const f6 = await makeSilent('f6');
  const f6Key = handler.__seedFlushBufferForTest(config, f6.phone, ['inbound f6']);
  let f6DeliverCalls = 0;
  let f6TransportCalls = 0;
  let f6FallbackCalls = 0;
  await handler.flushBuffer(f6Key, {
    getReply: async () => f6.prepared,
    sendReply: async () => {
      f6FallbackCalls += 1;
    },
    sendReplyPlain: async () => {
      f6FallbackCalls += 1;
    },
    isPaused: async () => false,
    lookupSilentHold: async () => ({ kind: 'inactive' as const }),
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
    deliverV2: async (prepared, checkpoint) => {
      f6DeliverCalls += 1;
      handler.__seedPendingFlushStateForTest(
        f6Key,
        ['inbound concorrente'],
        ['inbound-f6-successor'],
        [2]
      );
      return delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store: f6.store,
        now: () => now,
        id: nextId,
        checkpoint,
        sendTransport: async () => {
          f6TransportCalls += 1;
          throw new Error('F6 não pode transportar');
        },
      });
    },
  });
  assert.equal(f6DeliverCalls, 1);
  assert.equal(f6TransportCalls, 0);
  assert.equal(f6FallbackCalls, 0);
  assert.equal(f6.store.successors.size, 1, 'successor concorrente durável');
  const f6State = handler.__inspectFlushBufferForTest(f6Key);
  assert.equal(f6State, null, 'silentTurn limpa o buffer uma única vez');
  assert.equal(f6.posts.length, 1, 'sem segundo evento de divergência');
  handler.__resetFlushStateForTest();

  // F7: falha de plan não abre delivery nem transporte. Falha terminal deixa
  // apenas o plan reconciliável; retry/reconciliação nunca faz POST WhatsApp.
  class SavePlanFailureStore extends stateStore.MemoryConversationalV2StateStore {
    override async savePlanReceipt(_receipt: TurnPlanReceiptV2): Promise<void> {
      throw new Error('save plan fixture failure');
    }
  }
  class SaveDeliveryFailureStore extends stateStore.MemoryConversationalV2StateStore {
    override async saveTerminalDeliveryReceipt(): Promise<void> {
      throw new Error('save delivery fixture failure');
    }
  }

  const f7Plan = await makeSilent('f7-plan');
  const failedPlanStore = new SavePlanFailureStore();
  let f7PlanTransportCalls = 0;
  await assert.rejects(
    delivery.deliverPreparedReceptionistTurnV2(f7Plan.prepared, {
      store: failedPlanStore,
      now: () => now,
      id: nextId,
      checkpoint: async () => ({
        paused: true,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        f7PlanTransportCalls += 1;
        throw new Error('F7 plan não pode transportar');
      },
    }),
    /save plan fixture failure/
  );
  assert.equal(failedPlanStore.plans.size, 0);
  assert.equal(failedPlanStore.deliveries.size, 0);
  assert.equal(f7PlanTransportCalls, 0);
  assert.equal(f7Plan.posts.length, 1, 'falha de receipt não faz segundo POST de divergência');

  handler.__resetFlushStateForTest();
  const f7FlushKey = handler.__seedFlushBufferForTest(config, f7Plan.phone, [
    'f7 bookkeeping',
  ]);
  let f7M24Calls = 0;
  await handler.flushBuffer(f7FlushKey, {
    getReply: async () => f7Plan.prepared,
    sendReply: async () => {
      f7M24Calls += 1;
    },
    sendReplyPlain: async () => {
      f7M24Calls += 1;
    },
    isPaused: async () => false,
    lookupSilentHold: async () => ({ kind: 'inactive' as const }),
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
    deliverV2: async (prepared, checkpoint) =>
      delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store: failedPlanStore,
        now: () => now,
        id: nextId,
        checkpoint,
        sendTransport: async () => {
          throw new Error('F7 flush não pode transportar');
        },
      }),
  });
  assert.equal(f7M24Calls, 0, 'falha de savePlan não compensa com M24');
  handler.__resetFlushStateForTest();

  const f7Delivery = await makeSilent('f7-delivery');
  const failedDeliveryStore = new SaveDeliveryFailureStore();
  let f7DeliveryTransportCalls = 0;
  await assert.rejects(
    delivery.deliverPreparedReceptionistTurnV2(f7Delivery.prepared, {
      store: failedDeliveryStore,
      now: () => now,
      id: nextId,
      checkpoint: async () => ({
        paused: true,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        f7DeliveryTransportCalls += 1;
        throw new Error('F7 delivery não pode transportar');
      },
    }),
    /save delivery fixture failure/
  );
  assert.equal(failedDeliveryStore.plans.size, 1);
  assert.equal(failedDeliveryStore.deliveries.size, 0);
  assert.equal(f7DeliveryTransportCalls, 0);
  const incomplete = await failedDeliveryStore.verifyReceiptReconciliation([
    f7Delivery.prepared.frame.turnId,
  ]);
  assert.deepEqual(incomplete, {
    ok: false,
    planCount: 1,
    deliveryCount: 0,
    planWithoutDeliveryCount: 1,
    orphanDeliveryCount: 0,
    mismatchedTurnCount: 0,
    duplicateDeliveryForPlanCount: 0,
  });
  await failedDeliveryStore.sweep(now);
  assert.equal(f7DeliveryTransportCalls, 0, 'reconciliação não faz WhatsApp');

  // F8: caminho normal continua sob pause recheck e transporte ambíguo não
  // sofre retry. Renata e falha de hold IA-19B continuam cobertas pelos
  // smokes regressivos obrigatórios do contrato.
  const f8 = await makeSilent('f8');
  const normal = {
    ...f8.prepared,
    payload: 'Pergunta normal F8',
    planReceipt: {
      ...f8.prepared.planReceipt,
      recoveryKind: 'none' as const,
    },
  } satisfies PreparedReceptionistTurnV2;
  const normalStore = new stateStore.MemoryConversationalV2StateStore();
  const normalSuppressed = await deliverPrepared(normal, normalStore, {
    paused: true,
  });
  assert.equal(normalSuppressed.result.delivery, 'suppressed');
  assert.equal(normalSuppressed.result.receipt.transportOutcome, 'suppressed_pause');
  assert.equal(normalSuppressed.transportCalls, 0);

  const ambiguousStore = new stateStore.MemoryConversationalV2StateStore();
  let ambiguousCalls = 0;
  const ambiguous = await delivery.deliverPreparedReceptionistTurnV2(normal, {
    store: ambiguousStore,
    now: () => now,
    id: nextId,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: normal.frame.inputSequence,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => {
      ambiguousCalls += 1;
      throw Object.assign(new Error('timeout fixture'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(ambiguous.delivery, 'transport_unknown');
  assert.equal(ambiguousCalls, 1, 'transporte ambíguo não faz retry');

  const reconciliation = await f1.store.verifyReceiptReconciliation([
    f1.prepared.frame.turnId,
  ]);
  assert.deepEqual(reconciliation, {
    ok: true,
    planCount: 1,
    deliveryCount: 1,
    planWithoutDeliveryCount: 0,
    orphanDeliveryCount: 0,
    mismatchedTurnCount: 0,
    duplicateDeliveryForPlanCount: 0,
  });

  handler.__resetFlushStateForTest();
  console.log('smoke ana conversational v2 receipt bookkeeping: OK F1-F8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
