/**
 * Smoke determinístico do grounding do turno da recepcionista:
 * redação de nome contaminado, 409 canônico, prefetch de upcoming e slots.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke';

import assert from 'node:assert/strict';
import { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from '../src/services/customerIdentitySafety';
import type { ServicesResult, UpcomingAppointmentsResult } from '../src/services/calendarService';
import {
  HISTORY_PERSON_NAME_PLACEHOLDER,
  NO_UPCOMING_APPOINTMENT_CUSTOMER_MESSAGE,
  NON_OPERATIONAL_FEEDBACK_CUSTOMER_MESSAGE,
  NON_OPERATIONAL_TURN_CUSTOMER_MESSAGE,
  STANDALONE_CANCEL_CUSTOMER_MESSAGE,
  UNKNOWN_SERVICE_CUSTOMER_MESSAGE,
  classifyExistingAppointmentIntent,
  isNonOperationalFeedback,
  isUnknownCatalogServiceRequest,
  namedServiceAvailabilityIntent,
  redactUncataloguedPersonNames,
  resolveGroundedReceptionistTurn,
  resolveRelativeCalendarDate,
} from '../src/services/receptionistTurnGrounding';
import { uniqueCatalogServiceFromCurrentMessage } from '../src/services/service-gate';

const NOW = new Date('2026-08-12T18:00:00.000Z');
const TZ = 'America/Sao_Paulo';

const catalog: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-calo',
      name: 'Calosidades e Fissuras',
      durationMinutes: 45,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['pro-luzia-silva'],
    },
    {
      id: 'svc-unha',
      name: 'Unha encravada',
      durationMinutes: 40,
      price: 90,
      priceFormatted: 'R$ 90,00',
      professionalIds: ['pro-luzia-silva', 'pro-luzia-costa'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['pro-marina'],
    },
    {
      id: 'svc-pe',
      name: 'Spa dos pés',
      durationMinutes: 50,
      price: 110,
      priceFormatted: 'R$ 110,00',
      professionalIds: ['pro-luzia-silva'],
    },
  ],
  professionals: [
    { id: 'pro-luzia-silva', name: 'Luzia Silva' },
    { id: 'pro-luzia-costa', name: 'Luzia Costa' },
    { id: 'pro-marina', name: 'Marina Alves' },
  ],
};

const contaminated = [
  {
    role: 'assistant' as const,
    content: 'Eliana, seu pé com a Luzia ficou amanhã às 09h30. Qualquer coisa me chama.',
  },
  { role: 'user' as const, content: 'Obrigada, estarei lá.' },
];

async function main() {
  const redacted = redactUncataloguedPersonNames(
    contaminated,
    catalog,
    'Tudo bem?',
    'Ana'
  );
  assert.match(redacted[0]!.content, new RegExp(HISTORY_PERSON_NAME_PLACEHOLDER));
  assert.doesNotMatch(redacted[0]!.content, /Eliana/);
  assert.match(redacted[0]!.content, /Luzia/);
  assert.equal(redacted[1]!.content, 'Obrigada, estarei lá.');

  const keptCurrent = redactUncataloguedPersonNames(
    [...contaminated, { role: 'user', content: 'Oi, eu sou a Eliana' }],
    catalog,
    'Oi, eu sou a Eliana',
    'Ana'
  );
  assert.match(keptCurrent[keptCurrent.length - 1]!.content, /Eliana/);

  assert.equal(
    uniqueCatalogServiceFromCurrentMessage(
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
      catalog.services ?? []
    )?.id,
    'svc-calo'
  );
  assert.equal(
    resolveRelativeCalendarDate(
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
      NOW,
      TZ
    ),
    '2026-08-13'
  );
  assert.equal(
    resolveRelativeCalendarDate(
      'Quero agendar uma drenagem pra domingo',
      new Date('2026-08-15T17:32:00.000Z'),
      TZ
    ),
    '2026-08-16'
  );
  assert.equal(
    resolveRelativeCalendarDate(
      'Domingo, não sábado!',
      new Date('2026-08-15T17:32:00.000Z'),
      TZ
    ),
    '2026-08-16'
  );
  assert.equal(
    resolveRelativeCalendarDate(
      'domingo que vem',
      new Date('2026-08-16T18:00:00.000Z'),
      TZ
    ),
    '2026-08-23'
  );
  assert.equal(
    resolveRelativeCalendarDate(
      'não sábado, domingo',
      new Date('2026-08-15T17:32:00.000Z'),
      TZ
    ),
    '2026-08-16',
    'não X, Y (vírgula) elege Y — paridade com X, não Y'
  );
  assert.equal(
    namedServiceAvailabilityIntent(
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
      catalog.services ?? [],
      NOW,
      TZ
    )?.serviceId,
    'svc-calo'
  );
  assert.equal(
    namedServiceAvailabilityIntent('Tudo bem?', catalog.services ?? [], NOW, TZ),
    null
  );
  assert.equal(
    classifyExistingAppointmentIntent('Quero remarcar meu horário'),
    'reschedule'
  );
  assert.equal(
    classifyExistingAppointmentIntent('Quero cancelar meu horário de sexta'),
    'cancel'
  );
  assert.equal(classifyExistingAppointmentIntent('Tudo bem?'), 'none');

  const identity = await resolveGroundedReceptionistTurn({
    userMessage: 'Quero remarcar meu horário',
    userMessages: ['Quero remarcar meu horário'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async (): Promise<UpcomingAppointmentsResult> => ({
      success: false,
      reason: 'customer_identity_ambiguous',
      message: 'INTERNAL_HINT: duplicidade',
    }),
    readSlots: async () => {
      throw new Error('slots não deve ser chamado no 409');
    },
  });
  assert.equal(identity.kind, 'short_circuit');
  if (identity.kind === 'short_circuit') {
    assert.equal(identity.reply, CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE);
    assert.equal(identity.identityCanonical, true);
    assert.equal(identity.toolTrace[0]?.name, 'getUpcomingAppointments');
    assert.doesNotMatch(identity.reply, /duplicidade|dois cadastros|nome completo/i);
  }

  const reschedule = await resolveGroundedReceptionistTurn({
    userMessage: 'Quero remarcar meu horário da sexta',
    userMessages: ['Quero remarcar meu horário da sexta'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async (): Promise<UpcomingAppointmentsResult> => ({
      success: true,
      appointments: [
        {
          id: 'apt-1',
          startTime: '2026-08-14T13:00:00-03:00',
          endTime: '2026-08-14T13:45:00-03:00',
          serviceName: 'Calosidades e Fissuras',
          professionalName: 'Luzia Silva',
          status: 'CONFIRMED',
        },
      ],
    }),
    readSlots: async () => {
      throw new Error('slots não deve ser chamado na remarcação');
    },
  });
  assert.equal(reschedule.kind, 'short_circuit');
  if (reschedule.kind === 'short_circuit') {
    assert.match(reschedule.reply, /13:00/);
    assert.match(reschedule.reply, /Calosidades e Fissuras/);
    assert.match(reschedule.reply, /remarcar/i);
    assert.equal(reschedule.toolTrace[0]?.name, 'getUpcomingAppointments');
  }

  const emptyUpcoming = await resolveGroundedReceptionistTurn({
    userMessage: 'Qual é o meu horário marcado?',
    userMessages: ['Qual é o meu horário marcado?'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async (): Promise<UpcomingAppointmentsResult> => ({
      success: true,
      appointments: [],
    }),
    readSlots: async () => ({ success: false }),
  });
  assert.equal(emptyUpcoming.kind, 'short_circuit');
  if (emptyUpcoming.kind === 'short_circuit') {
    assert.equal(emptyUpcoming.reply, NO_UPCOMING_APPOINTMENT_CUSTOMER_MESSAGE);
  }

  const cancel = await resolveGroundedReceptionistTurn({
    userMessage: 'Quero cancelar meu horário de sexta',
    userMessages: ['Quero cancelar meu horário de sexta'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async (): Promise<UpcomingAppointmentsResult> => ({
      success: true,
      appointments: [
        {
          id: 'apt-1',
          startTime: '2026-08-14T13:00:00-03:00',
          endTime: '2026-08-14T13:45:00-03:00',
          serviceName: 'Calosidades e Fissuras',
          professionalName: 'Luzia Silva',
          status: 'CONFIRMED',
        },
      ],
    }),
    readSlots: async () => ({ success: false }),
  });
  assert.equal(cancel.kind, 'short_circuit');
  if (cancel.kind === 'short_circuit') {
    assert.equal(cancel.reply, STANDALONE_CANCEL_CUSTOMER_MESSAGE);
  }

  const slots = await resolveGroundedReceptionistTurn({
    userMessage: 'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
    userMessages: [
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
    ],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async () => {
      throw new Error('upcoming não deve ser chamado na consulta de slots');
    },
    readSlots: async (args) => {
      assert.equal(args.serviceId, 'svc-calo');
      assert.equal(args.date, '2026-08-13');
      assert.equal(args.professionalId, 'pro-luzia-silva');
      return { success: true, slots: ['13:00', '17:00', '17:30', '18:00'] };
    },
  });
  assert.equal(slots.kind, 'short_circuit');
  if (slots.kind === 'short_circuit') {
    assert.match(slots.reply, /13:00/);
    assert.match(slots.reply, /17:00/);
    assert.match(slots.reply, /18:00/);
    assert.doesNotMatch(slots.reply, /Qual serviço/i);
    assert.equal(slots.toolTrace[0]?.name, 'getAvailableSlots');
  }

  const { inspectCustomerReply } = await import(
    '../src/services/customerReplyGuard'
  );
  if (reschedule.kind === 'short_circuit') {
    const inspection = inspectCustomerReply(
      reschedule.reply,
      catalog,
      ['apt-1'],
      reschedule.toolTrace,
      'Quero remarcar meu horário da sexta',
      { now: NOW, timezone: TZ }
    );
    assert.equal(inspection.safe, true, inspection.reasons.join(','));
  }
  if (slots.kind === 'short_circuit') {
    const inspection = inspectCustomerReply(
      slots.reply,
      catalog,
      [],
      slots.toolTrace,
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
      { now: NOW, timezone: TZ }
    );
    assert.equal(inspection.safe, true, inspection.reasons.join(','));
  }

  const homonyms = await resolveGroundedReceptionistTurn({
    userMessage: 'Quero unha com a Luzia amanhã',
    userMessages: ['Quero unha com a Luzia amanhã'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async () => ({ success: true, appointments: [] }),
    readSlots: async () => {
      throw new Error('homônimos não podem consultar slots antes da escolha');
    },
  });
  assert.equal(homonyms.kind, 'continue');

  const social = await resolveGroundedReceptionistTurn({
    userMessage: 'Tudo bem?',
    userMessages: ['Tudo bem?'],
    history: contaminated,
    services: catalog,
    now: NOW,
    timezone: TZ,
    botName: 'Ana',
    readUpcoming: async () => {
      throw new Error('social não consulta upcoming');
    },
    readSlots: async () => {
      throw new Error('social não consulta slots');
    },
  });
  assert.equal(social.kind, 'continue');
  const historyForModel = social.modelHistory
    .map((item) => item.content)
    .join('\n');
  assert.doesNotMatch(historyForModel, /Eliana/);
  assert.match(historyForModel, new RegExp(HISTORY_PERSON_NAME_PLACEHOLDER));

  assert.equal(
    isUnknownCatalogServiceRequest('Quero marcar Botox amanhã', catalog),
    true
  );
  assert.equal(
    isUnknownCatalogServiceRequest('quero marcar amanhã', catalog),
    false
  );
  assert.equal(
    isUnknownCatalogServiceRequest(
      'Quais horários vocês têm amanhã para Calosidades e Fissuras?',
      catalog
    ),
    false
  );
  assert.equal(isNonOperationalFeedback('serviço ficou ótimo'), true);
  assert.equal(isNonOperationalFeedback('Quero remarcar meu horário'), false);

  const personalTurns = [
    'sexta foi top no evento',
    'hoje foi corrido',
    'tenho 2 filhos',
    'sexta às 20 tem festa',
    'hoje às 10 fui ao médico',
    'amanhã às 8 tenho aula',
  ];
  for (const userMessage of personalTurns) {
    const grounded = await resolveGroundedReceptionistTurn({
      userMessage,
      userMessages: [userMessage],
      history: [],
      services: catalog,
      now: NOW,
      timezone: TZ,
      readUpcoming: async () => {
        throw new Error(`turno pessoal não consulta upcoming: ${userMessage}`);
      },
      readSlots: async () => {
        throw new Error(`turno pessoal não consulta slots: ${userMessage}`);
      },
    });
    assert.equal(grounded.kind, 'short_circuit', userMessage);
    if (grounded.kind === 'short_circuit') {
      assert.equal(grounded.reply, NON_OPERATIONAL_TURN_CUSTOMER_MESSAGE);
      assert.equal(grounded.toolTrace.length, 0);
      assert.doesNotMatch(
        grounded.reply,
        /\b(?:horario|dispon|agend|20:00|13:00|17:00|18:00|Luzia)\b/i
      );
    }
  }

  const feedbackTurns = ['o serviço ficou ótimo', 'adorei a profissional'];
  for (const userMessage of feedbackTurns) {
    const grounded = await resolveGroundedReceptionistTurn({
      userMessage,
      userMessages: [userMessage],
      history: [],
      services: catalog,
      now: NOW,
      timezone: TZ,
      readUpcoming: async () => {
        throw new Error(`feedback não consulta upcoming: ${userMessage}`);
      },
      readSlots: async () => {
        throw new Error(`feedback não consulta slots: ${userMessage}`);
      },
    });
    assert.equal(grounded.kind, 'short_circuit', userMessage);
    if (grounded.kind === 'short_circuit') {
      assert.equal(grounded.reply, NON_OPERATIONAL_FEEDBACK_CUSTOMER_MESSAGE);
    }
  }

  const compactOperationalTurns = [
    '18h',
    'Pode ser 17h',
    'Calosidade',
    'Drenagem',
    'unha',
    'pé',
    'quero amanhã',
  ];
  for (const userMessage of compactOperationalTurns) {
    const grounded = await resolveGroundedReceptionistTurn({
      userMessage,
      userMessages: [userMessage],
      history: [],
      services: catalog,
      now: NOW,
      timezone: TZ,
      readUpcoming: async () => {
        throw new Error(`compacto operacional não consulta upcoming: ${userMessage}`);
      },
      readSlots: async () => {
        throw new Error(`compacto operacional não consulta slots: ${userMessage}`);
      },
    });
    assert.equal(
      grounded.kind,
      'continue',
      `compacto operacional não pode short-circuit: ${userMessage}`
    );
  }

  const serviceListHistory = [
    { role: 'user' as const, content: 'Quero agendar' },
    {
      role: 'assistant' as const,
      content:
        'Claro! Para qual serviço você gostaria de agendar? Temos Calosidades e Fissuras, Drenagem Linfática e Unha encravada. Qual você prefere?',
    },
    { role: 'user' as const, content: 'Calosidade' },
  ];
  const compactAfterList = await resolveGroundedReceptionistTurn({
    userMessage: 'Calosidade',
    userMessages: ['Quero agendar', 'Calosidade'],
    history: serviceListHistory,
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async () => {
      throw new Error('seleção compacta após lista não consulta upcoming');
    },
    readSlots: async () => {
      throw new Error('seleção compacta após lista não consulta slots');
    },
  });
  assert.equal(compactAfterList.kind, 'short_circuit');
  if (compactAfterList.kind === 'short_circuit') {
    assert.match(compactAfterList.reply, /Calosidades e Fissuras/);
    assert.doesNotMatch(compactAfterList.reply, /Temos |Unha encravada/);
    assert.equal(compactAfterList.toolTrace.length, 0);
  }

  for (const followUp of ['sim', 'ok', 'obrigada']) {
    const grounded = await resolveGroundedReceptionistTurn({
      userMessage: followUp,
      userMessages: [
        'Quero agendar Calosidades e Fissuras amanhã',
        'Pode ser 17h',
        followUp,
      ],
      history: [
        {
          role: 'user',
          content: 'Quero agendar Calosidades e Fissuras amanhã',
        },
        {
          role: 'assistant',
          content:
            'Tenho 13:00, 17:00 e 18:00 para Calosidades e Fissuras amanhã.',
        },
        { role: 'user', content: 'Pode ser 17h' },
        {
          role: 'assistant',
          content:
            'Posso marcar Calosidades e Fissuras amanhã às 17:00. Confirma?',
        },
      ],
      services: catalog,
      now: NOW,
      timezone: TZ,
      readUpcoming: async () => {
        throw new Error(`follow-up curto não consulta upcoming: ${followUp}`);
      },
      readSlots: async () => {
        throw new Error(`follow-up curto não consulta slots: ${followUp}`);
      },
    });
    assert.equal(
      grounded.kind,
      'continue',
      `follow-up curto não pode short-circuit: ${followUp}`
    );
  }

  const unknown = await resolveGroundedReceptionistTurn({
    userMessage: 'Quero marcar Botox amanhã',
    userMessages: ['Quero marcar Botox amanhã'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async () => {
      throw new Error('serviço ausente não consulta upcoming');
    },
    readSlots: async () => {
      throw new Error('serviço ausente não consulta slots');
    },
  });
  assert.equal(unknown.kind, 'short_circuit');
  if (unknown.kind === 'short_circuit') {
    assert.equal(unknown.reply, UNKNOWN_SERVICE_CUSTOMER_MESSAGE);
    assert.doesNotMatch(unknown.reply, /Botox/i);
  }

  const feedback = await resolveGroundedReceptionistTurn({
    userMessage: 'serviço ficou ótimo',
    userMessages: ['serviço ficou ótimo'],
    history: [],
    services: catalog,
    now: NOW,
    timezone: TZ,
    readUpcoming: async () => {
      throw new Error('feedback não consulta upcoming');
    },
    readSlots: async () => {
      throw new Error('feedback não consulta slots');
    },
  });
  assert.equal(feedback.kind, 'short_circuit');
  if (feedback.kind === 'short_circuit') {
    assert.equal(feedback.reply, NON_OPERATIONAL_FEEDBACK_CUSTOMER_MESSAGE);
    assert.doesNotMatch(feedback.reply, /agendar|remarcar/i);
  }

  console.log('smoke receptionist turn grounding: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
