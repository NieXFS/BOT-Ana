import type { TenantBotConfig } from '../../configProvider';
import {
  bookingConfirmationGate,
  hasTypedKeepBothEvidenceV2,
  hasTypedNoConflictPreflightEvidenceV2,
  type V2BookingConfirmationContext,
} from '../bookingConfirmationGate';
import type {
  ReceptionistModelLoopResult,
  ReceptionistToolTraceEntry,
} from '../brainService';
import { filterSlotsAtOrAfterNow, type ServicesResult, type UpcomingAppointment } from '../calendarService';
import { professionalSelectionGate } from '../professional-selection-gate';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  resolveUniqueCatalogEntityFromCurrentMessage,
  resolveUniqueCatalogEntityFromCurrentMessageForRead,
} from '../service-gate';
import type {
  FlowStateV2,
  ModelTurnResultV2,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import type { CurrentDateResolutionV2 } from './currentDateResolution';
import {
  buildTimeSelectionFollowUpV2,
  resolvePendingOptionProofV2,
} from './fastPaths';
import {
  buildCanonicalBookingSummaryV2,
  displayDateV2,
  reduceToolLifecycleV2,
} from './lifecycleReducer';
import {
  canonicalReadFailureCopyV2,
  hasExplicitAvailabilityReadRequestV2,
  type ReadFastPathReasonV2,
} from './readFastPaths';
import { hasPositiveExplicitBookingVerbV2 } from './flowSession';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';
import { validatedBookingDraftForPendingV2 } from './pendingQuestion';

export type BookingProgressFastPathV2 =
  | {
      kind: 'continue_model';
      reason: string;
      loop?: ReceptionistModelLoopResult;
      proof?: ResolutionProof | null;
      nextFlowState?: FlowStateV2;
    }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      loop: ReceptionistModelLoopResult;
      proof: ResolutionProof | null;
      nextFlowState: FlowStateV2;
    };

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

function readReason(parsed: Record<string, unknown> | null): ReadFastPathReasonV2 {
  const reason = String(parsed?.reason ?? 'other');
  return [
    'customer_identity_ambiguous',
    'customer_identity_mismatch',
    'service_not_resolved',
    'date_not_resolved',
    'professional_selection',
    'no_eligible_professional',
    'invalid_date',
    'past_date',
    'outside_hours',
    'rate_limited',
    'invalid_payload',
    'executor_error',
  ].includes(reason)
    ? (reason as ReadFastPathReasonV2)
    : 'other';
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
    model: 'booking-progress-fast-path-v2',
    providerReportedModels: [],
    rounds: 0,
    messages: [],
    toolTrace: [...trace],
    usage: [],
  };
}

