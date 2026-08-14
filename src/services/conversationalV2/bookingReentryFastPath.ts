import type { ServicesResult } from '../calendarService';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  buildServiceQuestion,
  resolveUniqueCatalogEntityFromCurrentMessage,
} from '../service-gate';
import type {
  FlowStateV2,
  ModelTurnResultV2,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import type { CurrentDateResolutionV2 } from './currentDateResolution';
import {
  newFlowStateV2,
} from './flowSession';
import { resolvePendingOptionProofV2 } from './fastPaths';
import {
  BOOKING_REENTRY_OPTION_IDS_V2,
  buildBookingContinuationQuestionV2,
  buildBookingReentryQuestionV2,
} from './pendingQuestion';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';

export type BookingReentryFastPathV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      proof: ResolutionProof | null;
      nextFlowState: FlowStateV2;
    };

function hasCatalogProgressV2(
  text: string,
  catalog: ServicesResult
): boolean {
  const options = {
    allowRestrictedDistanceTwo:
      ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  } as const;
  return (
    resolveUniqueCatalogEntityFromCurrentMessage(
      text,
      catalog.services ?? [],
      options
    ).kind !== 'no_match' ||
    resolveUniqueCatalogEntityFromCurrentMessage(
      text,
      catalog.professionals ?? [],
      options
    ).kind !== 'no_match'
  );
}

function withoutBookingReentryV2(flowState: FlowStateV2): FlowStateV2 {
  const { bookingReentry: _bookingReentry, ...rest } = flowState;
  return rest;
}

function isBareBookingReentryRequestV2(value: string): boolean {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    !normalized ||
    /\b(?:sim|pode|confirmo|confirma|confirmado|ok|isso|perfeito|fechado)\b/u.test(
      normalized
    )
  ) {
    return false;
  }
  return /^(?:(?:oi|ola|por favor)\s+)*(?:quero|gostaria de|preciso|vamos)\s+(?:agendar|marcar)(?:\s+(?:um|outro|novo)\s+(?:horario|agendamento))?(?:\s+por favor)?$/u.test(
    normalized
  );
}

function sourceOptionDisplayNameV2(
  entityId: string,
  kind: NonNullable<FlowStateV2['bookingReentry']>['pendingKind'],
  catalog: ServicesResult
): string {
  if (kind === 'SERVICE') {
    return catalog.services?.find((entry) => entry.id === entityId)?.name ?? 'serviço';
  }
  if (kind === 'PROFESSIONAL') {
    return catalog.professionals?.find((entry) => entry.id === entityId)?.name ?? 'profissional';
  }
  const duplicateNames: Record<string, string> = {
    'duplicate-resolution:keep-both': 'manter os dois',
    'duplicate-resolution:reschedule': 'remarcar',
    'duplicate-resolution:cancel-only': 'só cancelar o anterior',
    'duplicate-resolution:decide-later': 'decidir depois',
  };
  if (duplicateNames[entityId]) return duplicateNames[entityId]!;
  if (entityId.startsWith('booking-confirmation:')) return 'Confirmar agendamento';
  return entityId;
}

function reentryPendingV2(frame: TurnFrameV2): boolean {
  return Boolean(
    frame.pending?.kind === 'CONFIRMATION' &&
      frame.pending.options.length === BOOKING_REENTRY_OPTION_IDS_V2.length &&
      frame.pending.options.every(
        (option, index) =>
          option.entityId === BOOKING_REENTRY_OPTION_IDS_V2[index]
      ) &&
      frame.flowState.bookingReentry
  );
}

export function shouldOfferBookingReentryV2(input: {
  pending: TurnFrameV2['pending'];
  flowState: FlowStateV2;
  inboundText: string;
  currentDateResolution: CurrentDateResolutionV2;
  catalog: ServicesResult;
}): boolean {
  if (
    !input.pending ||
    input.flowState.bookingReentry ||
    input.pending.flowId !== input.flowState.flowId ||
    !input.flowState.fixedServiceId ||
    !input.flowState.resolvedDate ||
    !isBareBookingReentryRequestV2(input.inboundText)
  ) {
    return false;
  }
  return !(
    input.currentDateResolution.kind !== 'none' ||
    normalizeTemporalAssertionsV2(input.inboundText).some(
      (assertion) => assertion.kind === 'time'
    ) ||
    hasCatalogProgressV2(input.inboundText, input.catalog)
  );
}

