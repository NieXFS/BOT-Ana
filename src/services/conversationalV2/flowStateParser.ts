import {
  CANCELLATION_DISPOSITIONS_V2,
  PENDING_KINDS_V2,
  type BookingDraftV2,
  type BookingReentryV2,
  type CancellationCandidateV2,
  type CancellationFlowV2,
  type DeferredAvailabilityConstraintV2,
  type DeferredAvailabilityTimeWindowV2,
  type DeferredAvailabilityWindowV2,
  type DuplicatePreflightClearanceV2,
  type DuplicateResolutionEvidenceV2,
  type FixedByProofVersionV2,
  type FlowStateV2,
  type SlotEvidenceV2,
} from './contracts';

/**
 * Parser único do agregado persistido.  Estado vindo de JSON/PG nunca deve
 * ser parcialmente aproveitado: qualquer subshape inválido invalida o
 * agregado inteiro e força o chamador a seguir pelo caminho fail-closed.
 *
 * O parser devolve uma cópia nova, para que objetos lidos do driver ou de um
 * fixture não possam ser mutados acidentalmente pelo runtime.
 */

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
  } catch {
    return null;
  }
  return value as Dict;
}

function keysOnly(value: Dict, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function requiredKeys(value: Dict, required: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return validCivilDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function validCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validClock(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/u.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function validMinute(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= 23 * 60 + 59;
}

function parseTimeWindow(value: unknown): DeferredAvailabilityTimeWindowV2 | null {
  const raw = dict(value);
  if (!raw || typeof raw.kind !== 'string') return null;
  switch (raw.kind) {
    case 'EXACT':
    case 'AFTER_EXCLUSIVE':
    case 'AT_OR_AFTER':
    case 'BEFORE_EXCLUSIVE':
    case 'AT_OR_BEFORE':
      if (!keysOnly(raw, ['kind', 'minuteOfDay']) || !validMinute(raw.minuteOfDay)) {
        return null;
      }
      return { kind: raw.kind, minuteOfDay: raw.minuteOfDay } as DeferredAvailabilityTimeWindowV2;
    case 'BETWEEN_INCLUSIVE':
      if (
        !keysOnly(raw, ['kind', 'startMinute', 'endMinute']) ||
        !validMinute(raw.startMinute) ||
        !validMinute(raw.endMinute) ||
        raw.startMinute > raw.endMinute
      ) {
        return null;
      }
      return {
        kind: 'BETWEEN_INCLUSIVE',
        startMinute: raw.startMinute,
        endMinute: raw.endMinute,
      };
    case 'PERIOD':
      if (
        !keysOnly(raw, ['kind', 'period']) ||
        !['morning', 'afternoon', 'evening', 'night'].includes(String(raw.period))
      ) {
        return null;
      }
      return {
        kind: 'PERIOD',
        period: raw.period as 'morning' | 'afternoon' | 'evening' | 'night',
      };
    default:
      return null;
  }
}

function parseDeferred(value: unknown): DeferredAvailabilityConstraintV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, [
      'schemaVersion',
      'capturedAt',
      'capturedTurnId',
      'capturedInputSequence',
      'date',
      'timeWindow',
      'windows',
    ]) ||
    !requiredKeys(raw, ['schemaVersion', 'capturedAt', 'capturedTurnId', 'capturedInputSequence']) ||
    ![1, 2].includes(Number(raw.schemaVersion)) ||
    !validIso(raw.capturedAt) ||
    !nonEmptyString(raw.capturedTurnId) ||
    !nonNegativeInteger(raw.capturedInputSequence)
  ) {
    return null;
  }
  if (raw.date !== undefined && !validCivilDate(raw.date)) return null;
  const timeWindow = raw.timeWindow === undefined ? undefined : parseTimeWindow(raw.timeWindow);
  if (raw.timeWindow !== undefined && !timeWindow) return null;
  let windows: DeferredAvailabilityWindowV2[] | undefined;
  if (raw.windows !== undefined) {
    if (raw.schemaVersion !== 2 || !Array.isArray(raw.windows) || raw.windows.length < 2) {
      return null;
    }
    windows = [];
    for (const candidate of raw.windows) {
      const entry = dict(candidate);
      if (!entry || !keysOnly(entry, ['date', 'timeWindow'])) return null;
      if (entry.date !== undefined && !validCivilDate(entry.date)) return null;
      const entryWindow = entry.timeWindow === undefined ? undefined : parseTimeWindow(entry.timeWindow);
      if (entry.timeWindow !== undefined && !entryWindow) return null;
      if (entry.date === undefined && entry.timeWindow === undefined) return null;
      windows.push({
        ...(entry.date !== undefined ? { date: entry.date } : {}),
        ...(entryWindow ? { timeWindow: entryWindow } : {}),
      });
    }
  }
  if (
    raw.schemaVersion === 1 && raw.windows !== undefined ||
    raw.schemaVersion === 2 && windows === undefined ||
    (raw.date === undefined && raw.timeWindow === undefined && windows === undefined)
  ) return null;
  return {
    schemaVersion: raw.schemaVersion as 1 | 2,
    capturedAt: raw.capturedAt,
    capturedTurnId: raw.capturedTurnId,
    capturedInputSequence: raw.capturedInputSequence,
    ...(raw.date !== undefined ? { date: raw.date } : {}),
    ...(timeWindow ? { timeWindow } : {}),
    ...(windows ? { windows } : {}),
  };
}

