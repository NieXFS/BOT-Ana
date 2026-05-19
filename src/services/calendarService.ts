import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const ERP_API_TOKEN = process.env.ERP_API_TOKEN ?? 'minha-chave-secreta-receps-123';

const erpApi = axios.create({
  baseURL: ERP_BASE_URL,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${ERP_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

interface ErpService {
  id: string | number;
  name: string;
  durationMinutes: number;
  price?: number | string | null;
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
  professionalId?: string | number | null;
}

export type UpcomingAppointment = {
  id: string;
  startTime: string;
  endTime: string;
  serviceName: string;
  professionalName: string;
  status: string;
};

interface UpcomingAppointmentsResponse {
  appointments?: UpcomingAppointment[];
}

interface ServiceSummary {
  id: string;
  name: string;
  durationMinutes: number;
  price: number | null;
  priceFormatted: string | null;
}

interface ProfessionalSummary {
  id: string;
  name: string;
}

type ServicesResult = {
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

export function invalidateServicesCache(tenantSlug?: string): void {
  if (tenantSlug) servicesCache.delete(tenantSlug);
  else servicesCache.clear();
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

function getTodayStr(timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(new Date());
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
  console.log(`⚠️ Ano corrigido automaticamente de ${year} para ${currentYear}: ${correctedDate}`);
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

  const exactMatch = appointments.find((appointment) => appointment.id === candidate);
  if (exactMatch) return exactMatch;

  const prefixMatches = appointments.filter((appointment) =>
    appointment.id.startsWith(candidate)
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
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

  const timeMatches = appointments.filter((appointment) => {
    const { time } = formatDateTimeBR(appointment.startTime, timezone);
    return normalizedReference.includes(normalizeAppointmentReference(time));
  });

  return timeMatches.length === 1 ? timeMatches[0] : undefined;
}

function appointmentMatchesUserReference(
  appointment: UpcomingAppointment,
  rawReference: string | undefined,
  timezone: string
): boolean {
  if (!rawReference?.trim()) return false;

  const normalizedReference = normalizeAppointmentReference(rawReference);
  const { date, time } = formatDateTimeBR(appointment.startTime, timezone);
  const shortDate = date.slice(0, 5);
  const fullReference = normalizeAppointmentReference(`${date} ${time}`);
  const shortReference = normalizeAppointmentReference(`${shortDate} ${time}`);
  const timeReference = normalizeAppointmentReference(time);

  return (
    normalizedReference.includes(fullReference) ||
    normalizedReference.includes(shortReference) ||
    normalizedReference.includes(timeReference)
  );
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
    console.error('❌ Erro ao consultar serviços no ERP:', err);
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
      message: 'Preciso do serviço escolhido para consultar os horários.',
    };
  }

  if (serviceId.startsWith('seed-') || /^[a-z]+$/.test(serviceId)) {
    return {
      success: false,
      message:
        'INTERNAL_HINT: o serviceId fornecido parece ser um exemplo ou nome em vez do ID real. Chame getServices nesta conversa e use o "id" exato retornado. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.',
    };
  }

  if (
    professionalId &&
    /^[a-zà-ÿ\s]+$/i.test(professionalId) &&
    professionalId.length < 20
  ) {
    return {
      success: false,
      message:
        'INTERNAL_HINT: o professionalId parece ser um nome em vez do ID real. Chame getServices, encontre o profissional pelo nome na lista e use o "id" técnico dele. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.',
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

    const slots = Array.isArray(response.data?.availableTimes)
      ? response.data.availableTimes.filter((slot): slot is string => typeof slot === 'string')
      : [];

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
    console.error('❌ Erro ao consultar disponibilidade no ERP:', err);
    return {
      success: false,
      message:
        'Tive um problema ao verificar os horários agora. Pode tentar novamente em instantes?',
    };
  }
}

export async function getCustomerUpcomingAppointments(
  phone: string,
  config: TenantBotConfig
): Promise<{ success: boolean; appointments?: UpcomingAppointment[]; message?: string }> {
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
        )
      : [];

    return { success: true, appointments };
  } catch (err) {
    console.error('❌ Erro ao consultar agendamentos futuros no ERP:', err);
    return {
      success: false,
      message:
        'Tive um problema ao verificar seus agendamentos existentes agora. Pode tentar novamente em instantes?',
    };
  }
}

export async function cancelAppointment(
  appointmentId: string,
  phone: string,
  config: TenantBotConfig,
  currentUserMessage?: string
): Promise<{ success: boolean; message: string }> {
  const requestedAppointmentId = appointmentId?.trim();

  if (!requestedAppointmentId) {
    return { success: false, message: 'Preciso do ID do agendamento para cancelar.' };
  }

  let resolvedAppointmentId = requestedAppointmentId;
  const hasTechnicalId = Boolean(extractTechnicalAppointmentId(requestedAppointmentId));
  const upcoming = await getCustomerUpcomingAppointments(phone, config);

  if (upcoming.success && upcoming.appointments && upcoming.appointments.length > 0) {
    const technicalMatch = findAppointmentByTechnicalId(
      upcoming.appointments,
      requestedAppointmentId
    );

    if (technicalMatch) {
      resolvedAppointmentId = technicalMatch.id;
    } else if (!hasTechnicalId) {
      const dateTimeMatch = findAppointmentByDateTimeReference(
        upcoming.appointments,
        requestedAppointmentId,
        config.timezone
      );
      const userExplicitlyReferencedAppointment =
        dateTimeMatch &&
        appointmentMatchesUserReference(
          dateTimeMatch,
          currentUserMessage,
          config.timezone
        );

      if (
        dateTimeMatch &&
        (upcoming.appointments.length === 1 || userExplicitlyReferencedAppointment)
      ) {
        resolvedAppointmentId = dateTimeMatch.id;
      } else {
        const list = upcoming.appointments
          .slice(0, 5)
          .map((appointment) => formatAppointmentForHint(appointment, config.timezone))
          .join('\n- ');

        return {
          success: false,
          message: `INTERNAL_HINT: cancelAppointment recebeu "${requestedAppointmentId}", mas appointmentId precisa ser o ID técnico exato do agendamento. Agendamentos futuros atuais:\n- ${list}\n\nHá mais de um agendamento possível ou o parâmetro não é um ID técnico confiável. A mensagem atual do cliente não citou explicitamente esse data/horário. NÃO chame cancelAppointment novamente neste turno. Pergunte ao cliente qual agendamento deve ser cancelado e peça para responder com data e horário. Quando o cliente escolher, chame cancelAppointment com o id técnico correspondente se você tiver o ID; se não tiver, use a data/hora que o cliente acabou de citar. NÃO escolha um agendamento por conta própria.`,
        };
      }
    }

    if (resolvedAppointmentId !== requestedAppointmentId) {
      const resolvedAppointment = upcoming.appointments.find(
        (appointment) => appointment.id === resolvedAppointmentId
      );
      const resolvedLabel = resolvedAppointment
        ? formatAppointmentForHint(resolvedAppointment, config.timezone)
        : resolvedAppointmentId;
      console.log(
        `🔎 appointmentId "${requestedAppointmentId}" resolvido para ${resolvedLabel}`
      );
    }
  } else if (!hasTechnicalId) {
    return {
      success: false,
      message:
        'INTERNAL_HINT: cancelAppointment recebeu um appointmentId que não parece ser um ID técnico e não consegui consultar os agendamentos futuros para resolver. Não responda ao cliente como se tivesse cancelado; peça para a equipe ajudar com o cancelamento.',
    };
  }

  try {
    await erpApi.post('/api/v1/agenda/cancel', {
      tenantSlug: config.tenantSlug,
      customerPhone: normalizeWhatsappPhone(phone),
      appointmentId: resolvedAppointmentId,
    });

    return {
      success: true,
      message: 'Agendamento anterior cancelado com sucesso.',
    };
  } catch (err) {
    const errorMessage =
      axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
        ? err.response.data.error
        : 'Não consegui cancelar esse agendamento agora.';

    if (axios.isAxiosError(err)) {
      console.error('❌ Erro ao cancelar agendamento no ERP:', {
        status: err.response?.status,
        data: err.response?.data,
        code: err.code,
        message: err.message,
      });
    } else {
      console.error('❌ Erro ao cancelar agendamento no ERP:', err);
    }

    return {
      success: false,
      message: errorMessage,
    };
  }
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
): Promise<{ success: boolean; message: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: 'Formato de data inválido. Use AAAA-MM-DD.' };
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { success: false, message: 'Formato de horário inválido. Use HH:MM.' };
  }

  if (!serviceId?.trim()) {
    return {
      success: false,
      message: 'Preciso do serviço escolhido antes de concluir o agendamento.',
    };
  }

  if (serviceId.startsWith('seed-') || /^[a-z]+$/.test(serviceId)) {
    return {
      success: false,
      message:
        'INTERNAL_HINT: o serviceId fornecido parece ser um exemplo ou nome em vez do ID real. Chame getServices nesta conversa e use o "id" exato retornado. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.',
    };
  }

  if (
    professionalId &&
    /^[a-zà-ÿ\s]+$/i.test(professionalId) &&
    professionalId.length < 20
  ) {
    return {
      success: false,
      message:
        'INTERNAL_HINT: o professionalId parece ser um nome em vez do ID real. Chame getServices, encontre o profissional pelo nome na lista e use o "id" técnico dele. Não pergunte nada ao cliente; refaça esta chamada imediatamente com os IDs corretos.',
    };
  }

  const normalizedDate = normalizeDate(date, config.timezone);

  try {
    const servicesResult = await getServices(config);
    const services = servicesResult.services ?? [];
    const professionals = servicesResult.professionals ?? [];
    const selectedService = getServiceById(services, serviceId);
    const requestedProfessional = findByExactIdOrUniquePrefix(
      professionals,
      professionalId?.trim() ?? ''
    );

    if (!selectedService) {
      return {
        success: false,
        message:
          'Não encontrei esse serviço no sistema. Me diga qual serviço você quer e eu verifico de novo.',
      };
    }

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

    if (!availableSlots.includes(time)) {
      return {
        success: false,
        message:
          'Esse horário acabou de ficar indisponível. Me fala outro horário e eu vejo pra você.',
      };
    }

    const availabilityProfessionalId =
      availabilityResponse.data?.professionalId == null
        ? undefined
        : String(availabilityResponse.data.professionalId);

    const selectedProfessionalId =
      requestedProfessional?.id || availabilityProfessionalId || professionals[0]?.id;

    if (!selectedProfessionalId) {
      return {
        success: false,
        message:
          'Não encontrei um profissional disponível no sistema para concluir esse agendamento.',
      };
    }

    const startTime = toUtcIso(normalizedDate, time, config.timezone);
    const endTime = new Date(
      new Date(startTime).getTime() + selectedService.durationMinutes * 60_000
    ).toISOString();

    if (!confirmedDuplicate) {
      const upcoming = await getCustomerUpcomingAppointments(phone, config);

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
          message: `INTERNAL_HINT: o cliente já tem ${upcoming.appointments.length} agendamento(s) futuro(s) marcado(s):\n- ${list}\n\nPergunte ao cliente:\n"Vi que você já tem outro(s) agendamento(s). Quer:\n1. Manter os dois (este novo + o anterior)\n2. Remarcar (cancelar o anterior e marcar este novo)\n3. Só cancelar o anterior (sem criar este novo)\n4. Pensar e decidir depois"\n\nAguarde a resposta. Conforme a escolha:\n- Opção 1: chame bookAppointment novamente com confirmedDuplicate=true\n- Opção 2: chame cancelAppointment(appointmentId do anterior) E DEPOIS chame bookAppointment novamente com confirmedDuplicate=true\n- Opção 3: chame cancelAppointment(appointmentId do anterior). NÃO chame bookAppointment.\n- Opção 4: não chame ferramenta nenhuma, responda gentilmente.\nSe houver mais de um agendamento anterior e o cliente escolher remarcar ou só cancelar sem indicar qual, pergunte qual agendamento deve ser cancelado e peça para responder com data e horário antes de chamar cancelAppointment.`,
        };
      }
    }

    await erpApi.post('/api/v1/agenda/book', {
      tenantSlug: config.tenantSlug,
      customerPhone: normalizeWhatsappPhone(phone),
      customerName: customerName?.trim() || 'Cliente',
      serviceId: selectedService.id,
      professionalId: selectedProfessionalId,
      startTime,
      endTime,
    });

    return {
      success: true,
      message: `Agendado com sucesso para ${formatDateBR(normalizedDate)} às ${time}.`,
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      return {
        success: false,
        message:
          'Esse horário foi preenchido agora há pouco. Me fala outro horário que eu vejo os próximos disponíveis pra você.',
      };
    }

    console.error('❌ Erro ao criar agendamento no ERP:', err);
    return {
      success: false,
      message:
        'Tive um problema ao criar o agendamento agora. Pode tentar novamente em instantes?',
    };
  }
}
