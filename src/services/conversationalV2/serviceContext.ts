import type { TenantBotConfig } from '../../configProvider';
import type { ServicesResult } from '../calendarService';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  listCatalogEntityMatchesFromCurrentMessage,
  resolveUniqueCatalogEntityFromCurrentMessage,
} from '../service-gate';
import type {
  ReceptionistModelLoopResult,
  ReceptionistToolTraceEntry,
} from '../brainService';
import { professionalSelectionGate } from '../professional-selection-gate';
import { filterSlotsAtOrAfterNow } from '../calendarService';
import type {
  BookingDraftV2,
  DeferredAvailabilityConstraintV2,
  DeferredAvailabilityTimeWindowV2,
  FlowStateV2,
  ModelTurnResultV2,
  ServiceContextReceiptDecisionV2,
  TurnFrameV2,
} from './contracts';
import {
  maskOrdinalOptionSpansV2,
  type CurrentDateResolutionV2,
} from './currentDateResolution';
import { civilTodayV2, normalizeTemporalAssertionsV2 } from './temporalNormalizer';
import {
  clauseMatchHasPositivePolarityV2,
  splitClausesV2,
} from './polarity';
import {
  catalogFamilyHasPositiveWitnessV2,
  materializeServiceClarificationV2,
  selectCatalogServicesByIdsV2,
} from './serviceList';
import {
  hasPositiveExplicitBookingVerbV2,
} from './flowSession';
import { hasExplicitAvailabilityReadRequestV2 } from './readFastPaths';
import {
  buildCanonicalBookingSummaryV2,
  displayDateV2,
  reduceToolLifecycleV2,
} from './lifecycleReducer';
import { DATE_PENDING_QUESTION_V2 } from './pendingQuestion';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import {
  canonicalReadFailureCopyV2,
  type ReadFastPathReasonV2,
} from './readFastPaths';

export const DEFERRED_AVAILABILITY_MAX_AGE_MS_V2 = 4 * 60 * 60 * 1_000;

export const SERVICE_CONTEXT_REJECTED_COPY_V2 =
  'Entendi — não é uma dessas opções. Qual serviço você procura?';

export type ServiceCorrectionDecisionV2 =
  | { kind: 'none' }
  | { kind: 'select_outside_pending'; serviceId: string }
  | { kind: 'clarify_positive_candidates'; serviceIds: string[] }
  | { kind: 'reject_pending'; negatedServiceIds: string[] }
  | { kind: 'ambiguous_negation'; mentionedServiceIds: string[] };

export type ServiceContextDecisionV2 =
  | { kind: 'none' }
  | {
      kind: 'deferred_family_clarification';
      serviceIds: string[];
      constraint: DeferredAvailabilityConstraintV2;
    }
  | {
      kind: 'deferred_open_service_question';
      constraint: DeferredAvailabilityConstraintV2;
    }
  | Exclude<ServiceCorrectionDecisionV2, { kind: 'none' }>;

export type CapturedDeferredAvailabilityV2 =
  | { kind: 'none' }
  | { kind: 'vague_period' }
  | { kind: 'conflict' }
  | { kind: 'captured'; constraint: DeferredAvailabilityConstraintV2 };

export type ServiceContextPlanV2 = {
  decision: ServiceContextDecisionV2;
  receipt: ServiceContextReceiptDecisionV2;
  vetoFamilyFastPath: boolean;
  capturedConstraint: DeferredAvailabilityConstraintV2 | null;
  result: ModelTurnResultV2 | null;
  nextFlowState: FlowStateV2 | null;
  selectedServiceId?: string;
};

const TIME_TOKEN_SRC =
  '(?:[01]?\\d|2[0-3])(?:[:h][0-5]\\d)?|(?:[01]?\\d|2[0-3])\\s+e\\s+meia';
const PERIOD_TOKEN = '(?:manha|tarde|noite|madrugada)';
const VAGUE_PERIOD_RE = new RegExp(
  String.raw`\b(?:(?:de|pela|a|ao|na|no)\s+${PERIOD_TOKEN}|(?:no\s+)?periodo\s+d[aeo]\s+${PERIOD_TOKEN})\b`,
  'u'
);
const POLARITY_AMBIGUITY_RE = /\bnao\s+e\s+so\b/u;
const CORRECTION_DISCOURSE_RE =
  /\b(?:nao|nunca|na\s+verdade|melhor|quer\s+dizer|corrigindo|pera(?:i)?|alias|mudei\s+de\s+ideia|agora\s+quero|em\s+vez|ao\s+inves)\b/u;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function pendingFresh(frame: TurnFrameV2, now: Date): boolean {
  if (!frame.pending) return false;
  const askedAt = Date.parse(frame.pending.askedAt);
  return (
    frame.pending.flowId === frame.flowState.flowId &&
    Number.isFinite(askedAt) &&
    now.getTime() - askedAt <= PENDING_FAST_PATH_MAX_AGE_MS
  );
}

function parseClockToMinutes(raw: string): number | null {
  const text = normalize(raw).replace(/^(?:as|das?|de)\s+/u, '');
  const meia = /^([01]?\d|2[0-3])\s+e\s+meia$/u.exec(text);
  if (meia) return Number(meia[1]) * 60 + 30;
  const clock = /^([01]?\d|2[0-3])(?:[:h]([0-5]\d))?$/u.exec(text);
  if (!clock) return null;
  return Number(clock[1]) * 60 + Number(clock[2] ?? 0);
}

function minutesFromNormalizedTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function slotMinutesV2(slot: string): number | null {
  return minutesFromNormalizedTime(slot);
}

export function displayClockFromMinutesV2(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, '0')}`;
}

export function inboundHasVaguePeriodV2(text: string): boolean {
  const masked = maskOrdinalOptionSpansV2(normalize(text));
  return VAGUE_PERIOD_RE.test(masked);
}

export function inboundHasOperationalTemporalComponentV2(text: string): boolean {
  const masked = maskOrdinalOptionSpansV2(normalize(text));
  if (inboundHasVaguePeriodV2(text)) return true;
  if (normalizeTemporalAssertionsV2(masked).length > 0) return true;
  return false;
}

function sameTimeWindow(
  left: DeferredAvailabilityTimeWindowV2,
  right: DeferredAvailabilityTimeWindowV2
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'BETWEEN_INCLUSIVE' && right.kind === 'BETWEEN_INCLUSIVE') {
    return left.startMinute === right.startMinute && left.endMinute === right.endMinute;
  }
  if ('minuteOfDay' in left && 'minuteOfDay' in right) {
    return left.minuteOfDay === right.minuteOfDay;
  }
  return false;
}

function collectOperatorWindows(masked: string): {
  windows: DeferredAvailabilityTimeWindowV2[];
  conflict: boolean;
} {
  const windows: DeferredAvailabilityTimeWindowV2[] = [];
  const between = new RegExp(
    `\\bentre\\s+(${TIME_TOKEN_SRC})\\s+e\\s+(${TIME_TOKEN_SRC})\\b`,
    'gu'
  );
  for (const match of masked.matchAll(between)) {
    const start = parseClockToMinutes(match[1] ?? '');
    const end = parseClockToMinutes(match[2] ?? '');
    if (start === null || end === null || start > end) {
      return { windows: [], conflict: true };
    }
    windows.push({
      kind: 'BETWEEN_INCLUSIVE',
      startMinute: start,
      endMinute: end,
    });
  }
  const operators: Array<{
    re: RegExp;
    kind: Exclude<DeferredAvailabilityTimeWindowV2['kind'], 'BETWEEN_INCLUSIVE'>;
  }> = [
    {
      re: new RegExp(
        `\\ba\\s+partir\\s+(?:das?|de|as)\\s+(${TIME_TOKEN_SRC})\\b`,
        'gu'
      ),
      kind: 'AT_OR_AFTER',
    },
    {
      re: new RegExp(
        `\\b(?:depois|apos)\\s+(?:das?|de|as)\\s+(${TIME_TOKEN_SRC})\\b`,
        'gu'
      ),
      kind: 'AFTER_EXCLUSIVE',
    },
    {
      re: new RegExp(`\\bantes\\s+(?:das?|de|as)\\s+(${TIME_TOKEN_SRC})\\b`, 'gu'),
      kind: 'BEFORE_EXCLUSIVE',
    },
    {
      re: new RegExp(`\\bate\\s+(?:(?:as|das)\\s+)?(${TIME_TOKEN_SRC})\\b`, 'gu'),
      kind: 'AT_OR_BEFORE',
    },
  ];
  const covered = new Set<string>();
  for (const match of masked.matchAll(between)) {
    if (match[1]) covered.add(normalize(match[1]));
    if (match[2]) covered.add(normalize(match[2]));
  }
  for (const operator of operators) {
    for (const match of masked.matchAll(operator.re)) {
      const minutes = parseClockToMinutes(match[1] ?? '');
      if (minutes === null) return { windows: [], conflict: true };
      covered.add(normalize(match[1] ?? ''));
      windows.push({ kind: operator.kind, minuteOfDay: minutes });
    }
  }
  const assertions = normalizeTemporalAssertionsV2(masked).filter(
    (assertion) => assertion.kind === 'time'
  );
  for (const assertion of assertions) {
    const raw = normalize(assertion.raw);
    if ([...covered].some((token) => raw.includes(token) || token.includes(raw))) {
      continue;
    }
    const minutes = minutesFromNormalizedTime(assertion.normalized);
    if (minutes === null) continue;
    windows.push({ kind: 'EXACT', minuteOfDay: minutes });
  }
  if (windows.length === 0) return { windows: [], conflict: false };
  const first = windows[0]!;
  if (windows.some((window) => !sameTimeWindow(window, first))) {
    return { windows: [], conflict: true };
  }
  return { windows: [first], conflict: false };
}

export function captureDeferredAvailabilityConstraintV2(input: {
  inboundText: string;
  dateResolution: CurrentDateResolutionV2;
  now: Date;
  turnId: string;
  inputSequence: number;
}): CapturedDeferredAvailabilityV2 {
  const masked = maskOrdinalOptionSpansV2(normalize(input.inboundText));
  if (input.dateResolution.kind === 'ambiguous') {
    return { kind: 'conflict' };
  }
  const collected = collectOperatorWindows(masked);
  if (collected.conflict) return { kind: 'conflict' };
  const timeWindow = collected.windows[0];
  const vague = inboundHasVaguePeriodV2(input.inboundText);
  if (vague && !timeWindow) return { kind: 'vague_period' };
  const date =
    input.dateResolution.kind === 'resolved' ? input.dateResolution.date : undefined;
  if (!date && !timeWindow) return { kind: 'none' };
  return {
    kind: 'captured',
    constraint: {
      schemaVersion: 1,
      capturedAt: input.now.toISOString(),
      capturedTurnId: input.turnId,
      capturedInputSequence: input.inputSequence,
      ...(date ? { date } : {}),
      ...(timeWindow ? { timeWindow } : {}),
    },
  };
}

export function isDeferredAvailabilityConsumableV2(
  constraint: DeferredAvailabilityConstraintV2 | undefined,
  flowId: string,
  now: Date
): constraint is DeferredAvailabilityConstraintV2 {
  if (!constraint || constraint.schemaVersion !== 1) return false;
  if (constraint.capturedTurnId && flowId.length === 0) return false;
  const capturedAt = Date.parse(constraint.capturedAt);
  return (
    Number.isFinite(capturedAt) &&
    now.getTime() - capturedAt <= DEFERRED_AVAILABILITY_MAX_AGE_MS_V2
  );
}

export function pruneDeferredAvailabilityV2(
  flowState: FlowStateV2,
  now: Date
): FlowStateV2 {
  const constraint = flowState.deferredAvailability;
  if (!constraint) return flowState;
  if (isDeferredAvailabilityConsumableV2(constraint, flowState.flowId, now)) {
    return flowState;
  }
  const { deferredAvailability: _deferred, ...rest } = flowState;
  return rest;
}

export function withDeferredAvailabilityV2(
  flowState: FlowStateV2,
  constraint: DeferredAvailabilityConstraintV2 | null | undefined
): FlowStateV2 {
  if (!constraint) {
    const { deferredAvailability: _deferred, ...rest } = flowState;
    return rest;
  }
  return { ...flowState, deferredAvailability: constraint };
}

export function applyServiceChangeToFlowStateV2(
  flowState: FlowStateV2,
  serviceId: string,
  catalog: ServicesResult
): FlowStateV2 {
  const service = catalog.services?.find((entry) => entry.id === serviceId);
  const active = catalog.professionals ?? [];
  const eligible =
    service?.professionalIds === undefined
      ? active
      : active.filter((entry) => service.professionalIds!.includes(entry.id));
  const previousProfessional = flowState.fixedProfessionalId;
  const professionalStillEligible = previousProfessional
    ? eligible.some((entry) => entry.id === previousProfessional)
    : false;
  const {
    slotEvidence: _slotEvidence,
    bookingDraft: _bookingDraft,
    duplicateResolution: _duplicateResolution,
    duplicatePreflightClearance: _duplicatePreflightClearance,
    resolvedDate: _resolvedDate,
    fixedProfessionalId: _fixedProfessionalId,
    ...rest
  } = flowState;
  const nextVersion = (flowState.fixedByProofVersion.fixedServiceId ?? 0) + 1;
  const keepProfessional =
    eligible.length === 1
      ? eligible[0]!.id
      : professionalStillEligible
        ? previousProfessional
        : undefined;
  const fixedByProofVersion = { ...rest.fixedByProofVersion, fixedServiceId: nextVersion };
  delete fixedByProofVersion.resolvedDate;
  if (keepProfessional) {
    fixedByProofVersion.fixedProfessionalId = nextVersion;
  } else {
    delete fixedByProofVersion.fixedProfessionalId;
  }
  return {
    ...rest,
    fixedServiceId: serviceId,
    ...(keepProfessional ? { fixedProfessionalId: keepProfessional } : {}),
    fixedByProofVersion,
  };
}

export function formatDeferredConstraintPhraseV2(
  constraint: DeferredAvailabilityConstraintV2,
  now: Date,
  timezone: string
): string {
  const parts: string[] = [];
  if (constraint.date) {
    const today = civilTodayV2(now, timezone);
    parts.push(
      constraint.date === today
        ? 'hoje'
        : constraint.date === addCivilDays(today, 1)
          ? 'amanhã'
          : displayDateV2(constraint.date)
    );
  }
  const window = constraint.timeWindow;
  if (window) {
    if (window.kind === 'BETWEEN_INCLUSIVE') {
      parts.push(
        `entre ${displayClockFromMinutesV2(window.startMinute)} e ${displayClockFromMinutesV2(window.endMinute)}`
      );
    } else {
      const clock = displayClockFromMinutesV2(window.minuteOfDay);
      if (window.kind === 'AFTER_EXCLUSIVE') parts.push(`depois das ${clock}`);
      else if (window.kind === 'AT_OR_AFTER') parts.push(`a partir das ${clock}`);
      else if (window.kind === 'BEFORE_EXCLUSIVE') parts.push(`antes das ${clock}`);
      else if (window.kind === 'AT_OR_BEFORE') parts.push(`até ${clock}`);
      else parts.push(`às ${clock}`);
    }
  }
  return parts.join(' ');
}

function addCivilDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

function joinServiceNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} ou ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} ou ${names.at(-1)}`;
}

