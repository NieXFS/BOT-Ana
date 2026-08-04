import type {
  ServicesResult,
  UpcomingAppointment,
} from '../../../src/services/calendarService';
import type { ReceptionistToolExecutor } from '../../../src/services/brainService';
import type { FixtureMode } from './types';

export const FIXED_NOW = new Date('2026-08-03T13:00:00.000Z');

export const IDS = {
  service: {
    limpeza: 'cm0x7p4k9a1f3d8q2v6n',
    peeling: 'cm1b8r5m2k7z9w4c6t0q',
    corte: 'cm2c9s6n3j8y0x5d7u1r',
    corteBarba: 'cm3d0t7p4h9a1z6e8v2s',
    drenagem: 'cm4e1u8q5g0b2y7f9w3t',
  },
  professional: {
    julia: 'cmp5f2v9r6k1c3z8g0x4',
    marina: 'cmp6g3w0s7j2d4y9h1a5',
    caio: 'cmp7h4x1t8i3e5z0k2b6',
  },
  appointment: {
    existing: 'cma8i5y2u9h4f6a1m3c7',
    second: 'cma9j6z3v0g5e7b2n4d8',
  },
} as const;

export const SERVICES_RESULT: ServicesResult = {
  success: true,
  services: [
    {
      id: IDS.service.limpeza,
      name: 'Limpeza de Pele',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: [IDS.professional.julia],
    },
    {
      id: IDS.service.peeling,
      name: 'Peeling',
      durationMinutes: 45,
      price: 250,
      priceFormatted: 'R$ 250,00',
      professionalIds: [IDS.professional.julia, IDS.professional.marina],
    },
    {
      id: IDS.service.corte,
      name: 'Corte',
      durationMinutes: 30,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: [IDS.professional.caio],
    },
    {
      id: IDS.service.corteBarba,
      name: 'Corte e Barba',
      durationMinutes: 45,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: [IDS.professional.caio],
    },
    {
      id: IDS.service.drenagem,
      name: 'Drenagem',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: [],
    },
  ],
  professionals: [
    { id: IDS.professional.julia, name: 'Júlia' },
    { id: IDS.professional.marina, name: 'Marina' },
    { id: IDS.professional.caio, name: 'Caio' },
  ],
};

export const DEFAULT_SLOTS = ['09:00', '10:30', '15:00'] as const;
export const CONFLICT_ALTERNATIVES = ['09:00', '10:30'] as const;

const BOOK_FAILURE_AVAILABLE_SLOTS_HINT =
  'Estes (availableSlots) são os ÚNICOS horários reais disponíveis — já consultados pelo sistema. Ofereça SOMENTE eles, exatamente como vieram. NUNCA invente, arredonde ou acrescente outros horários, e NÃO chame getAvailableSlots de novo.';

export function fixtureUpcomingAppointments(
  mode: FixtureMode,
  cancelledAppointmentIds: readonly string[] = []
): UpcomingAppointment[] {
  if (mode === 'human_echo') {
    return [
      {
        id: IDS.appointment.existing,
        startTime: '2026-08-04T15:00:00-03:00',
        endTime: '2026-08-04T16:00:00-03:00',
        serviceName: 'Limpeza de Pele',
        professionalName: 'Júlia',
        status: 'CONFIRMED',
      },
    ];
  }

  if (mode !== 'duplicate' && mode !== 'duplicate_multiple') {
    return [];
  }

  return [
    {
      id: IDS.appointment.existing,
      startTime: '2026-08-05T14:00:00-03:00',
      endTime: '2026-08-05T15:00:00-03:00',
      serviceName: 'Limpeza de Pele',
      professionalName: 'Júlia',
      status: 'CONFIRMED',
    },
    ...(mode === 'duplicate_multiple'
      ? [
          {
            id: IDS.appointment.second,
            startTime: '2026-08-06T16:00:00-03:00',
            endTime: '2026-08-06T16:45:00-03:00',
            serviceName: 'Peeling',
            professionalName: 'Marina',
            status: 'CONFIRMED',
          },
        ]
      : []),
  ].filter(
    (appointment) => !cancelledAppointmentIds.includes(appointment.id)
  );
}

export interface FixtureToolState {
  dryRun: true;
  mode: FixtureMode;
  bookAttempts: number;
  bookEffects: number;
  cancelAttempts: number;
  cancelEffects: number;
  cancelledAppointmentIds: string[];
}