function parseBookingDraft(value: unknown): BookingDraftV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['serviceId', 'professionalId', 'date', 'time', 'slotEvidenceTurnId']) ||
    !requiredKeys(raw, ['serviceId', 'date', 'time', 'slotEvidenceTurnId']) ||
    !nonEmptyString(raw.serviceId) ||
    (raw.professionalId !== undefined && !nonEmptyString(raw.professionalId)) ||
    !validCivilDate(raw.date) ||
    !validClock(raw.time) ||
    !nonEmptyString(raw.slotEvidenceTurnId)
  ) {
    return null;
  }
  return {
    serviceId: raw.serviceId,
    ...(raw.professionalId !== undefined ? { professionalId: raw.professionalId } : {}),
    date: raw.date,
    time: raw.time,
    slotEvidenceTurnId: raw.slotEvidenceTurnId,
  };
}

function parseSlots(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const slots = value.map((slot) => (validClock(slot) ? slot : null));
  if (slots.some((slot) => slot === null)) return null;
  const strings = slots as string[];
  if (new Set(strings).size !== strings.length) return null;
  return strings;
}

function parseSlotEvidence(value: unknown): SlotEvidenceV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['turnId', 'serviceId', 'professionalId', 'date', 'slots']) ||
    !requiredKeys(raw, ['turnId', 'serviceId', 'date', 'slots']) ||
    !nonEmptyString(raw.turnId) ||
    !nonEmptyString(raw.serviceId) ||
    (raw.professionalId !== undefined && !nonEmptyString(raw.professionalId)) ||
    !validCivilDate(raw.date)
  ) {
    return null;
  }
  const slots = parseSlots(raw.slots);
  if (!slots) return null;
  return {
    turnId: raw.turnId,
    serviceId: raw.serviceId,
    ...(raw.professionalId !== undefined ? { professionalId: raw.professionalId } : {}),
    date: raw.date,
    slots,
  };
}

function parseBookingReentry(value: unknown): BookingReentryV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['pendingKind', 'optionEntityIds']) ||
    !requiredKeys(raw, ['pendingKind', 'optionEntityIds']) ||
    typeof raw.pendingKind !== 'string' ||
    !PENDING_KINDS_V2.includes(raw.pendingKind as (typeof PENDING_KINDS_V2)[number]) ||
    !Array.isArray(raw.optionEntityIds) ||
    raw.optionEntityIds.some((id) => !nonEmptyString(id))
  ) {
    return null;
  }
  const optionEntityIds = [...(raw.optionEntityIds as string[])];
  if (new Set(optionEntityIds).size !== optionEntityIds.length) return null;
  return { pendingKind: raw.pendingKind as BookingReentryV2['pendingKind'], optionEntityIds };
}

