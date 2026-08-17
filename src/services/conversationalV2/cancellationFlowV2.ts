import { createHash } from 'crypto';
import { isExplicitBookingConfirmation } from '../bookingConfirmationGate';
import { deliveryMatchesPendingV2 } from './deliveryEvidence';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';
import type { CurrentDateResolutionV2 } from './currentDateResolution';
import {
  CIVIL_DATE_TOKEN_RE,
  normalizeTemporalAssertionsV2,
  resolveCivilDateTokenV2,
} from './temporalNormalizer';
import {
  CANCELLATION_DISPOSITIONS_V2,
  type CancellationCandidateV2,
  type CancellationDispositionV2,
  type CancellationFlowV2,
  type CancellationTargetTokenV2,
  type FlowStateV2,
  type PendingFrameSnapshotV2,
  type PendingKindV2,
  type TurnFrameV2,
} from './contracts';
import { hasPositiveClauseMatchV2 } from './polarity';
import { stripPowerZeroMetalinguisticAssignmentsV2 } from './powerZeroWitness';

const CANCEL_VERB_RE =
  /\b(?:cancelar|cancela|cancele|cancelem|cancelamento|desmarcar|desmarca|desmarque|desmarquem)\b/gu;
const WEEKDAY_TOKEN_RE =
  /\b(?:(?:proxim[oa]\s+)?(?:segunda|terca|quarta|quinta|sexta)(?:[\s-]+feira)?|sabado|domingo)(?:\s+que\s+vem)?\b/gu;
const EXPLICIT_DATE_TOKEN_RE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gu;
const ORDINAL_WORDS: Record<string, number> = {
  primeira: 1,
  primeiro: 1,
  segunda: 2,
  segundo: 2,
  terceira: 3,
  terceiro: 3,
  quarta: 4,
  quarto: 4,
  quinta: 5,
  quinto: 5,
};

export const CANCEL_CONFIRMATION_COPY_PREFIX_V2 = 'Confirma o cancelamento de ';
export const NO_UPCOMING_CANCEL_COPY_V2 =
  'Não encontrei um agendamento futuro neste cadastro.';
export const NOT_CANCELABLE_COPY_V2 =
  'Esse agendamento não pode ser cancelado por aqui.';
export const CANCEL_NEED_DATETIME_COPY_V2 =
  'Você tem vários agendamentos. Me diga a data e o horário do que quer cancelar.';
export const CANCEL_AMBIGUOUS_REFERENCE_COPY_V2 =
  'Não identifiquei qual agendamento cancelar. Pode me dizer a data e o horário?';
export const CANCEL_TARGET_UNAVAILABLE_COPY_V2 =
  'Não localizei esse agendamento para cancelar. Pode me dizer de novo a data e o horário?';
export const CANCEL_WRITE_SUCCESS_COPY_V2 =
  'Tudo certo! O agendamento foi cancelado.';
export const CANCEL_WRITE_FAILURE_COPY_V2 =
  'Não consegui cancelar esse agendamento agora. Pode tentar novamente em instantes?';
export const CANCEL_HUMAN_REVIEW_FALLBACK_COPY_V2 =
  'Esse cancelamento precisa da equipe do estabelecimento. Eu não consigo concluí-lo por aqui.';
export const CANCEL_LIST_MAX_V2 = 5;

export type CancellationCandidateResolutionV2 =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; candidate: CancellationCandidateV2 };

export type CancelConfirmationGateDecisionV2 =
  | { ok: true; token: CancellationTargetTokenV2; candidate: CancellationCandidateV2 }
  | { ok: false; reason: string };

