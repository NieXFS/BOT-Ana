import type { PoolClient } from 'pg';
import { pool } from '../contextManager';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  ProviderDeliveryStatusV2,
  TurnDeliveryReceiptV2,
  TurnPlanReceiptV2,
} from './contracts';
import type { CopyVariantIdV2 } from './copyVariants';
import { ensureProviderStatusV2Tables } from './providerStatus';

export const PENDING_FRAME_TTL_MS_V2 = 24 * 60 * 60 * 1_000;
export const OUTBOX_TRANSPORT_STALE_MS_V2 = 2 * 60 * 1_000;
export const SUCCESSOR_MAX_REPROCESSES_V2 = 2;
export const SUCCESSOR_REARM_DEBOUNCE_MS_V2 = 12_000;
/** Piso Neon: nenhum poller recorrente consulta Postgres em cadência < 10min. */
export const CONVERSATIONAL_V2_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const CONVERSATIONAL_V2_SWEEP_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

export function nextConversationalV2SweepDelayMs(
  currentDelayMs: number,
  succeeded: boolean,
  requestedBaseMs = CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
  requestedMaxMs = CONVERSATIONAL_V2_SWEEP_MAX_BACKOFF_MS
): number {
  const baseMs = Math.max(
    CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
    requestedBaseMs
  );
  const maxMs = Math.max(baseMs, requestedMaxMs);
  if (succeeded) return baseMs;
  return Math.min(Math.max(currentDelayMs, baseMs) * 2, maxMs);
}

export type PendingFrameStateV2 =
  | 'OPEN'
  | 'RESOLVED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface PendingFrameRecordV2 {
  conversationKey: string;
  state: PendingFrameStateV2;
  snapshot: PendingFrameSnapshotV2;
  flowState: FlowStateV2;
  updatedAt: string;
}

export type MaterializedPendingTransitionV2 =
  | {
      kind: 'preserve';
      /** Provas validadas podem avançar o flowState sem trocar a pergunta. */
      nextFlowState?: FlowStateV2;
      expectedQuestionId?: string | null;
      expectedVersion?: number | null;
    }
  | {
      kind: 'resolve';
      questionId: string;
      expectedVersion: number;
      nextFlowState: FlowStateV2;
    }
  | {
      kind: 'invalidate';
      questionId: string;
      expectedVersion: number;
      reasonCodeHash?: string;
      nextFlowState: FlowStateV2;
    }
  | {
      kind: 'open';
      frame: PendingFrameSnapshotV2;
      expectedQuestionId: string | null;
      expectedVersion: number | null;
      nextFlowState: FlowStateV2;
    };

export interface AcceptedCommitPayloadV2 {
  assistantText: string;
  transition: MaterializedPendingTransitionV2;
  deliveryReceipt: TurnDeliveryReceiptV2;
  copyVariant?: CopyVariantIdV2;
}

