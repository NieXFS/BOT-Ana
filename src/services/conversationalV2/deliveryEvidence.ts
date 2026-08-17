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

function pendingFrameMatchesOpeningV2(
  pending: PendingFrameSnapshotV2,
  frame: PendingFrameSnapshotV2
): boolean {
  return (
    frame.questionId === pending.questionId &&
    frame.version === pending.version &&
    frame.flowId === pending.flowId &&
    frame.askedAt === pending.askedAt &&
    frame.kind === pending.kind &&
    frame.options.length === pending.options.length &&
    !frame.options.some((option, index) => {
      const current = pending.options[index];
      return (
        !current ||
        option.position !== current.position ||
        option.entityId !== current.entityId ||
        option.displayName !== current.displayName
      );
    })
  );
}

/**
 * A entrega que ABRIU a versão atual do PendingFrame: committed + open +
 * version/flowId/questionId/opções idênticos. Preserve posterior da mesma
 * copy não entra aqui — é o loop-breaker, não a prova de abertura.
 */
export function findCommittedOpeningDeliveryV2(input: {
  pending: PendingFrameSnapshotV2;
  deliveries: readonly (AcceptedDeliveryEvidenceV2 | null | undefined)[];
}): AcceptedDeliveryEvidenceV2 | null {
  for (const delivery of input.deliveries) {
    if (!delivery) continue;
    const transition = delivery.transition;
    if (
      delivery.conversationCommitOutcome === 'committed' &&
      delivery.pendingCommitOutcome === 'opened' &&
      transition.kind === 'open' &&
      pendingFrameMatchesOpeningV2(input.pending, transition.frame)
    ) {
      return delivery;
    }
  }
  return null;
}

function deliveriesForPendingMatchV2(input: {
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  openingAcceptedDelivery?: AcceptedDeliveryEvidenceV2 | null;
  acceptedDeliveries?: readonly (AcceptedDeliveryEvidenceV2 | null | undefined)[];
}): (AcceptedDeliveryEvidenceV2 | null | undefined)[] {
  return [
    ...(input.acceptedDeliveries ?? []),
    input.openingAcceptedDelivery,
    input.lastAcceptedDelivery,
  ];
}

/**
 * Prova de entrega committed da versão atual da pendência. A âncora é a
 * transição `open` que abriu esse version/flowId/questionId — lookup no
 * histórico de recibos, não a última transição. Preserve que re-apresenta a
 * mesma copy canônica não invalida. Sem nenhum open committed da versão
 * atual, a confirmação falha fechada (furo original: "sim" após fallback
 * preserve de pendência nunca-entregue).
 */
export function diagnoseDeliveryMatchPendingV2(input: {
  pending: PendingFrameSnapshotV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  openingAcceptedDelivery?: AcceptedDeliveryEvidenceV2 | null;
  acceptedDeliveries?: readonly (AcceptedDeliveryEvidenceV2 | null | undefined)[];
  now: Date;
  expectedCopy: string;
}):
  | { ok: true }
  | { ok: false; reason: PendingDeliveryMatchDeclineV2 } {
  const deliveries = deliveriesForPendingMatchV2(input);
  const opening = findCommittedOpeningDeliveryV2({
    pending: input.pending,
    deliveries,
  });
  if (!opening) {
    return {
      ok: false,
      reason: deliveries.some(Boolean)
        ? 'delivery_not_current_pending'
        : 'delivery_missing',
    };
  }
  const askedAge = input.now.getTime() - Date.parse(input.pending.askedAt);
  const terminalAge = input.now.getTime() - Date.parse(opening.terminalAt);
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
  return normalizeCustomerReplyStyle(opening.payload) ===
    normalizeCustomerReplyStyle(input.expectedCopy)
    ? { ok: true }
    : { ok: false, reason: 'delivery_payload_mismatch' };
}

export function deliveryMatchesPendingV2(input: {
  pending: PendingFrameSnapshotV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  openingAcceptedDelivery?: AcceptedDeliveryEvidenceV2 | null;
  acceptedDeliveries?: readonly (AcceptedDeliveryEvidenceV2 | null | undefined)[];
  now: Date;
  expectedCopy: string;
}): boolean {
  return diagnoseDeliveryMatchPendingV2(input).ok;
}
