import axios from 'axios';
import type { LicensedServiceDescriptionV2 } from './licensedServiceDescription';
import * as Sentry from '@sentry/node';
import type { TenantBotConfig } from '../configProvider';
import { ERP_API_TOKEN } from '../erpApiToken';
import {
  runtimeErrorKind,
  safeHttpStatus,
} from '../observability/safeRuntime';
import {
  CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
} from './customerIdentitySafety';
import { normalizeServiceAliases } from '../lib/services/service-aliases';
import {
  LAB_WRITE_DISABLED_REASON,
  assertExternalWriteAllowed,
  labBlockedWriteEffect,
  type LabBlockedWriteEffect,
} from '../runtimePolicy';

export { CUSTOMER_IDENTITY_AMBIGUOUS_HINT } from './customerIdentitySafety';

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';

const erpApi = axios.create({
  baseURL: ERP_BASE_URL,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${ERP_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

/** Mapeia o path do ERP → nome de operação legível pro Sentry. */
const ERP_OPERATION_BY_PATH: Record<string, string> = {
  '/api/v1/agenda/info': 'get_services',
  '/api/v1/agenda/availability': 'get_available_slots',
  '/api/v1/agenda/cancel': 'cancel_appointment',
  '/api/v1/agenda/book': 'book_appointment',
};

// Captura centralizada das falhas de calendar (chamadas ao ERP). Reporta UMA
// vez por falha, com operação + status, herdando o escopo de isolamento da
// mensagem (tenantSlug/phoneNumberId/messageId). 409 = corrida de horário e
// 422 = recusa por regra de negócio (bloqueio/pacote/fora de horário) — ambos
// ESPERADOS → reportados como `warning`, com o reason machine-readable do corpo
// pra diagnosticar padrões. Re-rejeita pra não mudar o fluxo.
erpApi.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    try {
      const isAxios = axios.isAxiosError(error);
      const status = isAxios ? error.response?.status : undefined;
      const url = isAxios ? error.config?.url ?? '' : '';
      const operation = ERP_OPERATION_BY_PATH[url] ?? (url || 'erp_request');
      const isRaceCondition = status === 409;
      const isExpectedScheduling = status === 409 || status === 422;
      const responseData = isAxios ? error.response?.data : undefined;
      const rawBookReason =
        responseData && typeof responseData === 'object' && 'reason' in responseData
          ? String((responseData as { reason?: unknown }).reason ?? 'n/a')
          : 'n/a';
      const bookReason = rawBookReason.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

      Sentry.captureException(new Error('erp calendar request failed'), {
        level: isExpectedScheduling ? 'warning' : 'error',
        tags: {
          service: 'erp_calendar',
          operation,
          erp_status: status ?? 'network',
          race_condition: isRaceCondition,
          book_reason: bookReason,
          error_kind: runtimeErrorKind(error),
        },
        contexts: {
          erp_request: {
            operation,
            url,
            method: isAxios ? error.config?.method ?? null : null,
            status: status ?? null,
            kind: isAxios ? (status ? 'http' : 'network') : 'unknown',
          },
        },
      });
    } catch {
      // nunca deixa o Sentry quebrar o fluxo do bot
    }
    return Promise.reject(error);
  },
);

interface ErpService {
  id: string | number;
  name: string;
  durationMinutes: number;
  price?: number | string | null;
  /** Contrato aditivo ERP: aliases já normalizados no catálogo autoritativo. */
  aliases?: unknown;
  // FIX 3: ids dos profissionais habilitados PARA ESTE serviço (vem do ERP novo).
  // Ausente no ERP antigo → tratamos como elegibilidade global (fallback).
  professionalIds?: (string | number)[];
}

interface ErpProfessional {
  id: string | number;
  name?: string;
}

interface AgendaInfoResponse {
  services?: ErpService[];
  professionals?: ErpProfessional[];
  staff?: ErpProfessional[];
  providers?: ErpProfessional[];
  employees?: ErpProfessional[];
}

interface AvailabilityResponse {
  availableTimes?: string[];
  // Grade completa do dia (dentro do funcionamento), independente de ocupação.
  // Usada por bookAppointment pra distinguir "fora do horário" de "ocupado".
  scheduleTimes?: string[];
  professionalId?: string | number | null;
}

export type CancellationDisposition =
  | 'AUTO_CANCEL_ALLOWED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'NOT_CANCELABLE';

export type UpcomingAppointment = {
  id: string;
  startTime: string;
  endTime: string;
  serviceName: string;
  professionalName: string;
  status: string;
  /** Aditivo ERP-6. Ausente = runtime velho; o fluxo v2 falha fechado. */
  cancellationDisposition?: CancellationDisposition;
};

interface UpcomingAppointmentsResponse {
  appointments?: UpcomingAppointment[];
}

export type CustomerIdentityFailureReason = 'customer_identity_ambiguous';
export type UpcomingAppointmentsResult = {
  success: boolean;
  appointments?: UpcomingAppointment[];
  message?: string;
  reason?: CustomerIdentityFailureReason;
};

export interface ServiceSummary {
  id: string;
  name: string;
  durationMinutes: number;
  price: number | null;
  priceFormatted: string | null;
  // FIX 3: ids (string) dos profissionais habilitados pra este serviço, quando o
  // ERP os informa. undefined = ERP antigo → fallback pra lista global.
  professionalIds?: string[];
  /** Aliases tenant-scoped; ausente no ERP antigo equivale a []. */
  aliases?: string[];
  /** Somente a rota v2 hidrata este campo do catálogo autoritativo da config. */
  licensedDescription?: LicensedServiceDescriptionV2 | null;
}

export interface ProfessionalSummary {
  id: string;
  name: string;
}

export type ServicesResult = {
  success: boolean;
  services?: ServiceSummary[];
  professionals?: ProfessionalSummary[];
  message?: string;
};

type ServicesCacheEntry = { data: ServicesResult; expiresAt: number };
const servicesCache = new Map<string, ServicesCacheEntry>();
const SERVICES_CACHE_TTL_MS = 5 * 60 * 1000;

type AvailabilityResult = {
  success: boolean;
  slots?: string[];
  professionalId?: string;
  message?: string;
};

export type BookFailureReason =
  | 'blocked'
  | 'conflict'
  | 'outside_hours'
  | 'package_exhausted'
  | CustomerIdentityFailureReason
  | typeof LAB_WRITE_DISABLED_REASON
  | 'other';

export type BookAppointmentResult = {
  success: boolean;
  message: string;
  // Motivo machine-readable quando success=false por causa do horário. Orienta
  // o próximo passo da Ana (regra de fluxo B do system prompt).
  reason?: BookFailureReason;
  // Instrução interna empurrando a Ana a consultar horários reais antes de
  // sugerir alternativas. Nunca deve ser repassada ao cliente.
  hint?: string;
  // GUARDRAIL A: quando o book falha por horário (blocked/conflict/outside_hours),
  // o PRÓPRIO calendarService já consulta a disponibilidade e devolve os horários
  // reais aqui — a Ana só repassa, sem chutar horários vizinhos (mata Falha 2 em
  // código, não dependendo do modelo seguir a regra B em prosa).
  availableSlots?: string[];
  class?: LabBlockedWriteEffect['class'];
  outcome?: LabBlockedWriteEffect['outcome'];
  writeCommitted?: false;
};

// Empurra a Ana a SEMPRE consultar a disponibilidade real antes de oferecer
// alternativas — em vez de chutar horários vizinhos (Falha 2 do relato).
export const BOOK_ALTERNATIVES_HINT =
  'Chame getAvailableSlots(date, serviceId, professionalId?) ANTES de sugerir qualquer alternativa e ofereça SOMENTE os horários reais retornados. NUNCA chute horários vizinhos.';

export const CANCEL_UPCOMING_APPOINTMENTS_LOOKUP_FAILURE_HINT =
  'INTERNAL_HINT: não consegui consultar os agendamentos futuros do cliente agora para confirmar qual cancelar. NÃO responda como se tivesse cancelado. Ao cliente, responda SOMENTE: "Esse cancelamento precisa ser tratado diretamente pela equipe. Eu não consigo concluí-lo por aqui." NÃO prometa nenhuma ação futura sua nem da equipe.';

export const GET_AVAILABLE_SLOTS_MISSING_SERVICE_HINT =
  'INTERNAL_HINT: getAvailableSlots foi chamado sem serviceId. NÃO ofereça horários ainda. Se houver mais de um serviço disponível, liste os serviços ao cliente e pergunte qual ele quer ANTES de consultar horários; depois refaça esta chamada com o serviceId correto. Se houver apenas um serviço, use o id dele.';

export const INVALID_SERVICE_ID_HINT =
  'INTERNAL_HINT: o serviceId fornecido parece ser um exemplo ou nome em vez do ID real. Chame getServices nesta conversa e use o "id" exato retornado. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.';

export const INVALID_PROFESSIONAL_ID_HINT =
  'INTERNAL_HINT: o professionalId parece ser um nome em vez do ID real. Chame getServices, encontre o profissional pelo nome na lista e use o "id" técnico dele. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.';

export const PROFESSIONAL_SERVICE_MISMATCH_HINT =
  'INTERNAL_HINT: o profissional escolhido NÃO atende o serviço selecionado (ou está inativo). NÃO ofereça horários com ele. Ofereça outro profissional habilitado pra este serviço (veja "Profissionais habilitados" no system prompt) ou, se não houver, avise gentilmente que o serviço está sem profissional disponível no momento. NÃO repasse esta mensagem ao cliente.';

export const NO_UPCOMING_APPOINTMENTS_HINT =
  'INTERNAL_HINT: o cliente não tem nenhum agendamento futuro para cancelar. Informe gentilmente que não encontrou agendamento futuro; NÃO diga que cancelou.';

export const BOOK_APPOINTMENT_MISSING_SERVICE_HINT =
  'INTERNAL_HINT: bookAppointment foi chamado sem serviceId. NÃO confirme nada ao cliente. Se há mais de um serviço, pergunte qual ele quer; depois refaça a chamada com o serviceId correto.';

/** Normaliza o reason vindo do ERP (ou infere pelo status) pro enum da Ana. */
export function normalizeBookReason(
  serverReason: unknown,
  status?: number
): BookFailureReason {
  if (
    serverReason === 'blocked' ||
    serverReason === 'conflict' ||
    serverReason === 'outside_hours' ||
    serverReason === 'package_exhausted' ||
    serverReason === 'customer_identity_ambiguous' ||
    serverReason === 'other'
  ) {
    return serverReason;
  }
  if (status === 409) return 'conflict';
  return 'other';
}

/** Mensagem (amigável, não-técnica) mostrada ao cliente final por motivo. */
export function customerMessageForReason(
  reason: BookFailureReason,
  professionalName?: string
): string {
  switch (reason) {
    case 'blocked':
      return professionalName
        ? `Esse horário está bloqueado na agenda da ${professionalName} (pode ser folga, almoço ou férias).`
        : 'Esse horário está bloqueado na agenda do profissional (pode ser folga, almoço ou férias).';
    case 'conflict':
      return 'Esse horário acabou de ser preenchido.';
    case 'outside_hours':
      return 'Esse horário está fora do nosso horário de atendimento.';
    case 'package_exhausted':
      return 'O pacote não tem mais sessões disponíveis para esse serviço.';
    case 'customer_identity_ambiguous':
      return CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE;
    default:
      return 'Não consegui concluir o agendamento nesse horário.';
  }
}

/**
 * GUARDRAIL A — monta a resposta de "horário indisponível" JÁ com os horários
 * reais embutidos. Em vez de pedir (via prosa/hint) pra Ana chamar
 * getAvailableSlots e confiar que ela não vai chutar, o código consulta a
 * disponibilidade aqui e entrega a lista pronta. A Ana só repassa.
 * Determinístico: o conjunto de horários oferecido = o conjunto real.
 */
async function buildUnavailableResult(params: {
  reason: BookFailureReason;
  config: TenantBotConfig;
  date: string; // YYYY-MM-DD (já normalizado)
  serviceId: string;
  serviceName: string;
  professionalId?: string;
  professionalName?: string;
}): Promise<BookAppointmentResult> {
  const { reason, config, date, serviceId, serviceName, professionalId, professionalName } = params;
  const baseMessage = customerMessageForReason(reason, professionalName);
  const withProfessional = professionalName ? ` com ${professionalName}` : '';

  let alternatives: string[] = [];
  try {
    const availability = await getAvailableSlots(date, serviceId, config, professionalId);
    if (availability.success && Array.isArray(availability.slots)) {
      alternatives = availability.slots;
    }
  } catch {
    // Sem alternativas (ERP indisponível) — cai no fallback abaixo.
  }

  if (alternatives.length > 0) {
    return {
      success: false,
      reason,
      availableSlots: alternatives,
      message: `${baseMessage} Tenho estes horários disponíveis para ${serviceName}${withProfessional}: ${alternatives.join(', ')}. Qual deles prefere?`,
      hint: 'Estes (availableSlots) são os ÚNICOS horários reais disponíveis — já consultados pelo sistema. Ofereça SOMENTE eles, exatamente como vieram. NUNCA invente, arredonde ou acrescente outros horários, e NÃO chame getAvailableSlots de novo.',
    };
  }

  // Nenhum horário real nesse dia (tudo ocupado/bloqueado, ou ERP fora).
  return {
    success: false,
    reason,
    availableSlots: [],
    message: `${baseMessage} Não encontrei outros horários livres nesse dia para ${serviceName}${withProfessional}. Quer tentar outra data?`,
    hint: 'Não há horários reais nesse dia. NÃO invente horários — ofereça tentar outra data.',
  };
}

export function invalidateServicesCache(tenantSlug?: string): void {
  if (tenantSlug) servicesCache.delete(tenantSlug);
  else servicesCache.clear();
}

/** Somente smokes: injeta o snapshot autoritativo sem chamar o ERP. */
export function __seedServicesCacheForTest(
  tenantSlug: string,
  data: ServicesResult
): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__seedServicesCacheForTest é proibido em produção');
  }
  const slug = tenantSlug.trim();
  if (!slug) {
    throw new Error('__seedServicesCacheForTest exige tenantSlug');
  }
  servicesCache.set(slug, {
    data,
    expiresAt: Date.now() + SERVICES_CACHE_TTL_MS,
  });
}

