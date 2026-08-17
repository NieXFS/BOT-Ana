import { normalizeCustomerReplyStyle } from '../customerReplyGuard';
import type { PendingFrameSnapshotV2 } from './contracts';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';

export type PendingDeliveryMatchDeclineV2 =
  | 'delivery_missing'
  | 'delivery_not_current_pending'
  | 'delivery_expired'
  | 'delivery_payload_mismatch';

function pendingFreshV2(pending: PendingFrameSnapshotV2, now: Date): boolean {
  const askedAt = Date.parse(pending.askedAt);
  return (
    Number.isFinite(askedAt) &&
    now.getTime() - askedAt <= PENDING_FAST_PATH_MAX_AGE_MS
  );
}

/**
 * Prova de entrega committed da pendência atual. Extraída do cancelamento
 * (fonte correta): transição open idêntica ao PendingFrame, versão/flow/
 * opções/timestamps frescos e payload igual à copy canônica materializada.
 */
export function diagnoseDeliveryMatchPendingV2(input: {
  pending: PendingFrameSnapshotV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  now: Date;
  expectedCopy: string;
}):
  | { ok: true }
  | { ok: false; reason: PendingDeliveryMatchDeclineV2 } {
  const delivery = input.lastAcceptedDelivery;
  const transition = delivery?.transition;
  if (!delivery || !transition) {
    return { ok: false, reason: 'delivery_missing' };
  }
  if (
    delivery.conversationCommitOutcome !== 'committed' ||
    delivery.pendingCommitOutcome !== 'opened' ||
    transition.kind !== 'open' ||
    transition.frame.questionId !== input.pending.questionId ||
    transition.frame.version !== input.pending.version ||
    transition.frame.flowId !== input.pending.flowId ||
    transition.frame.askedAt !== input.pending.askedAt ||
    transition.frame.kind !== input.pending.kind ||
    transition.frame.options.length !== input.pending.options.length ||
    transition.frame.options.some((option, index) => {
      const current = input.pending.options[index];
      return (
        !current ||
        option.position !== current.position ||
        option.entityId !== current.entityId ||
        option.displayName !== current.displayName
      );
    })
  ) {
    return { ok: false, reason: 'delivery_not_current_pending' };
  }
  const askedAge = input.now.getTime() - Date.parse(input.pending.askedAt);
  const terminalAge = input.now.getTime() - Date.parse(delivery.terminalAt);
  if (
    !Number.isFinite(askedAge) ||
    !Number.isFinite(terminalAge) ||
    askedAge < 0 ||
    terminalAge < 0 ||
    askedAge > PENDING_FAST_PATH_MAX_AGE_MS ||
    terminalAge > PENDING_FAST_PATH_MAX_AGE_MS ||
    !pendingFreshV2(input.pending, input.now)
  ) {
    return { ok: false, reason: 'delivery_expired' };
  }
  return normalizeCustomerReplyStyle(delivery.payload) ===
    normalizeCustomerReplyStyle(input.expectedCopy)
    ? { ok: true }
    : { ok: false, reason: 'delivery_payload_mismatch' };
}

export function deliveryMatchesPendingV2(input: {
  pending: PendingFrameSnapshotV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  now: Date;
  expectedCopy: string;
}): boolean {
  return diagnoseDeliveryMatchPendingV2(input).ok;
}