export function buildDeferredFamilyClarificationCopyV2(
  constraint: DeferredAvailabilityConstraintV2,
  names: readonly string[],
  now: Date,
  timezone: string
): string {
  const phrase = formatDeferredConstraintPhraseV2(constraint, now, timezone);
  return `Para eu verificar ${phrase}, qual destes serviços você quer: ${joinServiceNames(names)}?`;
}

export function buildEmptyDeferredAvailabilityCopyV2(
  _constraint: DeferredAvailabilityConstraintV2,
  _now: Date,
  _timezone: string
): string {
  return 'Não encontrei horário dentro da restrição que você pediu. Qual outro dia ou período você prefere?';
}

export function buildPolarityAmbiguityCopyV2(canonicalName: string): string {
  return `Só para confirmar: você quer ${canonicalName} ou está dizendo que não é ${canonicalName}?`;
}

export function slotMatchesDeferredTimeWindowV2(
  slot: string,
  window: DeferredAvailabilityTimeWindowV2
): boolean {
  const minutes = slotMinutesV2(slot);
  if (minutes === null) return false;
  switch (window.kind) {
    case 'EXACT':
      return minutes === window.minuteOfDay;
    case 'AFTER_EXCLUSIVE':
      return minutes > window.minuteOfDay;
    case 'AT_OR_AFTER':
      return minutes >= window.minuteOfDay;
    case 'BEFORE_EXCLUSIVE':
      return minutes < window.minuteOfDay;
    case 'AT_OR_BEFORE':
      return minutes <= window.minuteOfDay;
    case 'BETWEEN_INCLUSIVE':
      return minutes >= window.startMinute && minutes <= window.endMinute;
  }
}

