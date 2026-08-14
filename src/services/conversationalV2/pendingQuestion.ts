import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
} from './contracts';
import {
  buildCanonicalBookingSummaryV2,
  displayDateV2,
} from './lifecycleReducer';

export const PENDING_REANCHOR_GAP_MS_V2 = 15 * 60 * 1000;

export function shouldReanchorPendingQuestionV2(input: {
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  lastAcceptedTerminalAt?: string | null;
  now: Date;
  explicitRestart: boolean;
}): boolean {
  if (
    input.pending?.kind !== 'TIME' ||
    input.pending.flowId !== input.flowState.flowId
  ) {
    return false;
  }
  const terminalAt = Date.parse(input.lastAcceptedTerminalAt ?? '');
  return (
    input.explicitRestart ||
    (Number.isFinite(terminalAt) &&
      input.now.getTime() - terminalAt > PENDING_REANCHOR_GAP_MS_V2)
  );
}

export interface PendingQuestionCatalogV2 {
  services?: readonly { id: string; name: string }[];
  professionals?: readonly { id: string; name: string }[];
}

export function validatedBookingDraftForPendingV2(input: {
  pending: PendingFrameSnapshotV2;
  flowState: FlowStateV2;
  catalog: PendingQuestionCatalogV2;
}): FlowStateV2['bookingDraft'] | null {
  const draft = input.flowState.bookingDraft;
  const evidence = input.flowState.slotEvidence;
  if (
    input.pending.kind !== 'CONFIRMATION' ||
    input.pending.flowId !== input.flowState.flowId ||
    input.pending.options.length !== 1 ||
    input.pending.options[0]?.entityId !==
      `booking-confirmation:${input.pending.flowId}` ||
    !draft?.serviceId.trim() ||
    !draft.date.trim() ||
    !draft.time.trim() ||
    !draft.slotEvidenceTurnId.trim() ||
    input.flowState.fixedServiceId !== draft.serviceId ||
    (input.flowState.fixedProfessionalId ?? undefined) !==
      (draft.professionalId ?? undefined) ||
    input.flowState.resolvedDate !== draft.date ||
    !evidence ||
    evidence.turnId !== draft.slotEvidenceTurnId ||
    evidence.serviceId !== draft.serviceId ||
    (evidence.professionalId ?? undefined) !==
      (draft.professionalId ?? undefined) ||
    evidence.date !== draft.date ||
    !evidence.slots.includes(draft.time)
  ) {
    return null;
  }
  if (!input.catalog.services?.some((entry) => entry.id === draft.serviceId)) {
    return null;
  }
  if (
    draft.professionalId &&
    !input.catalog.professionals?.some(
      (entry) => entry.id === draft.professionalId
    )
  ) {
    return null;
  }
  return draft;
}

/**
 * Fonte única das perguntas canônicas de PendingFrame. CONFIRMATION normal só
 * expõe o resumo quando BookingDraftV2, opção e slotEvidence pertencem ao
 * mesmo flow; duplicidade conserva sua copy própria.
 */
export function buildPendingQuestionV2(input: {
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  catalog: PendingQuestionCatalogV2;
  reanchor?: boolean;
}): string | null {
  const pending = input.pending;
  if (!pending) return null;
  const names = pending.options
    .map((option) => option.displayName.trim())
    .filter(Boolean);
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
    case 'TIME': {
      const service = input.catalog.services?.find(
        (entry) => entry.id === input.flowState.fixedServiceId
      );
      if (
        input.reanchor === true &&
        pending.flowId === input.flowState.flowId &&
        service &&
        input.flowState.resolvedDate
      ) {
        return `A gente estava marcando ${service.name} para ${displayDateV2(
          input.flowState.resolvedDate
        )} — qual horário você prefere?`;
      }
      return 'Qual horário você prefere?';
    }
    case 'CONFIRMATION': {
      if (
        pending.options.some((option) =>
          option.entityId.startsWith('duplicate-resolution:')
        )
      ) {
        return names.length > 0
          ? `Qual opção você prefere: ${names.join(', ')}?`
          : 'Qual opção de duplicidade você prefere?';
      }
      const draft = validatedBookingDraftForPendingV2({
        pending,
        flowState: input.flowState,
        catalog: input.catalog,
      });
      return draft
        ? buildCanonicalBookingSummaryV2({
            draft,
            services: input.catalog,
          })
        : 'Você confirma essa opção?';
    }
  }
}