export interface FixtureToolHarness {
  dryRun: true;
  state: FixtureToolState;
  execute: ReceptionistToolExecutor;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function serviceById(id: string) {
  const services = SERVICES_RESULT.services ?? [];
  const normalizedId = id.trim();
  const exact = services.find((service) => service.id === normalizedId);
  if (exact) return exact;
  const prefixes = services.filter((service) =>
    service.id.startsWith(normalizedId)
  );
  return normalizedId && prefixes.length === 1 ? prefixes[0] : undefined;
}

function professionalById(id: string) {
  const professionals = SERVICES_RESULT.professionals ?? [];
  const normalizedId = id.trim();
  const exact = professionals.find(
    (professional) => professional.id === normalizedId
  );
  if (exact) return exact;
  const prefixes = professionals.filter((professional) =>
    professional.id.startsWith(normalizedId)
  );
  return normalizedId && prefixes.length === 1 ? prefixes[0] : undefined;
}

function validateServiceAndProfessional(
  args: Record<string, unknown>
): string | null {
  const serviceId = String(args.serviceId ?? '');
  const service = serviceById(serviceId);
  if (!service) {
    return 'INTERNAL_HINT: Serviço não encontrado. Chame getServices e use o ID técnico exato.';
  }

  if (service.professionalIds?.length === 0) {
    return 'INTERNAL_HINT: Este serviço está sem profissional habilitado. Não consulte horários nem agende.';
  }

  if (typeof args.professionalId === 'string') {
    const professional = professionalById(args.professionalId);
    if (
      !professional ||
      !service.professionalIds?.includes(professional.id)
    ) {
      return 'INTERNAL_HINT: O profissional informado não atende este serviço. Use somente um profissional habilitado.';
    }
  }

  return null;
}

function duplicateHint(mode: FixtureMode): string {
  if (mode === 'duplicate_multiple') {
    return `INTERNAL_HINT: O cliente já tem agendamentos futuros:
- Limpeza de Pele em 05/08/2026 às 14:00 com Júlia [id: ${IDS.appointment.existing}]
- Peeling em 06/08/2026 às 16:00 com Marina [id: ${IDS.appointment.second}]
Pergunte qual agendamento deve ser cancelado antes de continuar.`;
  }

  return `INTERNAL_HINT: O cliente já tem um agendamento futuro: Limpeza de Pele em 05/08/2026 às 14:00 com Júlia [id: ${IDS.appointment.existing}]. Pergunte se deseja manter os dois, remarcar, só cancelar o anterior ou pensar depois.`;
}

export function createFixtureToolHarness(
  mode: FixtureMode = 'normal'
): FixtureToolHarness {
  const state: FixtureToolState = {
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
    switch (functionName) {
      case 'getServices':
        return json(SERVICES_RESULT);

      case 'getAvailableSlots': {
        const validationHint = validateServiceAndProfessional(args);
        if (validationHint) {
          return json({ success: false, message: validationHint });
        }

        const date = String(args.date ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({
            success: false,
            message: 'INTERNAL_HINT: Use uma data válida no formato YYYY-MM-DD.',
          });
        }

        const slots =
          mode === 'book_failure' && state.bookAttempts > 0
            ? [...CONFLICT_ALTERNATIVES]
            : [...DEFAULT_SLOTS];
        return json({
          success: true,
          slots,
          professionalId:
            typeof args.professionalId === 'string'
              ? args.professionalId
              : undefined,
          message: `Horários disponíveis: ${slots.join(', ')}`,
        });
      }

      case 'getUpcomingAppointments': {
        const appointments = fixtureUpcomingAppointments(
          mode,
          state.cancelledAppointmentIds
        );
        return json({ success: true, appointments });
      }

      case 'bookAppointment': {
        state.bookAttempts += 1;
        const validationHint = validateServiceAndProfessional(args);
        if (validationHint) {
          return json({ success: false, message: validationHint });
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

        // Espelha a fronteira autoritativa do ERP: formato válido não torna um
        // horário disponível. A fixture nunca concede efeito fora da lista real.
        if (!(DEFAULT_SLOTS as readonly string[]).includes(time)) {
          return json({
            success: false,
            reason: 'conflict',
            message: 'Esse horário não está disponível.',
            hint: BOOK_FAILURE_AVAILABLE_SLOTS_HINT,
            availableSlots: [...DEFAULT_SLOTS],
          });
        }

        if (mode === 'book_failure') {
          return json({
            success: false,
            reason: 'conflict',
            message: 'Esse horário acabou de ser preenchido.',
            hint: BOOK_FAILURE_AVAILABLE_SLOTS_HINT,
            availableSlots: [...CONFLICT_ALTERNATIVES],
          });
        }

        const stillHasUpcomingDuplicate =
          fixtureUpcomingAppointments(
            mode,
            state.cancelledAppointmentIds
          ).length > 0;
        if (
          (mode === 'duplicate' || mode === 'duplicate_multiple') &&
          stillHasUpcomingDuplicate &&
          args.confirmedDuplicate !== true
        ) {
          return json({
            success: false,
            message: duplicateHint(mode),
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
            : IDS.professional.julia;
        return json({
          success: true,
          message: 'Agendamento realizado com sucesso.',
          professional: {
            id: professionalId,
            name: professionalById(professionalId)?.name ?? 'Júlia',
          },
        });
      }

      case 'cancelAppointment': {
        state.cancelAttempts += 1;
        // Espelha o calendarService endurecido: o ID precisa corresponder ao
        // agendamento apresentado ao modelo. Ter apenas um upcoming não
        // autoriza corrigir silenciosamente um ID inventado/incorreto.
        const appointmentId = String(args.appointmentId ?? '');
        const upcoming = fixtureUpcomingAppointments(
          mode,
          state.cancelledAppointmentIds
        );
        if (!upcoming.some((appointment) => appointment.id === appointmentId)) {
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