export type CancellationPlanV2 =
  | { kind: 'none' }
  | { kind: 'need_read' }
  | { kind: 'pure_consult' }
  | {
      kind: 'open_confirmation';
      copy: string;
      flow: CancellationFlowV2;
    }
  | {
      kind: 'open_target_list';
      copy: string;
      flow: CancellationFlowV2;
    }
  | {
      kind: 'need_datetime';
      copy: string;
      flow: CancellationFlowV2;
    }
  | {
      kind: 'human_review';
      flow: CancellationFlowV2;
      candidate: CancellationCandidateV2;
    }
  | {
      kind: 'not_cancelable';
      copy: string;
      flow: CancellationFlowV2;
    }
  | { kind: 'no_upcoming'; copy: string }
  | {
      kind: 'ambiguous_reference';
      copy: string;
      flow: CancellationFlowV2;
    }
  | {
      kind: 'target_unavailable';
      copy: string;
      flow: CancellationFlowV2 | undefined;
    }
  | {
      kind: 'confirm_write';
      token: CancellationTargetTokenV2;
      candidate: CancellationCandidateV2;
      flow: CancellationFlowV2;
    }
  | {
      kind: 'confirmation_not_authorized';
      reason: string;
      flow: CancellationFlowV2;
    };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function inboundLooksInterrogativeV2(value: string): boolean {
  return /\?/u.test(value.trim());
}

export function isCancellationPendingKindV2(
  kind: PendingKindV2 | undefined
): kind is 'CANCEL_TARGET' | 'CANCEL_CONFIRMATION' {
  return kind === 'CANCEL_TARGET' || kind === 'CANCEL_CONFIRMATION';
}

export function effectiveCancellationDispositionV2(
  value: unknown
): CancellationDispositionV2 {
  if (
    typeof value === 'string' &&
    (CANCELLATION_DISPOSITIONS_V2 as readonly string[]).includes(value)
  ) {
    return value as CancellationDispositionV2;
  }
  return 'HUMAN_REVIEW_REQUIRED';
}

export function cancellationTargetTokenV2(
  appointmentId: string
): CancellationTargetTokenV2 {
  const opaque = createHash('sha256')
    .update(`ana-v2-cancel-target:${appointmentId}`)
    .digest('hex')
    .slice(0, 20);
  return `cancel-target:${opaque}`;
}

export function cancellationFingerprintV2(appointment: {
  id: string;
  startTime: string;
  endTime: string;
  serviceName: string;
  professionalName: string;
  status: string;
  cancellationDisposition?: unknown;
}): string {
  return createHash('sha256')
    .update(
      [
        appointment.id,
        appointment.startTime,
        appointment.endTime,
        appointment.serviceName,
        appointment.professionalName,
        appointment.status,
        typeof appointment.cancellationDisposition === 'string'
          ? appointment.cancellationDisposition
          : '',
      ].join('\u001f')
    )
    .digest('hex');
}

export function civilPartsForInstantV2(
  startTime: string,
  timezone: string
): { date: string; time: string; displayDate: string } | null {
  const instant = new Date(startTime);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) {
    return null;
  }
  return {
    date,
    time,
    displayDate: `${part('day')}/${part('month')}/${part('year')}`,
  };
}

export function canonicalCancellationDisplayNameV2(
  appointment: {
    startTime: string;
    serviceName: string;
    professionalName: string;
  },
  timezone: string
): string | null {
  const parts = civilPartsForInstantV2(appointment.startTime, timezone);
  const service = appointment.serviceName.trim();
  const professional = appointment.professionalName.trim();
  if (!parts || !service || !professional) return null;
  return `${service} em ${parts.displayDate} às ${parts.time} com ${professional}`;
}

export function buildCancelConfirmationCopyV2(displayName: string): string {
  return `${CANCEL_CONFIRMATION_COPY_PREFIX_V2}${displayName}?`;
}

export function buildCancelTargetListCopyV2(
  candidates: readonly CancellationCandidateV2[]
): string {
  const names = candidates.map((candidate) => candidate.displayName.trim()).filter(Boolean);
  if (names.length === 0) return CANCEL_AMBIGUOUS_REFERENCE_COPY_V2;
  if (names.length === 1) {
    return `Encontrei este agendamento: ${names[0]}. Qual você quer cancelar?`;
  }
  return `Qual você quer cancelar: ${names.join('; ')}?`;
}

