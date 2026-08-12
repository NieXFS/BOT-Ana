/**
 * Grounding determinístico do turno da recepcionista, compartilhado pela
 * produção e pelo harness. Decide se o código consulta agenda/disponibilidade
 * ANTES do modelo e se o histórico pode ir ao LLM com nomes de outra pessoa.
 */
import type {
  ServicesResult,
  UpcomingAppointment,
  UpcomingAppointmentsResult,
} from './calendarService';
import { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from './customerIdentitySafety';
import type {
  ReceptionistModelHistoryMessage,
  StoredConversationMessage,
} from './humanConversationContext';
import { toReceptionistModelHistory } from './humanConversationContext';
import {
  eligibleProfessionalsForService,
  professionalSelectionGate,
} from './professional-selection-gate';
import {
  uniqueCatalogServiceFromCurrentMessage,
} from './service-gate';
import { upcomingAppointmentReadGate } from './upcomingAppointmentGate';

export const STANDALONE_CANCEL_CUSTOMER_MESSAGE =
  'Esse cancelamento precisa ser tratado diretamente pela equipe. Eu não consigo concluí-lo por aqui.';

export const NO_UPCOMING_APPOINTMENT_CUSTOMER_MESSAGE =
  'Não encontrei um agendamento futuro neste cadastro.';

export const UNKNOWN_SERVICE_CUSTOMER_MESSAGE =
  'Esse tipo de atendimento não está disponível neste estabelecimento.';

export const NON_OPERATIONAL_FEEDBACK_CUSTOMER_MESSAGE =
  'Que bom que você gostou. Se precisar de algo, é só chamar.';

export const HISTORY_PERSON_NAME_PLACEHOLDER = '[NOME]';

export type ExistingAppointmentIntent =
  | 'reschedule'
  | 'cancel'
  | 'inspect'
  | 'none';

export interface GroundedToolTraceEntry {
  round: number;
  name: string;
  args: Record<string, unknown>;
  argumentsValidJson: true;
  result: string;
}

export type GroundedReceptionistTurn =
  | {
      kind: 'short_circuit';
      reply: string;
      toolTrace: GroundedToolTraceEntry[];
      identityCanonical: boolean;
      modelHistory: ReceptionistModelHistoryMessage[];
    }
  | {
      kind: 'continue';
      toolTrace: GroundedToolTraceEntry[];
      identityCanonical: false;
      modelHistory: ReceptionistModelHistoryMessage[];
    };

export interface AvailabilitySlotsResult {
  success: boolean;
  slots?: string[];
  message?: string;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function civilDateInTimezone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addCivilDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

function weekdayInTimezone(now: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export function resolveRelativeCalendarDate(
  message: string,
  now: Date,
  timezone: string
): string | null {
  const text = normalize(message);
  if (!text) return null;
  const today = civilDateInTimezone(now, timezone);
  if (/\bhoje\b/.test(text)) return today;
  if (/\bdepois\s+de\s+amanha\b/.test(text)) return addCivilDays(today, 2);
  if (/\bamanha\b/.test(text)) return addCivilDays(today, 1);

  for (const [name, target] of Object.entries(WEEKDAY_INDEX)) {
    if (!new RegExp(`\\b${name}\\b`).test(text)) continue;
    const current = weekdayInTimezone(now, timezone);
    const delta = (target - current + 7) % 7;
    return addCivilDays(today, delta);
  }
  return null;
}

const AVAILABILITY_ASK_RE =
  /\b(?:quais?\s+horarios?|horarios?\s+(?:voces?\s+)?(?:tem|t[eê]m)|disponibilidade|tem(?:\s+algum)?\s+horario|vagas?)\b/;
const BOOKING_VERB_RE =
  /\b(?:marcar|marca|agendar|agenda|agendamento|remarcar|remarca|reagendar|reagenda|book)\b/;

export function namedServiceAvailabilityIntent(
  message: string,
  services: Array<{ id: string; name: string }>,
  now: Date,
  timezone: string
): { serviceId: string; serviceName: string; date: string } | null {
  const service = uniqueCatalogServiceFromCurrentMessage(message, services);
  if (!service) return null;
  const date = resolveRelativeCalendarDate(message, now, timezone);
  if (!date) return null;
  const text = normalize(message);
  if (!AVAILABILITY_ASK_RE.test(text) && !BOOKING_VERB_RE.test(text)) {
    return null;
  }
  return { serviceId: service.id, serviceName: service.name, date };
}

export function leftoverNonCatalogTokens(
  message: string,
  catalog: ServicesResult
): string[] {
  let text = normalize(message);
  for (const service of catalog.services ?? []) {
    text = text.replace(new RegExp(escapeRegex(normalize(service.name)), 'g'), ' ');
  }
  for (const professional of catalog.professionals ?? []) {
    text = text.replace(
      new RegExp(escapeRegex(normalize(professional.name)), 'g'),
      ' '
    );
    for (const part of normalize(professional.name).split(' ')) {
      if (part.length >= 3) {
        text = text.replace(new RegExp(`\\b${escapeRegex(part)}\\b`, 'g'), ' ');
      }
    }
  }
  text = text.replace(
    /\b(?:quero|queria|gostaria|preciso|desejo|prefiro|fazer|fazem|voces|voce|vc|marcar|marca|agendar|agenda|agendamento|remarcar|remarca|reagendar|hoje|amanha|depois|segunda|terca|quarta|quinta|sexta|sabado|domingo|horario|horarios|disponibilidade|vaga|vagas|dia|com|para|pra|por|uma|um|uns|umas|quais|qual|tem|têm|teria|pode|poderia|consigo|consegue)\b/g,
    ' '
  );
  text = text.replace(/\b\d+[h:]?\d*\b/g, ' ');
  return text
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length >= 4);
}

export function isUnknownCatalogServiceRequest(
  message: string,
  catalog: ServicesResult
): boolean {
  if (uniqueCatalogServiceFromCurrentMessage(message, catalog.services ?? [])) {
    return false;
  }
  const text = normalize(message);
  if (!BOOKING_VERB_RE.test(text) && !AVAILABILITY_ASK_RE.test(text)) {
    return false;
  }
  return leftoverNonCatalogTokens(message, catalog).length > 0;
}

const FEEDBACK_RE =
  /\b(?:ficou\s+(?:otimo|otima|bom|boa|maravilhos[oa]|perfeit[oa]|incrivel)|gostei|amei|adorei|muito\s+bom)\b/;

export function isNonOperationalFeedback(message: string): boolean {
  const text = normalize(message);
  if (!FEEDBACK_RE.test(text)) return false;
  if (classifyExistingAppointmentIntent(message) !== 'none') return false;
  if (BOOKING_VERB_RE.test(text) || AVAILABILITY_ASK_RE.test(text)) return false;
  return true;
}

export function classifyExistingAppointmentIntent(
  message: string
): ExistingAppointmentIntent {
  const gate = upcomingAppointmentReadGate({ currentUserMessage: message });
  if (!gate.ok) return 'none';
  const text = normalize(message);
  const reschedule = /\b(?:remarcar|remarcacao|reagendar)\b/.test(text);
  const cancel = /\b(?:cancelar|cancelamento)\b/.test(text);
  if (reschedule) return 'reschedule';
  if (cancel) return 'cancel';
  return 'inspect';
}

function allowedPersonNameTokens(
  catalog: ServicesResult,
  currentUserText: string,
  botName?: string
): Set<string> {
  const allowed = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalize(value ?? '');
    if (normalized.length >= 3) allowed.add(normalized);
    for (const part of normalized.split(' ')) {
      if (part.length >= 3) allowed.add(part);
    }
  };
  add(botName);
  add('ana');
  for (const professional of catalog.professionals ?? []) {
    add(professional.name);
  }
  add(currentUserText);
  return allowed;
}

const VOCATIVE_NAME_RE =
  /\b([A-ZÁÉÍÓÚÂÊÔÃÕ][A-Za-zÁÉÍÓÚÂÊÔÃÕáéíóúâêôãõç]{2,})\s*,\s+(?:seu|sua|seus|suas|voce|vc)\b/g;
const GREETING_NAME_RE =
  /\b(?:oi|ola|oie|opa)\s+([A-ZÁÉÍÓÚÂÊÔÃÕ][A-Za-zÁÉÍÓÚÂÊÔÃÕáéíóúâêôãõç]{2,})\b/gi;

function collectContaminatingNames(
  history: readonly StoredConversationMessage[],
  currentUserText: string,
  allowed: Set<string>
): string[] {
  const found = new Set<string>();
  for (const message of history) {
    if (message.role === 'user' && message.content === currentUserText) {
      continue;
    }
    const patterns = [VOCATIVE_NAME_RE, GREETING_NAME_RE];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of message.content.matchAll(pattern)) {
        const name = match[1]?.trim();
        if (!name) continue;
        if (allowed.has(normalize(name))) continue;
        found.add(name);
      }
    }
  }
  return [...found];
}