async function safeTool(input: {
  name: 'getAvailableSlots' | 'getUpcomingAppointments' | 'bookAppointment';
  args: Record<string, unknown>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<{ raw: string; parsed: Record<string, unknown> | null }> {
  try {
    const raw = await input.executeTool(input.name, input.args);
    return { raw, parsed: parseObject(raw) };
  } catch {
    const raw = JSON.stringify({ success: false, reason: 'executor_error' });
    return { raw, parsed: parseObject(raw) };
  }
}

/**
 * Confirmação v2 server-owned: o modal só licencia os argumentos do draft
 * validado e executa exatamente um write. O modelo não participa deste turno.
 */
export async function resolveBookingConfirmationWriteFastPathV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  history: readonly { role: string; content?: unknown }[];
  servicesResult: ServicesResult;
  lastAcceptedDelivery: V2BookingConfirmationContext['lastAcceptedDelivery'];
  now: Date;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onGateDecline?: V2BookingConfirmationContext['onGateDecline'];
}): Promise<BookingProgressFastPathV2> {
  const pending = input.frame.pending;
  if (!pending) {
    return { kind: 'continue_model', reason: 'confirmation_pending_absent' };
  }
  const context: V2BookingConfirmationContext = {
    pending,
    flowState: input.frame.flowState,
    catalog: input.servicesResult,
    lastAcceptedDelivery: input.lastAcceptedDelivery,
    now: input.now,
    ...(input.onGateDecline ? { onGateDecline: input.onGateDecline } : {}),
  };
  const draft = validatedBookingDraftForPendingV2({
    pending,
    flowState: input.frame.flowState,
    catalog: input.servicesResult,
  });
  if (!draft) {
    return { kind: 'continue_model', reason: 'confirmation_draft_invalid' };
  }
  const service = input.servicesResult.services?.find(
    (entry) => entry.id === draft.serviceId
  );
  const professional = draft.professionalId
    ? input.servicesResult.professionals?.find(
        (entry) => entry.id === draft.professionalId
      )
    : undefined;
  if (!service || (draft.professionalId && !professional)) {
    return { kind: 'continue_model', reason: 'confirmation_catalog_mismatch' };
  }
  const decision = bookingConfirmationGate({
    currentUserMessage: input.inboundText,
    history: [...input.history],
    confirmedDuplicate: false,
    expectedBooking: {
      date: draft.date,
      time: draft.time,
      serviceName: service.name,
      ...(professional ? { professionalName: professional.name } : {}),
    },
    v2ConfirmationContext: context,
  });
  if (!decision.ok) {
    input.onGateDecline?.({
      gate: 'booking_confirmation',
      reason: decision.reason,
    });
    return { kind: 'continue_model', reason: decision.reason };
  }

  const args: Record<string, unknown> = {
    serviceId: draft.serviceId,
    date: draft.date,
    time: draft.time,
    ...(draft.professionalId
      ? { professionalId: draft.professionalId }
      : {}),
  };
  const write = await safeTool({
    name: 'bookAppointment',
    args,
    executeTool: input.executeTool,
  });
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'bookAppointment',
    args,
    argumentsValidJson: true,
    result: write.raw,
  };
  const loop = loopForReads([trace]);
  const reduced = reduceToolLifecycleV2({
    frame: input.frame,
    toolTrace: [trace],
    services: input.servicesResult,
    sourceInboundText: input.inboundText,
  });
  if (write.parsed?.success === true && reduced?.kind === 'canonical_write') {
    return {
      kind: 'resolved',
      result: reduced.result,
      loop,
      proof: null,
      nextFlowState: reduced.nextFlowState,
    };
  }

  // A tentativa falhou sem efeito commitado. Reancora o mesmo resumo e mantém
  // a CONFIRMATION atual; nenhuma alegação do modelo é necessária ou aceita.
  return {
    kind: 'resolved',
    result: {
      schemaVersion: 2,
      reply: buildCanonicalBookingSummaryV2({
        draft,
        services: input.servicesResult,
      }),
      replyPurpose: 'WRITE_CONFIRMATION',
      pendingTransitionCandidate: { kind: 'preserve' },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
    loop,
    proof: null,
    nextFlowState: input.frame.flowState,
  };
}

function clearTemporalState(flowState: FlowStateV2): FlowStateV2 {
  const {
    resolvedDate: _date,
    slotEvidence: _evidence,
    bookingDraft: _draft,
    duplicatePreflightClearance: _duplicatePreflightClearance,
    ...base
  } = flowState;
  const fixedByProofVersion = { ...base.fixedByProofVersion };
  delete fixedByProofVersion.resolvedDate;
  return { ...base, fixedByProofVersion };
}