function formatDateBR(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

function formatDateTimeBR(isoDateTime: string, timezone: string): { date: string; time: string } {
  const parsedDate = new Date(isoDateTime);

  if (Number.isNaN(parsedDate.getTime())) {
    return {
      date: formatDateBR(isoDateTime.slice(0, 10)),
      time: isoDateTime.slice(11, 16),
    };
  }

  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsedDate);
  const getPart = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    date: `${getPart('day')}/${getPart('month')}/${getPart('year')}`,
    time: `${getPart('hour')}:${getPart('minute')}`,
  };
}

function getTodayStr(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(now);
}

/**
 * Filtro defensivo de apresentação: a API do ERP pode devolver a grade do dia
 * inteiro, inclusive horários já passados. Nunca oferece slot < agora no fuso.
 * Não altera a checagem de ocupação do book (não é caminho novo de negação).
 */
export function filterSlotsAtOrAfterNow(input: {
  date: string;
  slots: readonly string[];
  now: Date;
  timezone: string;
}): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) return [...input.slots];
  const today = getTodayStr(input.timezone, input.now);
  if (input.date > today) return [...input.slots];
  if (input.date < today) return [];
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(input.now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const nowMinutes = hour * 60 + minute;
  return input.slots.filter((slot) => {
    const match = /^(?:[01]\d|2[0-3]):([0-5]\d)$/u.exec(slot);
    if (!match) return true;
    const slotHour = Number(slot.slice(0, 2));
    const slotMinute = Number(match[1]);
    return slotHour * 60 + slotMinute >= nowMinutes;
  });
}

