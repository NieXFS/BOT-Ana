import { randomUUID } from 'crypto';
import { isAmbiguousWhatsAppTransportError } from '../../whatsappCloudService';
import type {
  DeliveryPreemptionV2,
  PendingFrameSnapshotV2,
  TurnDeliveryReceiptV2,
} from './contracts';
import {
  opaqueReceiptHashV2,
  serializeTurnDeliveryReceiptV2,
  serializeTurnPlanReceiptV2,
} from './receipts';
import type {
  ConversationalV2Checkpoint,
  PreparedReceptionistTurnV2,
} from './runtimeTypes';
import {
  pgConversationalV2StateStore,
  type ConversationalV2StateStore,
  type DurableSuccessorBatchV2,
} from './stateStore';

export interface DeliverPreparedReceptionistTurnV2Deps {
  store?: ConversationalV2StateStore;
  checkpoint: () => Promise<ConversationalV2Checkpoint>;
  sendTransport: (
    payload: string
  ) => Promise<{ providerMessageId: string }>;
  isAmbiguousTransportError?: (error: unknown) => boolean;
  now?: () => Date;
  id?: () => string;
}

export interface DeliverPreparedReceptionistTurnV2Result {
  delivery: 'sent' | 'suppressed' | 'transport_unknown' | 'transport_failed';
  receipt: TurnDeliveryReceiptV2;
  successor: DurableSuccessorBatchV2 | null;
}

function canonicalPendingQuestion(pending: PendingFrameSnapshotV2): string {
  const names = pending.options.map((option) => option.displayName.trim()).filter(Boolean);
  switch (pending.kind) {
    case 'SERVICE':
      return names.length > 0
        ? `Qual serviço você prefere: ${names.join(', ')}?`
        : 'Qual serviço você prefere?';
    case 'PROFESSIONAL':
      return names.length > 0
        ? `Qual profissional você prefere: ${names.join(', ')}?`
        : 'Você prefere algum profissional específico?';
    case 'DATE':
      return 'Qual dia você prefere?';
    case 'TIME':
      return 'Qual horário você prefere?';
    case 'CONFIRMATION':
      return 'Você confirma essa opção?';
  }
}

function transportForPreemption(preemption: DeliveryPreemptionV2): {
  outcome: TurnDeliveryReceiptV2['transportOutcome'];
  outboxState: TurnDeliveryReceiptV2['outboxState'];
} {
  if (preemption === 'PAUSE_RECHECK' || preemption === 'HUMAN_ACTIVE') {
    return { outcome: 'suppressed_pause', outboxState: 'prepared' };
  }
  if (preemption === 'SUPERSEDED_BY_NEW_INBOUND') {
    return { outcome: 'superseded', outboxState: 'prepared' };
  }
  if (
    preemption === 'TRANSPORT_OUTCOME_UNKNOWN' ||
    preemption === 'INBOUND_SUSPENDED'
  ) {
    return { outcome: 'transport_unknown', outboxState: 'transport_unknown' };
  }
  return { outcome: 'transport_failed', outboxState: 'transport_failed' };
}

function buildTerminalReceipt(input: {
  prepared: PreparedReceptionistTurnV2;
  id: () => string;
  now: Date;
  transportStartedAt: string | null;
  transportOutcome: TurnDeliveryReceiptV2['transportOutcome'];
  outboxState: TurnDeliveryReceiptV2['outboxState'];
  conversationCommitOutcome: TurnDeliveryReceiptV2['conversationCommitOutcome'];
  pendingCommitOutcome: TurnDeliveryReceiptV2['pendingCommitOutcome'];
  providerMessageIdHash?: string;
  successorTurnId?: string;
  observedPendingVersion?: number | null;
}): TurnDeliveryReceiptV2 {
  return {
    schemaVersion: 2,
    deliveryReceiptId: input.id(),
    planReceiptId: input.prepared.planReceipt.planReceiptId,
    turnId: input.prepared.frame.turnId,
    deliveryAttemptId: input.id(),
    transportStartedAt: input.transportStartedAt,
    transportOutcome: input.transportOutcome,
    ...(input.providerMessageIdHash
      ? { providerMessageIdHash: input.providerMessageIdHash }
      : {}),
    outboxState: input.outboxState,
    conversationCommitOutcome: input.conversationCommitOutcome,
    pendingCommitOutcome: input.pendingCommitOutcome,
    ...(input.successorTurnId
      ? { successorTurnId: input.successorTurnId }
      : {}),
    expectedPendingVersion:
      input.prepared.frame.pending?.version ?? null,
    observedPendingVersion:
      input.observedPendingVersion ?? input.prepared.frame.pending?.version ?? null,
    terminalAt: input.now.toISOString(),
  };
}