export function redactUncataloguedPersonNames(
  history: readonly StoredConversationMessage[],
  catalog: ServicesResult,
  currentUserText: string,
  botName?: string
): StoredConversationMessage[] {
  const allowed = allowedPersonNameTokens(catalog, currentUserText, botName);
  const names = collectContaminatingNames(history, currentUserText, allowed);
  if (names.length === 0) {
    return history.map((message) => ({ ...message }));
  }
  return history.map((message) => {
    if (message.role === 'user' && message.content === currentUserText) {
      return { ...message };
    }
    let content = message.content;
    for (const name of names) {
      content = content.replace(
        new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'),
        HISTORY_PERSON_NAME_PLACEHOLDER
      );
    }
    return { ...message, content };
  });
}

function formatCivilDateBr(ymd: string): string {
  const [year, month, day] = ymd.split('-');
  return `${day}/${month}/${year}`;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

export function buildAvailabilityOfferReply(
  serviceName: string,
  date: string,
  slots: string[]
): string {
  if (slots.length === 0) {
    return `Não encontrei horários livres para ${serviceName} em ${formatCivilDateBr(date)}.`;
  }
  return `Para ${serviceName} em ${formatCivilDateBr(date)} tenho ${formatList(slots)}. Qual horário fica melhor?`;
}

function appointmentLocalParts(
  startTime: string,
  timezone: string
): { day: string; time: string } | null {
  const parsed = new Date(startTime);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const day = get('day');
  const time = `${get('hour')}:${get('minute')}`;
  if (!day || time === ':') return null;
  return { day, time };
}

export function buildExistingAppointmentReply(
  intent: Exclude<ExistingAppointmentIntent, 'none' | 'cancel'>,
  appointments: UpcomingAppointment[],
  timezone: string
): string {
  if (appointments.length === 0) {
    return NO_UPCOMING_APPOINTMENT_CUSTOMER_MESSAGE;
  }
  const lines = appointments.map((appointment) => {
    const parts = appointmentLocalParts(appointment.startTime, timezone);
    const when = parts
      ? `dia ${Number(parts.day)} às ${parts.time}`
      : 'em data a confirmar';
    const service = appointment.serviceName?.trim();
    const professional = appointment.professionalName?.trim();
    const serviceBit = service ? ` para ${service}` : '';
    const professionalBit = professional ? ` com a ${professional}` : '';
    return `${when}${serviceBit}${professionalBit}`;
  });
  if (appointments.length === 1) {
    const question =
      intent === 'reschedule'
        ? ' Quer remarcar esse horário?'
        : '';
    return `Você tem um horário marcado ${lines[0]}.${question}`;
  }
  const question =
    intent === 'reschedule'
      ? ' Qual desses você quer remarcar?'
      : ' Qual desses você quer consultar?';
  return `Você tem estes horários marcados: ${formatList(lines)}.${question}`;
}

function customerSafeUpcomingFailure(
  upcoming: UpcomingAppointmentsResult
): { reply: string; identityCanonical: boolean } {
  if (upcoming.reason === 'customer_identity_ambiguous') {
    return {
      reply: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
      identityCanonical: true,
    };
  }
  const message = upcoming.message?.trim() ?? '';
  if (message && !/INTERNAL_HINT/i.test(message)) {
    return { reply: message, identityCanonical: false };
  }
  return {
    reply:
      'Tive um problema ao verificar seus agendamentos existentes agora. Pode tentar novamente em instantes?',
    identityCanonical: false,
  };
}

function traceEntry(
  name: string,
  args: Record<string, unknown>,
  result: unknown
): GroundedToolTraceEntry {
  return {
    round: 0,
    name,
    args,
    argumentsValidJson: true,
    result: typeof result === 'string' ? result : JSON.stringify(result),
  };
}

export async function resolveGroundedReceptionistTurn(input: {
  userMessage: string;
  userMessages: string[];
  history: readonly StoredConversationMessage[];
  services: ServicesResult;
  now: Date;
  timezone: string;
  botName?: string;
  readUpcoming: () => Promise<UpcomingAppointmentsResult>;
  readSlots: (args: {
    date: string;
    serviceId: string;
    professionalId?: string;
  }) => Promise<AvailabilitySlotsResult>;
}): Promise<GroundedReceptionistTurn> {
  const redacted = redactUncataloguedPersonNames(
    input.history,
    input.services,
    input.userMessage,
    input.botName
  );
  const modelHistory = toReceptionistModelHistory(redacted);
  const continueTurn = (
    toolTrace: GroundedToolTraceEntry[] = []
  ): GroundedReceptionistTurn => ({
    kind: 'continue',
    toolTrace,
    identityCanonical: false,
    modelHistory,
  });

  const intent = classifyExistingAppointmentIntent(input.userMessage);
  if (intent !== 'none') {
    const upcoming = await input.readUpcoming();
    const toolTrace = [traceEntry('getUpcomingAppointments', {}, upcoming)];
    if (
      upcoming.reason === 'customer_identity_ambiguous' ||
      (!upcoming.success && upcoming.reason === 'customer_identity_ambiguous')
    ) {
      return {
        kind: 'short_circuit',
        reply: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
        toolTrace,
        identityCanonical: true,
        modelHistory,
      };
    }
    if (!upcoming.success) {
      const failure = customerSafeUpcomingFailure(upcoming);
      return {
        kind: 'short_circuit',
        reply: failure.reply,
        toolTrace,
        identityCanonical: failure.identityCanonical,
        modelHistory,
      };
    }
    if (intent === 'cancel') {
      return {
        kind: 'short_circuit',
        reply: STANDALONE_CANCEL_CUSTOMER_MESSAGE,
        toolTrace,
        identityCanonical: false,
        modelHistory,
      };
    }
    return {
      kind: 'short_circuit',
      reply: buildExistingAppointmentReply(
        intent,
        upcoming.appointments ?? [],
        input.timezone
      ),
      toolTrace,
      identityCanonical: false,
      modelHistory,
    };
  }

  const availability = namedServiceAvailabilityIntent(
    input.userMessage,
    input.services.services ?? [],
    input.now,
    input.timezone
  );
  if (availability) {
    const selectedService = (input.services.services ?? []).find(
      (service) => service.id === availability.serviceId
    );
    if (selectedService) {
      const eligible = eligibleProfessionalsForService(
        selectedService,
        input.services.professionals ?? []
      );
      if (eligible.length > 0) {
        let professionalId: string | undefined;
        let canReadSlots = true;
        if (eligible.length === 1) {
          professionalId = eligible[0]?.id;
        } else {
          const professionalGate = professionalSelectionGate({
            serviceId: availability.serviceId,
            servicesResult: input.services,
            userMessages: input.userMessages,
          });
          if (!professionalGate.ok) {
            canReadSlots = false;
          } else {
            professionalId = professionalGate.effectiveProfessionalId;
          }
        }
        if (canReadSlots) {
          const slotsArgs = {
            date: availability.date,
            serviceId: availability.serviceId,
            ...(professionalId ? { professionalId } : {}),
          };
          const slots = await input.readSlots(slotsArgs);
          const toolTrace = [traceEntry('getAvailableSlots', slotsArgs, slots)];
          if (slots.success && Array.isArray(slots.slots)) {
            return {
              kind: 'short_circuit',
              reply: buildAvailabilityOfferReply(
                availability.serviceName,
                availability.date,
                slots.slots
              ),
              toolTrace,
              identityCanonical: false,
              modelHistory,
            };
          }
          return continueTurn(toolTrace);
        }
      }
    }
  }

  if (isUnknownCatalogServiceRequest(input.userMessage, input.services)) {
    return {
      kind: 'short_circuit',
      reply: UNKNOWN_SERVICE_CUSTOMER_MESSAGE,
      toolTrace: [],
      identityCanonical: false,
      modelHistory,
    };
  }

  if (isNonOperationalFeedback(input.userMessage)) {
    return {
      kind: 'short_circuit',
      reply: NON_OPERATIONAL_FEEDBACK_CUSTOMER_MESSAGE,
      toolTrace: [],
      identityCanonical: false,
      modelHistory,
    };
  }

  return continueTurn();
}
