import type { TenantBotConfig } from '../../configProvider';
import type {
  ReceptionistModelLoopResult,
  ReceptionistToolTraceEntry,
} from '../brainService';
import type { ServicesResult, UpcomingAppointment } from '../calendarService';
import { professionalSelectionGate } from '../professional-selection-gate';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
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
  type ReadFastPathReasonV2,
} from './readFastPaths';

export type BookingProgressFastPathV2 =
  | { kind: 'continue_model'; reason: string; loop?: ReceptionistModelLoopResult }
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

function validSlots(parsed: Record<string, unknown> | null): string[] | null {
  if (!Array.isArray(parsed?.slots)) return null;
  const slots = parsed.slots.filter(
    (slot): slot is string =>
      typeof slot === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)
  );
  return slots.length === parsed.slots.length ? [...new Set(slots)] : null;
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
  name: 'getAvailableSlots' | 'getUpcomingAppointments';
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

function clearTemporalState(flowState: FlowStateV2): FlowStateV2 {
  const {
    resolvedDate: _date,
    slotEvidence: _evidence,
    bookingDraft: _draft,
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

/** DATE atual ou correção de TIME → read tipado de slots → reducer canônico. */
export async function resolveDateSlotsFastPathV2(input: {
  frame: TurnFrameV2;
  dateResolution: CurrentDateResolutionV2;
  currentInboundText: string;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  now: Date;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<BookingProgressFastPathV2> {
  if (!input.frame.pending || !['DATE', 'TIME'].includes(input.frame.pending.kind)) {
    return { kind: 'continue_model', reason: 'pending_not_date_or_time' };
  }
  if (input.frame.pending.flowId !== input.frame.flowState.flowId) {
    return { kind: 'continue_model', reason: 'pending_from_other_flow' };
  }
  const askedAt = Date.parse(input.frame.pending.askedAt);
  if (!Number.isFinite(askedAt) || input.now.getTime() - askedAt > 4 * 60 * 60 * 1_000) {
    return { kind: 'continue_model', reason: 'pending_older_than_4h' };
  }
  if (input.dateResolution.kind !== 'resolved') {
    return {
      kind: 'continue_model',
      reason:
        input.dateResolution.kind === 'ambiguous'
          ? 'current_date_ambiguous'
          : 'current_date_absent',
    };
  }
  const date = input.dateResolution.date;
  if (
    input.frame.pending.kind === 'TIME' &&
    input.frame.flowState.slotEvidence?.date === date
  ) {
    return { kind: 'continue_model', reason: 'same_date_as_time_evidence' };
  }
  const serviceId = input.frame.flowState.fixedServiceId;
  if (!serviceId) return { kind: 'continue_model', reason: 'service_not_resolved' };
  const baseState = clearTemporalState(input.frame.flowState);
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
    professionalId: input.frame.flowState.fixedProfessionalId,
    servicesResult: input.servicesResult,
    userMessages: [input.currentInboundText],
    trustedFlowState: input.frame.flowState,
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
  const slots = read.parsed?.success === true ? validSlots(read.parsed) : null;
  if (slots && slots.length > 0) {
    const reducer = reduceToolLifecycleV2({
      frame: { ...input.frame, flowState: baseState },
      toolTrace: [trace],
      services: input.servicesResult,
      sourceInboundText: input.currentInboundText,
    });
    if (reducer?.kind === 'canonical_slots') {
      return {
        kind: 'resolved',
        result: reducer.result,
        loop,
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
    return { kind: 'continue_model', reason: 'no_duplicate_conflict', loop };
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
    nextFlowState: followUp.nextFlowState,
  };
}