export function buildNoUpcomingCancelCopyV2(): string {
  return NO_UPCOMING_CANCEL_COPY_V2;
}

export function buildNotCancelableCopyV2(): string {
  return NOT_CANCELABLE_COPY_V2;
}

export function buildCancelTargetUnavailableCopyV2(): string {
  return CANCEL_TARGET_UNAVAILABLE_COPY_V2;
}

export function buildHumanReviewCancelFallbackCopyV2(): string {
  return CANCEL_HUMAN_REVIEW_FALLBACK_COPY_V2;
}

export type CancellationCandidateForModelV2 = {
  token: CancellationTargetTokenV2;
  startTime: string;
  disposition: CancellationDispositionV2;
  displayName: string;
};

export function projectCancellationCandidateForModelV2(
  candidate: CancellationCandidateForModelV2
): CancellationCandidateForModelV2 {
  return {
    token: candidate.token,
    startTime: candidate.startTime,
    disposition: candidate.disposition,
    displayName: candidate.displayName,
  };
}

export type CancellationFlowForModelV2 = {
  flowId: string;
  selectedToken?: CancellationTargetTokenV2;
  sourceReadTurnId: string;
  candidates: readonly CancellationCandidateForModelV2[];
};

export function projectCancellationFlowForModelV2(
  flow: CancellationFlowV2 | CancellationFlowForModelV2 | undefined
): CancellationFlowForModelV2 | undefined {
  if (!flow) return undefined;
  return {
    flowId: flow.flowId,
    ...(flow.selectedToken ? { selectedToken: flow.selectedToken } : {}),
    sourceReadTurnId: flow.sourceReadTurnId,
    candidates: flow.candidates.map(projectCancellationCandidateForModelV2),
  };
}

export type TurnFrameForModelV2 = {
  schemaVersion: TurnFrameV2['schemaVersion'];
  turnId: string;
  inputSequence: number;
  catalogSnapshotHash: string;
  catalogState: TurnFrameV2['catalogState'];
  humanControl: TurnFrameV2['humanControl'];
  currentInboundIds: TurnFrameV2['currentInboundIds'];
  pending: TurnFrameV2['pending'];
  flowState: Omit<FlowStateV2, 'cancellation'> & {
    cancellation?: CancellationFlowForModelV2;
  };
};

export function projectTurnFrameForModelV2(
  frame: TurnFrameV2 | TurnFrameForModelV2
): TurnFrameForModelV2 {
  return {
    schemaVersion: frame.schemaVersion,
    turnId: frame.turnId,
    inputSequence: frame.inputSequence,
    catalogSnapshotHash: frame.catalogSnapshotHash,
    catalogState: frame.catalogState,
    humanControl: frame.humanControl,
    currentInboundIds: frame.currentInboundIds,
    pending: frame.pending,
    flowState: {
      ...frame.flowState,
      cancellation: projectCancellationFlowForModelV2(frame.flowState.cancellation),
    },
  };
}

/**
 * Projeção livre de appointmentId/fingerprint. O frame persistido continua
 * server-owned; só o prompt/modelo recebe este recorte.
 */
export function projectFlowStateForModelV2(
  flowState: FlowStateV2
): TurnFrameForModelV2['flowState'] {
  return projectTurnFrameForModelV2({
    schemaVersion: 2,
    turnId: 'projection',
    inputSequence: 0,
    catalogSnapshotHash: '',
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: [],
    pending: null,
    flowState,
  }).flowState;
}

export function candidatesFromUpcomingAppointmentsV2(
  appointments: readonly {
    id: string;
    startTime: string;
    endTime: string;
    serviceName: string;
    professionalName: string;
    status: string;
    cancellationDisposition?: unknown;
  }[],
  timezone: string
): CancellationCandidateV2[] {
  const candidates: CancellationCandidateV2[] = [];
  for (const appointment of appointments) {
    const displayName = canonicalCancellationDisplayNameV2(appointment, timezone);
    if (!displayName || !appointment.id.trim()) continue;
    candidates.push({
      token: cancellationTargetTokenV2(appointment.id),
      appointmentId: appointment.id,
      startTime: appointment.startTime,
      fingerprint: cancellationFingerprintV2(appointment),
      disposition: effectiveCancellationDispositionV2(
        appointment.cancellationDisposition
      ),
      displayName,
    });
  }
  return candidates;
}