async function persistSuccessor(
  prepared: PreparedReceptionistTurnV2,
  checkpoint: ConversationalV2Checkpoint,
  store: ConversationalV2StateStore,
  now: Date,
  id: () => string
): Promise<DurableSuccessorBatchV2 | null> {
  if (checkpoint.latestInputSequence <= prepared.frame.inputSequence) return null;
  const successorInputSequence =
    checkpoint.successorInputSequence ?? checkpoint.latestInputSequence;
  return store.enqueueSuccessor({
    successorTurnId: prepared.successorTurnId ?? id(),
    sourceTurnId: prepared.frame.turnId,
    conversationKey: prepared.conversationKey,
    phoneNumberId: prepared.phoneNumberId,
    customerPhone: prepared.customerPhone,
    inputSequence: successorInputSequence,
    inboundMessageIds: [...checkpoint.successorInboundMessageIds],
    requiresAuthoritativeRead: prepared.hasCommittedWrite,
    reprocessCount: 0,
    now,
  });
}

function emitPlan(prepared: PreparedReceptionistTurnV2): void {
  console.info(
    `[ana-conversational-v2-plan] ${serializeTurnPlanReceiptV2(
      prepared.planReceipt
    )}`
  );
}

function emitDelivery(receipt: TurnDeliveryReceiptV2): void {
  console.info(
    `[ana-conversational-v2-delivery] ${serializeTurnDeliveryReceiptV2(receipt)}`
  );
}

