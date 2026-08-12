import type {
  ServicesResult,
  UpcomingAppointment,
} from '../../../src/services/calendarService';
import type { ReceptionistToolExecutor } from '../../../src/services/brainService';

export const DAILY_FIXED_NOW = new Date('2026-08-12T18:00:00.000Z');

export const DAILY_IDS = {
  service: {
    calosidade: 'dsvc-calosidades-fissuras-01',
    drenagem: 'dsvc-drenagem-linfatica-02',
    unha: 'dsvc-unha-encravada-03',
    pe: 'dsvc-spa-dos-pes-04',
    esmalte: 'dsvc-esmalte-gel-05',
  },
  professional: {
    luziaSilva: 'dpro-luzia-silva-01',
    luziaCosta: 'dpro-luzia-costa-02',
    marina: 'dpro-marina-alves-03',
  },
  appointment: {
    existing: 'dapt-carla-retorno-01',
    second: 'dapt-carla-peeling-02',
  },
} as const;

export const DAILY_SLOTS = ['13:00', '17:00', '17:30', '18:00'] as const;

export const DAILY_SERVICES: ServicesResult = {
  success: true,
  services: [
    {
      id: DAILY_IDS.service.calosidade,
      name: 'Calosidades e Fissuras',
      durationMinutes: 45,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: [DAILY_IDS.professional.luziaSilva],
    },
    {
      id: DAILY_IDS.service.drenagem,
      name: 'Drenagem Linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: [DAILY_IDS.professional.marina],
    },
    {
      id: DAILY_IDS.service.unha,
      name: 'Unha encravada',
      durationMinutes: 40,
      price: 90,
      priceFormatted: 'R$ 90,00',
      professionalIds: [
        DAILY_IDS.professional.luziaSilva,
        DAILY_IDS.professional.luziaCosta,
      ],
    },
    {
      id: DAILY_IDS.service.pe,
      name: 'Spa dos pés',
      durationMinutes: 50,
      price: 110,
      priceFormatted: 'R$ 110,00',
      professionalIds: [DAILY_IDS.professional.luziaSilva],
    },
    {
      id: DAILY_IDS.service.esmalte,
      name: 'Esmaltação em gel',
      durationMinutes: 60,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: [DAILY_IDS.professional.marina],
    },
  ],
  professionals: [
    { id: DAILY_IDS.professional.luziaSilva, name: 'Luzia Silva' },
    { id: DAILY_IDS.professional.luziaCosta, name: 'Luzia Costa' },
    { id: DAILY_IDS.professional.marina, name: 'Marina Alves' },
  ],
};

export type DailyFixtureMode =
  | 'normal'
  | 'duplicate'
  | 'identity_ambiguous'
  | 'human_echo';