export function detectPositiveCancellationIntentV2(value: string): boolean {
  const witnessed = stripPowerZeroMetalinguisticAssignmentsV2(value);
  return hasPositiveClauseMatchV2(witnessed, CANCEL_VERB_RE);
}

function uniqueTimesFromInboundV2(text: string): string[] {
  return [
    ...new Set(
      normalizeTemporalAssertionsV2(text)
        .filter((assertion) => assertion.kind === 'time')
        .map((assertion) => assertion.normalized)
    ),
  ];
}

function uniqueWeekdayDatesV2(
  text: string,
  now: Date,
  timezone: string
): string[] {
  const dates = new Set<string>();
  const normalized = normalize(text);
  for (const match of normalized.matchAll(new RegExp(WEEKDAY_TOKEN_RE.source, 'gu'))) {
    const date = resolveCivilDateTokenV2(match[0], now, timezone);
    if (date) dates.add(date);
  }
  return [...dates];
}

function uniqueExplicitDatesV2(
  text: string,
  now: Date,
  timezone: string
): string[] {
  const dates = new Set<string>();
  const normalized = normalize(text);
  for (const match of normalized.matchAll(new RegExp(EXPLICIT_DATE_TOKEN_RE.source, 'gu'))) {
    const date = resolveCivilDateTokenV2(match[0], now, timezone);
    if (date) dates.add(date);
  }
  return [...dates];
}

function inboundDateTimeConstraintV2(input: {
  text: string;
  dateResolution: CurrentDateResolutionV2;
  now: Date;
  timezone: string;
}):
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; date: string; time: string } {
  const times = uniqueTimesFromInboundV2(input.text);
  if (times.length !== 1) {
    return times.length > 1 ? { kind: 'ambiguous' } : { kind: 'none' };
  }
  const weekdayDates = uniqueWeekdayDatesV2(input.text, input.now, input.timezone);
  const explicitDates = uniqueExplicitDatesV2(input.text, input.now, input.timezone);
  if (
    weekdayDates.length > 0 &&
    explicitDates.length > 0 &&
    weekdayDates.some((date) => !explicitDates.includes(date))
  ) {
    return { kind: 'ambiguous' };
  }
  if (input.dateResolution.kind === 'ambiguous') return { kind: 'ambiguous' };
  const date =
    input.dateResolution.kind === 'resolved'
      ? input.dateResolution.date
      : weekdayDates.length === 1
        ? weekdayDates[0]!
        : explicitDates.length === 1
          ? explicitDates[0]!
          : null;
  if (!date) return { kind: 'none' };
  return { kind: 'resolved', date, time: times[0]! };
}

function candidateCivilV2(
  candidate: CancellationCandidateV2,
  timezone: string
): { date: string; time: string } | null {
  const parts = civilPartsForInstantV2(candidate.startTime, timezone);
  return parts ? { date: parts.date, time: parts.time } : null;
}

function matchesDateTimeV2(
  candidate: CancellationCandidateV2,
  date: string,
  time: string,
  timezone: string
): boolean {
  const civil = candidateCivilV2(candidate, timezone);
  return Boolean(civil && civil.date === date && civil.time === time);
}

