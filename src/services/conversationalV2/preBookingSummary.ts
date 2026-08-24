import type { ServicesResult } from '../calendarService';
import type {
  BookingDraftV2,
  FlowStateV2,
  ModelTurnResultV2,
  PreBookingSummaryEvidenceV2,
} from './contracts';

/**
 * Materialização única da proposta ainda não escrita.
 *
 * Esta função recebe somente dados server-owned. Ela não interpreta texto do
 * cliente e não faz resolução fuzzy de entidades; o texto produzido aqui é
 * uma âncora de transporte, não uma prova por si só.
 */
export function materializePreBookingSummaryV2(input: {
  bookingDraft: BookingDraftV2;
  services: {
    services?: readonly { id: string; name: string }[];
    professionals?: readonly { id: string; name: string }[];
  };
}): string {
  const service = input.services.services?.find(
    (entry) => entry.id === input.bookingDraft.serviceId
  );
  const professional = input.bookingDraft.professionalId
    ? input.services.professionals?.find(
        (entry) => entry.id === input.bookingDraft.professionalId
      )
    : null;
  const professionalPart = professional ? `, com ${professional.name}` : '';
  return `Confirmando: ${service?.name ?? 'o serviço escolhido'}, em ${displayDateV2(
    input.bookingDraft.date
  )}, às ${displayTimeV2(input.bookingDraft.time)}${professionalPart}. Posso marcar?`;
}

export function displayDateV2(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : date;
}

export function displayTimeV2(value: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return value;
  return match[2] === '00'
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function currentCatalogSupportsDraft(
  draft: BookingDraftV2,
  flowState: FlowStateV2,
  services: ServicesResult
): boolean {
  if (
    !flowState.flowId.trim() ||
    !draft.serviceId.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(draft.date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(draft.time) ||
    !draft.slotEvidenceTurnId.trim()
  ) {
    return false;
  }

  const service = services.services?.find((entry) => entry.id === draft.serviceId);
  if (!service || !service.name.trim()) return false;
  if (flowState.fixedServiceId !== draft.serviceId) return false;
  if (flowState.resolvedDate !== draft.date) {
    return false;
  }
  if (flowState.fixedProfessionalId !== draft.professionalId) {
    return false;
  }

  if (
    service.professionalIds !== undefined &&
    service.professionalIds.filter((id) =>
      services.professionals?.some((professional) => professional.id === id)
    ).length === 0
  ) {
    return false;
  }

  if (draft.professionalId !== undefined) {
    const professional = services.professionals?.find(
      (entry) => entry.id === draft.professionalId
    );
    if (!professional || !professional.name.trim()) return false;
    if (
      service.professionalIds !== undefined &&
      !service.professionalIds.includes(draft.professionalId)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Valida e materializa a prova que o produtor pode entregar à boundary.
 * Ausência, divergência ou catálogo corrente incompatível não produz prova.
 */
export function buildPreBookingSummaryEvidenceV2(input: {
  flowState: FlowStateV2;
  services: ServicesResult;
}): PreBookingSummaryEvidenceV2 | null {
  const draft = input.flowState.bookingDraft;
  const slotEvidence = input.flowState.slotEvidence;
  if (!draft || !slotEvidence) return null;
  if (!currentCatalogSupportsDraft(draft, input.flowState, input.services)) {
    return null;
  }
  if (
    draft.slotEvidenceTurnId !== slotEvidence.turnId ||
    draft.serviceId !== slotEvidence.serviceId ||
    !sameOptional(draft.professionalId, slotEvidence.professionalId) ||
    draft.date !== slotEvidence.date ||
    !slotEvidence.turnId.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(slotEvidence.date) ||
    !slotEvidence.slots.includes(draft.time) ||
    slotEvidence.slots.some(
      (slot) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)
    )
  ) {
    return null;
  }
  return {
    flowId: input.flowState.flowId,
    serviceId: draft.serviceId,
    ...(draft.professionalId !== undefined
      ? { professionalId: draft.professionalId }
      : {}),
    date: draft.date,
    time: draft.time,
    slotEvidenceTurnId: draft.slotEvidenceTurnId,
  };
}

export function preBookingSummaryEvidenceMatchesFlowStateV2(input: {
  evidence: PreBookingSummaryEvidenceV2;
  flowState: FlowStateV2;
  services: ServicesResult;
}): boolean {
  const derived = buildPreBookingSummaryEvidenceV2({
    flowState: input.flowState,
    services: input.services,
  });
  return Boolean(
    derived &&
    derived.flowId === input.evidence.flowId &&
    derived.serviceId === input.evidence.serviceId &&
    sameOptional(derived.professionalId, input.evidence.professionalId) &&
    derived.date === input.evidence.date &&
    derived.time === input.evidence.time &&
    derived.slotEvidenceTurnId === input.evidence.slotEvidenceTurnId
  );
}

/**
 * Único ponto que associa uma proposta materializada ao resultado de um
 * produtor server-owned. Um resultado do modelo byte-idêntico não passa sem
 * source CANONICAL no RecoveryCoordinator.
 */
export function buildPreBookingSummaryEvidenceForCanonicalResultV2(input: {
  result: ModelTurnResultV2;
  flowState: FlowStateV2;
  services: ServicesResult;
}): PreBookingSummaryEvidenceV2 | null {
  const transition = input.result.pendingTransitionCandidate;
  if (
    input.result.replyPurpose !== 'WRITE_CONFIRMATION' ||
    transition.kind !== 'open' ||
    transition.pendingKind !== 'CONFIRMATION' ||
    transition.flowId !== input.flowState.flowId
  ) {
    return null;
  }
  const evidence = buildPreBookingSummaryEvidenceV2({
    flowState: input.flowState,
    services: input.services,
  });
  if (!evidence) return null;
  return materializePreBookingSummaryV2({
    bookingDraft: input.flowState.bookingDraft!,
    services: input.services,
  }) === input.result.reply
    ? evidence
    : null;
}