function getCurrentYear(timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
    }).format(new Date())
  );
}

function normalizeDate(date: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;

  const [year, month, day] = date.split('-');
  const currentYear = getCurrentYear(timezone);

  if (Number(year) >= currentYear) {
    return date;
  }

  const correctedDate = `${currentYear}-${month}-${day}`;
  console.log('⚠️ Ano de agendamento corrigido automaticamente.');
  return correctedDate;
}

function normalizeServices(services: ErpService[] = []): ServiceSummary[] {
  return services
    .filter((service) => service?.id !== undefined && service?.name)
    .map((service) => {
      const rawPrice = service.price;
      const parsedPrice =
        rawPrice === undefined || rawPrice === null || rawPrice === ''
          ? null
          : Number(rawPrice);
      const price = Number.isFinite(parsedPrice) ? parsedPrice : null;

      // FIX 3: só define professionalIds quando o ERP mandou o campo (ERP novo).
      // Ausente → undefined → fallback global no consumidor.
      const professionalIds = Array.isArray(service.professionalIds)
        ? service.professionalIds.map((id) => String(id))
        : undefined;

      return {
        id: String(service.id),
        name: service.name,
        durationMinutes: Number(service.durationMinutes) || 0,
        price,
        priceFormatted:
          price === null
            ? null
            : new Intl.NumberFormat('pt-BR', {
                style: 'currency',
                currency: 'BRL',
              }).format(price),
        professionalIds,
        aliases: normalizeServiceAliases(service.aliases),
      };
    });
}

function normalizeProfessionals(info: AgendaInfoResponse): ProfessionalSummary[] {
  const candidates = info.professionals ?? info.staff ?? info.providers ?? info.employees ?? [];

  return candidates
    .filter((professional) => professional?.id !== undefined)
    .map((professional) => ({
      id: String(professional.id),
      name: professional.name?.trim() || 'Profissional',
    }));
}

