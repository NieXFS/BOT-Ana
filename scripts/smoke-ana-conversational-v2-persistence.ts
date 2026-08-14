import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  PendingFrameSnapshotV2,
  TurnFrameV2,
  TurnPlanReceiptV2,
} from '../src/services/conversationalV2/contracts';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import {
  assertReceiptRedactedV2,
  opaqueReceiptHashV2,
} from '../src/services/conversationalV2/receipts';
import {
  ANA_CONVERSATIONAL_V2_PREPARED_KIND,
  type PreparedReceptionistTurnV2,
} from '../src/services/conversationalV2/runtimeTypes';
import {
  CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
  CONVERSATIONAL_V2_SWEEP_MAX_BACKOFF_MS,
  MemoryConversationalV2StateStore,
  nextConversationalV2SweepDelayMs,
  startConversationalV2Sweep,
  stopConversationalV2SweepForTest,
  SUCCESSOR_REARM_DEBOUNCE_MS_V2,
  type ConversationalV2StateStore,
  type MaterializedPendingTransitionV2,
} from '../src/services/conversationalV2/stateStore';
import {
  reprocessSuccessorBatchV2,
  startConversationalV2SuccessorSweep,
  stopConversationalV2SuccessorSweepForTest,
} from '../src/services/conversationalV2/successorProcessor';

const now = new Date('2026-08-13T15:00:00.000Z');
const config = {
  tenantSlug: 'tenant-v2-smoke',
  phoneNumberId: 'PN-V2-SMOKE',
  botRole: 'receptionist',
} as TenantBotConfig;
let serial = 0;
let idNamespace = 'v2-id';
const nextId = () => `${idNamespace}-${++serial}`;

function frame(conversationKey: string, pending: PendingFrameSnapshotV2 | null = null): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: nextId(),
    inputSequence: 1,
    catalogSnapshotHash: opaqueReceiptHashV2(`catalog:${conversationKey}`),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: [opaqueReceiptHashV2(`inbound:${conversationKey}`)],
    pending,
    flowState: {
      flowId: pending?.flowId ?? nextId(),
      fixedByProofVersion: {},
    },
  };
}

function plan(current: TurnFrameV2, route: TurnPlanReceiptV2['route'] = 'model'): TurnPlanReceiptV2 {
  return {
    schemaVersion: 2,
    planReceiptId: nextId(),
    turnId: current.turnId,
    frameHash: opaqueReceiptHashV2(`frame:${current.turnId}`),
    inputSequence: current.inputSequence,
    route,
    primaryModelRounds: route === 'fast_path' ? 0 : 1,
    primaryProviderCalls: route === 'fast_path' ? 0 : 1,
    regenProviderCalls: 0,
    pendingTransitionCandidate: { kind: 'preserve' },
    toolEffects: [],
    boundaryAttempts: [],
    recoveryKind: 'none',
    result: 'accepted_for_delivery',
  };
}

function prepared(input: {
  conversationKey: string;
  transition: MaterializedPendingTransitionV2;
  pending?: PendingFrameSnapshotV2 | null;
  preemption?: PreparedReceptionistTurnV2['preemption'];
  payload?: string | null;
  hasCommittedWrite?: boolean;
}): PreparedReceptionistTurnV2 {
  const current = frame(input.conversationKey, input.pending ?? null);
  return {
    kind: ANA_CONVERSATIONAL_V2_PREPARED_KIND,
    frame: current,
    conversationKey: input.conversationKey,
    phoneNumberId: config.phoneNumberId,
    customerPhone: '5511000000000',
    config,
    payload: input.payload === undefined ? 'Qual dia você prefere?' : input.payload,
    transition: input.transition,
    planReceipt: plan(current),
    preemption: input.preemption ?? null,
    successorTurnId: null,
    hasCommittedWrite: input.hasCommittedWrite ?? false,
    canonicalPendingQuestion: null,
  };
}