export interface DailyFixtureState {
  dryRun: true;
  mode: DailyFixtureMode;
  bookAttempts: number;
  bookEffects: number;
  cancelAttempts: number;
  cancelEffects: number;
  cancelledAppointmentIds: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function identityAmbiguousResult() {
  return json({
    success: false,
    reason: 'customer_identity_ambiguous',
    message:
      'INTERNAL_HINT: há mais de um cadastro para este telefone e não é seguro escolher um deles.',
  });
}

function serviceById(id: string) {
  const normalized = id.trim();
  const exact = DAILY_SERVICES.services?.find((item) => item.id === normalized);
  if (exact) return exact;
  const prefixes = (DAILY_SERVICES.services ?? []).filter((item) =>
    item.id.startsWith(normalized)
  );
  return normalized && prefixes.length === 1 ? prefixes[0] : undefined;
}

function professionalById(id: string) {
  const normalized = id.trim();
  const exact = DAILY_SERVICES.professionals?.find(
    (item) => item.id === normalized
  );
  if (exact) return exact;
  const prefixes = (DAILY_SERVICES.professionals ?? []).filter((item) =>
    item.id.startsWith(normalized)
  );
  return normalized && prefixes.length === 1 ? prefixes[0] : undefined;
}

export function dailyUpcomingAppointments(
  mode: DailyFixtureMode,
  cancelledAppointmentIds: readonly string[] = []
): UpcomingAppointment[] {
  if (mode !== 'duplicate' && mode !== 'human_echo') return [];
  return [
    {
      id: DAILY_IDS.appointment.existing,
      startTime: '2026-08-14T13:00:00-03:00',
      endTime: '2026-08-14T13:45:00-03:00',
      serviceName: 'Calosidades e Fissuras',
      professionalName: 'Luzia Silva',
      status: 'CONFIRMED',
    },
  ].filter((item) => !cancelledAppointmentIds.includes(item.id));
}

export function createDailyFixtureHarness(mode: DailyFixtureMode = 'normal'): {
  dryRun: true;
  state: DailyFixtureState;
  execute: ReceptionistToolExecutor;
} {
  const state: DailyFixtureState = {
    dryRun: true,
    mode,
    bookAttempts: 0,
    bookEffects: 0,
    cancelAttempts: 0,
    cancelEffects: 0,
    cancelledAppointmentIds: [],
  };
  const bookedKeys = new Set<string>();

  const execute: ReceptionistToolExecutor = async (functionName, args) => {
    if (mode === 'identity_ambiguous') {
      return identityAmbiguousResult();
    }

    switch (functionName) {
      case 'getServices':
        return json(DAILY_SERVICES);

      case 'getAvailableSlots': {
        const service = serviceById(String(args.serviceId ?? ''));
        if (!service) {
          return json({
            success: false,
            message:
              'INTERNAL_HINT: Serviço não encontrado. Chame getServices e use o ID técnico exato.',
          });
        }
        if (service.professionalIds?.length === 0) {
          return json({
            success: false,
            message:
              'INTERNAL_HINT: Este serviço está sem profissional habilitado. Não consulte horários nem agende.',
          });
        }
        const date = String(args.date ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({
            success: false,
            message: 'INTERNAL_HINT: Use uma data válida no formato YYYY-MM-DD.',
          });
        }
        return json({
          success: true,
          slots: [...DAILY_SLOTS],
          professionalId:
            typeof args.professionalId === 'string'
              ? args.professionalId
              : undefined,
          message: `Horários disponíveis: ${DAILY_SLOTS.join(', ')}`,
        });
      }

      case 'getUpcomingAppointments':
        return json({
          success: true,
          appointments: dailyUpcomingAppointments(
            mode,
            state.cancelledAppointmentIds
          ),
        });

      case 'bookAppointment': {
        state.bookAttempts += 1;
        const service = serviceById(String(args.serviceId ?? ''));
        if (!service) {
          return json({
            success: false,
            message:
              'INTERNAL_HINT: Serviço não encontrado. Chame getServices e use o ID técnico exato.',
          });
        }
        const date = String(args.date ?? '');
        const time = String(args.time ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
          return json({
            success: false,
            message:
              'INTERNAL_HINT: Data ou horário inválido. Use YYYY-MM-DD e HH:MM.',
          });
        }
        if (!(DAILY_SLOTS as readonly string[]).includes(time)) {
          return json({
            success: false,
            reason: 'conflict',
            message: 'Esse horário não está disponível.',
            availableSlots: [...DAILY_SLOTS],
          });
        }
        const upcoming = dailyUpcomingAppointments(
          mode,
          state.cancelledAppointmentIds
        );
        if (mode === 'duplicate' && upcoming.length > 0 && args.confirmedDuplicate !== true) {
          return json({
            success: false,
            message: `INTERNAL_HINT: O cliente já tem um agendamento futuro: Calosidades e Fissuras em 14/08/2026 às 13:00 com Luzia Silva [id: ${DAILY_IDS.appointment.existing}]. Pergunte se deseja manter os dois, remarcar, só cancelar o anterior ou pensar depois.`,
          });
        }
        const key = [
          date,
          time,
          String(args.serviceId ?? ''),
          String(args.professionalId ?? 'auto'),
        ].join('|');
        if (!bookedKeys.has(key)) {
          bookedKeys.add(key);
          state.bookEffects += 1;
        }
        const professionalId =
          typeof args.professionalId === 'string'
            ? args.professionalId
            : service.professionalIds?.[0] ?? DAILY_IDS.professional.luziaSilva;
        return json({
          success: true,
          message: 'Agendamento realizado com sucesso.',
          professional: {
            id: professionalId,
            name: professionalById(professionalId)?.name ?? 'Profissional',
          },
        });
      }

      case 'cancelAppointment': {
        state.cancelAttempts += 1;
        const appointmentId = String(args.appointmentId ?? '');
        const upcoming = dailyUpcomingAppointments(
          mode,
          state.cancelledAppointmentIds
        );
        if (!upcoming.some((item) => item.id === appointmentId)) {
          return json({
            success: false,
            message:
              'INTERNAL_HINT: O appointmentId não corresponde a um agendamento futuro deste cliente.',
          });
        }
        if (!state.cancelledAppointmentIds.includes(appointmentId)) {
          state.cancelledAppointmentIds.push(appointmentId);
          state.cancelEffects += 1;
        }
        return json({
          success: true,
          message: 'Agendamento anterior cancelado com sucesso.',
        });
      }

      default:
        return json({
          success: false,
          message: 'INTERNAL_HINT: Ferramenta não reconhecida.',
        });
    }
  };

  return { dryRun: true, state, execute };
}

export const ALL_DAILY_IDS = Object.values(DAILY_IDS).flatMap((group) =>
  Object.values(group)
);

export const SERVICE_LIST_ASSISTANT =
  'Temos Calosidades e Fissuras, Drenagem Linfática, Unha encravada, Spa dos pés e Esmaltação em gel. Qual você prefere?';

export const SLOT_OFFER_ASSISTANT =
  'Para amanhã tenho 13:00, 17:00, 17:30 e 18:00. Qual horário fica melhor?';