function parseDuplicateResolution(value: unknown): DuplicateResolutionEvidenceV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['kind', 'readEvidenceTurnId', 'sourcePendingVersion', 'serviceId', 'professionalId', 'date', 'time']) ||
    !requiredKeys(raw, ['kind', 'readEvidenceTurnId', 'sourcePendingVersion', 'serviceId', 'date', 'time']) ||
    raw.kind !== 'keep_both' ||
    !nonEmptyString(raw.readEvidenceTurnId) ||
    !positiveInteger(raw.sourcePendingVersion) ||
    !nonEmptyString(raw.serviceId) ||
    (raw.professionalId !== undefined && !nonEmptyString(raw.professionalId)) ||
    !validCivilDate(raw.date) ||
    !validClock(raw.time)
  ) {
    return null;
  }
  return {
    kind: 'keep_both',
    readEvidenceTurnId: raw.readEvidenceTurnId,
    sourcePendingVersion: raw.sourcePendingVersion,
    serviceId: raw.serviceId,
    ...(raw.professionalId !== undefined ? { professionalId: raw.professionalId } : {}),
    date: raw.date,
    time: raw.time,
  };
}

function parseDuplicateClearance(value: unknown): DuplicatePreflightClearanceV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['kind', 'readEvidenceTurnId', 'sourcePendingKind', 'sourcePendingVersion', 'serviceId', 'professionalId', 'date', 'time']) ||
    !requiredKeys(raw, ['kind', 'readEvidenceTurnId', 'sourcePendingKind', 'sourcePendingVersion', 'serviceId', 'date', 'time']) ||
    raw.kind !== 'no_conflict' ||
    !nonEmptyString(raw.readEvidenceTurnId) ||
    (raw.sourcePendingKind !== 'TIME' && raw.sourcePendingKind !== 'CONFIRMATION') ||
    !positiveInteger(raw.sourcePendingVersion) ||
    !nonEmptyString(raw.serviceId) ||
    (raw.professionalId !== undefined && !nonEmptyString(raw.professionalId)) ||
    !validCivilDate(raw.date) ||
    !validClock(raw.time)
  ) {
    return null;
  }
  return {
    kind: 'no_conflict',
    readEvidenceTurnId: raw.readEvidenceTurnId,
    sourcePendingKind: raw.sourcePendingKind,
    sourcePendingVersion: raw.sourcePendingVersion,
    serviceId: raw.serviceId,
    ...(raw.professionalId !== undefined ? { professionalId: raw.professionalId } : {}),
    date: raw.date,
    time: raw.time,
  };
}

function parseCancellationCandidate(value: unknown): CancellationCandidateV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['token', 'appointmentId', 'startTime', 'fingerprint', 'disposition', 'displayName']) ||
    !requiredKeys(raw, ['token', 'appointmentId', 'startTime', 'fingerprint', 'disposition', 'displayName']) ||
    !nonEmptyString(raw.token) ||
    !nonEmptyString(raw.appointmentId) ||
    !validIso(raw.startTime) ||
    !nonEmptyString(raw.fingerprint) ||
    typeof raw.disposition !== 'string' ||
    !CANCELLATION_DISPOSITIONS_V2.includes(raw.disposition as (typeof CANCELLATION_DISPOSITIONS_V2)[number]) ||
    !nonEmptyString(raw.displayName)
  ) {
    return null;
  }
  if (!raw.token.startsWith('cancel-target:') || raw.token.length <= 'cancel-target:'.length) return null;
  return {
    token: raw.token as CancellationCandidateV2['token'],
    appointmentId: raw.appointmentId,
    startTime: raw.startTime,
    fingerprint: raw.fingerprint,
    disposition: raw.disposition as CancellationCandidateV2['disposition'],
    displayName: raw.displayName,
  };
}

function parseCancellation(value: unknown): CancellationFlowV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['flowId', 'candidates', 'selectedToken', 'sourceReadTurnId']) ||
    !requiredKeys(raw, ['flowId', 'candidates', 'sourceReadTurnId']) ||
    !nonEmptyString(raw.flowId) ||
    !Array.isArray(raw.candidates) ||
    !nonEmptyString(raw.sourceReadTurnId) ||
    (raw.selectedToken !== undefined && !nonEmptyString(raw.selectedToken))
  ) {
    return null;
  }
  const candidates = raw.candidates.map(parseCancellationCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  const parsedCandidates = candidates as CancellationCandidateV2[];
  if (new Set(parsedCandidates.map((candidate) => candidate.token)).size !== parsedCandidates.length) {
    return null;
  }
  if (
    raw.selectedToken !== undefined &&
    !parsedCandidates.some((candidate) => candidate.token === raw.selectedToken)
  ) {
    return null;
  }
  return {
    flowId: raw.flowId,
    candidates: parsedCandidates,
    ...(raw.selectedToken !== undefined
      ? { selectedToken: raw.selectedToken as CancellationFlowV2['selectedToken'] }
      : {}),
    sourceReadTurnId: raw.sourceReadTurnId,
  };
}