function openTransition(flowId: string, questionId = nextId()): MaterializedPendingTransitionV2 {
  return {
    kind: 'open',
    frame: {
      questionId,
      askedAt: now.toISOString(),
      kind: 'SERVICE',
      flowId,
      version: 1,
      options: [
        { position: 1, entityId: 'svc-a', displayName: 'Serviço A' },
      ],
    },
    expectedQuestionId: null,
    expectedVersion: null,
    nextFlowState: { flowId, fixedByProofVersion: {} },
  };
}

async function deliver(input: {
  store: ConversationalV2StateStore;
  prepared: PreparedReceptionistTurnV2;
  send?: () => Promise<{ providerMessageId: string }>;
  paused?: boolean;
  sequence?: number;
}) {
  return deliverPreparedReceptionistTurnV2(input.prepared, {
    store: input.store,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: input.paused ?? false,
      latestInputSequence: input.sequence ?? input.prepared.frame.inputSequence,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport:
      input.send ?? (async () => ({ providerMessageId: nextId() })),
  });
}

async function main(): Promise<void> {
  for (const outcome of ['transport_failed', 'transport_unknown'] as const) {
    const store = new MemoryConversationalV2StateStore();
    const turn = prepared({
      conversationKey: `PN:${outcome}`,
      transition: openTransition(`flow-${outcome}`),
    });
    const result = await deliver({
      store,
      prepared: turn,
      send: async () => {
        const error = Object.assign(new Error(outcome),
          outcome === 'transport_unknown'
            ? { code: 'ETIMEDOUT' }
            : { response: { status: 400 } }
        );
        throw error;
      },
    });
    assert.equal(result.receipt.transportOutcome, outcome);
    assert.equal((await store.loadLatestState(turn.conversationKey)).pending, null);
  }

  const suppressedStore = new MemoryConversationalV2StateStore();
  const suppressed = prepared({
    conversationKey: 'PN:suppressed',
    transition: openTransition('flow-suppressed'),
  });
  const suppressedResult = await deliver({
    store: suppressedStore,
    prepared: suppressed,
    paused: true,
  });
  assert.equal(suppressedResult.receipt.transportOutcome, 'suppressed_pause');
  assert.equal(suppressedStore.transportPostCount, 0);
  assert.equal((await suppressedStore.loadLatestState(suppressed.conversationKey)).pending, null);
  assert.deepEqual(
    await suppressedStore.verifyReceiptReconciliation([suppressed.frame.turnId]),
    {
      ok: true,
      planCount: 1,
      deliveryCount: 1,
      planWithoutDeliveryCount: 0,
      orphanDeliveryCount: 0,
      mismatchedTurnCount: 0,
      duplicateDeliveryForPlanCount: 0,
    },
    'suppressed_pause persiste recibo terminal 1:1 sem POST'
  );

  const acceptedStore = new MemoryConversationalV2StateStore();
  const accepted = prepared({
    conversationKey: 'PN:accepted',
    transition: openTransition('flow-accepted'),
  });
  const acceptedResult = await deliver({ store: acceptedStore, prepared: accepted });
  assert.equal(acceptedResult.receipt.transportOutcome, 'accepted_by_provider');
  const acceptedState = await acceptedStore.loadLatestState(
    accepted.conversationKey
  );
  assert.equal(acceptedState.pending?.state, 'OPEN');
  assert.equal(acceptedState.lastAcceptedDelivery?.payload, accepted.payload);
  assert.equal(
    acceptedState.lastAcceptedDelivery?.transition.kind === 'open' &&
      acceptedState.lastAcceptedDelivery.transition.frame.questionId,
    accepted.transition.kind === 'open'
      ? accepted.transition.frame.questionId
      : null,
    'estado expõe a entrega aceita que abriu a versão exata'
  );
  assert.equal(
    acceptedStore.pending.get(accepted.conversationKey)?.filter((entry) => entry.state === 'OPEN').length,
    1,
    'aceite abre exatamente uma PendingFrame'
  );

  const existing = (await acceptedStore.loadLatestState(accepted.conversationKey)).pending!;
  const social = prepared({
    conversationKey: accepted.conversationKey,
    pending: existing.snapshot,
    transition: { kind: 'preserve' },
    payload: 'Claro! 😊',
  });
  await deliver({ store: acceptedStore, prepared: social });
  const afterSocial = (await acceptedStore.loadLatestState(accepted.conversationKey)).pending!;
  assert.equal(afterSocial.snapshot.questionId, existing.snapshot.questionId);
  assert.equal(afterSocial.snapshot.version, existing.snapshot.version);

  const proofPreserve = prepared({
    conversationKey: accepted.conversationKey,
    pending: afterSocial.snapshot,
    transition: {
      kind: 'preserve',
      expectedQuestionId: afterSocial.snapshot.questionId,
      expectedVersion: afterSocial.snapshot.version,
      nextFlowState: {
        flowId: afterSocial.snapshot.flowId,
        fixedServiceId: 'svc-a',
        fixedByProofVersion: { fixedServiceId: 3 },
      },
    },
    payload: 'Perfeito, vou considerar esse serviço.',
  });
  const proofPreserveResult = await deliver({
    store: acceptedStore,
    prepared: proofPreserve,
  });
  assert.equal(proofPreserveResult.receipt.pendingCommitOutcome, 'preserved');
  const afterProofPreserve = (
    await acceptedStore.loadLatestState(accepted.conversationKey)
  ).pending!;
  assert.equal(afterProofPreserve.snapshot.version, afterSocial.snapshot.version);
  assert.equal(afterProofPreserve.flowState.fixedServiceId, 'svc-a');
  assert.equal(
    afterProofPreserve.flowState.fixedByProofVersion.fixedServiceId,
    3,
    'proof validada avança flowState sem trocar nem versionar a pergunta preservada'
  );

  const rejectedReset = prepared({
    conversationKey: accepted.conversationKey,
    pending: afterSocial.snapshot,
    transition: {
      kind: 'resolve',
      questionId: afterSocial.snapshot.questionId,
      expectedVersion: afterSocial.snapshot.version + 50,
      nextFlowState: afterSocial.flowState,
    },
  });
  const rejectedResult = await deliver({ store: acceptedStore, prepared: rejectedReset });
  assert.equal(rejectedResult.receipt.pendingCommitOutcome, 'cas_conflict');
  assert.equal(
    (await acceptedStore.loadLatestState(accepted.conversationKey)).pending?.snapshot.version,
    afterSocial.snapshot.version,
    'CAS rejeitado não transiciona PendingFrame'
  );

  const uncommittedStore = new MemoryConversationalV2StateStore();
  uncommittedStore.failNextAcceptedCommit = true;
  const uncommitted = prepared({
    conversationKey: 'PN:accepted-uncommitted',
    transition: openTransition('flow-uncommitted'),
  });
  const uncommittedResult = await deliver({
    store: uncommittedStore,
    prepared: uncommitted,
  });
  assert.equal(uncommittedResult.receipt.outboxState, 'accepted_uncommitted');
  assert.equal(uncommittedStore.transportPostCount, 1);
  assert.equal((await uncommittedStore.loadLatestState(uncommitted.conversationKey)).pending, null);
  const guard = await uncommittedStore.inspectInboundGuard(uncommitted.conversationKey, now);
  assert.equal(guard.kind, 'reconstructed');
  await uncommittedStore.sweep(now);
  assert.equal(uncommittedStore.transportPostCount, 1, 'reconciliação local nunca repete POST');
  assert.equal((await uncommittedStore.loadLatestState(uncommitted.conversationKey)).pending?.state, 'OPEN');

  const crashStore = new MemoryConversationalV2StateStore();
  const crash = prepared({
    conversationKey: 'PN:crash',
    transition: openTransition('flow-crash'),
  });
  await crashStore.savePlanReceipt(crash.planReceipt);
  await crashStore.prepareOutbound({
    deliveryAttemptId: 'attempt-crash',
    conversationKey: crash.conversationKey,
    turnId: crash.frame.turnId,
    planReceiptId: crash.planReceipt.planReceiptId,
    payload: crash.payload!,
    transition: crash.transition,
    now,
  });
  await crashStore.markTransportStarted('attempt-crash', now);
  assert.equal((await crashStore.inspectInboundGuard(crash.conversationKey, now)).kind, 'suspended');
  await crashStore.sweep(new Date(now.getTime() + 3 * 60_000));
  assert.equal(crashStore.outbox.get('attempt-crash')?.state, 'transport_unknown');
  assert.equal(crashStore.transportPostCount, 1);

  const invalidated = await acceptedStore.invalidateOpenPendingByHuman(
    accepted.conversationKey,
    now
  );
  assert.equal(invalidated, 1);
  assert.equal((await acceptedStore.loadLatestState(accepted.conversationKey)).pending, null);

  const successorStore = new MemoryConversationalV2StateStore();
  const superseded = prepared({
    conversationKey: 'PN:successor',
    transition: { kind: 'preserve' },
  });
  const supersededResult = await deliver({
    store: successorStore,
    prepared: superseded,
    sequence: superseded.frame.inputSequence + 1,
  });
  assert.equal(supersededResult.receipt.transportOutcome, 'superseded');
  assert.ok(supersededResult.receipt.successorTurnId);
  assert.equal(successorStore.transportPostCount, 0);
  assert.equal(
    (await successorStore.verifyReceiptReconciliation([superseded.frame.turnId])).ok,
    true,
    'superseded persiste recibo terminal 1:1 sem POST'
  );
  for (const receipt of [
    ...successorStore.plans.values(),
    ...successorStore.deliveries.values(),
  ]) {
    assert.doesNotThrow(() =>
      assertReceiptRedactedV2(receipt, {
        forbiddenCatalogEntityIds: ['svc-a'],
        forbiddenPlaintextFragments: ['Qual dia você prefere?'],
        forbiddenMessageIds: ['wamid.successor-sensitive'],
        forbiddenPhoneValues: ['5511000000000'],
      })
    );
  }
  assert.equal((await successorStore.listReadySuccessors(10, now)).length, 0);
  const successorReadyAt = new Date(
    now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2
  );
  assert.equal(
    (await successorStore.listReadySuccessors(10, successorReadyAt)).length,
    1,
    'lote sucessor só fica elegível após o debounce durável de 12s'
  );
  const durableId = supersededResult.receipt.successorTurnId!;
  let successorProcesses = 0;
  assert.equal(
    await reprocessSuccessorBatchV2(durableId, {
      store: successorStore,
      now: () => successorReadyAt,
      process: async () => {
        successorProcesses += 1;
      },
      fallback: async () => {
        throw new Error('fallback não esperado');
      },
    }),
    'completed'
  );
  assert.equal(successorProcesses, 1);

  const committedWriteStore = new MemoryConversationalV2StateStore();
  const committedWrite = prepared({
    conversationKey: 'PN:committed-write-successor',
    transition: { kind: 'preserve' },
    payload: 'Agendamento confirmado.',
    hasCommittedWrite: true,
  });
  const committedWriteResult = await deliver({
    store: committedWriteStore,
    prepared: committedWrite,
    sequence: committedWrite.frame.inputSequence + 1,
  });
  assert.equal(
    committedWriteResult.receipt.transportOutcome,
    'accepted_by_provider',
    'write confirmado impede descarte mesmo com inbound novo'
  );
  assert.equal(committedWriteStore.transportPostCount, 1);
  assert.ok(committedWriteResult.successor, 'inbound novo ainda vira sucessor durável');
  assert.equal(
    committedWriteResult.successor?.requiresAuthoritativeRead,
    true,
    'sucessor de write confirmado exige read autoritativo no primeiro turno'
  );
  assert.equal(
    (await committedWriteStore.verifyReceiptReconciliation([committedWrite.frame.turnId])).ok,
    true
  );

  const starvationStore = new MemoryConversationalV2StateStore();
  const starvationTurn = prepared({
    conversationKey: 'PN:successor-starvation',
    transition: { kind: 'preserve' },
  });
  const starvationDelivery = await deliver({
    store: starvationStore,
    prepared: starvationTurn,
    sequence: starvationTurn.frame.inputSequence + 1,
  });
  const starvationId = starvationDelivery.receipt.successorTurnId!;
  let starvationProcesses = 0;
  let starvationFallbacks = 0;
  let attemptAt = new Date(now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(
      await reprocessSuccessorBatchV2(starvationId, {
        store: starvationStore,
        now: () => attemptAt,
        process: async () => {
          starvationProcesses += 1;
          throw new Error('falha injetada antes do teto');
        },
        fallback: async () => {
          starvationFallbacks += 1;
        },
      }),
      'rearmed'
    );
    attemptAt = new Date(attemptAt.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2);
  }
  assert.equal(
    await reprocessSuccessorBatchV2(starvationId, {
      store: starvationStore,
      now: () => attemptAt,
      process: async () => {
        starvationProcesses += 1;
      },
      fallback: async () => {
        starvationFallbacks += 1;
      },
    }),
    'fallback_completed',
    'após dois reprocessos o lote termina no fallback anti-starvation'
  );
  assert.equal(starvationProcesses, 2);
  assert.equal(starvationFallbacks, 1);
  assert.equal(
    await reprocessSuccessorBatchV2(starvationId, {
      store: starvationStore,
      now: () => attemptAt,
      process: async () => undefined,
      fallback: async () => {
        starvationFallbacks += 1;
      },
    }),
    'not_claimed'
  );
  assert.equal(starvationFallbacks, 1, 'fallback terminal nunca duplica após restart');

  const incompleteReceiptStore = new MemoryConversationalV2StateStore();
  const incomplete = prepared({
    conversationKey: 'PN:receipt-missing-delivery',
    transition: { kind: 'preserve' },
  });
  await incompleteReceiptStore.savePlanReceipt(incomplete.planReceipt);
  const incompleteReconciliation =
    await incompleteReceiptStore.verifyReceiptReconciliation([incomplete.frame.turnId]);
  assert.equal(incompleteReconciliation.ok, false);
  assert.equal(incompleteReconciliation.planWithoutDeliveryCount, 1);
  assert.equal(
    await reprocessSuccessorBatchV2(durableId, {
      store: successorStore,
      now: () => successorReadyAt,
      process: async () => {
        successorProcesses += 1;
      },
      fallback: async () => undefined,
    }),
    'not_claimed',
    'reprocesso do lote sucessor é idempotente após restart/claim'
  );
  assert.equal(successorProcesses, 1);

  assert.equal(
    CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
    600_000,
    'piso recorrente Neon é 10min'
  );
  assert.equal(
    nextConversationalV2SweepDelayMs(1, true, 1),
    CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
    'intervalo solicitado abaixo do piso é elevado para 10min'
  );
  assert.equal(
    nextConversationalV2SweepDelayMs(
      CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
      false
    ),
    2 * CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
    'erro dobra o intervalo'
  );
  assert.equal(
    nextConversationalV2SweepDelayMs(
      CONVERSATIONAL_V2_SWEEP_MAX_BACKOFF_MS,
      false
    ),
    CONVERSATIONAL_V2_SWEEP_MAX_BACKOFF_MS,
    'backoff respeita o teto'
  );
  assert.equal(
    nextConversationalV2SweepDelayMs(
      2 * CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
      true
    ),
    CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
    'sucesso reseta o backoff'
  );

  const timerStore = new MemoryConversationalV2StateStore();
  let recoverySweepRuns = 0;
  timerStore.sweep = async () => {
    recoverySweepRuns += 1;
    return { unknownMarked: 0, reconciled: 0, successorsReady: 0 };
  };
  startConversationalV2Sweep(timerStore, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stopConversationalV2SweepForTest();
  assert.equal(recoverySweepRuns, 1, 'sweeper outbox faz run inicial sem espera');

  let successorSweepRuns = 0;
  timerStore.listReadySuccessors = async () => {
    successorSweepRuns += 1;
    return [];
  };
  startConversationalV2SuccessorSweep(
    {
      store: timerStore,
      process: async () => undefined,
      fallback: async () => undefined,
    },
    1
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  stopConversationalV2SuccessorSweepForTest();
  assert.equal(successorSweepRuns, 1, 'sweeper sucessor faz run inicial sem espera');

  if (process.env.ANA_CONVERSATIONAL_V2_SMOKE_DB === '1') {
    const { ensureProcessedMessagesTable } = await import(
      '../src/services/processedMessages'
    );
    const { ensureAnaWave2Tables } = await import(
      '../src/services/anaWave2Store'
    );
    const {
      ensureConversationalV2Tables,
      pgConversationalV2StateStore,
    } = await import(
      '../src/services/conversationalV2/stateStore'
    );
    const { pool } = await import('../src/services/contextManager');
    await ensureProcessedMessagesTable();
    await ensureAnaWave2Tables();
    await ensureConversationalV2Tables();
    // IDs do trecho em memória são deliberadamente determinísticos; o trecho
    // PostgreSQL precisa de namespace por execução para sobreviver a um crash
    // anterior sem colidir com um outbox `transport_started`/`unknown` órfão.
    idNamespace = `v2-db-${Date.now().toString(36)}`;
    serial = 0;
    const dbConversationKey = `PN:db-v2-${Date.now()}`;
    const dbTurn = prepared({
      conversationKey: dbConversationKey,
      transition: openTransition(`flow-db-${Date.now()}`),
    });
    try {
      const result = await deliver({
        store: pgConversationalV2StateStore,
        prepared: dbTurn,
      });
      assert.equal(result.receipt.transportOutcome, 'accepted_by_provider');
      assert.equal(
        (await pgConversationalV2StateStore.loadLatestState(dbConversationKey, now))
          .pending?.state,
        'OPEN'
      );
      const persisted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM ana_v2_pending_frames
         WHERE conversation_key = $1 AND state = 'OPEN'`,
        [dbConversationKey]
      );
      assert.equal(persisted.rows[0]?.count, '1');
      assert.deepEqual(
        await pgConversationalV2StateStore.verifyReceiptReconciliation([
          dbTurn.frame.turnId,
        ]),
        {
          ok: true,
          planCount: 1,
          deliveryCount: 1,
          planWithoutDeliveryCount: 0,
          orphanDeliveryCount: 0,
          mismatchedTurnCount: 0,
          duplicateDeliveryForPlanCount: 0,
        },
        'Postgres reconcilia plano, entrega e turno 1:1'
      );
    } finally {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM ana_conversation_history WHERE "conversationKey" = $1',
          [dbConversationKey]
        );
        await client.query(
          'DELETE FROM ana_v2_pending_frames WHERE conversation_key = $1',
          [dbConversationKey]
        );
        await client.query(
          'DELETE FROM ana_v2_outbound_outbox WHERE conversation_key = $1',
          [dbConversationKey]
        );
        await client.query(
          'DELETE FROM ana_v2_turn_receipts WHERE turn_id = $1',
          [dbTurn.frame.turnId]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.end();
  }

  console.log('smoke ana conversational v2 persistence: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