function dateQuestionResult(
  frame: TurnFrameV2,
  reply: string
): ModelTurnResultV2 {
  return {
    schemaVersion: 2,
    reply,
    replyPurpose: 'DATE_TIME_QUESTION',
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'DATE',
      flowId: frame.flowState.flowId,
      optionEntityIds: ['date-freeform'],
    },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

function civilToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function inboundCatalogResolutionForReadV2(
  inboundText: string,
  services: ServicesResult
) {
  return resolveUniqueCatalogEntityFromCurrentMessageForRead(
    inboundText,
    services.services ?? [],
    {
      allowRestrictedDistanceTwo: ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
    }
  );
}

function inboundUniqueServiceIdV2(
  inboundText: string,
  services: ServicesResult
): string | undefined {
  const resolution = inboundCatalogResolutionForReadV2(inboundText, services);
  return resolution.kind === 'resolved' ? resolution.entity.id : undefined;
}

function uniqueEligibleProfessionalIdV2(
  serviceId: string,
  services: ServicesResult
): string | undefined {
  const service = services.services?.find((entry) => entry.id === serviceId);
  if (!service) return undefined;
  const active = services.professionals ?? [];
  const eligible =
    service.professionalIds === undefined
      ? active
      : active.filter((entry) => service.professionalIds!.includes(entry.id));
  return eligible.length === 1 ? eligible[0]!.id : undefined;
}

function inboundTimesV2(inboundText: string): string[] {
  return [
    ...new Set(
      normalizeTemporalAssertionsV2(inboundText)
        .filter((assertion) => assertion.kind === 'time')
        .map((assertion) => assertion.normalized)
    ),
  ];
}

function withFixedServiceState(
  flowState: FlowStateV2,
  serviceId: string,
  professionalId?: string
): FlowStateV2 {
  const serviceChanged = flowState.fixedServiceId !== serviceId;
  const serviceVersion = serviceChanged
    ? (flowState.fixedByProofVersion.fixedServiceId ?? 0) + 1
    : flowState.fixedByProofVersion.fixedServiceId ?? 1;
  return {
    ...flowState,
    fixedServiceId: serviceId,
    ...(professionalId ? { fixedProfessionalId: professionalId } : {}),
    fixedByProofVersion: {
      ...flowState.fixedByProofVersion,
      fixedServiceId: serviceVersion,
      ...(professionalId
        ? {
            fixedProfessionalId:
              flowState.fixedProfessionalId === professionalId
                ? flowState.fixedByProofVersion.fixedProfessionalId ?? serviceVersion
                : serviceVersion,
          }
        : {}),
    },
  };
}

function pendingFreshForDateSlotsV2(frame: TurnFrameV2, now: Date): boolean {
  if (!frame.pending) return false;
  if (frame.pending.flowId !== frame.flowState.flowId) return false;
  const askedAt = Date.parse(frame.pending.askedAt);
  return (
    Number.isFinite(askedAt) && now.getTime() - askedAt <= 4 * 60 * 60 * 1_000
  );
}

function dateSlotsEntitlementV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  servicesResult: ServicesResult;
  now: Date;
}):
  | { kind: 'continue'; reason: string }
  | { kind: 'ready'; serviceId: string; professionalId?: string } {
  const pending = input.frame.pending;
  const inboundResolution = inboundCatalogResolutionForReadV2(
    input.inboundText,
    input.servicesResult
  );
  if (inboundResolution.kind === 'ambiguous') {
    return { kind: 'continue', reason: 'service_not_resolved' };
  }
  const inboundServiceId = inboundUniqueServiceIdV2(
    input.inboundText,
    input.servicesResult
  );
  const serviceId = input.frame.flowState.fixedServiceId ?? inboundServiceId;
  const dateTimePending =
    pending &&
    ['DATE', 'TIME'].includes(pending.kind) &&
    pendingFreshForDateSlotsV2(input.frame, input.now);
  const servicePending =
    pending?.kind === 'SERVICE' &&
    pendingFreshForDateSlotsV2(input.frame, input.now) &&
    inboundServiceId !== undefined &&
    pending.options.some((option) => option.entityId === inboundServiceId);
  const openGrounded =
    !pending &&
    serviceId !== undefined &&
    (hasPositiveExplicitBookingVerbV2(input.inboundText) ||
      hasExplicitAvailabilityReadRequestV2(input.inboundText));
  if (!dateTimePending && !servicePending && !openGrounded) {
    if (pending && ['DATE', 'TIME'].includes(pending.kind)) {
      if (pending.flowId !== input.frame.flowState.flowId) {
        return { kind: 'continue', reason: 'pending_from_other_flow' };
      }
      if (!pendingFreshForDateSlotsV2(input.frame, input.now)) {
        return { kind: 'continue', reason: 'pending_older_than_4h' };
      }
    }
    return { kind: 'continue', reason: 'pending_not_date_or_time' };
  }
  if (!serviceId) return { kind: 'continue', reason: 'service_not_resolved' };
  const professionalId =
    input.frame.flowState.fixedProfessionalId ??
    uniqueEligibleProfessionalIdV2(serviceId, input.servicesResult);
  return professionalId
    ? { kind: 'ready', serviceId, professionalId }
    : { kind: 'ready', serviceId };
}