export function filterSlotsByDeferredWindowV2(
  slots: readonly string[],
  window: DeferredAvailabilityTimeWindowV2 | undefined
): string[] {
  if (!window) return [...slots];
  return slots.filter((slot) => slotMatchesDeferredTimeWindowV2(slot, window));
}

function catalogMatchOptions() {
  return {
    allowRestrictedDistanceTwo: ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  } as const;
}

function inboundLooksLikeServiceCorrectionV2(input: {
  inboundText: string;
  frame: TurnFrameV2;
  catalog: ServicesResult;
}): boolean {
  const text = normalize(input.inboundText);
  if (CORRECTION_DISCOURSE_RE.test(text) || POLARITY_AMBIGUITY_RE.test(text)) {
    return true;
  }
  const pending = input.frame.pending;
  if (!pending || pending.kind !== 'SERVICE') return false;
  const allow = new Set(pending.options.map((option) => option.entityId));
  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(
    input.inboundText,
    input.catalog.services ?? [],
    catalogMatchOptions()
  );
  if (resolution.kind === 'resolved') return !allow.has(resolution.entity.id);
  if (resolution.kind === 'ambiguous') {
    return resolution.entityIds.some((entityId) => !allow.has(entityId));
  }
  return false;
}

function polarityForMatchInClause(
  clause: string,
  entityId: string,
  catalog: ServicesResult
): boolean {
  const service = catalog.services?.find((entry) => entry.id === entityId);
  const name = normalize(service?.name ?? '');
  const index = name ? normalize(clause).indexOf(name) : -1;
  if (index >= 0) return clauseMatchHasPositivePolarityV2(normalize(clause), index);
  return clauseMatchHasPositivePolarityV2(normalize(clause), 0);
}

export function resolveServiceCorrectionDecisionV2(input: {
  inboundText: string;
  frame: TurnFrameV2;
  catalog: ServicesResult;
  now: Date;
}): ServiceCorrectionDecisionV2 {
  const pending = input.frame.pending;
  if (
    !pending ||
    pending.kind !== 'SERVICE' ||
    !pendingFresh(input.frame, input.now)
  ) {
    return { kind: 'none' };
  }
  const services = input.catalog.services ?? [];
  if (services.length === 0) return { kind: 'none' };
  const normalized = normalize(input.inboundText);
  if (POLARITY_AMBIGUITY_RE.test(normalized)) {
    const mentioned = resolveUniqueCatalogEntityFromCurrentMessage(
      input.inboundText,
      services,
      catalogMatchOptions()
    );
    if (mentioned.kind === 'resolved') {
      return {
        kind: 'ambiguous_negation',
        mentionedServiceIds: [mentioned.entity.id],
      };
    }
    const matches = listCatalogEntityMatchesFromCurrentMessage(
      input.inboundText,
      services,
      catalogMatchOptions()
    );
    if (matches.length === 1) {
      return {
        kind: 'ambiguous_negation',
        mentionedServiceIds: [matches[0]!.id],
      };
    }
    return { kind: 'ambiguous_negation', mentionedServiceIds: [] };
  }
  const allow = new Set(pending.options.map((option) => option.entityId));
  const exactName = services.filter((entry) => normalize(entry.name) === normalized);
  if (exactName.length === 1) {
    const serviceId = exactName[0]!.id;
    if (!allow.has(serviceId)) {
      return { kind: 'select_outside_pending', serviceId };
    }
    if (!inboundLooksLikeServiceCorrectionV2(input)) {
      return { kind: 'none' };
    }
  } else if (!inboundLooksLikeServiceCorrectionV2(input)) {
    return { kind: 'none' };
  }
  const clauses = splitClausesV2(input.inboundText.replace(/;/g, '.'));
  const positive = new Set<string>();
  const negative = new Set<string>();
  const clauseTexts = clauses.length > 0 ? clauses : [input.inboundText];
  for (const clause of clauseTexts) {
    const matches = listCatalogEntityMatchesFromCurrentMessage(
      clause,
      services,
      catalogMatchOptions()
    );
    for (const match of matches) {
      if (polarityForMatchInClause(clause, match.id, input.catalog)) {
        positive.add(match.id);
      } else {
        negative.add(match.id);
      }
    }
  }
  for (const entityId of negative) positive.delete(entityId);
  const positiveIds = [...positive];
  const negativeIds = [...negative];
  if (positiveIds.length === 1) {
    return { kind: 'select_outside_pending', serviceId: positiveIds[0]! };
  }
  if (positiveIds.length > 1) {
    return { kind: 'clarify_positive_candidates', serviceIds: positiveIds };
  }
  if (negativeIds.length > 0) {
    return { kind: 'reject_pending', negatedServiceIds: negativeIds };
  }
  return { kind: 'none' };
}

