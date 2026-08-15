import type { TenantBotConfig } from '../../configProvider';
import type {
  ReceptionistModelLoopResult,
  ReceptionistToolTraceEntry,
} from '../brainService';
import type {
  ServicesResult,
  UpcomingAppointment,
} from '../calendarService';
import { professionalSelectionGate } from '../professional-selection-gate';
import {
  STANDALONE_CANCEL_CUSTOMER_MESSAGE,
  buildExistingAppointmentReply,
  classifyExistingAppointmentIntent,
  type ExistingAppointmentIntent,
} from '../receptionistTurnGrounding';
import type {
  ModelTurnResultV2,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import { hasPositiveClauseMatchV2 } from './polarity';
import { displayDateV2 } from './lifecycleReducer';
import { stripPowerZeroMetalinguisticAssignmentsV2 } from './powerZeroWitness';

const UPCOMING_READ_REQUEST_RE =
  /\b(?:(?:ver|consultar|conferir|mostrar|mostra|lembrar|lembra)\b(?:\s+\w+){0,7}\b(?:agendamentos?|horarios?|marcacoes?)|(?:meus?|minhas?)\s+(?:agendamentos?|horarios?|marcacoes?)|(?:quando|qual\s+dia|que\s+dia|que\s+horario)\b(?:\s+\w+){0,6}\b(?:agendamento|horario|marcado)|(?:tenho|tem)\b(?:\s+\w+){0,5}\b(?:agendamento|horario)\b|(?:remarcar|reagendar|cancelar|desmarcar)\b)/gu;
const AVAILABILITY_READ_REQUEST_RE =
  /\b(?:(?:tem|teria|ha|consegue|pode|poderia|qual|quais|quando)\b(?:\s+\w+){0,6}\s+(?:horarios?|vagas?|disponibilidade)|(?:horarios?|vagas?|disponibilidade)\b(?:\s+\w+){0,6}\s+(?:tem|teria|ha|consegue|pode|qual|quais|quando)|(?:ver|consultar|conferir|mostrar)\b(?:\s+\w+){0,4}\s+(?:agenda|horarios?|vagas?))\b/gu;

export type ReadFastPathReasonV2 =
  | 'customer_identity_ambiguous'
  | 'customer_identity_mismatch'
  | 'service_not_resolved'
  | 'date_not_resolved'
  | 'professional_selection'
  | 'no_eligible_professional'
  | 'invalid_date'
  | 'past_date'
  | 'outside_hours'
  | 'rate_limited'
  | 'invalid_payload'
  | 'executor_error'
  | 'other';

export type ReadFastPathResultV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      loop: ReceptionistModelLoopResult;
      proof: ResolutionProof | null;
    };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export function hasExplicitUpcomingReadRequestV2(value: string): boolean {
  const witnessedValue = stripPowerZeroMetalinguisticAssignmentsV2(value);
  return (
    classifyExistingAppointmentIntent(witnessedValue) !== 'none' ||
    hasPositiveClauseMatchV2(witnessedValue, UPCOMING_READ_REQUEST_RE)
  );
}

export function hasExplicitAvailabilityReadRequestV2(value: string): boolean {
  return hasPositiveClauseMatchV2(value, AVAILABILITY_READ_REQUEST_RE);
}