/** DATE atual, correção de TIME, ou weekday/data no inbound → read de slots. */
export async function resolveDateSlotsFastPathV2(input: {
  frame: TurnFrameV2;
  dateResolution: CurrentDateResolutionV2;
  currentInboundText: string;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  now: Date;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<BookingProgressFastPathV2> {
  const entitlement = dateSlotsEntitlementV2({
    frame: input.frame,
    inboundText: input.currentInboundText,
    servicesResult: input.servicesResult,
    now: input.now,
  });
  if (entitlement.kind === 'continue') {
    return { kind: 'continue_model', reason: entitlement.reason };
  }
  if (input.dateResolution.kind === 'ambiguous') {
    return {
      kind: 'resolved',
      result: dateQuestionResult(
        input.frame,
        'Qual dia você prefere?'
      ),
      loop: loopForReads([]),
      proof: null,
      nextFlowState: withFixedServiceState(
        clearTemporalState(input.frame.flowState),
        entitlement.serviceId,
        entitlement.professionalId
      ),
    };
  }
  if (input.dateResolution.kind !== 'resolved') {
    return { kind: 'continue_model', reason: 'current_date_absent' };
  }
  const date = input.dateResolution.date;
  if (
    input.frame.pending?.kind === 'TIME' &&
    input.frame.flowState.slotEvidence?.date === date
  ) {
    return { kind: 'continue_model', reason: 'same_date_as_time_evidence' };
  }
  const serviceId = entitlement.serviceId;
  const baseState = withFixedServiceState(
    clearTemporalState(input.frame.flowState),
    serviceId,
    entitlement.professionalId
  );
  if (date < civilToday(input.now, input.config.timezone)) {
    return {
      kind: 'resolved',
      result: dateQuestionResult(
        input.frame,
        'Essa data já passou. Qual outra data você prefere?'
      ),
      loop: loopForReads([]),
      proof: null,
      nextFlowState: baseState,
    };
  }
  const professionalGate = professionalSelectionGate({
    serviceId,
    professionalId: entitlement.professionalId,
    servicesResult: input.servicesResult,
    userMessages: [input.currentInboundText],
    trustedFlowState: baseState,
  });
  if (!professionalGate.ok) {
    return {
      kind: 'continue_model',
      reason: `professional_gate:${professionalGate.reason}`,
    };
  }
  const args: Record<string, unknown> = { date, serviceId };
  if (professionalGate.effectiveProfessionalId) {
    args.professionalId = professionalGate.effectiveProfessionalId;
  }
  const read = await safeTool({
    name: 'getAvailableSlots',
    args,
    executeTool: input.executeTool,
  });
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'getAvailableSlots',
    args,
    argumentsValidJson: true,
    result: read.raw,
  };
  const loop = loopForReads([trace]);
  const slots =
    read.parsed?.success === true
      ? validSlots(
          read.parsed,
          input.now,
          input.config.timezone,
          date
        )
      : null;
  if (slots && slots.length > 0) {
    const filteredTrace: ReceptionistToolTraceEntry = {
      ...trace,
      result: JSON.stringify({
        ...(read.parsed ?? {}),
        slots,
      }),
    };
    const reducer = reduceToolLifecycleV2({
      frame: { ...input.frame, flowState: baseState },
      toolTrace: [filteredTrace],
      services: input.servicesResult,
      sourceInboundText: input.currentInboundText,
    });
    if (reducer?.kind === 'canonical_slots') {
      if (reducer.result.replyPurpose === 'WRITE_CONFIRMATION') {
        return {
          kind: 'resolved',
          result: reducer.result,
          loop: loopForReads([filteredTrace]),
          proof: null,
          nextFlowState: reducer.nextFlowState,
        };
      }
      const inboundTimes = inboundTimesV2(input.currentInboundText);
      const matchingTime =
        inboundTimes.length === 1 && slots.includes(inboundTimes[0]!)
          ? inboundTimes[0]!
          : null;
      if (matchingTime) {
        const timeFrame: TurnFrameV2 = {
          ...input.frame,
          pending: {
            questionId: input.frame.pending?.questionId ?? 'time-after-date',
            askedAt: input.now.toISOString(),
            kind: 'TIME',
            flowId: input.frame.flowState.flowId,
            version: (input.frame.pending?.version ?? 0) + 1,
            options: slots.map((slot, index) => ({
              position: index + 1,
              entityId: slot,
              displayName: slot,
            })),
          },
          flowState: reducer.nextFlowState,
        };
        const followUp = buildTimeSelectionFollowUpV2(
          matchingTime,
          timeFrame,
          input.servicesResult
        );
        if (followUp) {
          return {
            kind: 'resolved',
            result: followUp.result,
            loop: loopForReads([filteredTrace]),
            proof: null,
            nextFlowState: followUp.nextFlowState,
          };
        }
      }
      return {
        kind: 'resolved',
        result: reducer.result,
        loop: loopForReads([filteredTrace]),
        proof: null,
        nextFlowState: reducer.nextFlowState,
      };
    }
  }
  const reply = slots && slots.length === 0
    ? `Não encontrei horários para ${displayDateV2(date)}. Qual outro dia você prefere?`
    : canonicalReadFailureCopyV2(
        'availability',
        read.parsed?.success === true ? 'invalid_payload' : readReason(read.parsed)
      );
  return {
    kind: 'resolved',
    result: dateQuestionResult(input.frame, reply),
    loop,
    proof: null,
    nextFlowState: baseState,
  };
}

function localDateTimeParts(instant: string, timezone: string): {
  date: string;
  minutes: number;
} | null {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: hour * 60 + minute,
  };
}

