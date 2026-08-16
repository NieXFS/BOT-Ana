import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  PendingTransitionCandidate,
} from './contracts';
import {
  detectPositiveCancellationIntentV2,
  isCancellationPendingKindV2,
} from './cancellationFlowV2';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import { findClauseMatchesV2 } from './polarity';
import { hasPositiveExplicitBookingVerbV2 } from './flowSession';

const CANCEL_VERB_RE =
  /\b(?:cancelar|cancela|cancele|cancelem|cancelamento|desmarcar|desmarca|desmarque|desmarquem)\b/gu;

export type CancellationAbandonmentReasonV2 =
  | 'explicit_booking_or_reschedule'
  | 'explicit_withdrawal'
  | 'expired_pending';

export type CancellationAbandonmentV2 =
  | { kind: 'none' }
  | {
      kind: 'abandon';
      reason: CancellationAbandonmentReasonV2;
      nextFlowState: FlowStateV2;
      pendingTransitionCandidate: PendingTransitionCandidate;
    };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function hasPositiveExplicitRescheduleVerbV2(inboundText: string): boolean {
  const text = normalize(inboundText);
  const matcher = /\b(?:remarcar|reagendar)\b/gu;
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    if (/\b(?:nao|nunca)\b(?:\s+[a-z0-9]+){0,3}\s*$/u.test(prefix)) continue;
    if (
      /\b(?:quero|queria|gostaria de|preciso|desejo|posso|podemos|pode|vamos|vou)\s*$/u.test(
        prefix
      ) ||
      /^(?:remarcar|reagendar)\b/u.test(text.slice(match.index ?? 0))
    ) {
      return true;
    }
  }
  return false;
}

export function detectExplicitBookingOrRescheduleV2(inboundText: string): boolean {
  return (
    hasPositiveExplicitBookingVerbV2(inboundText) ||
    hasPositiveExplicitRescheduleVerbV2(inboundText)
  );
}

export function detectExplicitCancellationWithdrawalV2(inboundText: string): boolean {
  const text = normalize(inboundText);
  if (
    /\b(?:deixa pra la|deixa para la|deixa quieto|deixa assim)\b/u.test(text)
  ) {
    return true;
  }
  const matches = findClauseMatchesV2(inboundText, CANCEL_VERB_RE);
  const hasNegative = matches.some((match) => !match.positive);
  const hasPositive = matches.some((match) => match.positive);
  return hasNegative && !hasPositive;
}

export function stripCancellationFlowV2(flowState: FlowStateV2): FlowStateV2 {
  if (!flowState.cancellation) return flowState;
  const { cancellation: _removed, ...rest } = flowState;
  void _removed;
  return rest;
}

function cancellationPendingExpiredV2(
  pending: PendingFrameSnapshotV2,
  now: Date
): boolean {
  const askedAt = Date.parse(pending.askedAt);
  return (
    !Number.isFinite(askedAt) ||
    now.getTime() - askedAt > PENDING_FAST_PATH_MAX_AGE_MS
  );
}

function abandon(input: {
  reason: CancellationAbandonmentReasonV2;
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
}): Extract<CancellationAbandonmentV2, { kind: 'abandon' }> {
  return {
    kind: 'abandon',
    reason: input.reason,
    nextFlowState: stripCancellationFlowV2(input.flowState),
    pendingTransitionCandidate:
      input.pending && isCancellationPendingKindV2(input.pending.kind)
        ? {
            kind: 'invalidate',
            questionId: input.pending.questionId,
            reason: `cancellation_abandoned:${input.reason}`,
          }
        : { kind: 'preserve' },
  };
}

/**
 * Corre antes do planner. Um pedido novo de agendamento/remarcação, uma
 * retirada explícita ou uma pendência CANCEL_* vencida invalidam a pendência
 * e removem CancellationFlowV2 para o pipeline normal seguir.
 */
export function decideCancellationAbandonmentV2(input: {
  inboundText: string;
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  now: Date;
}): CancellationAbandonmentV2 {
  const hasCancelContext =
    Boolean(input.flowState.cancellation) ||
    isCancellationPendingKindV2(input.pending?.kind);
  if (!hasCancelContext) return { kind: 'none' };

  if (
    input.pending &&
    isCancellationPendingKindV2(input.pending.kind) &&
    cancellationPendingExpiredV2(input.pending, input.now)
  ) {
    return abandon({
      reason: 'expired_pending',
      pending: input.pending,
      flowState: input.flowState,
    });
  }

  if (detectExplicitCancellationWithdrawalV2(input.inboundText)) {
    return abandon({
      reason: 'explicit_withdrawal',
      pending: input.pending,
      flowState: input.flowState,
    });
  }

  if (
    detectExplicitBookingOrRescheduleV2(input.inboundText) &&
    !detectPositiveCancellationIntentV2(input.inboundText)
  ) {
    return abandon({
      reason: 'explicit_booking_or_reschedule',
      pending: input.pending,
      flowState: input.flowState,
    });
  }

  return { kind: 'none' };
}

export function applyCancellationAbandonmentTransitionV2(
  candidate: PendingTransitionCandidate,
  abandonment: CancellationAbandonmentV2
): PendingTransitionCandidate {
  if (abandonment.kind !== 'abandon' || candidate.kind !== 'preserve') {
    return candidate;
  }
  return abandonment.pendingTransitionCandidate;
}