export function resolveCancellationCandidateV2(input: {
  currentInboundBatchText: string;
  dateResolution: CurrentDateResolutionV2;
  timezone: string;
  now: Date;
  candidates: readonly CancellationCandidateV2[];
}): CancellationCandidateResolutionV2 {
  if (input.candidates.length === 0) return { kind: 'none' };
  const constraint = inboundDateTimeConstraintV2({
    text: input.currentInboundBatchText,
    dateResolution: input.dateResolution,
    now: input.now,
    timezone: input.timezone,
  });
  if (constraint.kind === 'ambiguous') return { kind: 'ambiguous' };
  if (constraint.kind === 'none') return { kind: 'none' };
  const matches = input.candidates.filter((candidate) =>
    matchesDateTimeV2(
      candidate,
      constraint.date,
      constraint.time,
      input.timezone
    )
  );
  if (matches.length === 1) return { kind: 'resolved', candidate: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'none' };
}

function stripCourtesyForPendingV2(value: string): string {
  let text = normalize(value);
  text = text.replace(/^(?:por favor[, ]+)+/u, '');
  text = text.replace(/[, ]+(?:por favor)$/u, '');
  text = text.replace(
    /^(?:vou querer|acho que|prefiro|queria|quero|pode ser|pode)\s+/u,
    ''
  );
  text = text.replace(
    /^(?:o|a|os|as|esse|essa|este|esta|aquele|aquela|isso)\s+(?:de\s+)?/u,
    ''
  );
  return text.trim();
}

function pendingOrdinalPositionV2(value: string): number | null {
  const text = stripCourtesyForPendingV2(value);
  if (!text) return null;
  if (/^[1-9]\d*$/u.test(text)) return null;
  const match = text.match(
    /^(?:a |o )?(?:(primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa])(?: opcao)?|opcao (?:numero )?(?:[1-9]|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]))$/u
  );
  const token = match?.[1] ?? match?.[2];
  if (!token) return null;
  if (/^[1-9]$/u.test(token)) return Number(token);
  return ORDINAL_WORDS[token] ?? null;
}