/**
 * Reentrada server-owned: um pedido nu de booking nunca cai no histórico/modelo
 * quando já existe progresso aproveitável. A escolha continuar|novo é a única
 * coisa resolvida neste turno; nenhuma opção licencia ferramenta ou write.
 */
export function resolveBookingReentryFastPathV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  currentDateResolution: CurrentDateResolutionV2;
  catalog: ServicesResult;
  now: Date;
  newFlowId: () => string;
  lastAcceptedAssistantText?: string;
}): BookingReentryFastPathV2 {
  if (reentryPendingV2(input.frame)) {
    const proof = resolvePendingOptionProofV2({
      frame: input.frame,
      inboundId: input.inboundId,
      inboundText: input.inboundText,
      now: input.now,
      catalog: input.catalog,
      lastAcceptedAssistantText: input.lastAcceptedAssistantText,
    });
    if (proof?.kind !== 'pending_option') {
      return { kind: 'continue_model', reason: 'reentry_choice_not_evidenced' };
    }
    if (proof.entityId === 'booking-reentry:new') {
      const nextFlowState = newFlowStateV2(input.newFlowId(), input.now);
      return {
        kind: 'resolved',
        proof,
        nextFlowState,
        result: {
          schemaVersion: 2,
          reply: buildServiceQuestion(input.catalog.services ?? []),
          replyPurpose: 'SERVICE_QUESTION',
          pendingTransitionCandidate: {
            kind: 'open',
            pendingKind: 'SERVICE',
            flowId: nextFlowState.flowId,
            optionEntityIds: (input.catalog.services ?? []).map(
              (service) => service.id
            ),
          },
          resolutionCandidate: null,
          unknownServiceEvidence: null,
        },
      };
    }
    if (proof.entityId !== 'booking-reentry:continue') {
      return { kind: 'continue_model', reason: 'unsupported_reentry_choice' };
    }
    const source = input.frame.flowState.bookingReentry!;
    const sourcePending = {
      ...input.frame.pending!,
      kind: source.pendingKind,
      options: source.optionEntityIds.map((entityId, index) => ({
        position: index + 1,
        entityId,
        displayName: sourceOptionDisplayNameV2(
          entityId,
          source.pendingKind,
          input.catalog
        ),
      })),
    };
    const nextFlowState = withoutBookingReentryV2(input.frame.flowState);
    const reply = buildBookingContinuationQuestionV2({
      pending: sourcePending,
      flowState: nextFlowState,
      catalog: input.catalog,
    });
    if (!reply) {
      return { kind: 'continue_model', reason: 'reentry_recap_unavailable' };
    }
    return {
      kind: 'resolved',
      proof,
      nextFlowState,
      result: {
        schemaVersion: 2,
        reply,
        replyPurpose:
          source.pendingKind === 'CONFIRMATION'
            ? 'WRITE_CONFIRMATION'
            : source.pendingKind === 'SERVICE'
              ? 'SERVICE_QUESTION'
              : source.pendingKind === 'PROFESSIONAL'
                ? 'PROFESSIONAL_QUESTION'
                : 'DATE_TIME_QUESTION',
        pendingTransitionCandidate: {
          kind: 'open',
          pendingKind: source.pendingKind,
          flowId: nextFlowState.flowId,
          optionEntityIds: [...source.optionEntityIds],
        },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
    };
  }

  const pending = input.frame.pending;
  if (!pending) {
    return { kind: 'continue_model', reason: 'no_open_pending' };
  }
  if (
    !shouldOfferBookingReentryV2({
      pending,
      flowState: input.frame.flowState,
      inboundText: input.inboundText,
      currentDateResolution: input.currentDateResolution,
      catalog: input.catalog,
    })
  ) {
    return { kind: 'continue_model', reason: 'not_bare_booking_reentry' };
  }
  const reply = buildBookingReentryQuestionV2({
    flowState: input.frame.flowState,
    catalog: input.catalog,
  });
  if (!reply) return { kind: 'continue_model', reason: 'reentry_recap_unavailable' };
  return {
    kind: 'resolved',
    proof: null,
    nextFlowState: {
      ...input.frame.flowState,
      bookingReentry: {
        pendingKind: pending.kind,
        optionEntityIds: pending.options.map((option) => option.entityId),
      },
    },
    result: {
      schemaVersion: 2,
      reply,
      replyPurpose: 'CLARIFICATION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'CONFIRMATION',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: [...BOOKING_REENTRY_OPTION_IDS_V2],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}