export async function deliverPreparedReceptionistTurnV2(
  prepared: PreparedReceptionistTurnV2,
  deps: DeliverPreparedReceptionistTurnV2Deps
): Promise<DeliverPreparedReceptionistTurnV2Result> {
  const store = deps.store ?? pgConversationalV2StateStore;
  const nowFn = deps.now ?? (() => new Date());
  const id = deps.id ?? randomUUID;
  const ambiguous =
    deps.isAmbiguousTransportError ?? isAmbiguousWhatsAppTransportError;

  await store.savePlanReceipt(prepared.planReceipt);
  emitPlan(prepared);
  const initialCheckpoint = await deps.checkpoint();
  const initialNow = nowFn();
  let successor = await persistSuccessor(
    prepared,
    initialCheckpoint,
    store,
    initialNow,
    id
  );

  let preemption = prepared.preemption;
  if (initialCheckpoint.paused) preemption = 'PAUSE_RECHECK';
  if (
    !preemption &&
    successor &&
    !prepared.hasCommittedWrite
  ) {
    preemption = 'SUPERSEDED_BY_NEW_INBOUND';
  }

  if (preemption) {
    const terminal = transportForPreemption(preemption);
    const successorTurnId =
      preemption === 'SUPERSEDED_BY_NEW_INBOUND'
        ? successor?.successorTurnId ?? prepared.successorTurnId ?? undefined
        : undefined;
    if (preemption === 'SUPERSEDED_BY_NEW_INBOUND' && !successorTurnId) {
      throw new Error('SUPERSEDED sem lote sucessor durável.');
    }
    const receipt = buildTerminalReceipt({
      prepared,
      id,
      now: initialNow,
      transportStartedAt: null,
      transportOutcome: terminal.outcome,
      outboxState: terminal.outboxState,
      conversationCommitOutcome: 'not_applicable',
      pendingCommitOutcome: 'not_applicable',
      ...(successorTurnId ? { successorTurnId } : {}),
    });
    await store.saveTerminalDeliveryReceipt(receipt);
    emitDelivery(receipt);
    return { delivery: 'suppressed', receipt, successor };
  }

  let payload = prepared.payload;
  if (!payload?.trim()) {
    throw new Error('Plano v2 ativo chegou à entrega sem payload.');
  }

  // Recheck determinístico de versão/TTL antes de preparar o transporte. Se a
  // âncora mudou, nunca enviamos uma copy de seleção baseada no snapshot velho;
  // repetimos somente a pergunta OPEN atual.
  const current = await store.loadLatestState(prepared.conversationKey, initialNow);
  if (
    prepared.frame.pending &&
    (!current.pending ||
      current.pending.snapshot.questionId !== prepared.frame.pending.questionId ||
      current.pending.snapshot.version !== prepared.frame.pending.version)
  ) {
    if (!current.pending) {
      const receipt = buildTerminalReceipt({
        prepared,
        id,
        now: initialNow,
        transportStartedAt: null,
        transportOutcome: 'transport_unknown',
        outboxState: 'transport_unknown',
        conversationCommitOutcome: 'not_applicable',
        pendingCommitOutcome: 'cas_conflict',
        observedPendingVersion: null,
      });
      await store.saveTerminalDeliveryReceipt(receipt);
      emitDelivery(receipt);
      return { delivery: 'suppressed', receipt, successor };
    }
    payload = canonicalPendingQuestion(current.pending.snapshot);
    prepared.planReceipt.route = 'fallback';
    prepared.planReceipt.recoveryKind = 'direct_fallback';
    prepared.transition = { kind: 'preserve' };
    await store.savePlanReceipt(prepared.planReceipt);
  }

  const deliveryAttemptId = id();
  await store.prepareOutbound({
    deliveryAttemptId,
    conversationKey: prepared.conversationKey,
    turnId: prepared.frame.turnId,
    planReceiptId: prepared.planReceipt.planReceiptId,
    payload,
    transition: prepared.transition,
    now: initialNow,
  });
  const transportStartedAt = nowFn();
  await store.markTransportStarted(deliveryAttemptId, transportStartedAt);

  let providerMessageId: string;
  try {
    providerMessageId = (
      await deps.sendTransport(payload)
    ).providerMessageId;
  } catch (error) {
    const outcome = ambiguous(error) ? 'transport_unknown' : 'transport_failed';
    const receipt = {
      ...buildTerminalReceipt({
        prepared,
        id,
        now: nowFn(),
        transportStartedAt: transportStartedAt.toISOString(),
        transportOutcome: outcome,
        outboxState: outcome,
        conversationCommitOutcome: 'failed',
        pendingCommitOutcome: 'not_applicable',
      }),
      deliveryAttemptId,
    };
    await store.markTransportTerminal({
      deliveryAttemptId,
      state: outcome,
      receipt,
      now: nowFn(),
    });
    emitDelivery(receipt);
    return {
      delivery: outcome,
      receipt,
      successor,
    };
  }

  const providerMessageIdHash = opaqueReceiptHashV2(providerMessageId);
  const acceptedAt = nowFn();
  const pendingOutcome =
    prepared.transition.kind === 'open'
      ? 'opened'
      : prepared.transition.kind === 'resolve'
        ? 'resolved'
        : prepared.transition.kind === 'invalidate'
          ? 'invalidated'
          : prepared.frame.pending
            ? 'preserved'
            : 'not_applicable';
  const acceptedReceipt = {
    ...buildTerminalReceipt({
      prepared,
      id,
      now: acceptedAt,
      transportStartedAt: transportStartedAt.toISOString(),
      transportOutcome: 'accepted_by_provider',
      outboxState: 'accepted_by_provider',
      conversationCommitOutcome: 'committed',
      pendingCommitOutcome: pendingOutcome,
      providerMessageIdHash,
    }),
    deliveryAttemptId,
  };
  const commitPayload = {
    assistantText: payload,
    transition: prepared.transition,
    deliveryReceipt: acceptedReceipt,
  };

  try {
    const pending = await store.commitAccepted({
      deliveryAttemptId,
      providerMessageIdHash,
      commitPayload,
      now: acceptedAt,
    });
    const receipt: TurnDeliveryReceiptV2 = {
      ...acceptedReceipt,
      pendingCommitOutcome: pending.outcome,
      observedPendingVersion: pending.observedVersion,
    };
    emitDelivery(receipt);
    return { delivery: 'sent', receipt, successor };
  } catch {
    const receipt: TurnDeliveryReceiptV2 = {
      ...acceptedReceipt,
      outboxState: 'accepted_uncommitted',
      conversationCommitOutcome: 'accepted_uncommitted',
      pendingCommitOutcome: 'failed',
    };
    let acceptedStatePersisted = false;
    for (let attempt = 0; attempt < 3 && !acceptedStatePersisted; attempt += 1) {
      try {
        await store.markAcceptedUncommitted({
          deliveryAttemptId,
          providerMessageIdHash,
          commitPayload: { ...commitPayload, deliveryReceipt: receipt },
          now: acceptedAt,
        });
        acceptedStatePersisted = true;
      } catch {
        // Retry exclusivamente local. O POST já foi aceito e nunca se repete.
      }
    }
    if (!acceptedStatePersisted) {
      console.error(
        '[ana-conversational-v2] aceite do provider sem persistência local; sem retry de transporte'
      );
    }
    emitDelivery(receipt);
    return { delivery: 'sent', receipt, successor };
  }
}