function getServiceById(
  services: ServiceSummary[],
  serviceId: string
): ServiceSummary | undefined {
  return findByExactIdOrUniquePrefix(services, serviceId);
}

function findByExactIdOrUniquePrefix<T extends { id: string }>(
  items: T[],
  rawId: string
): T | undefined {
  const id = rawId.trim();
  if (!id) return undefined;

  const exactMatch = items.find((item) => item.id === id);
  if (exactMatch) return exactMatch;

  const prefixMatches = items.filter((item) => item.id.startsWith(id));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

async function resolveServiceId(
  serviceId: string,
  config: TenantBotConfig
): Promise<string> {
  const servicesResult = await getServices(config);
  const resolvedService = getServiceById(servicesResult.services ?? [], serviceId);
  return resolvedService?.id ?? serviceId;
}

async function resolveProfessionalId(
  professionalId: string | undefined,
  config: TenantBotConfig
): Promise<string | undefined> {
  if (!professionalId?.trim()) return undefined;

  const servicesResult = await getServices(config);
  const resolvedProfessional = findByExactIdOrUniquePrefix(
    servicesResult.professionals ?? [],
    professionalId
  );

  return resolvedProfessional?.id ?? professionalId;
}

function toUtcIso(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(utcGuess);
  const getPart = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const zonedTimestamp = Date.UTC(
    getPart('year'),
    getPart('month') - 1,
    getPart('day'),
    getPart('hour'),
    getPart('minute'),
    getPart('second')
  );

  const desiredTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = zonedTimestamp - desiredTimestamp;

  return new Date(desiredTimestamp - offsetMs).toISOString();
}

function normalizeWhatsappPhone(phone: string): string {
  const sanitized = phone.trim();
  if (!sanitized) return sanitized;
  return sanitized.startsWith('+') ? sanitized : `+${sanitized}`;
}

function normalizeAppointmentReference(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d{1,2})\s*h\s*(\d{2})/g, '$1:$2')
    .replace(/(\d{1,2})\s*h\b/g, '$1:00')
    .replace(/\b(as|às)\b/g, ' ')
    .replace(/[^\d:/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTechnicalAppointmentId(value: string): string | undefined {
  return value.match(/\bcm[a-z0-9]{12,}\b/i)?.[0];
}

function formatAppointmentForHint(
  appointment: UpcomingAppointment,
  timezone: string
): string {
  const { date, time } = formatDateTimeBR(appointment.startTime, timezone);
  return `${date} às ${time} (${appointment.serviceName} com ${appointment.professionalName}) [id: ${appointment.id}]`;
}

function findAppointmentByTechnicalId(
  appointments: UpcomingAppointment[],
  rawAppointmentId: string
): UpcomingAppointment | undefined {
  const candidate = extractTechnicalAppointmentId(rawAppointmentId) ?? rawAppointmentId.trim();
  if (!candidate) return undefined;

  // Cancelamento é destrutivo: prefixo único não basta. Só um ID técnico
  // COMPLETO que exista na lista autoritativa do cliente pode ser aceito.
  return appointments.find((appointment) => appointment.id === candidate);
}

function findAppointmentByDateTimeReference(
  appointments: UpcomingAppointment[],
  rawReference: string,
  timezone: string
): UpcomingAppointment | undefined {
  const normalizedReference = normalizeAppointmentReference(rawReference);
  if (!normalizedReference) return undefined;

  const dateTimeMatches = appointments.filter((appointment) => {
    const { date, time } = formatDateTimeBR(appointment.startTime, timezone);
    const shortDate = date.slice(0, 5);
    const fullReference = normalizeAppointmentReference(`${date} ${time}`);
    const shortReference = normalizeAppointmentReference(`${shortDate} ${time}`);

    return (
      normalizedReference.includes(fullReference) ||
      normalizedReference.includes(shortReference)
    );
  });

  if (dateTimeMatches.length === 1) {
    return dateTimeMatches[0];
  }

  const dateMatches = appointments.filter((appointment) => {
    const { date } = formatDateTimeBR(appointment.startTime, timezone);
    const shortDate = date.slice(0, 5);
    return (
      normalizedReference.includes(normalizeAppointmentReference(date)) ||
      normalizedReference.includes(normalizeAppointmentReference(shortDate))
    );
  });

  if (dateMatches.length === 1) {
    return dateMatches[0];
  }

  const timeMatches = appointments.filter((appointment) => {
    const { time } = formatDateTimeBR(appointment.startTime, timezone);
    return normalizedReference.includes(normalizeAppointmentReference(time));
  });

  return timeMatches.length === 1 ? timeMatches[0] : undefined;
}

export type CancellationTargetResolution =
  | {
      ok: true;
      appointmentId: string;
      correctedFromRequestedId: boolean;
    }
  | {
      ok: false;
      reason: 'multiple_reference_required' | 'target_not_found';
      message: string;
    };

export function buildCancellationMultipleReferenceHint(list: string): string {
  return `INTERNAL_HINT: há mais de um agendamento futuro e a mensagem ATUAL do cliente não identifica de forma inequívoca o mesmo agendamento do appointmentId recebido. Agendamentos futuros:\n- ${list}\n\nPergunte qual cancelar (peça data e/ou horário). NÃO escolha por conta própria nem chame cancelAppointment de novo neste turno.`;
}

export function buildCancellationTargetNotFoundHint(list: string): string {
  return `INTERNAL_HINT: não deu pra identificar com segurança qual agendamento cancelar — o appointmentId não corresponde exatamente a um agendamento futuro e a mensagem ATUAL do cliente não traz uma referência inequívoca de data/horário. Agendamentos futuros:\n- ${list}\n\nPergunte qual cancelar (peça data e/ou horário). NÃO escolha por conta própria nem chame cancelAppointment de novo neste turno.`;
}

/**
 * Resolve o alvo destrutivo sem rede. É exportado para que smokes e o benchmark
 * auditem exatamente a mesma decisão usada em produção, sem reimplementar uma
 * versão mais permissiva do guardrail.
 */
export function resolveCancellationTarget(input: {
  appointments: UpcomingAppointment[];
  requestedAppointmentId: string;
  currentUserMessage: string;
  timezone: string;
}): CancellationTargetResolution {
  const requestedAppointmentId = input.requestedAppointmentId.trim();
  const technicalMatch = findAppointmentByTechnicalId(
    input.appointments,
    requestedAppointmentId
  );
  const currentReferenceMatch = findAppointmentByDateTimeReference(
    input.appointments,
    input.currentUserMessage,
    input.timezone
  );
  const list = input.appointments
    .slice(0, 5)
    .map((appointment) =>
      formatAppointmentForHint(appointment, input.timezone)
    )
    .join('\n- ');

  if (technicalMatch) {
    if (
      input.appointments.length >= 2 &&
      currentReferenceMatch?.id !== technicalMatch.id
    ) {
      return {
        ok: false,
        reason: 'multiple_reference_required',
        message: buildCancellationMultipleReferenceHint(list),
      };
    }

    return {
      ok: true,
      appointmentId: technicalMatch.id,
      correctedFromRequestedId: technicalMatch.id !== requestedAppointmentId,
    };
  }

  if (currentReferenceMatch) {
    return {
      ok: true,
      appointmentId: currentReferenceMatch.id,
      correctedFromRequestedId:
        currentReferenceMatch.id !== requestedAppointmentId,
    };
  }

  return {
    ok: false,
    reason: 'target_not_found',
    message: buildCancellationTargetNotFoundHint(list),
  };
}

export async function getServices(
  config: TenantBotConfig
): Promise<ServicesResult> {
  const cacheKey = config.tenantSlug;
  const cached = servicesCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const response = await erpApi.get<AgendaInfoResponse>('/api/v1/agenda/info', {
      params: { tenantSlug: config.tenantSlug },
    });

    const services = normalizeServices(response.data.services);
    const professionals = normalizeProfessionals(response.data);

    if (services.length === 0) {
      return {
        success: false,
        message:
          'Não encontrei serviços cadastrados no momento. Pode tentar novamente em instantes?',
      };
    }

    const result: ServicesResult = { success: true, services, professionals };
    servicesCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + SERVICES_CACHE_TTL_MS,
    });
    return result;
  } catch (err) {
    console.error(
      `❌ Erro ao consultar serviços no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );
    return {
      success: false,
      message:
        'Tive um problema ao consultar os serviços agora. Pode tentar de novo em instantes?',
    };
  }
}

export async function getAvailableSlots(
  date: string,
  serviceId: string,
  config: TenantBotConfig,
  professionalId?: string
): Promise<AvailabilityResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: 'Formato de data inválido. Use AAAA-MM-DD.' };
  }

  if (!serviceId?.trim()) {
    return {
      success: false,
      message: GET_AVAILABLE_SLOTS_MISSING_SERVICE_HINT,
    };
  }

  if (serviceId.startsWith('seed-') || /^[a-z]+$/.test(serviceId)) {
    return {
      success: false,
      message: INVALID_SERVICE_ID_HINT,
    };
  }

  if (
    professionalId &&
    /^[a-zà-ÿ\s]+$/i.test(professionalId) &&
    professionalId.length < 20
  ) {
    return {
      success: false,
      message: INVALID_PROFESSIONAL_ID_HINT,
    };
  }

  const normalizedDate = normalizeDate(date, config.timezone);
  const resolvedServiceId = await resolveServiceId(serviceId, config);
  const resolvedProfessionalId = await resolveProfessionalId(professionalId, config);

  if (normalizedDate < getTodayStr(config.timezone)) {
    return { success: false, message: 'Essa data já passou. Escolha uma data futura.' };
  }

  try {
    const response = await erpApi.get<AvailabilityResponse>('/api/v1/agenda/availability', {
        params: {
          tenantSlug: config.tenantSlug,
          date: normalizedDate,
          serviceId: resolvedServiceId,
          professionalId: resolvedProfessionalId?.trim() || undefined,
        },
      });

    const slots = filterSlotsAtOrAfterNow({
      date: normalizedDate,
      slots: Array.isArray(response.data?.availableTimes)
        ? response.data.availableTimes.filter(
            (slot): slot is string => typeof slot === 'string'
          )
        : [],
      now: new Date(),
      timezone: config.timezone,
    });

    const availabilityProfessionalId =
      response.data?.professionalId == null
        ? undefined
        : String(response.data.professionalId);

    if (slots.length === 0) {
      return {
        success: true,
        slots: [],
        professionalId: availabilityProfessionalId,
        message: `Não encontrei horários livres para ${formatDateBR(normalizedDate)}.`,
      };
    }

    return {
      success: true,
      slots,
      professionalId: availabilityProfessionalId,
    };
  } catch (err) {
    console.error(
      `❌ Erro ao consultar disponibilidade no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );

    // FIX 3 (defesa em profundidade): se o ERP recusou com 400 porque o
    // profissional não atende/está inativo pra este serviço, devolve um
    // INTERNAL_HINT específico pra Ana oferecer outro habilitado — em vez do
    // genérico "tive um problema". A hint é interna; nunca repassada ao cliente.
    if (axios.isAxiosError(err) && err.response?.status === 400) {
      const erpMessage =
        typeof err.response.data?.error === 'string' ? err.response.data.error : '';
      if (/não pode realizar|não está ativo/i.test(erpMessage)) {
        return {
          success: false,
          message: PROFESSIONAL_SERVICE_MISMATCH_HINT,
        };
      }
    }

    return {
      success: false,
      message:
        'Tive um problema ao verificar os horários agora. Pode tentar novamente em instantes?',
    };
  }
}