function duplicateProofValid(
  proof: ResolutionProof | null | undefined,
  frame: TurnFrameV2
): proof is Extract<ResolutionProof, { kind: 'pending_option' }> {
  return Boolean(
    proof?.kind === 'pending_option' &&
      frame.pending?.kind === 'CONFIRMATION' &&
      proof.flowId === frame.flowState.flowId &&
      proof.flowId === frame.pending.flowId &&
      proof.questionId === frame.pending.questionId &&
      proof.pendingVersion === frame.pending.version &&
      frame.pending.options.some(
        (option) =>
          option.position === proof.position &&
          option.entityId === proof.entityId &&
          option.entityId.startsWith('duplicate-resolution:')
      )
  );
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

function reasonFromResult(
  parsed: Record<string, unknown> | null
): ReadFastPathReasonV2 {
  const reason = String(parsed?.reason ?? '').trim();
  if (
    [
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
  ) {
    return reason as ReadFastPathReasonV2;
  }
  return 'other';
}

export function canonicalReadFailureCopyV2(
  read: 'upcoming' | 'availability',
  reason: ReadFastPathReasonV2
): string {
  if (
    reason === 'customer_identity_ambiguous' ||
    reason === 'customer_identity_mismatch'
  ) {
    return 'Não consegui identificar com segurança qual cadastro consultar. Confira os dados e tente novamente.';
  }
  if (reason === 'rate_limited') {
    return 'A consulta está temporariamente ocupada. Pode tentar novamente em instantes?';
  }
  if (read === 'upcoming') {
    return 'Não consegui consultar seus agendamentos agora. Pode tentar novamente em instantes?';
  }
  switch (reason) {
    case 'service_not_resolved':
      return 'Qual serviço você quer consultar?';
    case 'date_not_resolved':
    case 'invalid_date':
      return 'Qual data você quer consultar?';
    case 'past_date':
      return 'Essa data já passou. Qual outra data você prefere?';
    case 'professional_selection':
      return 'Você prefere algum profissional específico ou tanto faz?';
    case 'no_eligible_professional':
      return 'Esse serviço está temporariamente sem profissional disponível. Quer escolher outro serviço?';
    case 'outside_hours':
      return 'Não encontrei horários disponíveis nessa data. Quer tentar outro dia?';
    default:
      return 'Não consegui consultar os horários agora. Pode tentar novamente em instantes?';
  }
}

function formatAppointment(
  appointment: UpcomingAppointment,
  timezone: string
): string | null {
  const instant = new Date(appointment.startTime);
  if (
    Number.isNaN(instant.getTime()) ||
    typeof appointment.serviceName !== 'string' ||
    !appointment.serviceName.trim() ||
    typeof appointment.professionalName !== 'string' ||
    !appointment.professionalName.trim()
  ) {
    return null;
  }
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
  const date = `${part('day')}/${part('month')}/${part('year')}`;
  const time = `${part('hour')}:${part('minute')}`;
  return `${appointment.serviceName.trim()} em ${date} às ${time} com ${appointment.professionalName.trim()}`;
}

function localAppointmentDate(
  appointment: UpcomingAppointment,
  timezone: string
): string | null {
  const instant = new Date(appointment.startTime);
  if (Number.isNaN(instant.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function parsedUpcomingAppointments(
  parsed: Record<string, unknown>,
  timezone: string,
  dateFilter?: string
): UpcomingAppointment[] | null {
  if (!Array.isArray(parsed.appointments)) return null;
  const appointments: UpcomingAppointment[] = [];
  for (const entry of parsed.appointments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const appointment = entry as UpcomingAppointment;
    if (!formatAppointment(appointment, timezone)) return null;
    if (
      dateFilter &&
      localAppointmentDate(appointment, timezone) !== dateFilter
    ) {
      continue;
    }
    appointments.push(appointment);
  }
  return appointments;
}

function upcomingSuccessCopy(
  parsed: Record<string, unknown>,
  timezone: string,
  dateFilter?: string
): string | null {
  const appointments = parsedUpcomingAppointments(parsed, timezone, dateFilter);
  if (!appointments) return null;
  if (appointments.length === 0) {
    return 'Não encontrei agendamentos futuros para você.';
  }
  const formatted = appointments.map((entry) => formatAppointment(entry, timezone));
  return formatted.length === 1
    ? `Encontrei este agendamento: ${formatted[0]}.`
    : `Encontrei estes agendamentos: ${formatted.join('; ')}.`;
}

function forcedExistingIntentCopy(
  intent: Exclude<ExistingAppointmentIntent, 'none' | 'inspect'>,
  parsed: Record<string, unknown>,
  timezone: string,
  dateFilter?: string
): string | null {
  const appointments = parsedUpcomingAppointments(parsed, timezone, dateFilter);
  if (!appointments) return null;
  return intent === 'cancel'
    ? STANDALONE_CANCEL_CUSTOMER_MESSAGE
    : buildExistingAppointmentReply('reschedule', appointments, timezone);
}

function validSlots(parsed: Record<string, unknown>): string[] | null {
  if (!Array.isArray(parsed.slots)) return null;
  const slots = parsed.slots.filter(
    (slot): slot is string =>
      typeof slot === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)
  );
  return slots.length === parsed.slots.length ? [...new Set(slots)] : null;
}

function availabilitySuccessResult(
  parsed: Record<string, unknown>,
  frame: TurnFrameV2,
  date: string
): ModelTurnResultV2 | null {
  const slots = validSlots(parsed);
  if (!slots) return null;
  if (slots.length === 0) {
    return {
      schemaVersion: 2,
      reply: 'Não encontrei horários disponíveis nessa data. Quer tentar outro dia?',
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
  return {
    schemaVersion: 2,
    reply: `Pra ${displayDateV2(date)} eu tenho ${slots.join(', ')}. Qual fica melhor pra você?`,
    replyPurpose: 'DATE_TIME_QUESTION',
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'TIME',
      flowId: frame.flowState.flowId,
      optionEntityIds: slots,
    },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

function loopForRead(trace: ReceptionistToolTraceEntry): ReceptionistModelLoopResult {
  return {
    rawReply: null,
    exhausted: false,
    provider: 'openai',
    model: 'read-fast-path-v2',
    providerReportedModels: [],
    rounds: 0,
    messages: [],
    toolTrace: [trace],
    usage: [],
  };
}

async function executeRead(input: {
  name: 'getUpcomingAppointments' | 'getAvailableSlots';
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

/** Read-only, allow-only: qualquer entitlement incompleto volta ao modelo. */
export async function resolveReadFastPathV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  servicesResult: ServicesResult;
  config: TenantBotConfig;
  duplicateResolutionProof?: ResolutionProof | null;
  forceUpcomingRead?: boolean;
  forcedExistingIntent?: Exclude<ExistingAppointmentIntent, 'none'>;
  /** Recorte somente por data civil unívoca resolvida no lote completo. */
  upcomingDateFilter?: string;
  now?: Date;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<ReadFastPathResultV2> {
  const explicitUpcoming = hasExplicitUpcomingReadRequestV2(input.inboundText);
  const proof = duplicateProofValid(input.duplicateResolutionProof, input.frame)
    ? input.duplicateResolutionProof
    : null;
  if (explicitUpcoming || proof || input.forceUpcomingRead === true) {
    const read = await executeRead({
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
    const successCopy =
      read.parsed?.success === true
        ? input.forcedExistingIntent && input.forcedExistingIntent !== 'inspect'
          ? forcedExistingIntentCopy(
              input.forcedExistingIntent,
              read.parsed,
              input.config.timezone,
              input.upcomingDateFilter
            )
          : upcomingSuccessCopy(
              read.parsed,
              input.config.timezone,
              input.upcomingDateFilter
            )
        : null;
    const reply = successCopy ?? canonicalReadFailureCopyV2(
      'upcoming',
      read.parsed?.success === true
        ? 'invalid_payload'
        : reasonFromResult(read.parsed)
    );
    return {
      kind: 'resolved',
      proof,
      loop: loopForRead(trace),
      result: {
        schemaVersion: 2,
        reply,
        replyPurpose: 'OPERATIONAL_ANSWER',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
    };
  }

  if (!hasExplicitAvailabilityReadRequestV2(input.inboundText)) {
    return { kind: 'continue_model', reason: 'no_explicit_read_request' };
  }
  const serviceId = input.frame.flowState.fixedServiceId;
  const date = input.frame.flowState.resolvedDate;
  if (!serviceId) {
    return { kind: 'continue_model', reason: 'service_not_resolved' };
  }
  if (!date) {
    return { kind: 'continue_model', reason: 'date_not_resolved' };
  }
  const today = input.now
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: input.config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(input.now)
    : null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || (today !== null && date < today)) {
    return { kind: 'continue_model', reason: 'past_or_invalid_state_date' };
  }
  const professionalGate = professionalSelectionGate({
    serviceId,
    professionalId: input.frame.flowState.fixedProfessionalId,
    servicesResult: input.servicesResult,
    userMessages: [input.inboundText],
    trustedFlowState: input.frame.flowState,
  });
  if (!professionalGate.ok) {
    return { kind: 'continue_model', reason: professionalGate.reason };
  }
  const args: Record<string, unknown> = { date, serviceId };
  if (professionalGate.effectiveProfessionalId) {
    args.professionalId = professionalGate.effectiveProfessionalId;
  }
  const read = await executeRead({
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
  const successResult =
    read.parsed?.success === true
      ? availabilitySuccessResult(read.parsed, input.frame, date)
      : null;
  const result: ModelTurnResultV2 = successResult ?? {
    schemaVersion: 2,
    reply: canonicalReadFailureCopyV2(
      'availability',
      read.parsed?.success === true
        ? 'invalid_payload'
        : reasonFromResult(read.parsed)
    ),
    replyPurpose: 'OPERATIONAL_ANSWER',
    pendingTransitionCandidate: { kind: 'preserve' },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
  return {
    kind: 'resolved',
    proof: null,
    loop: loopForRead(trace),
    result,
  };
}

export const __readMatchersForSmokeV2 = {
  UPCOMING_READ_REQUEST_RE,
  AVAILABILITY_READ_REQUEST_RE,
  normalize,
};
