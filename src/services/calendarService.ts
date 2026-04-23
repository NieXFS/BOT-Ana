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

type AvailabilityResult = {
  success: boolean;
  slots?: string[];
  professionalId?: string;
  message?: string;
};

function formatDateBR(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
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
  return services.find((service) => service.id === serviceId);
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

export async function getServices(
  config: TenantBotConfig
): Promise<ServicesResult> {
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

    return { success: true, services, professionals };
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

  if (normalizedDate < getTodayStr(config.timezone)) {
    return { success: false, message: 'Essa data já passou. Escolha uma data futura.' };
  }

  try {
    const response = await erpApi.get<AvailabilityResponse>('/api/v1/agenda/availability', {
      params: {
        tenantSlug: config.tenantSlug,
        date: normalizedDate,
        serviceId,
        professionalId: professionalId?.trim() || undefined,
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

export async function bookAppointment(
  date: string,
  time: string,
  serviceId: string,
  phone: string,
  customerName: string,
  config: TenantBotConfig,
  professionalId?: string
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
    const infoResponse = await erpApi.get<AgendaInfoResponse>('/api/v1/agenda/info', {
      params: { tenantSlug: config.tenantSlug },
    });

    const services = normalizeServices(infoResponse.data.services);
    const professionals = normalizeProfessionals(infoResponse.data);
    const selectedService = getServiceById(services, serviceId);

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
          serviceId,
          professionalId: professionalId?.trim() || undefined,
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
      professionalId?.trim() || availabilityProfessionalId || professionals[0]?.id;

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

    await erpApi.post('/api/v1/agenda/book', {
      tenantSlug: config.tenantSlug,
      customerPhone: normalizeWhatsappPhone(phone),
      customerName: customerName?.trim() || 'Cliente',
      serviceId,
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