async function getCustomerUpcomingAppointmentsWithPolicy(
  phone: string,
  config: TenantBotConfig,
  identityMismatchFailsClosed: boolean
): Promise<UpcomingAppointmentsResult> {
  try {
    const response = await erpApi.get<UpcomingAppointmentsResponse>(
      '/api/v1/agenda/customer-upcoming',
      {
        params: {
          tenantSlug: config.tenantSlug,
          customerPhone: normalizeWhatsappPhone(phone),
        },
      }
    );

    const appointments = Array.isArray(response.data?.appointments)
      ? response.data.appointments.filter(
          (appointment): appointment is UpcomingAppointment =>
            typeof appointment?.id === 'string' &&
            typeof appointment.startTime === 'string' &&
            typeof appointment.endTime === 'string'
        ).map((appointment) => {
          const disposition = appointment.cancellationDisposition;
          if (
            disposition === 'AUTO_CANCEL_ALLOWED' ||
            disposition === 'HUMAN_REVIEW_REQUIRED' ||
            disposition === 'NOT_CANCELABLE'
          ) {
            return { ...appointment, cancellationDisposition: disposition };
          }
          const { cancellationDisposition: _ignored, ...rest } = appointment;
          void _ignored;
          return rest;
        })
      : [];

    return { success: true, appointments };
  } catch (err) {
    const responseReason = axios.isAxiosError(err)
      ? (err.response?.data as { reason?: unknown } | undefined)?.reason
      : undefined;
    if (
      responseReason === 'customer_identity_ambiguous' ||
      (identityMismatchFailsClosed &&
        responseReason === 'customer_identity_mismatch')
    ) {
      return {
        success: false,
        reason: 'customer_identity_ambiguous',
        message: CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
      };
    }
    console.error(
      `❌ Erro ao consultar agendamentos futuros no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );
    return {
      success: false,
      message:
        'Tive um problema ao verificar seus agendamentos existentes agora. Pode tentar novamente em instantes?',
    };
  }
}

/** Contrato legado/v1 preservado: só a ambiguidade já conhecida é tipada. */
export async function getCustomerUpcomingAppointments(
  phone: string,
  config: TenantBotConfig
): Promise<UpcomingAppointmentsResult> {
  return getCustomerUpcomingAppointmentsWithPolicy(phone, config, false);
}

/** Entitlement v2: titular divergente também falha fechado, sem fatos de agenda. */
export async function getCustomerUpcomingAppointmentsV2(
  phone: string,
  config: TenantBotConfig
): Promise<UpcomingAppointmentsResult> {
  return getCustomerUpcomingAppointmentsWithPolicy(phone, config, true);
}

interface CancelAppointmentPayload {
  tenantSlug: string;
  customerPhone: string;
  appointmentId: string;
}

export interface CancelAppointmentDeps {
  getUpcomingAppointments: typeof getCustomerUpcomingAppointments;
  postCancel: (payload: CancelAppointmentPayload) => Promise<void>;
}

const defaultCancelAppointmentDeps: CancelAppointmentDeps = {
  getUpcomingAppointments: getCustomerUpcomingAppointments,
  postCancel: async (payload) => {
    assertExternalWriteAllowed();
    await erpApi.post('/api/v1/agenda/cancel', payload);
  },
};

export async function cancelAppointment(
  appointmentId: string,
  phone: string,
  config: TenantBotConfig,
  currentUserMessage?: string,
  deps: CancelAppointmentDeps = defaultCancelAppointmentDeps
): Promise<{
  success: boolean;
  message: string;
  reason?: CustomerIdentityFailureReason | typeof LAB_WRITE_DISABLED_REASON;
  class?: LabBlockedWriteEffect['class'];
  outcome?: LabBlockedWriteEffect['outcome'];
  writeCommitted?: false;
}> {
  const labBlock = labBlockedWriteEffect('cancelAppointment');
  if (labBlock) return labBlock;

  const requestedAppointmentId = appointmentId?.trim();

  if (!requestedAppointmentId) {
    return { success: false, message: 'Preciso do ID do agendamento para cancelar.' };
  }

  const upcoming = await deps.getUpcomingAppointments(phone, config);

  // GUARDRAIL: o cancelamento SÓ pode mirar um agendamento futuro REAL do cliente.
  // Não dá pra confiar no id que o modelo passa. O ID precisa bater EXATAMENTE
  // com a lista autoritativa. Sem match técnico, só a referência inequívoca de
  // data/horário na mensagem ATUAL do cliente pode resolver o alvo. Com 2+
  // futuros, até um ID válido exige que a mensagem atual identifique o mesmo
  // agendamento — o modelo nunca escolhe um dos vários sozinho.
  if (!upcoming.success) {
    return {
      success: false,
      reason: upcoming.reason,
      message:
        upcoming.reason === 'customer_identity_ambiguous'
          ? CUSTOMER_IDENTITY_AMBIGUOUS_HINT
          : CANCEL_UPCOMING_APPOINTMENTS_LOOKUP_FAILURE_HINT,
    };
  }

  const upcomingAppointments = upcoming.appointments ?? [];
  if (upcomingAppointments.length === 0) {
    return {
      success: false,
      message: NO_UPCOMING_APPOINTMENTS_HINT,
    };
  }

  const target = resolveCancellationTarget({
    appointments: upcomingAppointments,
    requestedAppointmentId,
    currentUserMessage: currentUserMessage ?? '',
    timezone: config.timezone,
  });
  if (!target.ok) {
    return { success: false, message: target.message };
  }

  if (target.correctedFromRequestedId) {
    console.log(
      `🔎 appointmentId corrigido por referência explícita do cliente | tenantSlug=${config.tenantSlug}`
    );
  }

  try {
    await deps.postCancel({
      tenantSlug: config.tenantSlug,
      customerPhone: normalizeWhatsappPhone(phone),
      appointmentId: target.appointmentId,
    });

    return {
      success: true,
      message: 'Agendamento anterior cancelado com sucesso.',
    };
  } catch (err) {
    const responseReason = axios.isAxiosError(err)
      ? (err.response?.data as { reason?: unknown } | undefined)?.reason
      : undefined;
    if (responseReason === 'customer_identity_ambiguous') {
      return {
        success: false,
        reason: 'customer_identity_ambiguous',
        message: CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
      };
    }
    const errorMessage =
      axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
        ? err.response.data.error
        : 'Não consegui cancelar esse agendamento agora.';

    console.error(
      `❌ Erro ao cancelar agendamento no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );

    return {
      success: false,
      message: errorMessage,
    };
  }
}