function appointmentConflicts(input: {
  appointment: UpcomingAppointment;
  serviceId: string;
  date: string;
  time: string;
  durationMinutes: number;
  services: ServicesResult;
  timezone: string;
}): boolean {
  const start = localDateTimeParts(input.appointment.startTime, input.timezone);
  const end = localDateTimeParts(input.appointment.endTime, input.timezone);
  if (!start || !end) return false;
  const serviceResolution = resolveUniqueCatalogEntityFromCurrentMessage(
    input.appointment.serviceName,
    input.services.services ?? [],
    {
      allowRestrictedDistanceTwo:
        ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
    }
  );
  if (
    serviceResolution.kind === 'resolved' &&
    serviceResolution.entity.id === input.serviceId
  ) {
    return true;
  }
  if (start.date !== input.date) return false;
  const match = /^(\d{2}):(\d{2})$/u.exec(input.time);
  if (!match) return false;
  const newStart = Number(match[1]) * 60 + Number(match[2]);
  const newEnd = newStart + input.durationMinutes;
  const existingEnd = end.date === start.date ? end.minutes : 24 * 60;
  return newStart < existingEnd && start.minutes < newEnd;
}

function validUpcomingAppointmentsV2(
  parsed: Record<string, unknown> | null
): UpcomingAppointment[] | null {
  if (parsed?.success !== true || !Array.isArray(parsed.appointments)) {
    return null;
  }
  const appointments = parsed.appointments.filter(
    (entry): entry is UpcomingAppointment =>
      Boolean(
        entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          typeof (entry as UpcomingAppointment).startTime === 'string' &&
          typeof (entry as UpcomingAppointment).endTime === 'string' &&
          typeof (entry as UpcomingAppointment).serviceName === 'string'
      )
  );
  return appointments.length === parsed.appointments.length
    ? appointments
    : null;
}

function conflictsForDraftV2(input: {
  appointments: readonly UpcomingAppointment[];
  flowState: FlowStateV2;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
}): UpcomingAppointment[] | null {
  const draft = input.flowState.bookingDraft;
  if (!draft) return null;
  const service = input.servicesResult.services?.find(
    (entry) => entry.id === draft.serviceId
  );
  if (!service) return null;
  return input.appointments.filter((appointment) =>
    appointmentConflicts({
      appointment,
      serviceId: draft.serviceId,
      date: draft.date,
      time: draft.time,
      durationMinutes: service.durationMinutes,
      services: input.servicesResult,
      timezone: input.config.timezone,
    })
  );
}

/**
 * A escolha keep-both nunca licencia write diretamente. Releitura autoritativa,
 * evidência tipada e novo resumo canônico formam uma confirmação normal nova.
 */