function modelResult(input: {
  reply: string;
  purpose: ModelTurnResultV2['replyPurpose'];
  transition: ModelTurnResultV2['pendingTransitionCandidate'];
}): ModelTurnResultV2 {
  return {
    schemaVersion: 2,
    reply: input.reply,
    replyPurpose: input.purpose,
    pendingTransitionCandidate: input.transition,
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

function receiptForDecision(
  decision: ServiceContextDecisionV2
): ServiceContextReceiptDecisionV2 {
  switch (decision.kind) {
    case 'deferred_family_clarification':
    case 'deferred_open_service_question':
      return 'temporal_deferred';
    case 'select_outside_pending':
      return 'outside_pending_selection';
    case 'clarify_positive_candidates':
      return 'positive_reclarification';
    case 'reject_pending':
    case 'ambiguous_negation':
      return 'negative_clarification';
    default:
      return 'not_applicable';
  }
}

export function planServiceContextV2(input: {
  enabled: boolean;
  frame: TurnFrameV2;
  inboundText: string;
  catalog: ServicesResult;
  now: Date;
  dateResolution: CurrentDateResolutionV2;
  timezone: string;
  turnId: string;
  inputSequence: number;
}): ServiceContextPlanV2 {
  const empty: ServiceContextPlanV2 = {
    decision: { kind: 'none' },
    receipt: input.enabled ? 'not_applicable' : 'disabled',
    vetoFamilyFastPath: false,
    capturedConstraint: null,
    result: null,
    nextFlowState: null,
  };
  if (!input.enabled) return empty;
  const frame = {
    ...input.frame,
    flowState: pruneDeferredAvailabilityV2(input.frame.flowState, input.now),
  };
  const correction = resolveServiceCorrectionDecisionV2({
    inboundText: input.inboundText,
    frame,
    catalog: input.catalog,
    now: input.now,
  });
  const preservedConstraint = isDeferredAvailabilityConsumableV2(
    frame.flowState.deferredAvailability,
    frame.flowState.flowId,
    input.now
  )
    ? frame.flowState.deferredAvailability
    : undefined;
  if (correction.kind === 'ambiguous_negation') {
    const mentionedId = correction.mentionedServiceIds[0];
    const name =
      input.catalog.services?.find((entry) => entry.id === mentionedId)?.name ??
      'esse serviço';
    return {
      decision: correction,
      receipt: 'negative_clarification',
      vetoFamilyFastPath: true,
      capturedConstraint: preservedConstraint ?? null,
      result: modelResult({
        reply: buildPolarityAmbiguityCopyV2(name),
        purpose: 'CLARIFICATION',
        transition: frame.pending
          ? { kind: 'invalidate', questionId: frame.pending.questionId, reason: 'service_polarity_ambiguity' }
          : { kind: 'preserve' },
      }),
      nextFlowState: withDeferredAvailabilityV2(
        frame.flowState,
        preservedConstraint ?? null
      ),
    };
  }
  if (correction.kind === 'reject_pending') {
    return {
      decision: correction,
      receipt: 'negative_clarification',
      vetoFamilyFastPath: true,
      capturedConstraint: preservedConstraint ?? null,
      result: modelResult({
        reply: SERVICE_CONTEXT_REJECTED_COPY_V2,
        purpose: 'SERVICE_QUESTION',
        transition: frame.pending
          ? { kind: 'invalidate', questionId: frame.pending.questionId, reason: 'service_pending_rejected' }
          : { kind: 'preserve' },
      }),
      nextFlowState: withDeferredAvailabilityV2(
        frame.flowState,
        preservedConstraint ?? null
      ),
    };
  }
  if (correction.kind === 'clarify_positive_candidates') {
    const subset = selectCatalogServicesByIdsV2(input.catalog, correction.serviceIds);
    const materialized = materializeServiceClarificationV2(subset);
    if (!materialized || materialized.visibleServiceIds.length === 0) {
      return {
        ...empty,
        decision: correction,
        receipt: 'positive_reclarification',
        vetoFamilyFastPath: true,
        capturedConstraint: preservedConstraint ?? null,
      };
    }
    const names = materialized.visibleServiceIds
      .map((id) => subset.find((entry) => entry.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return {
      decision: correction,
      receipt: 'positive_reclarification',
      vetoFamilyFastPath: true,
      capturedConstraint: preservedConstraint ?? null,
      result: modelResult({
        reply: `Qual destes serviços você quer: ${joinServiceNames(names)}?`,
        purpose: 'SERVICE_QUESTION',
        transition: {
          kind: 'open',
          pendingKind: 'SERVICE',
          flowId: frame.flowState.flowId,
          optionEntityIds: materialized.visibleServiceIds,
        },
      }),
      nextFlowState: withDeferredAvailabilityV2(
        frame.flowState,
        preservedConstraint ?? null
      ),
    };
  }
  if (correction.kind === 'select_outside_pending') {
    return {
      decision: correction,
      receipt: 'outside_pending_selection',
      vetoFamilyFastPath: true,
      capturedConstraint: preservedConstraint ?? null,
      result: null,
      nextFlowState: withDeferredAvailabilityV2(
        applyServiceChangeToFlowStateV2(
          frame.flowState,
          correction.serviceId,
          input.catalog
        ),
        preservedConstraint ?? null
      ),
      selectedServiceId: correction.serviceId,
    };
  }

  const captured = captureDeferredAvailabilityConstraintV2({
    inboundText: input.inboundText,
    dateResolution: input.dateResolution,
    now: input.now,
    turnId: input.turnId,
    inputSequence: input.inputSequence,
  });
  const temporal = inboundHasOperationalTemporalComponentV2(input.inboundText);
  const availabilityOrBooking =
    hasExplicitAvailabilityReadRequestV2(input.inboundText) ||
    hasPositiveExplicitBookingVerbV2(input.inboundText);
  if (captured.kind === 'vague_period' || captured.kind === 'conflict') {
    return {
      ...empty,
      vetoFamilyFastPath: temporal && availabilityOrBooking,
      receipt: temporal ? 'temporal_deferred' : 'not_applicable',
    };
  }
  const constraint =
    captured.kind === 'captured' ? captured.constraint : preservedConstraint ?? null;
  if (!constraint || !availabilityOrBooking) {
    return {
      ...empty,
      capturedConstraint: constraint,
      vetoFamilyFastPath: false,
      nextFlowState: constraint
        ? withDeferredAvailabilityV2(frame.flowState, constraint)
        : null,
    };
  }
  if (frame.pending && pendingFresh(frame, input.now)) {
    return {
      ...empty,
      capturedConstraint: constraint,
      nextFlowState: withDeferredAvailabilityV2(frame.flowState, constraint),
      receipt: 'temporal_deferred',
      vetoFamilyFastPath: temporal,
    };
  }
  const services = input.catalog.services ?? [];
  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(
    input.inboundText,
    services,
    catalogMatchOptions()
  );
  if (resolution.kind === 'resolved') {
    return {
      decision: { kind: 'none' },
      receipt: 'temporal_deferred',
      vetoFamilyFastPath: true,
      capturedConstraint: constraint,
      result: null,
      nextFlowState: withDeferredAvailabilityV2(
        applyServiceChangeToFlowStateV2(
          frame.flowState,
          resolution.entity.id,
          input.catalog
        ),
        constraint
      ),
      selectedServiceId: resolution.entity.id,
    };
  }
  if (
    frame.flowState.fixedServiceId &&
    services.some((entry) => entry.id === frame.flowState.fixedServiceId)
  ) {
    return {
      decision: { kind: 'none' },
      receipt: 'temporal_deferred',
      vetoFamilyFastPath: true,
      capturedConstraint: constraint,
      result: null,
      nextFlowState: withDeferredAvailabilityV2(frame.flowState, constraint),
    };
  }
  if (
    resolution.kind === 'ambiguous' &&
    catalogFamilyHasPositiveWitnessV2(
      input.inboundText,
      resolution.entityIds,
      services
    )
  ) {
    const subset = selectCatalogServicesByIdsV2(input.catalog, resolution.entityIds);
    const materialized = materializeServiceClarificationV2(subset);
    if (materialized && materialized.visibleServiceIds.length > 0) {
      const names = materialized.visibleServiceIds
        .map((id) => subset.find((entry) => entry.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      const decision: ServiceContextDecisionV2 = {
        kind: 'deferred_family_clarification',
        serviceIds: materialized.visibleServiceIds,
        constraint,
      };
      return {
        decision,
        receipt: receiptForDecision(decision),
        vetoFamilyFastPath: true,
        capturedConstraint: constraint,
        result: modelResult({
          reply: buildDeferredFamilyClarificationCopyV2(
            constraint,
            names,
            input.now,
            input.timezone
          ),
          purpose: 'SERVICE_QUESTION',
          transition: {
            kind: 'open',
            pendingKind: 'SERVICE',
            flowId: frame.flowState.flowId,
            optionEntityIds: materialized.visibleServiceIds,
          },
        }),
        nextFlowState: withDeferredAvailabilityV2(frame.flowState, constraint),
      };
    }
  }
  const decision: ServiceContextDecisionV2 = {
    kind: 'deferred_open_service_question',
    constraint,
  };
  return {
    decision,
    receipt: 'temporal_deferred',
    vetoFamilyFastPath: true,
    capturedConstraint: constraint,
    result: null,
    nextFlowState: withDeferredAvailabilityV2(frame.flowState, constraint),
  };
}

function eligibleProfessionals(
  serviceId: string,
  catalog: ServicesResult
): Array<{ id: string; name: string }> {
  const service = catalog.services?.find((entry) => entry.id === serviceId);
  const active = catalog.professionals ?? [];
  if (!service) return [];
  return service.professionalIds === undefined
    ? active
    : active.filter((entry) => service.professionalIds!.includes(entry.id));
}

export function serviceSelectionFollowUpWithConstraintV2(input: {
  serviceId: string;
  frame: TurnFrameV2;
  catalog: ServicesResult;
  now: Date;
  timezone: string;
}): { result: ModelTurnResultV2; nextFlowState: FlowStateV2 } | null {
  const service = input.catalog.services?.find((entry) => entry.id === input.serviceId);
  if (!service) return null;
  const eligible = eligibleProfessionals(input.serviceId, input.catalog);
  const nextFlowState = applyServiceChangeToFlowStateV2(
    pruneDeferredAvailabilityV2(input.frame.flowState, input.now),
    input.serviceId,
    input.catalog
  );
  const constraint = nextFlowState.deferredAvailability;
  if (eligible.length === 0) {
    const alternatives = (input.catalog.services ?? [])
      .filter((entry) => entry.id !== input.serviceId)
      .map((entry) => entry.id);
    return {
      nextFlowState,
      result: modelResult({
        reply:
          'Esse serviço está temporariamente sem profissional disponível. Qual outro serviço você prefere?',
        purpose: 'SERVICE_QUESTION',
        transition:
          alternatives.length > 0
            ? {
                kind: 'open',
                pendingKind: 'SERVICE',
                flowId: input.frame.flowState.flowId,
                optionEntityIds: alternatives,
              }
            : { kind: 'preserve' },
      }),
    };
  }
  if (eligible.length > 1 && !nextFlowState.fixedProfessionalId) {
    return {
      nextFlowState,
      result: modelResult({
        reply: `Você prefere ${eligible.map((entry) => entry.name).join(' ou ')} ou tanto faz?`,
        purpose: 'PROFESSIONAL_QUESTION',
        transition: {
          kind: 'open',
          pendingKind: 'PROFESSIONAL',
          flowId: input.frame.flowState.flowId,
          optionEntityIds: eligible.map((entry) => entry.id),
        },
      }),
    };
  }
  if (!constraint?.date) {
    return {
      nextFlowState,
      result: modelResult({
        reply: `Perfeito. ${DATE_PENDING_QUESTION_V2}`,
        purpose: 'DATE_TIME_QUESTION',
        transition: {
          kind: 'open',
          pendingKind: 'DATE',
          flowId: input.frame.flowState.flowId,
          optionEntityIds: ['date-freeform'],
        },
      }),
    };
  }
  return {
    nextFlowState,
    result: modelResult({
      reply: `Perfeito. ${DATE_PENDING_QUESTION_V2}`,
      purpose: 'DATE_TIME_QUESTION',
      transition: {
        kind: 'open',
        pendingKind: 'DATE',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: ['date-freeform'],
      },
    }),
  };
}

function availabilityQueryFailureReason(
  parsed: Record<string, unknown> | null
): ReadFastPathReasonV2 {
  if (parsed?.success === true) return 'invalid_payload';
  const reason = String(parsed?.reason ?? 'other');
  return reason === 'executor_error' ||
    reason === 'invalid_payload' ||
    reason === 'rate_limited'
    ? reason
    : 'other';
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validSlots(
  parsed: Record<string, unknown> | null,
  now?: Date,
  timezone?: string,
  date?: string
): string[] | null {
  if (!Array.isArray(parsed?.slots)) return null;
  const slots = parsed.slots.filter(
    (slot): slot is string =>
      typeof slot === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)
  );
  if (slots.length !== parsed.slots.length) return null;
  const unique = [...new Set(slots)];
  if (now && timezone && date) {
    return filterSlotsAtOrAfterNow({ date, slots: unique, now, timezone });
  }
  return unique;
}

function loopForReads(trace: readonly ReceptionistToolTraceEntry[]): ReceptionistModelLoopResult {
  return {
    rawReply: null,
    exhausted: false,
    provider: 'openai',
    model: 'service-context-v2',
    providerReportedModels: [],
    rounds: 0,
    messages: [],
    toolTrace: [...trace],
    usage: [],
  };
}

export type DeferredAvailabilityConsumptionV2 =
  | { kind: 'continue'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      nextFlowState: FlowStateV2;
      loop: ReceptionistModelLoopResult;
    };

export async function consumeDeferredAvailabilityV2(input: {
  frame: TurnFrameV2;
  flowState: FlowStateV2;
  inboundText: string;
  catalog: ServicesResult;
  config: TenantBotConfig;
  now: Date;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<DeferredAvailabilityConsumptionV2> {
  const flowState = pruneDeferredAvailabilityV2(input.flowState, input.now);
  const constraint = flowState.deferredAvailability;
  if (
    !constraint ||
    !isDeferredAvailabilityConsumableV2(constraint, flowState.flowId, input.now)
  ) {
    return { kind: 'continue', reason: 'constraint_not_consumable' };
  }
  const serviceId = flowState.fixedServiceId;
  if (!serviceId || !input.catalog.services?.some((entry) => entry.id === serviceId)) {
    return { kind: 'continue', reason: 'service_not_resolved' };
  }
  const eligible = eligibleProfessionals(serviceId, input.catalog);
  const professionalId =
    flowState.fixedProfessionalId ??
    (eligible.length === 1 ? eligible[0]!.id : undefined);
  if (eligible.length > 1 && !professionalId) {
    return { kind: 'continue', reason: 'professional_required' };
  }
  if (!constraint.date) {
    return { kind: 'continue', reason: 'deferred_date_absent' };
  }
  const date = constraint.date;
  const baseState = {
    ...flowState,
    ...(professionalId ? { fixedProfessionalId: professionalId } : {}),
  };
  const professionalGate = professionalSelectionGate({
    serviceId,
    professionalId,
    servicesResult: input.catalog,
    userMessages: [input.inboundText],
    trustedFlowState: baseState,
  });
  if (!professionalGate.ok) {
    return { kind: 'continue', reason: `professional_gate:${professionalGate.reason}` };
  }
  const args: Record<string, unknown> = { date, serviceId };
  if (professionalGate.effectiveProfessionalId) {
    args.professionalId = professionalGate.effectiveProfessionalId;
  }
  let raw: string;
  try {
    raw = await input.executeTool('getAvailableSlots', args);
  } catch {
    raw = JSON.stringify({ success: false, reason: 'executor_error' });
  }
  const parsed = parseObject(raw);
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'getAvailableSlots',
    args,
    argumentsValidJson: true,
    result: raw,
  };
  const toolSlots =
    parsed?.success === true
      ? validSlots(parsed, input.now, input.config.timezone, date)
      : null;
  if (!toolSlots) {
    return {
      kind: 'resolved',
      result: modelResult({
        reply: canonicalReadFailureCopyV2(
          'availability',
          availabilityQueryFailureReason(parsed)
        ),
        purpose: 'DATE_TIME_QUESTION',
        transition: {
          kind: 'open',
          pendingKind: 'DATE',
          flowId: flowState.flowId,
          optionEntityIds: ['date-freeform'],
        },
      }),
      nextFlowState: baseState,
      loop: loopForReads([trace]),
    };
  }
  const offered = filterSlotsByDeferredWindowV2(toolSlots, constraint.timeWindow);
  if (offered.length === 0) {
    return {
      kind: 'resolved',
      result: modelResult({
        reply: buildEmptyDeferredAvailabilityCopyV2(
          constraint,
          input.now,
          input.config.timezone
        ),
        purpose: 'DATE_TIME_QUESTION',
        transition: {
          kind: 'open',
          pendingKind: 'DATE',
          flowId: flowState.flowId,
          optionEntityIds: ['date-freeform'],
        },
      }),
      nextFlowState: {
        ...baseState,
        resolvedDate: date,
      },
      loop: loopForReads([trace]),
    };
  }
  const filteredTrace: ReceptionistToolTraceEntry = {
    ...trace,
    result: JSON.stringify({
      ...(parsed ?? {}),
      slots: offered,
    }),
  };
  const reducer = reduceToolLifecycleV2({
    frame: { ...input.frame, flowState: baseState },
    toolTrace: [filteredTrace],
    services: input.catalog,
    sourceInboundText: input.inboundText,
    preserveDeferredAvailability: true,
  });
  if (reducer?.kind === 'canonical_slots') {
    const exactMinute =
      constraint.timeWindow?.kind === 'EXACT'
        ? constraint.timeWindow.minuteOfDay
        : null;
    const exactSlot =
      exactMinute !== null
        ? offered.find((slot) => slotMinutesV2(slot) === exactMinute) ?? null
        : null;
    if (exactSlot && reducer.nextFlowState.slotEvidence?.slots.includes(exactSlot)) {
      const evidence = reducer.nextFlowState.slotEvidence;
      const professionalId = reducer.nextFlowState.fixedProfessionalId;
      const draft: BookingDraftV2 = {
        serviceId: evidence.serviceId,
        ...(professionalId ? { professionalId } : {}),
        date: evidence.date,
        time: exactSlot,
        slotEvidenceTurnId: evidence.turnId,
      };
      return {
        kind: 'resolved',
        result: {
          schemaVersion: 2,
          reply: buildCanonicalBookingSummaryV2({ draft, services: input.catalog }),
          replyPurpose: 'WRITE_CONFIRMATION',
          pendingTransitionCandidate: {
            kind: 'open',
            pendingKind: 'CONFIRMATION',
            flowId: flowState.flowId,
            optionEntityIds: [`booking-confirmation:${flowState.flowId}`],
          },
          resolutionCandidate: null,
          unknownServiceEvidence: null,
        },
        nextFlowState: { ...reducer.nextFlowState, bookingDraft: draft },
        loop: loopForReads([filteredTrace]),
      };
    }
    const {
      bookingDraft: _draft,
      ...stateWithoutDraft
    } = reducer.nextFlowState;
    const evidence = stateWithoutDraft.slotEvidence;
    const timeReply =
      evidence && offered.length > 0
        ? `Encontrei horários para ${displayDateV2(evidence.date)}: ${offered.join(', ')}. Qual você prefere?`
        : reducer.result.reply;
    return {
      kind: 'resolved',
      result: {
        schemaVersion: 2,
        reply: timeReply,
        replyPurpose: 'DATE_TIME_QUESTION',
        pendingTransitionCandidate: {
          kind: 'open',
          pendingKind: 'TIME',
          flowId: flowState.flowId,
          optionEntityIds: offered,
        },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      nextFlowState: stateWithoutDraft,
      loop: loopForReads([filteredTrace]),
    };
  }
  return {
    kind: 'resolved',
    result: modelResult({
      reply: buildEmptyDeferredAvailabilityCopyV2(
        constraint,
        input.now,
        input.config.timezone
      ),
      purpose: 'DATE_TIME_QUESTION',
      transition: {
        kind: 'open',
        pendingKind: 'DATE',
        flowId: flowState.flowId,
        optionEntityIds: ['date-freeform'],
      },
    }),
    nextFlowState: baseState,
    loop: loopForReads([trace]),
  };
}