export function buildExistingAppointmentsHint(
  appointmentCount: number,
  list: string
): string {
  return `INTERNAL_HINT: o cliente já tem ${appointmentCount} agendamento(s) futuro(s) marcado(s):\n- ${list}\n\nPergunte ao cliente:\n"Vi que você já tem outro(s) agendamento(s). Quer:\n1. Manter os dois (este novo + o anterior)\n2. Remarcar (cancelar o anterior e marcar este novo)\n3. Só cancelar o anterior (sem criar este novo)\n4. Pensar e decidir depois"\n\nAguarde a resposta. Conforme a escolha:\n- Opção 1: chame bookAppointment novamente com confirmedDuplicate=true\n- Opção 2: chame cancelAppointment(appointmentId do anterior) E DEPOIS chame bookAppointment novamente com confirmedDuplicate=true\n- Opção 3: chame cancelAppointment(appointmentId do anterior). NÃO chame bookAppointment.\n- Opção 4: não chame ferramenta nenhuma, responda gentilmente.\nSe houver mais de um agendamento anterior e o cliente escolher remarcar ou só cancelar sem indicar qual, pergunte qual agendamento deve ser cancelado e peça para responder com data e horário antes de chamar cancelAppointment.`;
}

export async function bookAppointment(
  date: string,
  time: string,
  serviceId: string,
  phone: string,
  customerName: string,
  config: TenantBotConfig,
  professionalId?: string,
  confirmedDuplicate = false
): Promise<BookAppointmentResult> {
  const labBlock = labBlockedWriteEffect('bookAppointment');
  if (labBlock) return labBlock;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, reason: 'other', message: 'Formato de data inválido. Use AAAA-MM-DD.' };
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { success: false, reason: 'other', message: 'Formato de horário inválido. Use HH:MM.' };
  }

  if (!serviceId?.trim()) {
    return {
      success: false,
      message: BOOK_APPOINTMENT_MISSING_SERVICE_HINT,
    };
  }

  if (serviceId.startsWith('seed-') || /^[a-z]+$/.test(serviceId)) {
    return {
      success: false,
      message: INVALID_SERVICE_ID_HINT,
    };
  }

  if (
    professionalId &&
    /^[a-zà-ÿ\s]+$/i.test(professionalId) &&
    professionalId.length < 20
  ) {
    return {
      success: false,
      message: INVALID_PROFESSIONAL_ID_HINT,
    };
  }

  const normalizedDate = normalizeDate(date, config.timezone);

  // Resolução fora do try: getServices não lança (trata erro internamente),
  // e o catch precisa do nome do profissional pra montar a mensagem de bloqueio.
  const servicesResult = await getServices(config);
  const services = servicesResult.services ?? [];
  const professionals = servicesResult.professionals ?? [];
  const selectedService = getServiceById(services, serviceId);
  const requestedProfessional = findByExactIdOrUniquePrefix(
    professionals,
    professionalId?.trim() ?? ''
  );
  const professionalName = requestedProfessional?.name;

  if (!selectedService) {
    return {
      success: false,
      reason: 'other',
      message:
        'Não encontrei esse serviço no sistema. Me diga qual serviço você quer e eu verifico de novo.',
    };
  }

  try {
    // A disponibilidade já respeita ScheduleBlock (corrigido no ERP). Usamos
    // availableTimes (livres) + scheduleTimes (grade do dia, p/ distinguir
    // "fora de horário" de "ocupado/bloqueado"). O motivo exato (bloqueio vs
    // conflito) vem do POST autoritativo abaixo.
    const availabilityResponse = await erpApi.get<AvailabilityResponse>(
      '/api/v1/agenda/availability',
      {
        params: {
          tenantSlug: config.tenantSlug,
          date: normalizedDate,
          serviceId: selectedService.id,
          professionalId:
            requestedProfessional?.id || professionalId?.trim() || undefined,
        },
      }
    );

    const availableSlots = Array.isArray(availabilityResponse.data?.availableTimes)
      ? availabilityResponse.data.availableTimes.filter(
          (slot): slot is string => typeof slot === 'string'
        )
      : [];
    const scheduleSlots = Array.isArray(availabilityResponse.data?.scheduleTimes)
      ? availabilityResponse.data.scheduleTimes.filter(
          (slot): slot is string => typeof slot === 'string'
        )
      : [];

    const slotIsFree = availableSlots.includes(time);
    const gridKnown = scheduleSlots.length > 0;
    const slotInGrid = !gridKnown || scheduleSlots.includes(time);

    // Fora da grade do dia = fora do horário de atendimento. Não tenta agendar;
    // já devolve os horários reais do dia (Guardrail A).
    if (!slotIsFree && gridKnown && !slotInGrid) {
      return await buildUnavailableResult({
        reason: 'outside_hours',
        config,
        date: normalizedDate,
        serviceId: selectedService.id,
        serviceName: selectedService.name,
        professionalId: requestedProfessional?.id || professionalId?.trim() || undefined,
        professionalName,
      });
    }

    // Profissional: se o cliente especificou (requestedProfessional resolvido),
    // mandamos esse id — comportamento estrito (409 se ocupado). Se NÃO
    // especificou, OMITIMOS o professionalId e o SERVIDOR escolhe um profissional
    // livre no horário (fix multi-profissional). Antes, a Ana mandava
    // professionals[0] como default — bug: às vezes o 1º estava ocupado com outro
    // profissional livre, batendo em 409.
    const selectedProfessionalId = requestedProfessional?.id;

    const startTime = toUtcIso(normalizedDate, time, config.timezone);
    const endTime = new Date(
      new Date(startTime).getTime() + selectedService.durationMinutes * 60_000
    ).toISOString();

    // Detecção de duplicidade só quando vamos REALMENTE criar (slot livre). Se o
    // slot está ocupado/bloqueado, deixamos o POST recusar e classificar o motivo
    // — não faz sentido perguntar sobre duplicata pra um horário indisponível.
    if (slotIsFree && !confirmedDuplicate) {
      const upcoming = await getCustomerUpcomingAppointments(phone, config);

      if (
        !upcoming.success &&
        upcoming.reason === 'customer_identity_ambiguous'
      ) {
        return {
          success: false,
          reason: 'customer_identity_ambiguous',
          message: CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
        };
      }

      if (upcoming.success && upcoming.appointments && upcoming.appointments.length > 0) {
        const list = upcoming.appointments
          .slice(0, 3)
          .map((appointment) => {
            const { date: appointmentDate, time: appointmentTime } = formatDateTimeBR(
              appointment.startTime,
              config.timezone
            );
            return `${appointmentDate} às ${appointmentTime} (${appointment.serviceName} com ${appointment.professionalName}) [id: ${appointment.id}]`;
          })
          .join('\n- ');

        return {
          success: false,
          message: buildExistingAppointmentsHint(
            upcoming.appointments.length,
            list
          ),
        };
      }
    }

    // Breadcrumb ANTES do POST: fica no escopo quando o interceptor captura uma
    // eventual falha, dando contexto (tenant/data/hora/profissional) pro Sentry.
    Sentry.addBreadcrumb({
      category: 'booking',
      type: 'info',
      level: 'info',
      message: 'book_attempt',
      data: {
        tenantSlug: config.tenantSlug,
        date: normalizedDate,
        time,
        serviceId: selectedService.id,
        professionalId: selectedProfessionalId ?? 'auto',
        slotWasFree: slotIsFree,
      },
    });

    // professionalId undefined é OMITIDO do JSON pelo axios → o servidor resolve
    // automaticamente um profissional livre.
    assertExternalWriteAllowed();
    const bookResponse = await erpApi.post<{
      professional?: { id: string; name?: string };
    }>('/api/v1/agenda/book', {
      tenantSlug: config.tenantSlug,
      customerPhone: normalizeWhatsappPhone(phone),
      customerName: customerName?.trim() || 'Cliente',
      serviceId: selectedService.id,
      professionalId: selectedProfessionalId,
      startTime,
      endTime,
    });

    // Confirma COM QUEM ficou — essencial quando o profissional foi escolhido
    // automaticamente (cliente disse "tanto faz").
    const bookedProfessionalName =
      bookResponse.data?.professional?.name?.trim() || requestedProfessional?.name;
    const withProfessional = bookedProfessionalName ? ` com ${bookedProfessionalName}` : '';

    const successResult: BookAppointmentResult = {
      success: true,
      message: `Agendado com sucesso para ${formatDateBR(normalizedDate)} às ${time}${withProfessional} para ${selectedService.name}.`,
    };
    return successResult;
  } catch (err) {
    // Falha HTTP do POST/availability: o ERP devolve um reason machine-readable
    // (blocked/conflict/outside_hours/package_exhausted/other). Traduzimos numa
    // mensagem amigável + hint pra Ana SEMPRE consultar horários reais depois.
    if (axios.isAxiosError(err) && err.response) {
      const responseData = err.response.data as { reason?: unknown } | undefined;
      const reason = normalizeBookReason(responseData?.reason, err.response.status);
      if (reason === 'customer_identity_ambiguous') {
        return {
          success: false,
          reason,
          message: CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
        };
      }
      // Falha por horário → entrega alternativas reais já consultadas (Guardrail A).
      if (reason === 'blocked' || reason === 'conflict' || reason === 'outside_hours') {
        return await buildUnavailableResult({
          reason,
          config,
          date: normalizedDate,
          serviceId: selectedService.id,
          serviceName: selectedService.name,
          professionalId: requestedProfessional?.id || professionalId?.trim() || undefined,
          professionalName,
        });
      }
      // package_exhausted / other: oferecer horários não resolve.
      return {
        success: false,
        reason,
        message: customerMessageForReason(reason, professionalName),
        hint: BOOK_ALTERNATIVES_HINT,
      };
    }

    // Erro de rede / inesperado: transitório, não é problema de horário —
    // sem hint (consultar horários não ajudaria) e mensagem de "tente de novo".
    console.error(
      `❌ Erro ao criar agendamento no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );
    return {
      success: false,
      reason: 'other',
      message:
        'Tive um problema ao criar o agendamento agora. Pode tentar novamente em instantes?',
    };
  }
}

/**
 * Amostras estáveis de toda instrução interna que pode alcançar o loop da
 * recepcionista. Os builders dinâmicos recebem apenas dados sintéticos; o smoke
 * usa esta lista para auditar promessas operacionais sem tocar no ERP.
 */
export const CALENDAR_RECEPTIONIST_INTERNAL_HINT_SAMPLES = [
  BOOK_ALTERNATIVES_HINT,
  CANCEL_UPCOMING_APPOINTMENTS_LOOKUP_FAILURE_HINT,
  GET_AVAILABLE_SLOTS_MISSING_SERVICE_HINT,
  INVALID_SERVICE_ID_HINT,
  INVALID_PROFESSIONAL_ID_HINT,
  PROFESSIONAL_SERVICE_MISMATCH_HINT,
  NO_UPCOMING_APPOINTMENTS_HINT,
  BOOK_APPOINTMENT_MISSING_SERVICE_HINT,
  buildCancellationMultipleReferenceHint(
    '05/08/2026 às 14:00 (Serviço Smoke com Profissional Smoke) [id: appointment-smoke]'
  ),
  buildCancellationTargetNotFoundHint(
    '05/08/2026 às 14:00 (Serviço Smoke com Profissional Smoke) [id: appointment-smoke]'
  ),
  buildExistingAppointmentsHint(
    1,
    '05/08/2026 às 14:00 (Serviço Smoke com Profissional Smoke) [id: appointment-smoke]'
  ),
] as const;
