import type { ServicesResult } from '../calendarService';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  resolveUniqueCatalogEntityFromCurrentMessage,
} from '../service-gate';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  PendingTransitionCandidate,
} from './contracts';
import type { CurrentDateResolutionV2 } from './currentDateResolution';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';

export const FLOW_STATE_IDLE_TTL_MS_V2 = 4 * 60 * 60 * 1_000;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function hasPositiveExplicitBookingVerbV2(inboundText: string): boolean {
  const text = normalize(inboundText);
  const matcher = /\b(?:agendar|marcar)\b/gu;
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    if (/\b(?:nao|nunca)\b(?:\s+[a-z0-9]+){0,3}\s*$/u.test(prefix)) continue;
    if (
      /\b(?:quero|queria|gostaria de|preciso|desejo|posso|podemos|pode|vamos|vou)\s*$/u.test(
        prefix
      ) ||
      /^(?:agendar|marcar)\b/u.test(text.slice(match.index ?? 0))
    ) {
      return true;
    }
  }
  return false;
}

function pendingFresh(pending: PendingFrameSnapshotV2, now: Date): boolean {
  const askedAt = Date.parse(pending.askedAt);
  return (
    Number.isFinite(askedAt) &&
    now.getTime() - askedAt <= FLOW_STATE_IDLE_TTL_MS_V2
  );
}

function hasCatalogProgress(text: string, catalog: ServicesResult): boolean {
  const options = {
    allowRestrictedDistanceTwo:
      ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  } as const;
  const service = resolveUniqueCatalogEntityFromCurrentMessage(
    text,
    catalog.services ?? [],
    options
  );
  const professional = resolveUniqueCatalogEntityFromCurrentMessage(
    text,
    catalog.professionals ?? [],
    options
  );
  return service.kind !== 'no_match' || professional.kind !== 'no_match';
}

export function flowStateIdleV2(
  flowState: FlowStateV2 | null,
  now: Date
): boolean {
  if (!flowState) return false;
  const lastOperationalAt = Date.parse(flowState.lastOperationalAt ?? '');
  return (
    !Number.isFinite(lastOperationalAt) ||
    now.getTime() - lastOperationalAt > FLOW_STATE_IDLE_TTL_MS_V2
  );
}

export type FlowResetReasonV2 = 'idle_timeout' | 'explicit_restart';

/**
 * Um reset que termine em copy+PRESERVE não pode enxertar o flowState novo na
 * pendência antiga. Invalida a pergunta velha no mesmo commit de entrega; um
 * novo OPEN, quando existir, continua supersedendo-a pela regra normal.
 */
export function adjustTransitionForFlowResetV2(
  candidate: PendingTransitionCandidate,
  pending: PendingFrameSnapshotV2 | null,
  resetReason: FlowResetReasonV2 | null
): PendingTransitionCandidate {
  if (!resetReason || !pending || candidate.kind !== 'preserve') {
    return candidate;
  }
  return {
    kind: 'invalidate',
    questionId: pending.questionId,
    reason: `flow_session_reset:${resetReason}`,
  };
}

/** Reset allow-only. DATE/TIME/CONFIRMATION/PROFESSIONAL frescas são soberanas. */
export function decideFlowResetV2(input: {
  flowState: FlowStateV2 | null;
  pending: PendingFrameSnapshotV2 | null;
  inboundText: string;
  dateResolution: CurrentDateResolutionV2;
  catalog: ServicesResult;
  now: Date;
}): FlowResetReasonV2 | null {
  if (flowStateIdleV2(input.flowState, input.now)) return 'idle_timeout';
  if (!hasPositiveExplicitBookingVerbV2(input.inboundText)) return null;
  if (hasCatalogProgress(input.inboundText, input.catalog)) return null;
  if (input.dateResolution.kind !== 'none') return null;
  if (
    normalizeTemporalAssertionsV2(input.inboundText).some(
      (assertion) => assertion.kind === 'time'
    )
  ) {
    return null;
  }
  if (
    input.pending &&
    pendingFresh(input.pending, input.now) &&
    input.pending.kind !== 'SERVICE'
  ) {
    return null;
  }
  return 'explicit_restart';
}

export function newFlowStateV2(flowId: string, now: Date): FlowStateV2 {
  return {
    flowId,
    lastOperationalAt: now.toISOString(),
    fixedByProofVersion: {},
  };
}

export function stampFlowOperationalActivityV2(
  flowState: FlowStateV2,
  now: Date
): FlowStateV2 {
  return { ...flowState, lastOperationalAt: now.toISOString() };
}