export async function resolveDuplicateKeepBothFastPathV2(input: {
  frame: TurnFrameV2;
  proof: ResolutionProof | null;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<BookingProgressFastPathV2> {
  if (
    input.frame.pending?.kind !== 'CONFIRMATION' ||
    input.frame.pending.flowId !== input.frame.flowState.flowId ||
    input.proof?.kind !== 'pending_option' ||
    input.proof.entityId !== 'duplicate-resolution:keep-both' ||
    !input.frame.pending.options.every((option) =>
      option.entityId.startsWith('duplicate-resolution:')
    )
  ) {
    return { kind: 'continue_model', reason: 'keep_both_not_evidenced' };
  }
  const read = await safeTool({
    name: 'getUpcomingAppointments',
    args: {},
    executeTool: input.executeTool,
  });
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'getUpcomingAppointments',
    args: {},
    argumentsValidJson: true,
    result: read.raw,
  };
  const loop = loopForReads([trace]);
  const reason = readReason(read.parsed);
  if (
    read.parsed?.success !== true &&
    (reason === 'customer_identity_ambiguous' ||
      reason === 'customer_identity_mismatch')
  ) {
    return {
      kind: 'resolved',
      result: {
        schemaVersion: 2,
        reply: canonicalReadFailureCopyV2('upcoming', reason),
        replyPurpose: 'OPERATIONAL_ANSWER',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      loop,
      proof: null,
      nextFlowState: input.frame.flowState,
    };
  }
  const appointments = validUpcomingAppointmentsV2(read.parsed);
  const conflicts = appointments
    ? conflictsForDraftV2({
        appointments,
        flowState: input.frame.flowState,
        servicesResult: input.servicesResult,
        config: input.config,
      })
    : null;
  const draft = input.frame.flowState.bookingDraft;
  if (!appointments || !conflicts || !draft) {
    return { kind: 'continue_model', reason: 'keep_both_read_failed', loop };
  }
  const nextFlowState: FlowStateV2 = conflicts.length > 0
    ? {
        ...input.frame.flowState,
        duplicateResolution: {
          kind: 'keep_both',
          readEvidenceTurnId: input.frame.turnId,
          sourcePendingVersion: input.frame.pending.version,
          serviceId: draft.serviceId,
          ...(draft.professionalId
            ? { professionalId: draft.professionalId }
            : {}),
          date: draft.date,
          time: draft.time,
        },
      }
    : (() => {
        const { duplicateResolution: _duplicateResolution, ...rest } =
          input.frame.flowState;
        return rest;
      })();
  return {
    kind: 'resolved',
    result: {
      schemaVersion: 2,
      reply: buildCanonicalBookingSummaryV2({
        draft,
        services: input.servicesResult,
      }),
      replyPurpose: 'WRITE_CONFIRMATION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'CONFIRMATION',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: [
          `booking-confirmation:${input.frame.flowState.flowId}`,
        ],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
    loop,
    proof: input.proof,
    nextFlowState,
  };
}

function duplicateQuestion(
  appointment: UpcomingAppointment,
  timezone: string
): string {
  const start = localDateTimeParts(appointment.startTime, timezone);
  const time = start
    ? `${String(Math.floor(start.minutes / 60)).padStart(2, '0')}:${String(
        start.minutes % 60
      ).padStart(2, '0')}`
    : '';
  return `Vi que você já tem outro agendamento de ${appointment.serviceName} em ${
    start ? displayDateV2(start.date) : 'uma data próxima'
  } às ${time}. Quer manter os dois, remarcar, só cancelar o anterior ou decidir depois?`;
}

function withNoConflictClearanceV2(input: {
  frame: TurnFrameV2;
  flowState: FlowStateV2;
  draft: NonNullable<FlowStateV2['bookingDraft']>;
}): FlowStateV2 {
  const sourcePendingKind = input.frame.pending?.kind;
  if (
    (sourcePendingKind !== 'TIME' && sourcePendingKind !== 'CONFIRMATION') ||
    !input.frame.pending
  ) {
    return input.flowState;
  }
  return {
    ...input.flowState,
    duplicatePreflightClearance: {
      kind: 'no_conflict',
      readEvidenceTurnId: input.frame.turnId,
      sourcePendingKind,
      sourcePendingVersion: input.frame.pending.version,
      serviceId: input.draft.serviceId,
      ...(input.draft.professionalId
        ? { professionalId: input.draft.professionalId }
        : {}),
      date: input.draft.date,
      time: input.draft.time,
    },
  };
}

function withoutDuplicatePreflightClearanceV2(
  flowState: FlowStateV2
): FlowStateV2 {
  const {
    duplicatePreflightClearance: _clearance,
    ...rest
  } = flowState;
  return rest;
}

/**
 * Compatibilidade para uma CONFIRMATION já aberta sem o cache do turno TIME.
 * Sem conflito, o read é somente um pass-through e o léxico continua no MESMO
 * turno. Com conflito, a pergunta própria continua preemptando o write.
 */
export async function resolveConfirmationDuplicatePreflightV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  history: readonly { role: string; content?: unknown }[];
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  now: Date;
  lastAcceptedDelivery: V2BookingConfirmationContext['lastAcceptedDelivery'];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<BookingProgressFastPathV2> {
  const pending = input.frame.pending;
  const draft = pending
    ? validatedBookingDraftForPendingV2({
        pending,
        flowState: input.frame.flowState,
        catalog: input.servicesResult,
      })
    : null;
  if (!pending || !draft) {
    return { kind: 'continue_model', reason: 'normal_confirmation_not_ready' };
  }
  const context: V2BookingConfirmationContext = {
    pending,
    flowState: input.frame.flowState,
    catalog: input.servicesResult,
    lastAcceptedDelivery: input.lastAcceptedDelivery,
    now: input.now,
  };
  if (hasTypedKeepBothEvidenceV2(context)) {
    return { kind: 'continue_model', reason: 'duplicate_keep_both_already_typed' };
  }
  if (hasTypedNoConflictPreflightEvidenceV2(context)) {
    return { kind: 'continue_model', reason: 'duplicate_preflight_already_clear' };
  }
  const service = input.servicesResult.services?.find(
    (entry) => entry.id === draft.serviceId
  );
  const professional = draft.professionalId
    ? input.servicesResult.professionals?.find(
        (entry) => entry.id === draft.professionalId
      )
    : undefined;
  if (!service || (draft.professionalId && !professional)) {
    return { kind: 'continue_model', reason: 'confirmation_catalog_mismatch' };
  }
  const confirmation = bookingConfirmationGate({
    currentUserMessage: input.inboundText,
    history: [...input.history],
    confirmedDuplicate: false,
    expectedBooking: {
      date: draft.date,
      time: draft.time,
      serviceName: service.name,
      ...(professional ? { professionalName: professional.name } : {}),
    },
    v2ConfirmationContext: context,
  });
  if (!confirmation.ok) {
    return {
      kind: 'continue_model',
      reason: `confirmation_not_licensed:${confirmation.reason}`,
    };
  }

  const read = await safeTool({
    name: 'getUpcomingAppointments',
    args: {},
    executeTool: input.executeTool,
  });
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'getUpcomingAppointments',
    args: {},
    argumentsValidJson: true,
    result: read.raw,
  };
  const loop = loopForReads([trace]);
  const reason = readReason(read.parsed);
  const appointments = validUpcomingAppointmentsV2(read.parsed);
  if (!appointments) {
    return {
      kind: 'resolved',
      result: {
        schemaVersion: 2,
        reply: canonicalReadFailureCopyV2('upcoming', reason),
        replyPurpose: 'OPERATIONAL_ANSWER',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      loop,
      proof: null,
      nextFlowState: withoutDuplicatePreflightClearanceV2(
        input.frame.flowState
      ),
    };
  }
  const conflicts = conflictsForDraftV2({
    appointments,
    flowState: input.frame.flowState,
    servicesResult: input.servicesResult,
    config: input.config,
  });
  if (!conflicts) {
    return {
      kind: 'resolved',
      result: {
        schemaVersion: 2,
        reply: canonicalReadFailureCopyV2('upcoming', 'invalid_payload'),
        replyPurpose: 'OPERATIONAL_ANSWER',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      loop,
      proof: null,
      nextFlowState: withoutDuplicatePreflightClearanceV2(
        input.frame.flowState
      ),
    };
  }
  if (conflicts.length === 0) {
    return {
      kind: 'continue_model',
      reason: 'no_duplicate_conflict',
      loop,
      proof: null,
      nextFlowState: withNoConflictClearanceV2({
        frame: input.frame,
        flowState: input.frame.flowState,
        draft,
      }),
    };
  }
  return {
    kind: 'resolved',
    result: {
      schemaVersion: 2,
      reply: duplicateQuestion(conflicts[0]!, input.config.timezone),
      replyPurpose: 'OPERATIONAL_ANSWER',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'CONFIRMATION',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: [
          'duplicate-resolution:keep-both',
          'duplicate-resolution:reschedule',
          'duplicate-resolution:cancel-only',
          'duplicate-resolution:decide-later',
        ],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
    loop,
    proof: null,
    nextFlowState: withoutDuplicatePreflightClearanceV2(
      input.frame.flowState
    ),
  };
}

/** Preflight proativo somente após uma opção TIME autoritativa ser escolhida. */
export async function resolveTimeDuplicatePreflightV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  currentDateResolution: CurrentDateResolutionV2;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  now: Date;
  lastAcceptedAssistantText?: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<BookingProgressFastPathV2> {
  if (input.frame.pending?.kind !== 'TIME') {
    return { kind: 'continue_model', reason: 'pending_not_time' };
  }
  if (input.currentDateResolution.kind !== 'none') {
    return { kind: 'continue_model', reason: 'date_assertion_preempts_time' };
  }
  const proof = resolvePendingOptionProofV2({
    frame: input.frame,
    inboundId: input.inboundId,
    inboundText: input.inboundText,
    now: input.now,
    catalog: input.servicesResult,
    lastAcceptedAssistantText: input.lastAcceptedAssistantText,
  });
  if (proof?.kind !== 'pending_option') {
    return { kind: 'continue_model', reason: 'time_option_not_evidenced' };
  }
  const followUp = buildTimeSelectionFollowUpV2(
    proof.entityId,
    input.frame,
    input.servicesResult
  );
  if (!followUp?.nextFlowState.bookingDraft) {
    return { kind: 'continue_model', reason: 'time_option_without_draft' };
  }
  const read = await safeTool({
    name: 'getUpcomingAppointments',
    args: {},
    executeTool: input.executeTool,
  });
  const trace: ReceptionistToolTraceEntry = {
    round: 0,
    name: 'getUpcomingAppointments',
    args: {},
    argumentsValidJson: true,
    result: read.raw,
  };
  const loop = loopForReads([trace]);
  const reason = readReason(read.parsed);
  if (
    read.parsed?.success !== true &&
    (reason === 'customer_identity_ambiguous' ||
      reason === 'customer_identity_mismatch')
  ) {
    return {
      kind: 'resolved',
      result: {
        schemaVersion: 2,
        reply: canonicalReadFailureCopyV2('upcoming', reason),
        replyPurpose: 'OPERATIONAL_ANSWER',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      loop,
      proof: null,
      nextFlowState: input.frame.flowState,
    };
  }
  const appointments = validUpcomingAppointmentsV2(read.parsed);
  if (!appointments) {
    return { kind: 'continue_model', reason: 'preflight_read_failed', loop };
  }
  const draft = followUp.nextFlowState.bookingDraft;
  const service = input.servicesResult.services?.find(
    (entry) => entry.id === draft.serviceId
  );
  if (!service) return { kind: 'continue_model', reason: 'draft_service_missing', loop };
  const conflicts = conflictsForDraftV2({
    appointments,
    flowState: followUp.nextFlowState,
    servicesResult: input.servicesResult,
    config: input.config,
  });
  if (!conflicts) {
    return { kind: 'continue_model', reason: 'draft_conflict_unavailable', loop };
  }
  if (conflicts.length === 0) {
    return {
      kind: 'continue_model',
      reason: 'no_duplicate_conflict',
      loop,
      proof,
      nextFlowState: withNoConflictClearanceV2({
        frame: input.frame,
        flowState: followUp.nextFlowState,
        draft,
      }),
    };
  }
  return {
    kind: 'resolved',
    result: {
      schemaVersion: 2,
      reply: duplicateQuestion(conflicts[0]!, input.config.timezone),
      replyPurpose: 'OPERATIONAL_ANSWER',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'CONFIRMATION',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: [
          'duplicate-resolution:keep-both',
          'duplicate-resolution:reschedule',
          'duplicate-resolution:cancel-only',
          'duplicate-resolution:decide-later',
        ],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
    loop,
    proof,
    nextFlowState: withoutDuplicatePreflightClearanceV2(
      followUp.nextFlowState
    ),
  };
}