function parseFixedByProofVersion(value: unknown): FixedByProofVersionV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, ['fixedServiceId', 'fixedProfessionalId', 'resolvedDate']) ||
    Object.values(raw).some((version) => !positiveInteger(version))
  ) {
    return null;
  }
  return {
    ...(raw.fixedServiceId !== undefined ? { fixedServiceId: raw.fixedServiceId as number } : {}),
    ...(raw.fixedProfessionalId !== undefined ? { fixedProfessionalId: raw.fixedProfessionalId as number } : {}),
    ...(raw.resolvedDate !== undefined ? { resolvedDate: raw.resolvedDate as number } : {}),
  };
}

/** Returns a fully validated, detached FlowStateV2 or null. */
export function parsePersistedFlowStateV2(value: unknown): FlowStateV2 | null {
  try {
    return parsePersistedFlowStateV2Unsafe(value);
  } catch {
    // JSON/PG input must never make hydration throw because a getter/proxy or
    // malformed nested object escaped one of the narrow validators.
    return null;
  }
}

function parsePersistedFlowStateV2Unsafe(value: unknown): FlowStateV2 | null {
  const raw = dict(value);
  if (
    !raw ||
    !keysOnly(raw, [
      'flowId',
      'lastOperationalAt',
      'fixedServiceId',
      'fixedProfessionalId',
      'resolvedDate',
      'bookingDraft',
      'slotEvidence',
      'bookingReentry',
      'duplicateResolution',
      'duplicatePreflightClearance',
      'cancellation',
      'deferredAvailability',
      'fixedByProofVersion',
    ]) ||
    !requiredKeys(raw, ['flowId', 'fixedByProofVersion']) ||
    !nonEmptyString(raw.flowId) ||
    (raw.lastOperationalAt !== undefined && !validIso(raw.lastOperationalAt)) ||
    (raw.fixedServiceId !== undefined && !nonEmptyString(raw.fixedServiceId)) ||
    (raw.fixedProfessionalId !== undefined && !nonEmptyString(raw.fixedProfessionalId)) ||
    (raw.resolvedDate !== undefined && !validCivilDate(raw.resolvedDate))
  ) {
    return null;
  }

  const fixedByProofVersion = parseFixedByProofVersion(raw.fixedByProofVersion);
  if (!fixedByProofVersion) return null;
  if (fixedByProofVersion.fixedServiceId !== undefined && raw.fixedServiceId === undefined) return null;
  if (fixedByProofVersion.fixedProfessionalId !== undefined && raw.fixedProfessionalId === undefined) return null;
  if (fixedByProofVersion.resolvedDate !== undefined && raw.resolvedDate === undefined) return null;
  if (raw.fixedServiceId !== undefined && fixedByProofVersion.fixedServiceId === undefined) return null;
  if (raw.fixedProfessionalId !== undefined && fixedByProofVersion.fixedProfessionalId === undefined) return null;
  if (raw.resolvedDate !== undefined && fixedByProofVersion.resolvedDate === undefined) return null;
  const bookingDraft = raw.bookingDraft === undefined ? undefined : parseBookingDraft(raw.bookingDraft);
  const slotEvidence = raw.slotEvidence === undefined ? undefined : parseSlotEvidence(raw.slotEvidence);
  const bookingReentry = raw.bookingReentry === undefined ? undefined : parseBookingReentry(raw.bookingReentry);
  const duplicateResolution = raw.duplicateResolution === undefined ? undefined : parseDuplicateResolution(raw.duplicateResolution);
  const duplicatePreflightClearance = raw.duplicatePreflightClearance === undefined
    ? undefined
    : parseDuplicateClearance(raw.duplicatePreflightClearance);
  const cancellation = raw.cancellation === undefined ? undefined : parseCancellation(raw.cancellation);
  const deferredAvailability = raw.deferredAvailability === undefined
    ? undefined
    : parseDeferred(raw.deferredAvailability);
  if (
    (raw.bookingDraft !== undefined && !bookingDraft) ||
    (raw.slotEvidence !== undefined && !slotEvidence) ||
    (raw.bookingReentry !== undefined && !bookingReentry) ||
    (raw.duplicateResolution !== undefined && !duplicateResolution) ||
    (raw.duplicatePreflightClearance !== undefined && !duplicatePreflightClearance) ||
    (raw.cancellation !== undefined && !cancellation) ||
    (raw.deferredAvailability !== undefined && !deferredAvailability)
  ) {
    return null;
  }

  if (bookingDraft && !slotEvidence) return null;
  if (slotEvidence) {
    if (
      raw.fixedServiceId === undefined ||
      raw.resolvedDate === undefined ||
      slotEvidence.serviceId !== raw.fixedServiceId ||
      slotEvidence.date !== raw.resolvedDate ||
      slotEvidence.professionalId !== raw.fixedProfessionalId
    ) {
      return null;
    }
  }
  if (bookingDraft && slotEvidence) {
    if (
      bookingDraft.slotEvidenceTurnId !== slotEvidence.turnId ||
      bookingDraft.serviceId !== slotEvidence.serviceId ||
      bookingDraft.professionalId !== slotEvidence.professionalId ||
      bookingDraft.date !== slotEvidence.date ||
      !slotEvidence.slots.includes(bookingDraft.time)
    ) {
      return null;
    }
  }
  if (
    bookingDraft &&
    ((raw.fixedServiceId !== undefined && raw.fixedServiceId !== bookingDraft.serviceId) ||
      (raw.fixedProfessionalId !== undefined && raw.fixedProfessionalId !== bookingDraft.professionalId) ||
      (raw.resolvedDate !== undefined && raw.resolvedDate !== bookingDraft.date))
  ) {
    return null;
  }
  const validateOperationalEvidence = (evidence: {
    serviceId: string;
    professionalId?: string;
    date: string;
    time: string;
  }): boolean => {
    if (
      raw.fixedServiceId === undefined ||
      raw.resolvedDate === undefined ||
      (evidence.professionalId !== undefined && raw.fixedProfessionalId === undefined)
    ) {
      return false;
    }
    if (
      raw.fixedServiceId !== undefined && evidence.serviceId !== raw.fixedServiceId ||
      raw.fixedProfessionalId !== undefined && evidence.professionalId !== raw.fixedProfessionalId ||
      raw.resolvedDate !== undefined && evidence.date !== raw.resolvedDate
    ) {
      return false;
    }
    if (bookingDraft && (
      evidence.serviceId !== bookingDraft.serviceId ||
      evidence.professionalId !== bookingDraft.professionalId ||
      evidence.date !== bookingDraft.date ||
      evidence.time !== bookingDraft.time
    )) {
      return false;
    }
    if (slotEvidence && (
      evidence.serviceId !== slotEvidence.serviceId ||
      evidence.professionalId !== slotEvidence.professionalId ||
      evidence.date !== slotEvidence.date ||
      !slotEvidence.slots.includes(evidence.time)
    )) {
      return false;
    }
    return true;
  };
  if (
    (duplicateResolution && !validateOperationalEvidence(duplicateResolution)) ||
    (duplicatePreflightClearance && !validateOperationalEvidence(duplicatePreflightClearance))
  ) {
    return null;
  }
  if (cancellation && cancellation.flowId !== raw.flowId) return null;

  return {
    flowId: raw.flowId,
    ...(raw.lastOperationalAt !== undefined ? { lastOperationalAt: raw.lastOperationalAt } : {}),
    ...(raw.fixedServiceId !== undefined ? { fixedServiceId: raw.fixedServiceId } : {}),
    ...(raw.fixedProfessionalId !== undefined ? { fixedProfessionalId: raw.fixedProfessionalId } : {}),
    ...(raw.resolvedDate !== undefined ? { resolvedDate: raw.resolvedDate } : {}),
    ...(bookingDraft ? { bookingDraft } : {}),
    ...(slotEvidence ? { slotEvidence } : {}),
    ...(bookingReentry ? { bookingReentry } : {}),
    ...(duplicateResolution ? { duplicateResolution } : {}),
    ...(duplicatePreflightClearance ? { duplicatePreflightClearance } : {}),
    ...(cancellation ? { cancellation } : {}),
    ...(deferredAvailability ? { deferredAvailability } : {}),
    fixedByProofVersion,
  };
}
