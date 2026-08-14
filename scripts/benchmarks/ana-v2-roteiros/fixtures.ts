import type { TenantBotConfig } from '../../../src/configProvider';
import type { ReceptionistToolExecutor } from '../../../src/services/brainService';
import type { ServicesResult } from '../../../src/services/calendarService';
import {
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from '../../../src/botDefaults';
import { DEEPSEEK_V4_FLASH_MODEL } from '../../../src/services/receptionistLlmProvider';

export const ROTEIROS_TENANT_SLUG = 'fixture-ana-v2-roteiros';
export const ROTEIROS_FIXED_NOW = new Date('2026-08-13T12:00:00.000Z');

export const ROTEIROS_IDS = {
  service: {
    drenagem: 'rv2-svc-drenagem-linfatica',
    limpeza: 'rv2-svc-limpeza-profunda',
    peeling: 'rv2-svc-peeling-facial',
  },
  professional: {
    carla: 'rv2-prof-carla-mendes',
    marina: 'rv2-prof-marina-costa',
  },
} as const;

export const ROTEIROS_SERVICES: ServicesResult = {
  success: true,
  services: [
    {
      id: ROTEIROS_IDS.service.drenagem,
      name: 'Drenagem linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: [ROTEIROS_IDS.professional.carla],
    },
    {
      id: ROTEIROS_IDS.service.limpeza,
      name: 'Limpeza de pele profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: [ROTEIROS_IDS.professional.carla],
    },
    {
      id: ROTEIROS_IDS.service.peeling,
      name: 'Peeling facial',
      durationMinutes: 45,
      price: 140,
      priceFormatted: 'R$ 140,00',
      professionalIds: [ROTEIROS_IDS.professional.carla],
    },
  ],
  professionals: [
    { id: ROTEIROS_IDS.professional.carla, name: 'Carla Mendes' },
    { id: ROTEIROS_IDS.professional.marina, name: 'Marina Costa' },
  ],
};

export const ROTEIROS_SLOTS_BY_DATE: Readonly<Record<string, readonly string[]>> = {
  '2026-08-13': ['14:00', '15:00', '17:00'],
  '2026-08-14': ['09:00', '10:30', '15:00'],
  '2026-08-21': ['09:00', '11:00', '14:30'],
};

export const ALL_ROTEIROS_SLOTS = [
  ...new Set(Object.values(ROTEIROS_SLOTS_BY_DATE).flat()),
];

export interface RoteirosToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface RoteirosFixtureState {
  dryRun: true;
  calls: RoteirosToolCall[];
  bookAttempts: number;
  bookEffects: number;
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { success: false, reason: 'invalid_fixture_result' };
}

function serviceById(id: string) {
  return ROTEIROS_SERVICES.services?.find((service) => service.id === id);
}

function professionalById(id: string) {
  return ROTEIROS_SERVICES.professionals?.find(
    (professional) => professional.id === id
  );
}

export function createRoteirosFixtureHarness(): {
  state: RoteirosFixtureState;
  execute: ReceptionistToolExecutor;
} {
  const state: RoteirosFixtureState = {
    dryRun: true,
    calls: [],
    bookAttempts: 0,
    bookEffects: 0,
  };
  const booked = new Set<string>();

  const execute: ReceptionistToolExecutor = async (name, args) => {
    let result: Record<string, unknown>;
    if (name === 'getServices') {
      result = ROTEIROS_SERVICES as unknown as Record<string, unknown>;
    } else if (name === 'getUpcomingAppointments') {
      result = { success: true, appointments: [] };
    } else if (name === 'getAvailableSlots') {
      const service = serviceById(String(args.serviceId ?? ''));
      const date = String(args.date ?? '');
      const professionalId =
        typeof args.professionalId === 'string'
          ? args.professionalId
          : service?.professionalIds?.[0];
      if (!service) {
        result = {
          success: false,
          reason: 'service_not_resolved',
          message: 'INTERNAL_HINT: serviço fixture inválido.',
        };
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result = {
          success: false,
          reason: 'invalid_date',
          message: 'INTERNAL_HINT: data fixture inválida.',
        };
      } else if (
        professionalId &&
        !service.professionalIds?.includes(professionalId)
      ) {
        result = {
          success: false,
          reason: 'professional_selection',
          message: 'INTERNAL_HINT: profissional não atende o serviço.',
        };
      } else {
        result = {
          success: true,
          slots: [...(ROTEIROS_SLOTS_BY_DATE[date] ?? [])],
          ...(professionalId ? { professionalId } : {}),
        };
      }
    } else if (name === 'bookAppointment') {
      state.bookAttempts += 1;
      const service = serviceById(String(args.serviceId ?? ''));
      const date = String(args.date ?? '');
      const time = String(args.time ?? '');
      const professionalId =
        typeof args.professionalId === 'string'
          ? args.professionalId
          : service?.professionalIds?.[0];
      const slots = ROTEIROS_SLOTS_BY_DATE[date] ?? [];
      if (!service || !slots.includes(time)) {
        result = {
          success: false,
          reason: 'conflict',
          availableSlots: [...slots],
          message: 'Esse horário não está disponível.',
        };
      } else if (
        !professionalId ||
        !service.professionalIds?.includes(professionalId)
      ) {
        result = {
          success: false,
          reason: 'professional_selection',
          message: 'INTERNAL_HINT: escolha profissional inválida.',
        };
      } else {
        const key = `${service.id}|${date}|${time}|${professionalId}`;
        if (!booked.has(key)) {
          booked.add(key);
          state.bookEffects += 1;
        }
        result = {
          success: true,
          appointmentId: 'rv2-appointment-synthetic',
          service: service.name,
          date,
          time,
          professional: professionalById(professionalId)?.name ?? 'Profissional',
        };
      }
    } else {
      result = {
        success: false,
        reason: 'unsupported_fixture_tool',
        message: 'INTERNAL_HINT: ferramenta não suportada no fixture.',
      };
    }
    const safeResult = objectResult(result);
    state.calls.push({ name, args: { ...args }, result: safeResult });
    return JSON.stringify(safeResult);
  };

  return { state, execute };
}

export function buildRoteirosConfig(): TenantBotConfig {
  return {
    tenantSlug: ROTEIROS_TENANT_SLUG,
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT,
    greetingMessage: DEFAULT_GREETING_MESSAGE,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    aiProvider: 'deepseek',
    aiModel: DEEPSEEK_V4_FLASH_MODEL,
    aiTemperature: 0.4,
    aiMaxTokens: 900,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '08:00',
    botActiveEnd: '20:00',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'fixture-no-whatsapp',
    waApiVersion: 'v21.0',
    phoneNumberId: 'fixture-ana-v2-phone',
    isActive: true,
  };
}