export interface OutboundOutboxRecordV2 {
  deliveryAttemptId: string;
  conversationKey: string;
  turnId: string;
  planReceiptId: string;
  state:
    | 'prepared'
    | 'transport_started'
    | 'accepted_by_provider'
    | 'transport_unknown'
    | 'transport_failed'
    | 'accepted_uncommitted';
  payload: string;
  transition: MaterializedPendingTransitionV2;
  providerMessageIdHash: string | null;
  /** Projeção assíncrona; não altera commitPayload.deliveryReceipt. */
  providerStatus: ProviderDeliveryStatusV2 | null;
  providerStatusAt: string | null;
  providerFailureCode: string | null;
  providerStatusVersion: number;
  transportStartedAt: string | null;
  commitPayload: AcceptedCommitPayloadV2 | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Proveniência tipada da última copy que o provider aceitou. O payload só
 * volta ao runtime em memória; recibos de produção continuam hash-only.
 */
export interface AcceptedDeliveryEvidenceV2 {
  readonly payload: string;
  readonly terminalAt: string;
  readonly transition: MaterializedPendingTransitionV2;
  readonly conversationCommitOutcome: TurnDeliveryReceiptV2['conversationCommitOutcome'];
  readonly pendingCommitOutcome: TurnDeliveryReceiptV2['pendingCommitOutcome'];
  readonly copyVariant: CopyVariantIdV2;
}

export interface DurableSuccessorBatchV2 {
  successorTurnId: string;
  sourceTurnId: string;
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  inputSequence: number;
  inboundMessageIds: string[];
  requiresAuthoritativeRead: boolean;
  reprocessCount: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export type InboundDeliveryGuardV2 =
  | { kind: 'clear'; pending: PendingFrameRecordV2 | null }
  | {
      kind: 'reconstructed';
      pending: PendingFrameRecordV2;
      deliveryAttemptId: string;
    }
  | {
      kind: 'suspended';
      reason: 'transport_started' | 'accepted_uncommitted';
      deliveryAttemptId: string;
    };

export interface PendingCommitResultV2 {
  outcome:
    | 'opened'
    | 'preserved'
    | 'resolved'
    | 'invalidated'
    | 'cas_conflict'
    | 'not_applicable'
    | 'failed';
  observedVersion: number | null;
}

export interface ReceiptReconciliationV2 {
  ok: boolean;
  planCount: number;
  deliveryCount: number;
  planWithoutDeliveryCount: number;
  orphanDeliveryCount: number;
  mismatchedTurnCount: number;
  duplicateDeliveryForPlanCount: number;
}

export type FlowStateInvalidationReasonV2 =
  | 'HUMAN_OWNERSHIP'
  | 'SILENT_ESCALATION'
  | 'EXPLICIT_CONVERSATION_RESET';

export interface FlowStateInvalidationV2 {
  conversationKey: string;
  invalidatedAt: string;
  reason: FlowStateInvalidationReasonV2;
}

export interface ConversationalV2LatestState {
  pending: PendingFrameRecordV2 | null;
  flowState: FlowStateV2 | null;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  /**
   * Recibo committed da transição `open` que abriu a PendingFrame OPEN atual
   * (mesmo version/flowId/questionId). Preserve posterior não substitui.
   */
  openingAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
}

export interface ConversationalV2StateStore {
  savePlanReceipt(receipt: TurnPlanReceiptV2): Promise<void>;
  saveTerminalDeliveryReceipt(receipt: TurnDeliveryReceiptV2): Promise<void>;
  loadLatestState(
    conversationKey: string,
    now?: Date
  ): Promise<ConversationalV2LatestState>;
  getInputSequence(conversationKey: string): Promise<number>;
  prepareOutbound(input: {
    deliveryAttemptId: string;
    conversationKey: string;
    turnId: string;
    planReceiptId: string;
    payload: string;
    transition: MaterializedPendingTransitionV2;
    now: Date;
  }): Promise<OutboundOutboxRecordV2>;
  markTransportStarted(deliveryAttemptId: string, now: Date): Promise<void>;
  markTransportTerminal(input: {
    deliveryAttemptId: string;
    state: 'transport_unknown' | 'transport_failed';
    receipt: TurnDeliveryReceiptV2;
    now: Date;
  }): Promise<void>;
  commitAccepted(input: {
    deliveryAttemptId: string;
    providerMessageIdHash: string;
    commitPayload: AcceptedCommitPayloadV2;
    now: Date;
  }): Promise<PendingCommitResultV2>;
  markAcceptedUncommitted(input: {
    deliveryAttemptId: string;
    providerMessageIdHash: string;
    commitPayload: AcceptedCommitPayloadV2;
    now: Date;
  }): Promise<void>;
  reconcileAcceptedCommit(deliveryAttemptId: string, now?: Date): Promise<PendingCommitResultV2>;
  inspectInboundGuard(conversationKey: string, now?: Date): Promise<InboundDeliveryGuardV2>;
  invalidateOpenPendingByHuman(conversationKey: string, now?: Date): Promise<number>;
  recordFlowStateInvalidation(input: {
    conversationKey: string;
    reason: FlowStateInvalidationReasonV2;
    now?: Date;
  }): Promise<void>;
  enqueueSuccessor(input: Omit<
    DurableSuccessorBatchV2,
    'status' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'
  > & { now: Date }): Promise<DurableSuccessorBatchV2>;
  listReadySuccessors(limit: number, now?: Date): Promise<DurableSuccessorBatchV2[]>;
  claimSuccessor(successorTurnId: string, now?: Date): Promise<DurableSuccessorBatchV2 | null>;
  markSuccessorCompleted(successorTurnId: string, now?: Date): Promise<void>;
  rearmSuccessor(successorTurnId: string, nextAttemptAt: Date): Promise<DurableSuccessorBatchV2 | null>;
  verifyReceiptReconciliation(turnIds?: readonly string[]): Promise<ReceiptReconciliationV2>;
  sweep(now?: Date): Promise<{
    unknownMarked: number;
    reconciled: number;
    successorsReady: number;
  }>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function iso(now: Date): string {
  return now.toISOString();
}

function isExpired(snapshot: PendingFrameSnapshotV2, now: Date): boolean {
  const askedAt = Date.parse(snapshot.askedAt);
  return !Number.isFinite(askedAt) || now.getTime() - askedAt >= PENDING_FRAME_TTL_MS_V2;
}

function acceptedDeliveryEvidenceFromOutbox(
  record: OutboundOutboxRecordV2
): AcceptedDeliveryEvidenceV2 | null {
  const commit = record.commitPayload;
  if (
    record.state !== 'accepted_by_provider' ||
    !commit ||
    commit.deliveryReceipt.transportOutcome !== 'accepted_by_provider'
  ) {
    return null;
  }
  return {
    payload: record.payload,
    terminalAt: commit.deliveryReceipt.terminalAt,
    transition: clone(record.transition),
    conversationCommitOutcome: commit.deliveryReceipt.conversationCommitOutcome,
    pendingCommitOutcome: commit.deliveryReceipt.pendingCommitOutcome,
    copyVariant: commit.copyVariant ?? 'canonical',
  };
}

function isAcceptedProviderOutbox(record: OutboundOutboxRecordV2): boolean {
  return (
    record.state === 'accepted_by_provider' &&
    record.commitPayload?.deliveryReceipt.transportOutcome ===
      'accepted_by_provider'
  );
}

function compareAcceptedOutboxByTerminal(
  left: OutboundOutboxRecordV2,
  right: OutboundOutboxRecordV2,
  direction: 'asc' | 'desc'
): number {
  const sign = direction === 'desc' ? -1 : 1;
  const terminalDelta =
    Date.parse(left.commitPayload!.deliveryReceipt.terminalAt) -
    Date.parse(right.commitPayload!.deliveryReceipt.terminalAt);
  return (
    sign * terminalDelta ||
    sign * (Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
  );
}

function isCommittedOpeningOutboxForPending(
  record: OutboundOutboxRecordV2,
  pending: PendingFrameSnapshotV2
): boolean {
  if (record.transition.kind !== 'open') return false;
  const evidence = acceptedDeliveryEvidenceFromOutbox(record);
  if (
    !evidence ||
    evidence.conversationCommitOutcome !== 'committed' ||
    evidence.pendingCommitOutcome !== 'opened'
  ) {
    return false;
  }
  const frame = record.transition.frame;
  return (
    frame.questionId === pending.questionId &&
    frame.version === pending.version &&
    frame.flowId === pending.flowId
  );
}

function transitionNextFlowStateV2(
  transition: MaterializedPendingTransitionV2
): FlowStateV2 | undefined {
  return transition.nextFlowState;
}

function isPersistedDeferredFlowStateV2(
  flowState: FlowStateV2 | null | undefined
): flowState is FlowStateV2 {
  const constraint = flowState?.deferredAvailability;
  if (!constraint || constraint.schemaVersion !== 1) return false;
  if (typeof constraint.capturedAt !== 'string') return false;
  if (!Number.isFinite(Date.parse(constraint.capturedAt))) return false;
  if (
    typeof constraint.capturedTurnId !== 'string' ||
    constraint.capturedTurnId.trim().length === 0
  ) {
    return false;
  }
  if (
    typeof constraint.capturedInputSequence !== 'number' ||
    !Number.isFinite(constraint.capturedInputSequence)
  ) {
    return false;
  }
  return true;
}

function committedDeferredFlowStateFromOutboxV2(
  record: OutboundOutboxRecordV2 | null
): FlowStateV2 | null {
  if (!record) return null;
  if (record.state !== 'accepted_by_provider') return null;
  const receipt = record.commitPayload?.deliveryReceipt;
  if (!receipt) return null;
  if (receipt.transportOutcome !== 'accepted_by_provider') return null;
  if (receipt.conversationCommitOutcome !== 'committed') return null;
  const nextFlowState = transitionNextFlowStateV2(record.transition);
  return isPersistedDeferredFlowStateV2(nextFlowState) ? nextFlowState : null;
}

function outboxTerminalIsAfterPendingV2(
  record: OutboundOutboxRecordV2,
  pending: PendingFrameRecordV2 | null
): boolean {
  if (!pending || pending.state === 'EXPIRED') return true;
  const terminalAt = Date.parse(
    record.commitPayload?.deliveryReceipt.terminalAt ?? ''
  );
  const pendingAt = Date.parse(pending.updatedAt);
  return Number.isFinite(terminalAt) && Number.isFinite(pendingAt) && terminalAt > pendingAt;
}

function isStrictlyAfterCutoffV2(
  timestamp: string | null | undefined,
  cutoffAt: string | null | undefined
): boolean {
  if (!cutoffAt) return true;
  const value = Date.parse(timestamp ?? '');
  const cutoff = Date.parse(cutoffAt);
  return Number.isFinite(value) && Number.isFinite(cutoff) && value > cutoff;
}

function withoutDeferredAvailabilityV2(flowState: FlowStateV2): FlowStateV2 {
  const { deferredAvailability: _deferred, ...rest } = clone(flowState);
  return rest;
}

function mergeFlowStateInvalidationV2(
  existing: FlowStateInvalidationV2 | undefined,
  next: FlowStateInvalidationV2
): FlowStateInvalidationV2 {
  if (!existing) return clone(next);
  const existingAt = Date.parse(existing.invalidatedAt);
  const nextAt = Date.parse(next.invalidatedAt);
  if (!Number.isFinite(nextAt)) return clone(existing);
  if (!Number.isFinite(existingAt) || nextAt > existingAt) return clone(next);
  return clone(existing);
}

function restorableOpenPendingV2(
  open: PendingFrameRecordV2 | null,
  invalidation: FlowStateInvalidationV2 | null | undefined
): PendingFrameRecordV2 | null {
  if (!open) return null;
  return isStrictlyAfterCutoffV2(open.updatedAt, invalidation?.invalidatedAt)
    ? open
    : null;
}

/**
 * Precedência da projeção de leitura do flowState v2.
 * PendingFrame OPEN vigente continua autoritativa só se for estritamente
 * posterior ao cutoff humano. Sem pending aplicável, um outbox já
 * aceito/commitado pode restaurar `nextFlowState` somente quando carrega
 * `deferredAvailability` e o terminal também é posterior ao cutoff.
 * Terminais INVALIDATED/SUPERSEDED/RESOLVED nunca devolvem
 * `deferredAvailability`. Não escreve nem reenvia transporte.
 */
export function resolveLatestFlowStateV2(input: {
  latestPendingRecord: PendingFrameRecordV2 | null;
  lastAcceptedOutbox: OutboundOutboxRecordV2 | null;
  now: Date;
  flowStateInvalidation?: FlowStateInvalidationV2 | null;
}): FlowStateV2 | null {
  const pending = input.latestPendingRecord;
  const cutoffAt = input.flowStateInvalidation?.invalidatedAt ?? null;
  const openApplicable =
    pending &&
    pending.state === 'OPEN' &&
    !isExpired(pending.snapshot, input.now)
      ? pending
      : null;
  const openRestorable = restorableOpenPendingV2(openApplicable, input.flowStateInvalidation);
  if (openRestorable) return clone(openRestorable.flowState);
  // OPEN anterior ao cutoff não vence: invalidação incompleta falha fechada.
  const pendingForFallback = openApplicable && !openRestorable ? null : pending;

  const fromOutbox = committedDeferredFlowStateFromOutboxV2(input.lastAcceptedOutbox);
  if (
    fromOutbox &&
    input.lastAcceptedOutbox &&
    isStrictlyAfterCutoffV2(
      input.lastAcceptedOutbox.commitPayload?.deliveryReceipt.terminalAt,
      cutoffAt
    ) &&
    outboxTerminalIsAfterPendingV2(input.lastAcceptedOutbox, pendingForFallback)
  ) {
    return clone(fromOutbox);
  }
  if (pendingForFallback && pendingForFallback.state !== 'EXPIRED') {
    if (!isStrictlyAfterCutoffV2(pendingForFallback.updatedAt, cutoffAt)) {
      return null;
    }
    const restored = clone(pendingForFallback.flowState);
    if (
      pendingForFallback.state === 'INVALIDATED' ||
      pendingForFallback.state === 'SUPERSEDED' ||
      pendingForFallback.state === 'RESOLVED'
    ) {
      return withoutDeferredAvailabilityV2(restored);
    }
    return restored;
  }
  return null;
}

export function projectLatestFlowStateV2(input: {
  openPending: PendingFrameRecordV2 | null;
  latestPending: PendingFrameRecordV2 | null;
  lastAcceptedOutbox: OutboundOutboxRecordV2 | null;
  invalidation: FlowStateInvalidationV2 | null;
  now: Date;
}): Pick<ConversationalV2LatestState, 'pending' | 'flowState'> {
  const restorableOpen = restorableOpenPendingV2(
    input.openPending,
    input.invalidation
  );
  return {
    pending: restorableOpen ? clone(restorableOpen) : null,
    flowState: resolveLatestFlowStateV2({
      latestPendingRecord: input.openPending ?? input.latestPending,
      lastAcceptedOutbox: input.lastAcceptedOutbox,
      now: input.now,
      flowStateInvalidation: input.invalidation,
    }),
  };
}

function reconstructedPending(
  conversationKey: string,
  transition: MaterializedPendingTransitionV2,
  now: Date
): PendingFrameRecordV2 | null {
  if (transition.kind !== 'open' || isExpired(transition.frame, now)) return null;
  return {
    conversationKey,
    state: 'OPEN',
    snapshot: clone(transition.frame),
    flowState: clone(transition.nextFlowState),
    updatedAt: iso(now),
  };
}

export class MemoryConversationalV2StateStore implements ConversationalV2StateStore {
  readonly pending = new Map<string, PendingFrameRecordV2[]>();
  readonly outbox = new Map<string, OutboundOutboxRecordV2>();
  readonly plans = new Map<string, TurnPlanReceiptV2>();
  readonly deliveries = new Map<string, TurnDeliveryReceiptV2>();
  readonly successors = new Map<string, DurableSuccessorBatchV2>();
  readonly inputSequences = new Map<string, number>();
  readonly flowStateInvalidations = new Map<string, FlowStateInvalidationV2>();
  failNextAcceptedCommit = false;
  transportPostCount = 0;

  setInputSequence(conversationKey: string, sequence: number): void {
    this.inputSequences.set(conversationKey, sequence);
  }

  async savePlanReceipt(receipt: TurnPlanReceiptV2): Promise<void> {
    this.plans.set(receipt.planReceiptId, clone(receipt));
  }

  async saveTerminalDeliveryReceipt(receipt: TurnDeliveryReceiptV2): Promise<void> {
    this.deliveries.set(receipt.deliveryReceiptId, clone(receipt));
  }

  private rows(conversationKey: string): PendingFrameRecordV2[] {
    const rows = this.pending.get(conversationKey) ?? [];
    this.pending.set(conversationKey, rows);
    return rows;
  }

  async loadLatestState(
    conversationKey: string,
    now = new Date()
  ): Promise<ConversationalV2LatestState> {
    const rows = this.rows(conversationKey);
    for (const row of rows) {
      if (row.state === 'OPEN' && isExpired(row.snapshot, now)) {
        row.state = 'EXPIRED';
        row.snapshot = { ...row.snapshot, version: row.snapshot.version + 1 };
        row.updatedAt = iso(now);
      }
    }
    const latest = rows.at(-1) ?? null;
    const open = [...rows].reverse().find((row) => row.state === 'OPEN') ?? null;
    const accepted = [...this.outbox.values()].filter(
      (record) =>
        record.conversationKey === conversationKey &&
        isAcceptedProviderOutbox(record)
    );
    const lastAccepted = [...accepted].sort((left, right) =>
      compareAcceptedOutboxByTerminal(left, right, 'desc')
    )[0];
    const openingAccepted = open
      ? [...accepted]
          .filter((record) =>
            isCommittedOpeningOutboxForPending(record, open.snapshot)
          )
          .sort((left, right) =>
            compareAcceptedOutboxByTerminal(left, right, 'asc')
          )[0]
      : undefined;
    const invalidation = this.flowStateInvalidations.get(conversationKey) ?? null;
    const projected = projectLatestFlowStateV2({
      openPending: open,
      latestPending: latest,
      lastAcceptedOutbox: lastAccepted ?? null,
      invalidation,
      now,
    });
    return {
      pending: projected.pending,
      // OPEN vigente continua autoritativa depois do cutoff. Sem pending
      // aplicável, o outbox aceito/commitado pode projetar deferredAvailability
      // já persistida em transition_json — sem escrever de novo nem reenviar
      // transporte, e nunca após um cutoff humano.
      flowState: projected.flowState,
      lastAcceptedDelivery: lastAccepted
        ? acceptedDeliveryEvidenceFromOutbox(lastAccepted)
        : null,
      openingAcceptedDelivery: projected.pending && openingAccepted
        ? acceptedDeliveryEvidenceFromOutbox(openingAccepted)
        : null,
    };
  }

  async getInputSequence(conversationKey: string): Promise<number> {
    return this.inputSequences.get(conversationKey) ?? 0;
  }

  async prepareOutbound(input: {
    deliveryAttemptId: string;
    conversationKey: string;
    turnId: string;
    planReceiptId: string;
    payload: string;
    transition: MaterializedPendingTransitionV2;
    now: Date;
  }): Promise<OutboundOutboxRecordV2> {
    const existing = this.outbox.get(input.deliveryAttemptId);
    if (existing) return clone(existing);
    const record: OutboundOutboxRecordV2 = {
      deliveryAttemptId: input.deliveryAttemptId,
      conversationKey: input.conversationKey,
      turnId: input.turnId,
      planReceiptId: input.planReceiptId,
      state: 'prepared',
      payload: input.payload,
      transition: clone(input.transition),
      providerMessageIdHash: null,
      providerStatus: null,
      providerStatusAt: null,
      providerFailureCode: null,
      providerStatusVersion: 0,
      transportStartedAt: null,
      commitPayload: null,
      createdAt: iso(input.now),
      updatedAt: iso(input.now),
    };
    this.outbox.set(record.deliveryAttemptId, record);
    return clone(record);
  }

  async markTransportStarted(deliveryAttemptId: string, now: Date): Promise<void> {
    const record = this.outbox.get(deliveryAttemptId);
    if (!record || record.state !== 'prepared') {
      throw new Error('outbox v2 não está em prepared');
    }
    record.state = 'transport_started';
    record.transportStartedAt = iso(now);
    record.updatedAt = iso(now);
    this.transportPostCount += 1;
  }

  async markTransportTerminal(input: {
    deliveryAttemptId: string;
    state: 'transport_unknown' | 'transport_failed';
    receipt: TurnDeliveryReceiptV2;
    now: Date;
  }): Promise<void> {
    const record = this.outbox.get(input.deliveryAttemptId);
    if (!record) throw new Error('outbox v2 ausente');
    record.state = input.state;
    record.updatedAt = iso(input.now);
    this.deliveries.set(input.receipt.deliveryReceiptId, clone(input.receipt));
  }

  private applyTransition(
    conversationKey: string,
    transition: MaterializedPendingTransitionV2,
    now: Date
  ): PendingCommitResultV2 {
    const rows = this.rows(conversationKey);
    const open = [...rows].reverse().find((row) => row.state === 'OPEN') ?? null;
    if (transition.kind === 'preserve') {
      if (
        transition.nextFlowState &&
        (transition.expectedQuestionId !== (open?.snapshot.questionId ?? null) ||
          transition.expectedVersion !== (open?.snapshot.version ?? null))
      ) {
        return {
          outcome: 'cas_conflict',
          observedVersion: open?.snapshot.version ?? null,
        };
      }
      if (open && transition.nextFlowState) {
        open.flowState = clone(transition.nextFlowState);
        open.updatedAt = iso(now);
      }
      return { outcome: open ? 'preserved' : 'not_applicable', observedVersion: open?.snapshot.version ?? null };
    }
    if (transition.kind === 'resolve' || transition.kind === 'invalidate') {
      if (
        !open ||
        open.snapshot.questionId !== transition.questionId ||
        open.snapshot.version !== transition.expectedVersion
      ) {
        return { outcome: 'cas_conflict', observedVersion: open?.snapshot.version ?? null };
      }
      open.state = transition.kind === 'resolve' ? 'RESOLVED' : 'INVALIDATED';
      open.snapshot = { ...open.snapshot, version: open.snapshot.version + 1 };
      open.flowState = clone(transition.nextFlowState);
      open.updatedAt = iso(now);
      return {
        outcome: transition.kind === 'resolve' ? 'resolved' : 'invalidated',
        observedVersion: transition.expectedVersion,
      };
    }
    if (
      (transition.expectedQuestionId === null && open) ||
      (transition.expectedQuestionId !== null &&
        (!open ||
          open.snapshot.questionId !== transition.expectedQuestionId ||
          open.snapshot.version !== transition.expectedVersion))
    ) {
      return { outcome: 'cas_conflict', observedVersion: open?.snapshot.version ?? null };
    }
    if (open) {
      open.state = 'SUPERSEDED';
      open.snapshot = { ...open.snapshot, version: open.snapshot.version + 1 };
      open.updatedAt = iso(now);
    }
    rows.push({
      conversationKey,
      state: 'OPEN',
      snapshot: clone(transition.frame),
      flowState: clone(transition.nextFlowState),
      updatedAt: iso(now),
    });
    return { outcome: 'opened', observedVersion: transition.expectedVersion };
  }

  async commitAccepted(input: {
    deliveryAttemptId: string;
    providerMessageIdHash: string;
    commitPayload: AcceptedCommitPayloadV2;
    now: Date;
  }): Promise<PendingCommitResultV2> {
    if (this.failNextAcceptedCommit) {
      this.failNextAcceptedCommit = false;
      throw new Error('accepted commit failure injected');
    }
    const record = this.outbox.get(input.deliveryAttemptId);
    if (!record) throw new Error('outbox v2 ausente');
    if (record.state === 'accepted_by_provider') {
      return {
        outcome: input.commitPayload.deliveryReceipt.pendingCommitOutcome,
        observedVersion: input.commitPayload.deliveryReceipt.observedPendingVersion,
      } as PendingCommitResultV2;
    }
    if (!['transport_started', 'accepted_uncommitted'].includes(record.state)) {
      throw new Error('outbox v2 não aceita commit local neste estado');
    }
    const pending = this.applyTransition(
      record.conversationKey,
      input.commitPayload.transition,
      input.now
    );
    record.state = 'accepted_by_provider';
    record.providerMessageIdHash = input.providerMessageIdHash;
    record.commitPayload = clone(input.commitPayload);
    record.updatedAt = iso(input.now);
    const receipt: TurnDeliveryReceiptV2 = {
      ...input.commitPayload.deliveryReceipt,
      outboxState: 'accepted_by_provider',
      conversationCommitOutcome: 'committed',
      pendingCommitOutcome: pending.outcome,
      observedPendingVersion: pending.observedVersion,
    };
    record.commitPayload.deliveryReceipt = receipt;
    this.deliveries.set(receipt.deliveryReceiptId, clone(receipt));
    return pending;
  }

  async markAcceptedUncommitted(input: {
    deliveryAttemptId: string;
    providerMessageIdHash: string;
    commitPayload: AcceptedCommitPayloadV2;
    now: Date;
  }): Promise<void> {
    const record = this.outbox.get(input.deliveryAttemptId);
    if (!record) throw new Error('outbox v2 ausente');
    record.state = 'accepted_uncommitted';
    record.providerMessageIdHash = input.providerMessageIdHash;
    record.commitPayload = clone(input.commitPayload);
    record.updatedAt = iso(input.now);
    this.deliveries.set(
      input.commitPayload.deliveryReceipt.deliveryReceiptId,
      clone(input.commitPayload.deliveryReceipt)
    );
  }

  async reconcileAcceptedCommit(deliveryAttemptId: string, now = new Date()): Promise<PendingCommitResultV2> {
    const record = this.outbox.get(deliveryAttemptId);
    if (!record?.commitPayload || record.state !== 'accepted_uncommitted') {
      return { outcome: 'not_applicable', observedVersion: null };
    }
    return this.commitAccepted({
      deliveryAttemptId,
      providerMessageIdHash: record.providerMessageIdHash ?? '',
      commitPayload: clone(record.commitPayload),
      now,
    });
  }

  async inspectInboundGuard(conversationKey: string, now = new Date()): Promise<InboundDeliveryGuardV2> {
    const blocking = [...this.outbox.values()]
      .filter(
        (entry) =>
          entry.conversationKey === conversationKey &&
          (entry.state === 'transport_started' || entry.state === 'accepted_uncommitted')
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (blocking) {
      if (blocking.state === 'accepted_uncommitted' && blocking.commitPayload) {
        const pending = reconstructedPending(
          conversationKey,
          blocking.commitPayload.transition,
          now
        );
        if (pending) {
          return {
            kind: 'reconstructed',
            pending,
            deliveryAttemptId: blocking.deliveryAttemptId,
          };
        }
      }
      return {
        kind: 'suspended',
        reason: blocking.state as 'transport_started' | 'accepted_uncommitted',
        deliveryAttemptId: blocking.deliveryAttemptId,
      };
    }
    const state = await this.loadLatestState(conversationKey, now);
    return { kind: 'clear', pending: state.pending };
  }

  async invalidateOpenPendingByHuman(conversationKey: string, now = new Date()): Promise<number> {
    let count = 0;
    for (const row of this.rows(conversationKey)) {
      if (row.state !== 'OPEN') continue;
      row.state = 'INVALIDATED';
      row.snapshot = { ...row.snapshot, version: row.snapshot.version + 1 };
      row.updatedAt = iso(now);
      count += 1;
    }
    await this.recordFlowStateInvalidation({
      conversationKey,
      reason: 'HUMAN_OWNERSHIP',
      now,
    });
    return count;
  }

  async recordFlowStateInvalidation(input: {
    conversationKey: string;
    reason: FlowStateInvalidationReasonV2;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const next: FlowStateInvalidationV2 = {
      conversationKey: input.conversationKey,
      invalidatedAt: iso(now),
      reason: input.reason,
    };
    this.flowStateInvalidations.set(
      input.conversationKey,
      mergeFlowStateInvalidationV2(
        this.flowStateInvalidations.get(input.conversationKey),
        next
      )
    );
  }

  async enqueueSuccessor(input: Omit<
    DurableSuccessorBatchV2,
    'status' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'
  > & { now: Date }): Promise<DurableSuccessorBatchV2> {
    const duplicate = [...this.successors.values()].find(
      (entry) =>
        entry.conversationKey === input.conversationKey &&
        entry.sourceTurnId === input.sourceTurnId &&
        entry.inputSequence === input.inputSequence
    );
    if (duplicate) {
      duplicate.inboundMessageIds = [...new Set([
        ...duplicate.inboundMessageIds,
        ...input.inboundMessageIds,
      ])];
      duplicate.requiresAuthoritativeRead ||= input.requiresAuthoritativeRead;
      duplicate.nextAttemptAt = iso(
        new Date(input.now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2)
      );
      duplicate.updatedAt = iso(input.now);
      return clone(duplicate);
    }
    const record: DurableSuccessorBatchV2 = {
      ...clone(input),
      status: 'queued',
      nextAttemptAt: iso(
        new Date(input.now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2)
      ),
      createdAt: iso(input.now),
      updatedAt: iso(input.now),
    };
    delete (record as Partial<typeof record> & { now?: Date }).now;
    this.successors.set(record.successorTurnId, record);
    return clone(record);
  }

  async listReadySuccessors(limit: number, now = new Date()): Promise<DurableSuccessorBatchV2[]> {
    return [...this.successors.values()]
      .filter(
        (entry) =>
          entry.status === 'queued' &&
          Date.parse(entry.nextAttemptAt) <= now.getTime()
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async claimSuccessor(successorTurnId: string, now = new Date()): Promise<DurableSuccessorBatchV2 | null> {
    const record = this.successors.get(successorTurnId);
    const alreadyTerminal = [...this.deliveries.values()].some(
      (receipt) => receipt.turnId === successorTurnId
    );
    if (record && alreadyTerminal) {
      record.status = 'completed';
      record.updatedAt = iso(now);
      return null;
    }
    if (
      !record ||
      record.status !== 'queued' ||
      Date.parse(record.nextAttemptAt) > now.getTime()
    ) {
      return null;
    }
    record.status = 'processing';
    record.updatedAt = iso(now);
    return clone(record);
  }

  async markSuccessorCompleted(successorTurnId: string, now = new Date()): Promise<void> {
    const record = this.successors.get(successorTurnId);
    if (!record) return;
    record.status = 'completed';
    record.updatedAt = iso(now);
  }

  async rearmSuccessor(successorTurnId: string, nextAttemptAt: Date): Promise<DurableSuccessorBatchV2 | null> {
    const record = this.successors.get(successorTurnId);
    if (!record || record.reprocessCount >= SUCCESSOR_MAX_REPROCESSES_V2) return null;
    record.reprocessCount += 1;
    record.status = 'queued';
    record.nextAttemptAt = iso(nextAttemptAt);
    record.updatedAt = iso(new Date());
    return clone(record);
  }

  async verifyReceiptReconciliation(
    turnIds: readonly string[] = []
  ): Promise<ReceiptReconciliationV2> {
    const selected = new Set(turnIds);
    const plans = [...this.plans.values()].filter(
      (plan) => selected.size === 0 || selected.has(plan.turnId)
    );
    const deliveries = [...this.deliveries.values()].filter(
      (delivery) => selected.size === 0 || selected.has(delivery.turnId)
    );
    const planById = new Map(plans.map((plan) => [plan.planReceiptId, plan]));
    const deliveryCounts = new Map<string, number>();
    let orphanDeliveryCount = 0;
    let mismatchedTurnCount = 0;
    for (const delivery of deliveries) {
      deliveryCounts.set(
        delivery.planReceiptId,
        (deliveryCounts.get(delivery.planReceiptId) ?? 0) + 1
      );
      const plan = planById.get(delivery.planReceiptId);
      if (!plan) orphanDeliveryCount += 1;
      else if (plan.turnId !== delivery.turnId) mismatchedTurnCount += 1;
    }
    const planWithoutDeliveryCount = plans.filter(
      (plan) => (deliveryCounts.get(plan.planReceiptId) ?? 0) === 0
    ).length;
    const duplicateDeliveryForPlanCount = [...deliveryCounts.values()].filter(
      (count) => count > 1
    ).length;
    return {
      ok:
        plans.length === deliveries.length &&
        planWithoutDeliveryCount === 0 &&
        orphanDeliveryCount === 0 &&
        mismatchedTurnCount === 0 &&
        duplicateDeliveryForPlanCount === 0,
      planCount: plans.length,
      deliveryCount: deliveries.length,
      planWithoutDeliveryCount,
      orphanDeliveryCount,
      mismatchedTurnCount,
      duplicateDeliveryForPlanCount,
    };
  }

  async sweep(now = new Date()): Promise<{
    unknownMarked: number;
    reconciled: number;
    successorsReady: number;
  }> {
    let unknownMarked = 0;
    let reconciled = 0;
    for (const entry of this.outbox.values()) {
      if (
        entry.state === 'transport_started' &&
        entry.transportStartedAt &&
        now.getTime() - Date.parse(entry.transportStartedAt) >= OUTBOX_TRANSPORT_STALE_MS_V2
      ) {
        entry.state = 'transport_unknown';
        entry.updatedAt = iso(now);
        unknownMarked += 1;
      } else if (entry.state === 'accepted_uncommitted') {
        try {
          await this.reconcileAcceptedCommit(entry.deliveryAttemptId, now);
          reconciled += 1;
        } catch {
          // Fail-closed: permanece accepted_uncommitted; nunca há re-POST.
        }
      }
    }
    const successorsReady = (await this.listReadySuccessors(100, now)).length;
    return { unknownMarked, reconciled, successorsReady };
  }
}

export async function ensureConversationalV2Tables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_pending_frames (
      conversation_key text NOT NULL,
      flow_id text NOT NULL,
      question_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('OPEN','RESOLVED','INVALIDATED','EXPIRED','SUPERSEDED')),
      asked_at timestamptz NOT NULL,
      pending_kind text NOT NULL,
      options_json jsonb NOT NULL,
      version bigint NOT NULL,
      flow_state_json jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_key, flow_id, question_id)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ana_v2_pending_frames_one_open_uq
    ON ana_v2_pending_frames (conversation_key, flow_id)
    WHERE state = 'OPEN'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_pending_frames_active_idx
    ON ana_v2_pending_frames (conversation_key, updated_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_outbound_outbox (
      delivery_attempt_id text PRIMARY KEY,
      conversation_key text NOT NULL,
      turn_id text NOT NULL,
      plan_receipt_id text NOT NULL,
      state text NOT NULL CHECK (state IN (
        'prepared','transport_started','accepted_by_provider',
        'transport_unknown','transport_failed','accepted_uncommitted'
      )),
      payload text NOT NULL,
      transition_json jsonb NOT NULL,
      provider_message_id_hash text,
      transport_started_at timestamptz,
      commit_payload_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // IA-20 é aditivo: instalações que já têm a tabela recebem apenas a
  // projeção de status; o receipt terminal existente permanece inalterado.
  await pool.query(`
    ALTER TABLE ana_v2_outbound_outbox
      ADD COLUMN IF NOT EXISTS provider_status text,
      ADD COLUMN IF NOT EXISTS provider_status_at timestamptz,
      ADD COLUMN IF NOT EXISTS provider_failure_code text,
      ADD COLUMN IF NOT EXISTS provider_status_version bigint NOT NULL DEFAULT 0
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_outbound_outbox_provider_hash_idx
      ON ana_v2_outbound_outbox (provider_message_id_hash)
     WHERE provider_message_id_hash IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_outbound_outbox_guard_idx
    ON ana_v2_outbound_outbox (conversation_key, updated_at DESC)
    WHERE state IN ('transport_started','accepted_uncommitted')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_outbound_outbox_sweep_idx
    ON ana_v2_outbound_outbox (state, updated_at)
    WHERE state IN ('transport_started','accepted_uncommitted')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_outbound_outbox_accepted_delivery_idx
    ON ana_v2_outbound_outbox (conversation_key, updated_at DESC)
    WHERE state = 'accepted_by_provider'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_turn_receipts (
      receipt_id text PRIMARY KEY,
      turn_id text NOT NULL,
      receipt_kind text NOT NULL CHECK (receipt_kind IN ('plan','delivery')),
      receipt_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_successor_batches (
      successor_turn_id text PRIMARY KEY,
      source_turn_id text NOT NULL,
      conversation_key text NOT NULL,
      phone_number_id text NOT NULL,
      customer_phone text NOT NULL,
      input_sequence bigint NOT NULL,
      inbound_message_ids_json jsonb NOT NULL,
      requires_authoritative_read boolean NOT NULL DEFAULT false,
      reprocess_count integer NOT NULL DEFAULT 0,
      status text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (conversation_key, source_turn_id, input_sequence)
    )
  `);
  await pool.query(`
    ALTER TABLE ana_v2_successor_batches
    ADD COLUMN IF NOT EXISTS requires_authoritative_read boolean NOT NULL DEFAULT false
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_successor_batches_ready_idx
    ON ana_v2_successor_batches (next_attempt_at, created_at)
    WHERE status = 'queued'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_flow_state_invalidations (
      conversation_key text PRIMARY KEY,
      invalidated_at timestamptz NOT NULL,
      reason text NOT NULL CHECK (reason IN (
        'HUMAN_OWNERSHIP',
        'SILENT_ESCALATION',
        'EXPLICIT_CONVERSATION_RESET'
      ))
    )
  `);
  await ensureProviderStatusV2Tables();
}

interface RawPendingRowV2 {
  conversation_key: string;
  flow_id: string;
  question_id: string;
  state: PendingFrameStateV2;
  asked_at: Date | string;
  pending_kind: PendingFrameSnapshotV2['kind'];
  options_json: PendingFrameSnapshotV2['options'];
  version: string | number;
  flow_state_json: FlowStateV2;
  updated_at: Date | string;
}

interface RawOutboxRowV2 {
  delivery_attempt_id: string;
  conversation_key: string;
  turn_id: string;
  plan_receipt_id: string;
  state: OutboundOutboxRecordV2['state'];
  payload: string;
  transition_json: MaterializedPendingTransitionV2;
  provider_message_id_hash: string | null;
  provider_status: ProviderDeliveryStatusV2 | null;
  provider_status_at: Date | string | null;
  provider_failure_code: string | null;
  provider_status_version: string | number;
  transport_started_at: Date | string | null;
  commit_payload_json: AcceptedCommitPayloadV2 | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawSuccessorRowV2 {
  successor_turn_id: string;
  source_turn_id: string;
  conversation_key: string;
  phone_number_id: string;
  customer_phone: string;
  input_sequence: string | number;
  inbound_message_ids_json: string[];
  requires_authoritative_read: boolean;
  reprocess_count: number;
  status: DurableSuccessorBatchV2['status'];
  next_attempt_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface RawFlowStateInvalidationRowV2 {
  conversation_key: string;
  invalidated_at: Date | string;
  reason: FlowStateInvalidationReasonV2;
}

function invalidationFromRow(
  row: RawFlowStateInvalidationRowV2
): FlowStateInvalidationV2 {
  return {
    conversationKey: row.conversation_key,
    invalidatedAt: dateIso(row.invalidated_at),
    reason: row.reason,
  };
}

const UPSERT_FLOW_STATE_INVALIDATION_SQL = `
INSERT INTO ana_v2_flow_state_invalidations (
  conversation_key, invalidated_at, reason
) VALUES ($1, $2, $3)
ON CONFLICT (conversation_key) DO UPDATE SET
  invalidated_at = GREATEST(
    ana_v2_flow_state_invalidations.invalidated_at,
    EXCLUDED.invalidated_at
  ),
  reason = CASE
    WHEN EXCLUDED.invalidated_at > ana_v2_flow_state_invalidations.invalidated_at
    THEN EXCLUDED.reason
    ELSE ana_v2_flow_state_invalidations.reason
  END
`;

function pendingFromRow(row: RawPendingRowV2): PendingFrameRecordV2 {
  return {
    conversationKey: row.conversation_key,
    state: row.state,
    snapshot: {
      questionId: row.question_id,
      askedAt: dateIso(row.asked_at),
      kind: row.pending_kind,
      flowId: row.flow_id,
      version: Number(row.version),
      options: row.options_json,
    },
    flowState: row.flow_state_json,
    updatedAt: dateIso(row.updated_at),
  };
}

function outboxFromRow(row: RawOutboxRowV2): OutboundOutboxRecordV2 {
  return {
    deliveryAttemptId: row.delivery_attempt_id,
    conversationKey: row.conversation_key,
    turnId: row.turn_id,
    planReceiptId: row.plan_receipt_id,
    state: row.state,
    payload: row.payload,
    transition: row.transition_json,
    providerMessageIdHash: row.provider_message_id_hash,
    providerStatus: row.provider_status ?? null,
    providerStatusAt: row.provider_status_at ? dateIso(row.provider_status_at) : null,
    providerFailureCode: row.provider_failure_code ?? null,
    providerStatusVersion: Number(row.provider_status_version ?? 0),
    transportStartedAt: row.transport_started_at ? dateIso(row.transport_started_at) : null,
    commitPayload: row.commit_payload_json,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function successorFromRow(row: RawSuccessorRowV2): DurableSuccessorBatchV2 {
  return {
    successorTurnId: row.successor_turn_id,
    sourceTurnId: row.source_turn_id,
    conversationKey: row.conversation_key,
    phoneNumberId: row.phone_number_id,
    customerPhone: row.customer_phone,
    inputSequence: Number(row.input_sequence),
    inboundMessageIds: row.inbound_message_ids_json,
    requiresAuthoritativeRead: row.requires_authoritative_read,
    reprocessCount: row.reprocess_count,
    status: row.status,
    nextAttemptAt: dateIso(row.next_attempt_at),
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

async function selectOpenPending(
  client: Pick<PoolClient, 'query'>,
  conversationKey: string,
  forUpdate = false
): Promise<PendingFrameRecordV2 | null> {
  const result = await client.query<RawPendingRowV2>(
    `SELECT conversation_key, flow_id, question_id, state, asked_at,
            pending_kind, options_json, version::text, flow_state_json, updated_at
     FROM ana_v2_pending_frames
     WHERE conversation_key = $1 AND state = 'OPEN'
     ORDER BY updated_at DESC
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [conversationKey]
  );
  return result.rows[0] ? pendingFromRow(result.rows[0]) : null;
}

async function applyPgTransition(
  client: PoolClient,
  conversationKey: string,
  transition: MaterializedPendingTransitionV2,
  now: Date
): Promise<PendingCommitResultV2> {
  const open = await selectOpenPending(client, conversationKey, true);
  if (transition.kind === 'preserve') {
    if (
      transition.nextFlowState &&
      (transition.expectedQuestionId !== (open?.snapshot.questionId ?? null) ||
        transition.expectedVersion !== (open?.snapshot.version ?? null))
    ) {
      return {
        outcome: 'cas_conflict',
        observedVersion: open?.snapshot.version ?? null,
      };
    }
    if (open && transition.nextFlowState) {
      await client.query(
        `UPDATE ana_v2_pending_frames
         SET flow_state_json = $4::jsonb, updated_at = $5
         WHERE conversation_key = $1 AND flow_id = $2 AND question_id = $3
           AND state = 'OPEN' AND version = $6`,
        [
          conversationKey,
          open.snapshot.flowId,
          open.snapshot.questionId,
          JSON.stringify(transition.nextFlowState),
          now,
          open.snapshot.version,
        ]
      );
    }
    return {
      outcome: open ? 'preserved' : 'not_applicable',
      observedVersion: open?.snapshot.version ?? null,
    };
  }
  if (transition.kind === 'resolve' || transition.kind === 'invalidate') {
    if (
      !open ||
      open.snapshot.questionId !== transition.questionId ||
      open.snapshot.version !== transition.expectedVersion
    ) {
      return { outcome: 'cas_conflict', observedVersion: open?.snapshot.version ?? null };
    }
    await client.query(
      `UPDATE ana_v2_pending_frames
       SET state = $4, version = version + 1, flow_state_json = $5::jsonb,
           updated_at = $6
       WHERE conversation_key = $1 AND flow_id = $2 AND question_id = $3
         AND state = 'OPEN' AND version = $7`,
      [
        conversationKey,
        open.snapshot.flowId,
        open.snapshot.questionId,
        transition.kind === 'resolve' ? 'RESOLVED' : 'INVALIDATED',
        JSON.stringify(transition.nextFlowState),
        now,
        transition.expectedVersion,
      ]
    );
    return {
      outcome: transition.kind === 'resolve' ? 'resolved' : 'invalidated',
      observedVersion: transition.expectedVersion,
    };
  }
  if (
    (transition.expectedQuestionId === null && open) ||
    (transition.expectedQuestionId !== null &&
      (!open ||
        open.snapshot.questionId !== transition.expectedQuestionId ||
        open.snapshot.version !== transition.expectedVersion))
  ) {
    return { outcome: 'cas_conflict', observedVersion: open?.snapshot.version ?? null };
  }
  if (open) {
    await client.query(
      `UPDATE ana_v2_pending_frames
       SET state = 'SUPERSEDED', version = version + 1, updated_at = $4
       WHERE conversation_key = $1 AND flow_id = $2 AND question_id = $3
         AND state = 'OPEN' AND version = $5`,
      [conversationKey, open.snapshot.flowId, open.snapshot.questionId, now, open.snapshot.version]
    );
  }
  await client.query(
    `INSERT INTO ana_v2_pending_frames (
       conversation_key, flow_id, question_id, state, asked_at,
       pending_kind, options_json, version, flow_state_json, updated_at
     ) VALUES ($1, $2, $3, 'OPEN', $4, $5, $6::jsonb, $7, $8::jsonb, $9)`,
    [
      conversationKey,
      transition.frame.flowId,
      transition.frame.questionId,
      transition.frame.askedAt,
      transition.frame.kind,
      JSON.stringify(transition.frame.options),
      transition.frame.version,
      JSON.stringify(transition.nextFlowState),
      now,
    ]
  );
  return { outcome: 'opened', observedVersion: transition.expectedVersion };
}

async function commitAcceptedPg(input: {
  deliveryAttemptId: string;
  providerMessageIdHash: string;
  commitPayload: AcceptedCommitPayloadV2;
  now: Date;
}): Promise<PendingCommitResultV2> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<RawOutboxRowV2>(
      `SELECT * FROM ana_v2_outbound_outbox
       WHERE delivery_attempt_id = $1 FOR UPDATE`,
      [input.deliveryAttemptId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error('outbox v2 ausente');
    if (row.state === 'accepted_by_provider') {
      await client.query('COMMIT');
      return {
        outcome: input.commitPayload.deliveryReceipt.pendingCommitOutcome,
        observedVersion: input.commitPayload.deliveryReceipt.observedPendingVersion,
      } as PendingCommitResultV2;
    }
    if (!['transport_started', 'accepted_uncommitted'].includes(row.state)) {
      throw new Error('outbox v2 não aceita commit local neste estado');
    }
    const pending = await applyPgTransition(
      client,
      row.conversation_key,
      input.commitPayload.transition,
      input.now
    );
    await client.query(
      `INSERT INTO ana_conversation_history ("conversationKey", "role", "content")
       VALUES ($1, 'assistant', $2)`,
      [row.conversation_key, input.commitPayload.assistantText]
    );
    await client.query(
      `DELETE FROM ana_conversation_history
       WHERE "conversationKey" = $1
         AND (
           message_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM inbound_event_outbox pending
             WHERE pending.message_id = ana_conversation_history.message_id
               AND pending.delivered_at IS NULL
           )
         )
         AND "id" NOT IN (
           SELECT "id" FROM ana_conversation_history
           WHERE "conversationKey" = $1
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT 30
         )`,
      [row.conversation_key]
    );
    const receipt: TurnDeliveryReceiptV2 = {
      ...input.commitPayload.deliveryReceipt,
      outboxState: 'accepted_by_provider',
      conversationCommitOutcome: 'committed',
      pendingCommitOutcome: pending.outcome,
      observedPendingVersion: pending.observedVersion,
    };
    const committedPayload: AcceptedCommitPayloadV2 = {
      ...input.commitPayload,
      deliveryReceipt: receipt,
    };
    await client.query(
      `UPDATE ana_v2_outbound_outbox
       SET state = 'accepted_by_provider', provider_message_id_hash = $2,
           commit_payload_json = $3::jsonb, updated_at = $4
       WHERE delivery_attempt_id = $1`,
      [
        input.deliveryAttemptId,
        input.providerMessageIdHash,
        JSON.stringify(committedPayload),
        new Date(input.now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2),
      ]
    );
    await client.query(
      `INSERT INTO ana_v2_turn_receipts (
         receipt_id, turn_id, receipt_kind, receipt_json
       ) VALUES ($1, $2, 'delivery', $3::jsonb)
       ON CONFLICT (receipt_id) DO UPDATE SET receipt_json = EXCLUDED.receipt_json`,
      [receipt.deliveryReceiptId, receipt.turnId, JSON.stringify(receipt)]
    );
    await client.query('COMMIT');
    return pending;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original.
    }
    throw error;
  } finally {
    client.release();
  }
}

export const pgConversationalV2StateStore: ConversationalV2StateStore = {
  async savePlanReceipt(receipt) {
    await pool.query(
      `INSERT INTO ana_v2_turn_receipts (receipt_id, turn_id, receipt_kind, receipt_json)
       VALUES ($1, $2, 'plan', $3::jsonb)
       ON CONFLICT (receipt_id) DO UPDATE SET receipt_json = EXCLUDED.receipt_json`,
      [receipt.planReceiptId, receipt.turnId, JSON.stringify(receipt)]
    );
  },
  async saveTerminalDeliveryReceipt(receipt) {
    await pool.query(
      `INSERT INTO ana_v2_turn_receipts (receipt_id, turn_id, receipt_kind, receipt_json)
       VALUES ($1, $2, 'delivery', $3::jsonb)
       ON CONFLICT (receipt_id) DO UPDATE SET receipt_json = EXCLUDED.receipt_json`,
      [receipt.deliveryReceiptId, receipt.turnId, JSON.stringify(receipt)]
    );
  },
  async loadLatestState(conversationKey, now = new Date()) {
    await pool.query(
      `UPDATE ana_v2_pending_frames
       SET state = 'EXPIRED', version = version + 1, updated_at = $2
       WHERE conversation_key = $1 AND state = 'OPEN'
         AND asked_at <= $2::timestamptz - interval '24 hours'`,
      [conversationKey, now]
    );
    const open = await selectOpenPending(pool as unknown as PoolClient, conversationKey);
    const latest = pool.query<RawPendingRowV2>(
      `SELECT conversation_key, flow_id, question_id, state, asked_at,
              pending_kind, options_json, version::text, flow_state_json, updated_at
       FROM ana_v2_pending_frames
       WHERE conversation_key = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conversationKey]
    );
    const accepted = pool.query<RawOutboxRowV2>(
      `SELECT *
       FROM ana_v2_outbound_outbox
       WHERE conversation_key = $1
         AND state = 'accepted_by_provider'
         AND commit_payload_json->'deliveryReceipt'->>'transportOutcome' =
             'accepted_by_provider'
       ORDER BY COALESCE(
                  NULLIF(commit_payload_json->'deliveryReceipt'->>'terminalAt', '')::timestamptz,
                  updated_at
                ) DESC,
                updated_at DESC
       LIMIT 1`,
      [conversationKey]
    );
    const opening = open
      ? pool.query<RawOutboxRowV2>(
          `SELECT *
           FROM ana_v2_outbound_outbox
           WHERE conversation_key = $1
             AND state = 'accepted_by_provider'
             AND commit_payload_json->'deliveryReceipt'->>'transportOutcome' =
                 'accepted_by_provider'
             AND commit_payload_json->'deliveryReceipt'->>'conversationCommitOutcome' =
                 'committed'
             AND commit_payload_json->'deliveryReceipt'->>'pendingCommitOutcome' =
                 'opened'
             AND transition_json->>'kind' = 'open'
             AND transition_json->'frame'->>'questionId' = $2
             AND transition_json->'frame'->>'flowId' = $3
             AND transition_json->'frame'->>'version' = $4
           ORDER BY COALESCE(
                      NULLIF(commit_payload_json->'deliveryReceipt'->>'terminalAt', '')::timestamptz,
                      updated_at
                    ) ASC,
                    updated_at ASC
           LIMIT 1`,
          [
            conversationKey,
            open.snapshot.questionId,
            open.snapshot.flowId,
            String(open.snapshot.version),
          ]
        )
      : Promise.resolve({ rows: [] as RawOutboxRowV2[] });
    const invalidationQuery = pool.query<RawFlowStateInvalidationRowV2>(
      `SELECT conversation_key, invalidated_at, reason
       FROM ana_v2_flow_state_invalidations
       WHERE conversation_key = $1`,
      [conversationKey]
    );
    const [latestResult, acceptedResult, openingResult, invalidationResult] =
      await Promise.all([latest, accepted, opening, invalidationQuery]);
    const lastAccepted = acceptedResult.rows[0]
      ? outboxFromRow(acceptedResult.rows[0])
      : null;
    const openingAccepted = openingResult.rows[0]
      ? outboxFromRow(openingResult.rows[0])
      : null;
    const latestPending = latestResult.rows[0]
      ? pendingFromRow(latestResult.rows[0])
      : null;
    const invalidation = invalidationResult.rows[0]
      ? invalidationFromRow(invalidationResult.rows[0])
      : null;
    const projected = projectLatestFlowStateV2({
      openPending: open,
      latestPending,
      lastAcceptedOutbox: lastAccepted,
      invalidation,
      now,
    });
    return {
      pending: projected.pending,
      flowState: projected.flowState,
      lastAcceptedDelivery: lastAccepted
        ? acceptedDeliveryEvidenceFromOutbox(lastAccepted)
        : null,
      openingAcceptedDelivery: projected.pending && openingAccepted
        ? acceptedDeliveryEvidenceFromOutbox(openingAccepted)
        : null,
    };
  },
  async getInputSequence(conversationKey) {
    const result = await pool.query<{ last_sequence: string }>(
      `SELECT last_sequence::text FROM ana_conversation_seq WHERE conversation_key = $1`,
      [conversationKey]
    );
    return Number(result.rows[0]?.last_sequence ?? 0);
  },
  async prepareOutbound(input) {
    const result = await pool.query<RawOutboxRowV2>(
      `INSERT INTO ana_v2_outbound_outbox (
         delivery_attempt_id, conversation_key, turn_id, plan_receipt_id,
         state, payload, transition_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'prepared',$5,$6::jsonb,$7,$7)
       ON CONFLICT (delivery_attempt_id) DO UPDATE SET
         delivery_attempt_id = ana_v2_outbound_outbox.delivery_attempt_id
       RETURNING *`,
      [
        input.deliveryAttemptId,
        input.conversationKey,
        input.turnId,
        input.planReceiptId,
        input.payload,
        JSON.stringify(input.transition),
        input.now,
      ]
    );
    return outboxFromRow(result.rows[0]!);
  },
  async markTransportStarted(deliveryAttemptId, now) {
    const result = await pool.query(
      `UPDATE ana_v2_outbound_outbox
       SET state = 'transport_started', transport_started_at = $2, updated_at = $2
       WHERE delivery_attempt_id = $1 AND state = 'prepared'`,
      [deliveryAttemptId, now]
    );
    if (result.rowCount !== 1) throw new Error('outbox v2 não está em prepared');
  },
  async markTransportTerminal(input) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ana_v2_outbound_outbox SET state = $2, updated_at = $3
         WHERE delivery_attempt_id = $1 AND state = 'transport_started'`,
        [input.deliveryAttemptId, input.state, input.now]
      );
      await client.query(
        `INSERT INTO ana_v2_turn_receipts (receipt_id, turn_id, receipt_kind, receipt_json)
         VALUES ($1,$2,'delivery',$3::jsonb)
         ON CONFLICT (receipt_id) DO UPDATE SET receipt_json = EXCLUDED.receipt_json`,
        [input.receipt.deliveryReceiptId, input.receipt.turnId, JSON.stringify(input.receipt)]
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve */ }
      throw error;
    } finally {
      client.release();
    }
  },
  commitAccepted: commitAcceptedPg,
  async markAcceptedUncommitted(input) {
    const receipt = input.commitPayload.deliveryReceipt;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ana_v2_outbound_outbox
         SET state = 'accepted_uncommitted', provider_message_id_hash = $2,
             commit_payload_json = $3::jsonb, updated_at = $4
         WHERE delivery_attempt_id = $1
           AND state IN ('transport_started','accepted_uncommitted')`,
        [
          input.deliveryAttemptId,
          input.providerMessageIdHash,
          JSON.stringify(input.commitPayload),
          input.now,
        ]
      );
      await client.query(
        `INSERT INTO ana_v2_turn_receipts (receipt_id, turn_id, receipt_kind, receipt_json)
         VALUES ($1,$2,'delivery',$3::jsonb)
         ON CONFLICT (receipt_id) DO UPDATE SET receipt_json = EXCLUDED.receipt_json`,
        [receipt.deliveryReceiptId, receipt.turnId, JSON.stringify(receipt)]
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve */ }
      throw error;
    } finally {
      client.release();
    }
  },
  async reconcileAcceptedCommit(deliveryAttemptId, now = new Date()) {
    const result = await pool.query<RawOutboxRowV2>(
      `SELECT * FROM ana_v2_outbound_outbox
       WHERE delivery_attempt_id = $1 AND state = 'accepted_uncommitted'`,
      [deliveryAttemptId]
    );
    const row = result.rows[0];
    if (!row?.commit_payload_json || !row.provider_message_id_hash) {
      return { outcome: 'not_applicable', observedVersion: null };
    }
    return commitAcceptedPg({
      deliveryAttemptId,
      providerMessageIdHash: row.provider_message_id_hash,
      commitPayload: row.commit_payload_json,
      now,
    });
  },
  async inspectInboundGuard(conversationKey, now = new Date()) {
    const result = await pool.query<RawOutboxRowV2>(
      `SELECT * FROM ana_v2_outbound_outbox
       WHERE conversation_key = $1
         AND state IN ('transport_started','accepted_uncommitted')
       ORDER BY updated_at DESC LIMIT 1`,
      [conversationKey]
    );
    const row = result.rows[0];
    if (row) {
      if (row.state === 'accepted_uncommitted' && row.commit_payload_json) {
        const pending = reconstructedPending(
          conversationKey,
          row.commit_payload_json.transition,
          now
        );
        if (pending) {
          return {
            kind: 'reconstructed',
            pending,
            deliveryAttemptId: row.delivery_attempt_id,
          };
        }
      }
      return {
        kind: 'suspended',
        reason: row.state as 'transport_started' | 'accepted_uncommitted',
        deliveryAttemptId: row.delivery_attempt_id,
      };
    }
    const state = await pgConversationalV2StateStore.loadLatestState(conversationKey, now);
    return { kind: 'clear', pending: state.pending };
  },
  async invalidateOpenPendingByHuman(conversationKey, now = new Date()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE ana_v2_pending_frames
         SET state = 'INVALIDATED', version = version + 1, updated_at = $2
         WHERE conversation_key = $1 AND state = 'OPEN'`,
        [conversationKey, now]
      );
      await client.query(UPSERT_FLOW_STATE_INVALIDATION_SQL, [
        conversationKey,
        now,
        'HUMAN_OWNERSHIP',
      ]);
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve */ }
      throw error;
    } finally {
      client.release();
    }
  },
  async recordFlowStateInvalidation(input) {
    await pool.query(UPSERT_FLOW_STATE_INVALIDATION_SQL, [
      input.conversationKey,
      input.now ?? new Date(),
      input.reason,
    ]);
  },
  async enqueueSuccessor(input) {
    const result = await pool.query<RawSuccessorRowV2>(
      `INSERT INTO ana_v2_successor_batches (
         successor_turn_id, source_turn_id, conversation_key, phone_number_id,
         customer_phone, input_sequence, inbound_message_ids_json,
         requires_authoritative_read, reprocess_count, status,
         next_attempt_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'queued',$10,$11,$11)
       ON CONFLICT (conversation_key, source_turn_id, input_sequence) DO UPDATE SET
         inbound_message_ids_json = EXCLUDED.inbound_message_ids_json,
         requires_authoritative_read =
           ana_v2_successor_batches.requires_authoritative_read
           OR EXCLUDED.requires_authoritative_read,
         next_attempt_at = EXCLUDED.next_attempt_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.successorTurnId,
        input.sourceTurnId,
        input.conversationKey,
        input.phoneNumberId,
        input.customerPhone,
        input.inputSequence,
        JSON.stringify(input.inboundMessageIds),
        input.requiresAuthoritativeRead,
        input.reprocessCount,
        new Date(input.now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2),
        input.now,
      ]
    );
    return successorFromRow(result.rows[0]!);
  },
  async listReadySuccessors(limit, now = new Date()) {
    const result = await pool.query<RawSuccessorRowV2>(
      `SELECT * FROM ana_v2_successor_batches
       WHERE status = 'queued' AND next_attempt_at <= $2
       ORDER BY next_attempt_at ASC, created_at ASC LIMIT $1`,
      [limit, now]
    );
    return result.rows.map(successorFromRow);
  },
  async claimSuccessor(successorTurnId, now = new Date()) {
    await pool.query(
      `UPDATE ana_v2_successor_batches successor
       SET status = 'completed', updated_at = $2
       WHERE successor_turn_id = $1
         AND status IN ('queued','processing')
         AND EXISTS (
           SELECT 1 FROM ana_v2_turn_receipts receipt
           WHERE receipt.turn_id = successor.successor_turn_id
             AND receipt.receipt_kind = 'delivery'
         )`,
      [successorTurnId, now]
    );
    const result = await pool.query<RawSuccessorRowV2>(
      `UPDATE ana_v2_successor_batches
       SET status = 'processing', updated_at = $2
       WHERE successor_turn_id = $1 AND status = 'queued'
         AND next_attempt_at <= $2
       RETURNING *`,
      [successorTurnId, now]
    );
    return result.rows[0] ? successorFromRow(result.rows[0]) : null;
  },
  async markSuccessorCompleted(successorTurnId, now = new Date()) {
    await pool.query(
      `UPDATE ana_v2_successor_batches
       SET status = 'completed', updated_at = $2 WHERE successor_turn_id = $1`,
      [successorTurnId, now]
    );
  },
  async rearmSuccessor(successorTurnId, nextAttemptAt) {
    const result = await pool.query<RawSuccessorRowV2>(
      `UPDATE ana_v2_successor_batches
       SET reprocess_count = reprocess_count + 1, status = 'queued',
           next_attempt_at = $2, updated_at = now()
       WHERE successor_turn_id = $1 AND reprocess_count < $3
       RETURNING *`,
      [successorTurnId, nextAttemptAt, SUCCESSOR_MAX_REPROCESSES_V2]
    );
    return result.rows[0] ? successorFromRow(result.rows[0]) : null;
  },
  async verifyReceiptReconciliation(turnIds = []) {
    const result = await pool.query<{
      plan_count: string;
      delivery_count: string;
      plan_without_delivery_count: string;
      orphan_delivery_count: string;
      mismatched_turn_count: string;
      duplicate_delivery_for_plan_count: string;
    }>(
      `WITH selected AS (
         SELECT turn_id, receipt_kind, receipt_json
         FROM ana_v2_turn_receipts
         WHERE cardinality($1::text[]) = 0 OR turn_id = ANY($1::text[])
       ),
       plans AS (
         SELECT turn_id, receipt_json->>'planReceiptId' AS plan_receipt_id
         FROM selected WHERE receipt_kind = 'plan'
       ),
       deliveries AS (
         SELECT turn_id, receipt_json->>'planReceiptId' AS plan_receipt_id
         FROM selected WHERE receipt_kind = 'delivery'
       ),
       delivery_counts AS (
         SELECT plan_receipt_id, COUNT(*)::integer AS count
         FROM deliveries GROUP BY plan_receipt_id
       )
       SELECT
         (SELECT COUNT(*) FROM plans)::text AS plan_count,
         (SELECT COUNT(*) FROM deliveries)::text AS delivery_count,
         (SELECT COUNT(*) FROM plans p
          LEFT JOIN delivery_counts d USING (plan_receipt_id)
          WHERE COALESCE(d.count, 0) = 0)::text AS plan_without_delivery_count,
         (SELECT COUNT(*) FROM deliveries d
          LEFT JOIN plans p USING (plan_receipt_id)
          WHERE p.plan_receipt_id IS NULL)::text AS orphan_delivery_count,
         (SELECT COUNT(*) FROM deliveries d
          JOIN plans p USING (plan_receipt_id)
          WHERE d.turn_id <> p.turn_id)::text AS mismatched_turn_count,
         (SELECT COUNT(*) FROM delivery_counts WHERE count > 1)::text
           AS duplicate_delivery_for_plan_count`,
      [[...new Set(turnIds)]]
    );
    const row = result.rows[0]!;
    const reconciliation: ReceiptReconciliationV2 = {
      planCount: Number(row.plan_count),
      deliveryCount: Number(row.delivery_count),
      planWithoutDeliveryCount: Number(row.plan_without_delivery_count),
      orphanDeliveryCount: Number(row.orphan_delivery_count),
      mismatchedTurnCount: Number(row.mismatched_turn_count),
      duplicateDeliveryForPlanCount: Number(
        row.duplicate_delivery_for_plan_count
      ),
      ok: false,
    };
    reconciliation.ok =
      reconciliation.planCount === reconciliation.deliveryCount &&
      reconciliation.planWithoutDeliveryCount === 0 &&
      reconciliation.orphanDeliveryCount === 0 &&
      reconciliation.mismatchedTurnCount === 0 &&
      reconciliation.duplicateDeliveryForPlanCount === 0;
    return reconciliation;
  },
  async sweep(now = new Date()) {
    const unknown = await pool.query(
      `UPDATE ana_v2_outbound_outbox
       SET state = 'transport_unknown', updated_at = $1
       WHERE state = 'transport_started'
         AND transport_started_at <= $1::timestamptz - interval '2 minutes'`,
      [now]
    );
    const accepted = await pool.query<{ delivery_attempt_id: string }>(
      `SELECT delivery_attempt_id FROM ana_v2_outbound_outbox
       WHERE state = 'accepted_uncommitted' ORDER BY updated_at ASC LIMIT 50`,
      []
    );
    let reconciled = 0;
    for (const row of accepted.rows) {
      try {
        await pgConversationalV2StateStore.reconcileAcceptedCommit(
          row.delivery_attempt_id,
          now
        );
        reconciled += 1;
      } catch {
        // Commit local será tentado no próximo sweep; transporte nunca repete.
      }
    }
    const successorsReady = (await pgConversationalV2StateStore.listReadySuccessors(100, now)).length;
    return {
      unknownMarked: unknown.rowCount ?? 0,
      reconciled,
      successorsReady,
    };
  },
};

let sweepTimer: NodeJS.Timeout | null = null;
let sweepActive = false;
let sweepGeneration = 0;

export function startConversationalV2Sweep(
  store: ConversationalV2StateStore = pgConversationalV2StateStore,
  requestedIntervalMs = CONVERSATIONAL_V2_SWEEP_INTERVAL_MS
): void {
  if (sweepActive) return;
  sweepActive = true;
  const generation = ++sweepGeneration;
  let nextDelayMs = nextConversationalV2SweepDelayMs(
    requestedIntervalMs,
    true,
    requestedIntervalMs
  );
  const run = async (): Promise<void> => {
    let succeeded = false;
    try {
      await store.sweep();
      succeeded = true;
    } catch {
      // Recuperação fail-closed: o próximo ciclo recua exponencialmente.
    }
    if (!sweepActive || generation !== sweepGeneration) return;
    nextDelayMs = nextConversationalV2SweepDelayMs(
      nextDelayMs,
      succeeded,
      requestedIntervalMs
    );
    sweepTimer = setTimeout(() => void run(), nextDelayMs);
    sweepTimer.unref?.();
  };
  // Uma execução imediata no boot; recorrência só depois de ela terminar.
  void run();
}

export function stopConversationalV2SweepForTest(): void {
  sweepActive = false;
  sweepGeneration += 1;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
}