export function resolveCancellationPendingSelectionV2(input: {
  currentInboundBatchText: string;
  dateResolution: CurrentDateResolutionV2;
  timezone: string;
  now: Date;
  pending: PendingFrameSnapshotV2 | null;
  flow: CancellationFlowV2 | undefined;
}): CancellationCandidateResolutionV2 {
  if (
    !input.pending ||
    input.pending.kind !== 'CANCEL_TARGET' ||
    !input.flow ||
    input.pending.flowId !== input.flow.flowId
  ) {
    return { kind: 'none' };
  }
  const anchored = input.flow.candidates.filter((candidate) =>
    input.pending!.options.some((option) => option.entityId === candidate.token)
  );
  if (anchored.length === 0) return { kind: 'none' };

  const ordinal = pendingOrdinalPositionV2(input.currentInboundBatchText);
  if (ordinal !== null) {
    const option = input.pending.options.find((entry) => entry.position === ordinal);
    const candidate = option
      ? anchored.find((entry) => entry.token === option.entityId)
      : undefined;
    return candidate
      ? { kind: 'resolved', candidate }
      : { kind: 'none' };
  }

  const stripped = stripCourtesyForPendingV2(input.currentInboundBatchText);
  const constraint = inboundDateTimeConstraintV2({
    text: stripped || input.currentInboundBatchText,
    dateResolution: input.dateResolution,
    now: input.now,
    timezone: input.timezone,
  });
  if (constraint.kind === 'ambiguous') return { kind: 'ambiguous' };
  if (constraint.kind === 'resolved') {
    const matches = anchored.filter((candidate) =>
      matchesDateTimeV2(
        candidate,
        constraint.date,
        constraint.time,
        input.timezone
      )
    );
    if (matches.length === 1) return { kind: 'resolved', candidate: matches[0]! };
    if (matches.length > 1) return { kind: 'ambiguous' };
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

function pendingFreshV2(pending: PendingFrameSnapshotV2, now: Date): boolean {
  const askedAt = Date.parse(pending.askedAt);
  return Number.isFinite(askedAt) && now.getTime() - askedAt <= PENDING_FAST_PATH_MAX_AGE_MS;
}

export function cancelConfirmationGateV2(input: {
  currentInboundBatchText: string;
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  now: Date;
}): CancelConfirmationGateDecisionV2 {
  const pending = input.pending;
  const flow = input.flowState.cancellation;
  if (
    !pending ||
    pending.kind !== 'CANCEL_CONFIRMATION' ||
    pending.flowId !== input.flowState.flowId ||
    !flow ||
    flow.flowId !== pending.flowId ||
    pending.options.length !== 1
  ) {
    return { ok: false, reason: 'cancel_confirmation_pending_absent' };
  }
  const token = pending.options[0]!.entityId;
  if (!token.startsWith('cancel-target:')) {
    return { ok: false, reason: 'cancel_confirmation_token_invalid' };
  }
  const candidate = flow.candidates.find((entry) => entry.token === token);
  if (!candidate || flow.selectedToken !== candidate.token) {
    return { ok: false, reason: 'cancel_confirmation_candidate_missing' };
  }
  const expectedCopy = buildCancelConfirmationCopyV2(candidate.displayName);
  if (
    !deliveryMatchesPendingV2({
      pending,
      lastAcceptedDelivery: input.lastAcceptedDelivery,
      now: input.now,
      expectedCopy,
    })
  ) {
    return { ok: false, reason: 'cancel_confirmation_delivery_not_accepted' };
  }
  if (inboundLooksInterrogativeV2(input.currentInboundBatchText)) {
    return { ok: false, reason: 'cancel_confirmation_interrogative' };
  }
  if (!isExplicitBookingConfirmation(input.currentInboundBatchText)) {
    return { ok: false, reason: 'cancel_confirmation_not_explicit' };
  }
  return {
    ok: true,
    token: candidate.token,
    candidate,
  };
}

function flowFromCandidatesV2(input: {
  flowId: string;
  sourceReadTurnId: string;
  candidates: readonly CancellationCandidateV2[];
  selectedToken?: CancellationTargetTokenV2;
}): CancellationFlowV2 {
  return {
    flowId: input.flowId,
    sourceReadTurnId: input.sourceReadTurnId,
    candidates: [...input.candidates],
    ...(input.selectedToken ? { selectedToken: input.selectedToken } : {}),
  };
}

function planForResolvedCandidateV2(
  candidate: CancellationCandidateV2,
  flow: CancellationFlowV2
): CancellationPlanV2 {
  if (candidate.disposition === 'NOT_CANCELABLE') {
    return {
      kind: 'not_cancelable',
      copy: buildNotCancelableCopyV2(),
      flow,
    };
  }
  if (candidate.disposition !== 'AUTO_CANCEL_ALLOWED') {
    return { kind: 'human_review', flow, candidate };
  }
  return {
    kind: 'open_confirmation',
    copy: buildCancelConfirmationCopyV2(candidate.displayName),
    flow: { ...flow, selectedToken: candidate.token },
  };
}

function planForCandidateCountV2(
  candidates: readonly CancellationCandidateV2[],
  flow: CancellationFlowV2
): CancellationPlanV2 {
  if (candidates.length === 0) {
    return { kind: 'no_upcoming', copy: buildNoUpcomingCancelCopyV2() };
  }
  if (candidates.length === 1) {
    return planForResolvedCandidateV2(candidates[0]!, flow);
  }
  if (candidates.length > CANCEL_LIST_MAX_V2) {
    return {
      kind: 'need_datetime',
      copy: CANCEL_NEED_DATETIME_COPY_V2,
      flow,
    };
  }
  return {
    kind: 'open_target_list',
    copy: buildCancelTargetListCopyV2(candidates),
    flow,
  };
}

export function planCancellationIntentV2(input: {
  currentInboundBatchText: string;
  dateResolution: CurrentDateResolutionV2;
  timezone: string;
  now: Date;
  pending: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  candidates: readonly CancellationCandidateV2[] | null;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  forcePlan?: boolean;
  sourceReadTurnId: string;
}): CancellationPlanV2 {
  const pending = input.pending;
  const pendingFresh =
    pending &&
    pending.flowId === input.flowState.flowId &&
    pendingFreshV2(pending, input.now);

  if (pendingFresh && pending.kind === 'CANCEL_CONFIRMATION') {
    const gate = cancelConfirmationGateV2({
      currentInboundBatchText: input.currentInboundBatchText,
      pending,
      flowState: input.flowState,
      lastAcceptedDelivery: input.lastAcceptedDelivery,
      now: input.now,
    });
    const flow = input.flowState.cancellation;
    if (gate.ok && flow) {
      return {
        kind: 'confirm_write',
        token: gate.token,
        candidate: gate.candidate,
        flow,
      };
    }
    if (flow) {
      const interrogative = inboundLooksInterrogativeV2(
        input.currentInboundBatchText
      );
      const reopen =
        detectPositiveCancellationIntentV2(input.currentInboundBatchText) &&
        !interrogative;
      if (!reopen) {
        return {
          kind: 'confirmation_not_authorized',
          reason: gate.ok ? 'unreachable' : gate.reason,
          flow,
        };
      }
    }
  }

  if (pendingFresh && pending.kind === 'CANCEL_TARGET') {
    const selection = resolveCancellationPendingSelectionV2({
      currentInboundBatchText: input.currentInboundBatchText,
      dateResolution: input.dateResolution,
      timezone: input.timezone,
      now: input.now,
      pending,
      flow: input.flowState.cancellation,
    });
    const flow = input.flowState.cancellation;
    if (!flow) {
      return {
        kind: 'target_unavailable',
        copy: buildCancelTargetUnavailableCopyV2(),
        flow: undefined,
      };
    }
    if (selection.kind === 'resolved') {
      return planForResolvedCandidateV2(selection.candidate, flow);
    }
    if (selection.kind === 'ambiguous' || selection.kind === 'none') {
      if (
        !detectPositiveCancellationIntentV2(input.currentInboundBatchText) &&
        !input.forcePlan
      ) {
        return {
          kind: 'ambiguous_reference',
          copy: CANCEL_AMBIGUOUS_REFERENCE_COPY_V2,
          flow,
        };
      }
    }
  }

  const cancelIntent =
    input.forcePlan === true ||
    detectPositiveCancellationIntentV2(input.currentInboundBatchText);
  if (!cancelIntent) {
    return isCancellationPendingKindV2(pending?.kind)
      ? {
          kind: 'ambiguous_reference',
          copy: CANCEL_AMBIGUOUS_REFERENCE_COPY_V2,
          flow:
            input.flowState.cancellation ??
            flowFromCandidatesV2({
              flowId: input.flowState.flowId,
              sourceReadTurnId: input.sourceReadTurnId,
              candidates: input.candidates ?? [],
            }),
        }
      : { kind: 'none' };
  }

  if (input.candidates === null) return { kind: 'need_read' };

  const flow = flowFromCandidatesV2({
    flowId: input.flowState.flowId,
    sourceReadTurnId: input.sourceReadTurnId,
    candidates: input.candidates,
  });
  if (input.candidates.length === 0) {
    return { kind: 'no_upcoming', copy: buildNoUpcomingCancelCopyV2() };
  }

  const resolved = resolveCancellationCandidateV2({
    currentInboundBatchText: input.currentInboundBatchText,
    dateResolution: input.dateResolution,
    timezone: input.timezone,
    now: input.now,
    candidates: input.candidates,
  });
  if (resolved.kind === 'resolved') {
    return planForResolvedCandidateV2(resolved.candidate, flow);
  }
  if (resolved.kind === 'ambiguous') {
    return planForCandidateCountV2(input.candidates, flow);
  }
  return planForCandidateCountV2(input.candidates, flow);
}

export const __cancellationFlowForSmokeV2 = {
  CANCEL_VERB_RE,
  WEEKDAY_TOKEN_RE,
  inboundDateTimeConstraintV2,
  pendingOrdinalPositionV2,
  stripCourtesyForPendingV2,
  CIVIL_DATE_TOKEN_RE,
};
