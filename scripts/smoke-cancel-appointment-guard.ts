/**
 * Smoke determinístico do hard block de cancelamento.
 *
 * Sem rede/DB: getUpcomingAppointments e postCancel são injetados. Prova que:
 * - ID técnico errado/parcial nunca é resolvido só porque existe 1 upcoming;
 * - referência inequívoca de data/horário na mensagem atual pode corrigir o ID;
 * - com 2+ upcoming, até um ID válido exige referência atual ao MESMO alvo;
 * - casos bloqueados não chegam ao POST.
 *
 * Rodar: npx tsx scripts/smoke-cancel-appointment-guard.ts
 */
process.env.ERP_API_TOKEN ||= 'smoke-cancel-guard';
process.env.ERP_BASE_URL = 'http://127.0.0.1:1';

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  CancelAppointmentDeps,
  UpcomingAppointment,
} from '../src/services/calendarService';

const FIRST_ID = 'cma8i5y2u9h4f6a1m3c7';
const SECOND_ID = 'cma9j6z3v0g5e7b2n4d8';

const first: UpcomingAppointment = {
  id: FIRST_ID,
  startTime: '2026-08-05T17:00:00.000Z', // 05/08/2026 14:00 em São Paulo
  endTime: '2026-08-05T18:00:00.000Z',
  serviceName: 'Limpeza de Pele',
  professionalName: 'Júlia',
  status: 'CONFIRMED',
};

const second: UpcomingAppointment = {
  id: SECOND_ID,
  startTime: '2026-08-06T19:30:00.000Z', // 06/08/2026 16:30 em São Paulo
  endTime: '2026-08-06T20:15:00.000Z',
  serviceName: 'Peeling',
  professionalName: 'Marina',
  status: 'CONFIRMED',
};

const sameTimeOnAnotherDay: UpcomingAppointment = {
  ...second,
  startTime: '2026-08-06T17:00:00.000Z', // também 14:00 em São Paulo
  endTime: '2026-08-06T17:45:00.000Z',
};

const config: TenantBotConfig = {
  tenantSlug: 'smoke-cancel-guard',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'smoke',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '08:00',
  botActiveEnd: '20:00',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'smoke',
  waApiVersion: 'v21.0',
  phoneNumberId: 'smoke-phone-number-id',
  isActive: true,
};

function depsFor(appointments: UpcomingAppointment[]): {
  deps: CancelAppointmentDeps;
  posts: Array<{
    tenantSlug: string;
    customerPhone: string;
    appointmentId: string;
  }>;
} {
  const posts: Array<{
    tenantSlug: string;
    customerPhone: string;
    appointmentId: string;
  }> = [];
  const deps: CancelAppointmentDeps = {
    getUpcomingAppointments: async () => ({
      success: true,
      appointments,
    }),
    postCancel: async (payload) => {
      posts.push(payload);
    },
  };
  return { deps, posts };
}

async function main(): Promise<void> {
  const { cancelAppointment } = await import('../src/services/calendarService');
  const phone = '5511999999999';

  {
    const { deps, posts } = depsFor([first]);
    const result = await cancelAppointment(
      'cmwrongtechnicalid999',
      phone,
      config,
      'Quero remarcar.',
      deps
    );
    assert.equal(result.success, false);
    assert.match(result.message, /^INTERNAL_HINT:/);
    assert.equal(posts.length, 0);
  }

  {
    const { deps, posts } = depsFor([first]);
    const result = await cancelAppointment(
      FIRST_ID.slice(0, -4),
      phone,
      config,
      'Quero remarcar.',
      deps
    );
    assert.equal(result.success, false);
    assert.match(result.message, /não corresponde exatamente/i);
    assert.equal(posts.length, 0);
  }

  {
    const { deps, posts } = depsFor([first]);
    const result = await cancelAppointment(
      FIRST_ID,
      phone,
      config,
      'Quero remarcar.',
      deps
    );
    assert.equal(result.success, true);
    assert.deepEqual(posts, [
      {
        tenantSlug: config.tenantSlug,
        customerPhone: `+${phone}`,
        appointmentId: FIRST_ID,
      },
    ]);
  }

  {
    const { deps, posts } = depsFor([first]);
    const result = await cancelAppointment(
      'cmwrongtechnicalid999',
      phone,
      config,
      'Quero cancelar o agendamento de 05/08 às 14h.',
      deps
    );
    assert.equal(result.success, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].appointmentId, FIRST_ID);
  }

  {
    const { deps, posts } = depsFor([first, second]);
    const result = await cancelAppointment(
      FIRST_ID,
      phone,
      config,
      'Quero remarcar.',
      deps
    );
    assert.equal(result.success, false);
    assert.match(result.message, /mais de um agendamento futuro/i);
    assert.equal(posts.length, 0);
  }

  {
    const { deps, posts } = depsFor([first, second]);
    const result = await cancelAppointment(
      FIRST_ID,
      phone,
      config,
      'Quero cancelar o do dia 05/08.',
      deps
    );
    assert.equal(result.success, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].appointmentId, FIRST_ID);
  }

  {
    const { deps, posts } = depsFor([first, second]);
    const result = await cancelAppointment(
      SECOND_ID,
      phone,
      config,
      'Quero cancelar o de 05/08 às 14h.',
      deps
    );
    assert.equal(result.success, false);
    assert.match(result.message, /não identifica de forma inequívoca o mesmo agendamento/i);
    assert.equal(posts.length, 0);
  }

  {
    const { deps, posts } = depsFor([first, second]);
    const result = await cancelAppointment(
      'cmwrongtechnicalid999',
      phone,
      config,
      'Quero cancelar o de 06/08 às 16h30.',
      deps
    );
    assert.equal(result.success, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].appointmentId, SECOND_ID);
  }

  {
    const { deps, posts } = depsFor([first, sameTimeOnAnotherDay]);
    const result = await cancelAppointment(
      FIRST_ID,
      phone,
      config,
      'Quero cancelar o das 14h.',
      deps
    );
    assert.equal(result.success, false);
    assert.match(result.message, /mais de um agendamento futuro/i);
    assert.equal(posts.length, 0);
  }

  console.log('✅ smoke cancel appointment guard: 9 cenários, zero rede real');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
