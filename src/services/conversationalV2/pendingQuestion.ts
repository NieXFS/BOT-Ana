import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
} from './contracts';
import {
  buildCanonicalBookingSummaryV2,
  displayDateV2,
} from './lifecycleReducer';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';

export const PENDING_REANCHOR_GAP_MS_V2 = 15 * 60 * 1000;
/** Loop-breaker de dia vazio: só na janela [0, 2min] após o terminalAt. */
export const EMPTY_AVAILABILITY_LOOP_WINDOW_MS_V2 = 2 * 60 * 1000;

export const DATE_PENDING_QUESTION_V2 = 'Qual dia você prefere?';

/** Segunda ocorrência da mesma copy de sem-horários no mesmo dia. */
export const EXPLICIT_DAY_QUESTION_V2 =
  'Qual dia você prefere? Pode me falar o nome do dia ou a data.';

export function emptyAvailabilityDayCopyV2(date: string): string {
  return `Não encontrei horários para ${displayDateV2(date)}. Qual outro dia você prefere?`;
}

function normalizeCopy(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Loop-breaker de dia vazio: igualdade de copy/data E
 * 0 ≤ now − terminalAt ≤ 2min. Fora da janela, relê.
 */
export function isRepeatedEmptyAvailabilityDayV2(
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null | undefined,
  date: string,
  now: Date
): boolean {
  const payload = lastAcceptedDelivery?.payload;
  const terminalAtRaw = lastAcceptedDelivery?.terminalAt;
  if (!payload?.trim() || !terminalAtRaw) return false;
  const terminalAt = Date.parse(terminalAtRaw);
  if (!Number.isFinite(terminalAt)) return false;
  const delta = now.getTime() - terminalAt;
  if (delta < 0 || delta > EMPTY_AVAILABILITY_LOOP_WINDOW_MS_V2) return false;
  const previous = normalizeCopy(payload);
  const dated = normalizeCopy(emptyAvailabilityDayCopyV2(date));
  if (previous.includes(dated) || previous === dated) return true;
  const display = normalizeCopy(displayDateV2(date));
  return previous.includes(`nao encontrei horarios para ${display}`);
}

export const DUPLICATE_RESOLUTION_OPTIONS_V2 = [
  {
    entityId: 'duplicate-resolution:keep-both',
    displayName: 'manter os dois',
  },
  {
    entityId: 'duplicate-resolution:reschedule',
    displayName: 'remarcar',
  },
  {
    entityId: 'duplicate-resolution:cancel-only',
    displayName: 'só cancelar o anterior',
  },
  {
    entityId: 'duplicate-resolution:decide-later',
    displayName: 'decidir depois',
  },
] as const;

export const DUPLICATE_RESOLUTION_CHOICE_QUESTION_V2 = `Quer ${DUPLICATE_RESOLUTION_OPTIONS_V2.slice(
  0,
  -1
)
  .map((option) => option.displayName)
  .join(', ')} ou ${DUPLICATE_RESOLUTION_OPTIONS_V2.at(-1)!.displayName}?`;

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

const BOOKING_REENTRY_CONTINUE_ID = 'booking-reentry:continue';
const BOOKING_REENTRY_NEW_ID = 'booking-reentry:new';

export const BOOKING_REENTRY_OPTION_IDS_V2 = [
  BOOKING_REENTRY_CONTINUE_ID,
  BOOKING_REENTRY_NEW_ID,
] as const;

function displayTimeV2(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return value;
  return match[2] === '00'
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
}

function serviceForFlowV2(
  flowState: FlowStateV2,
  catalog: PendingQuestionCatalogV2
): { id: string; name: string } | null {
  return catalog.services?.find(
    (entry) => entry.id === flowState.fixedServiceId
  ) ?? null;
}

export function buildBookingReentryQuestionV2(input: {
  flowState: FlowStateV2;
  catalog: PendingQuestionCatalogV2;
}): string | null {
  const service = serviceForFlowV2(input.flowState, input.catalog);
  if (!service || !input.flowState.resolvedDate) return null;
  const time = input.flowState.bookingDraft?.time;
  return `A gente estava marcando ${service.name} para ${displayDateV2(
    input.flowState.resolvedDate
  )}${time ? ` às ${displayTimeV2(time)}` : ''} — quer continuar esse agendamento ou marcar outro?`;
}

export function buildBookingContinuationQuestionV2(input: {
  pending: PendingFrameSnapshotV2;
  flowState: FlowStateV2;
  catalog: PendingQuestionCatalogV2;
}): string | null {
  const service = serviceForFlowV2(input.flowState, input.catalog);
  if (!service) return null;
  if (input.pending.kind === 'DATE') {
    return `A gente estava marcando ${service.name} — qual dia você prefere?`;
  }
  if (input.pending.kind === 'PROFESSIONAL') {
    const names = input.pending.options
      .map((option) => option.displayName.trim())
      .filter(Boolean);
    return `A gente estava marcando ${service.name} — qual profissional você prefere${
      names.length > 0 ? `: ${names.join(', ')}` : ''}?`;
  }
  return buildPendingQuestionV2({
    ...input,
    reanchor: input.pending.kind === 'TIME',
  });
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
  if (
    pending.kind === 'CONFIRMATION' &&
    pending.options.length === BOOKING_REENTRY_OPTION_IDS_V2.length &&
    pending.options.every(
      (option, index) =>
        option.entityId === BOOKING_REENTRY_OPTION_IDS_V2[index]
    )
  ) {
    return buildBookingReentryQuestionV2(input);
  }
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
      return DATE_PENDING_QUESTION_V2;
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
    case 'CANCEL_TARGET': {
      if (names.length > 5) {
        return 'Você tem vários agendamentos. Me diga a data e o horário do que quer cancelar.';
      }
      return names.length > 0
        ? `Qual você quer cancelar: ${names.join('; ')}?`
        : 'Qual agendamento você quer cancelar?';
    }
    case 'CANCEL_CONFIRMATION': {
      const selected =
        input.flowState.cancellation?.candidates.find(
          (candidate) =>
            candidate.token === input.flowState.cancellation?.selectedToken
        ) ??
        input.flowState.cancellation?.candidates.find(
          (candidate) => candidate.token === pending.options[0]?.entityId
        );
      return selected
        ? `Confirma o cancelamento de ${selected.displayName}?`
        : names[0]
          ? `Confirma o cancelamento de ${names[0]}?`
          : 'Confirma o cancelamento?';
    }
  }
}
