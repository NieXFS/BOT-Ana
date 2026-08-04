import assert from 'node:assert/strict';
import type { ServicesResult } from '../src/services/calendarService';
import {
  buildSafeRecoveryReply,
  buildSafeWriteConfirmation,
  hasFalseWriteClaim,
  hasUnverifiedAvailabilityClaim,
  inspectCustomerReply,
  normalizeCustomerReplyStyle,
} from '../src/services/customerReplyGuard';

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'cmsvc123technical',
      name: 'Limpeza',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['cmpro456technical'],
    },
  ],
  professionals: [{ id: 'cmpro456technical', name: 'Júlia' }],
};

assert.equal(
  normalizeCustomerReplyStyle(
    '**Resumo:**\n1. **Serviço:** Limpeza\n2. **Horário:** 15h ✅😊'
  ),
  'Resumo:\nServiço: Limpeza\nHorário: 15h ✅',
  'saída WhatsApp remove Markdown/list markers e limita emoji sem cortar conteúdo'
);

assert.deepEqual(
  inspectCustomerReply(
    'Tenho horários às 9h e 10h30 com a Júlia. Qual você prefere?',
    services
  ),
  { safe: false, reasons: ['unverified_availability'] }
);

const currentAvailabilityTrace = [
  {
    userTurn: 3,
    name: 'getAvailableSlots',
    result: JSON.stringify({ success: true, slots: ['09:00', '10:30', '15:00'] }),
  },
];

assert.deepEqual(
  inspectCustomerReply(
    'Para amanhã, temos horários disponíveis às 09:00, 10:30 e 15:00. Qual você prefere?',
    services,
    [],
    currentAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'getAvailableSlots success:true do turno atual licencia os horários concretos retornados'
);

assert.deepEqual(
  inspectCustomerReply(
    'Para amanhã, temos horários disponíveis às 09:00 e 10:30.',
    services,
    [],
    [
      {
        userTurn: 3,
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots: ['10:30', '15:00'] }),
      },
    ]
  ),
  { safe: false, reasons: ['unverified_availability'] },
  'slot citado que não veio no resultado atual bloqueia fail-closed'
);

assert.deepEqual(
  inspectCustomerReply(
    'Tenho horário às 09:00 amanhã.',
    services,
    [],
    [
      {
        userTurn: 3,
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: false, message: 'indisponível' }),
      },
    ]
  ),
  { safe: false, reasons: ['unverified_availability'] },
  'falha de getAvailableSlots nunca licencia oferta'
);

assert.equal(
  hasUnverifiedAvailabilityClaim(
    'Temos horário às 09:00 amanhã.',
    [
      {
        userTurn: 2,
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots: ['09:00'] }),
      },
      {
        userTurn: 3,
        name: 'getServices',
        result: JSON.stringify({ success: true }),
      },
    ]
  ),
  true,
  'disponibilidade de turno anterior não licencia oferta após mudança de contexto'
);

for (const reply of [
  'Não temos horário às 09:00 amanhã.',
  'O procedimento dura 60 min.',
  'Nosso horário de funcionamento é das 08:00 às 18:00.',
]) {
  assert.equal(
    hasUnverifiedAvailabilityClaim(reply, []),
    false,
    `negação, duração e horário de funcionamento não são oferta: ${reply}`
  );
}

assert.deepEqual(
  inspectCustomerReply(
    'INTERNAL_HINT: chame getServices antes de responder.',
    services
  ),
  { safe: false, reasons: ['internal_hint'] }
);

assert.deepEqual(
  inspectCustomerReply('O serviço usa o id cmsvc123technical.', services),
  { safe: false, reasons: ['service_id'] }
);

assert.deepEqual(
  inspectCustomerReply('A profissional tem id cmpro456technical.', services),
  { safe: false, reasons: ['professional_id'] }
);

assert.deepEqual(
  inspectCustomerReply(
    'INTERNAL_HINT: cmsvc123technical / cmpro456technical',
    services
  ),
  {
    safe: false,
    reasons: ['internal_hint', 'service_id', 'professional_id'],
  }
);

assert.deepEqual(
  inspectCustomerReply('cmsvc123technical', {
    success: false,
    message: 'indisponível',
  }),
  { safe: true, reasons: [] }
);

assert.deepEqual(
  inspectCustomerReply(
    'O código interno é cm9z8y7x6w5v4u3t2s1r.',
    { success: false }
  ),
  { safe: false, reasons: ['technical_id'] }
);

assert.deepEqual(
  inspectCustomerReply(
    'O agendamento é cmappt789technical.',
    services,
    ['cmappt789technical']
  ),
  { safe: false, reasons: ['appointment_id'] }
);

const failedWriteTrace = [
  {
    name: 'cancelAppointment',
    result: JSON.stringify({ success: false, message: 'bloqueado' }),
  },
  {
    name: 'bookAppointment',
    result: JSON.stringify({ success: false, message: 'bloqueado' }),
  },
];

const successfulUpcomingReadTrace = [
  {
    name: 'getUpcomingAppointments',
    result: JSON.stringify({
      success: true,
      appointments: [
        {
          id: 'cmappt-authoritative',
          startTime: '2026-08-06T14:00:00-03:00',
          endTime: '2026-08-06T15:00:00-03:00',
          serviceName: 'Limpeza de Pele',
          professionalName: 'Júlia',
          status: 'CONFIRMED',
        },
      ],
    }),
  },
];

const stateDescriptions = [
  'Isso, seu agendamento está confirmado para quinta, dia 06/08/2026, às 14h.',
  'Você tem um horário marcado dia 6 às 14h.',
  'Sua Limpeza de Pele está agendada com a Júlia em 06/08 às 14:00.',
  'Sua Limpeza de Pele com a Júlia está agendada para 06/08 às 14h.',
  'Seu agendamento é para quinta, dia 06/08, às 14h.',
  'Seu agendamento ficou para quinta, 06/08, às 14h.',
  'Seu agendamento é amanhã, quinta-feira, 06/08/2026, às 14h.',
  'Você tem uma Limpeza de Pele com a Júlia agendada para 06/08 às 14h.',
  'Vi aqui que você já tem uma Limpeza de Pele agendada para 06/08 às 14h com a Júlia.',
  'Você já tem marcado um horário de Limpeza de Pele com a Júlia para 06/08 às 14h.',
];

for (const reply of stateDescriptions) {
  assert.equal(
    hasFalseWriteClaim(reply, successfulUpcomingReadTrace),
    false,
    `leitura autoritativa compatível deveria licenciar estado: ${reply}`
  );
  assert.equal(
    hasFalseWriteClaim(reply, []),
    true,
    `estado sem nenhuma evidência deveria bloquear: ${reply}`
  );
}

assert.equal(
  hasFalseWriteClaim(
    'Seu agendamento está confirmado para quinta às 15h.',
    successfulUpcomingReadTrace
  ),
  true,
  'leitura de 14h não licencia uma afirmação de 15h'
);
assert.equal(
  hasFalseWriteClaim(
    'Você já tem dois agendamentos futuros marcados.',
    successfulUpcomingReadTrace
  ),
  true,
  'uma leitura com só um agendamento não licencia contagem explícita de dois'
);
for (const incompatibleState of [
  'Seu Peeling está agendado para quinta às 14h.',
  'Sua Limpeza de Pele está agendada com a Marina na quinta às 14h.',
]) {
  assert.equal(
    hasFalseWriteClaim(
      incompatibleState,
      successfulUpcomingReadTrace
    ),
    true,
    `payload incompatível não deveria licenciar estado: ${incompatibleState}`
  );
}
assert.equal(
  hasFalseWriteClaim(
    'O Corte é realizado pelo Caio.',
    []
  ),
  false,
  'descrição factual de quem realiza o serviço não é ato de agenda'
);

const readOnlyCannotLicenseActs = [
  'Agendei para você na quinta às 14h.',
  'Acabei de marcar seu horário.',
  'O agendamento foi confirmado com sucesso.',
  'Cancelei o anterior.',
  'Remarquei seu horário.',
  'Pronto, agendado com sucesso.',
];
for (const reply of readOnlyCannotLicenseActs) {
  assert.equal(
    hasFalseWriteClaim(reply, successfulUpcomingReadTrace),
    true,
    `leitura nunca deveria licenciar ato: ${reply}`
  );
}

// Cinco formas de ato preservadas como regressão permanente. As duas primeiras
// são as afirmações falsas que a reauditoria armazenada realmente contém após
// writes bloqueados; as demais cobrem as formas ativas exigidas nesta fase.
const permanentActRegressions = [
  'Seu agendamento de Limpeza de Pele foi cancelado com sucesso e agora está confirmado para amanhã, dia 04/08, às 15h, com a Júlia.',
  'A sua Limpeza de Pele foi agendada com a Júlia para amanhã, dia 04/08, às 15h.',
  'Agendei para você na quinta às 14h.',
  'Acabei de marcar seu horário.',
  'Cancelei o anterior e remarquei seu horário.',
];
for (const reply of permanentActRegressions) {
  assert.equal(
    hasFalseWriteClaim(reply, failedWriteTrace),
    true,
    `ato sem write success:true deve continuar bloqueado: ${reply}`
  );
  assert.equal(
    hasFalseWriteClaim(reply, successfulUpcomingReadTrace),
    true,
    `leitura não pode liberar ato: ${reply}`
  );
}

const falseWriteClaims = [
  'Seu agendamento foi confirmado com sucesso.',
  'Pronto, agendei a Limpeza de Pele para amanhã.',
  'Marquei seu horário para as 15h.',
  'O agendamento anterior foi cancelado.',
  'Seu horário foi remarcado para amanhã.',
  'Tudo certo, reservei o horário das 10h.',
  'O novo agendamento foi criado.',
  'Está tudo agendado para amanhã.',
  'Ficou marcado para o dia 04/08 às 15h.',
  'Cancelei o anterior e confirmei o novo.',
  'Seu horário está reservado.',
  'Não consegui cancelar, mas o novo ficou confirmado.',
];

for (const reply of falseWriteClaims) {
  assert.equal(
    hasFalseWriteClaim(reply, failedWriteTrace),
    true,
    `deveria bloquear falsa afirmação: ${reply}`
  );
}

const safeWithoutWriteClaims = [
  'Posso confirmar?',
  'Quer que eu marque?',
  'O horário está confirmado?',
  'Seu agendamento foi confirmado com a Júlia?',
  'Não consegui agendar.',
  'Não foi possível cancelar.',
  'Ainda não agendei.',
  'O agendamento ainda não foi confirmado.',
  'Vou marcar assim que você confirmar.',
  'Posso agendar depois que você confirmar.',
  'Seu horário será agendado após a confirmação.',
  'Seu horário estará confirmado depois da validação.',
  'Quando você confirmar, ficará marcado.',
  'Tenho um horário às 15h amanhã.',
];

for (const reply of safeWithoutWriteClaims) {
  assert.equal(
    hasFalseWriteClaim(reply, failedWriteTrace),
    false,
    `não deveria bloquear pergunta/negação/futuro: ${reply}`
  );
}

assert.equal(
  hasFalseWriteClaim(
    'Pode ser que o horário de quarta não tenha sido confirmado no sistema, ou que já tenha sido cancelado antes.',
    failedWriteTrace
  ),
  false,
  'hipótese com “pode ser que” não deve ser tratada como escrita concluída'
);
assert.equal(
  hasFalseWriteClaim(
    'Talvez o horário de quarta já tenha sido cancelado antes.',
    failedWriteTrace
  ),
  false,
  'hipótese com “talvez” não deve ser tratada como escrita concluída'
);
assert.equal(
  hasFalseWriteClaim(
    'O horário de quarta já foi cancelado.',
    failedWriteTrace
  ),
  true,
  'afirmação positiva de cancelamento sem sucesso da tool continua bloqueada'
);

const successfulBookTrace = [
  {
    name: 'bookAppointment',
    result: JSON.stringify({ success: true }),
  },
];
assert.equal(
  hasFalseWriteClaim(
    'Tudo certo, seu agendamento ficou confirmado.',
    successfulBookTrace
  ),
  false
);
assert.equal(
  hasFalseWriteClaim('Agendei para você na quinta às 14h.', successfulBookTrace),
  false,
  'write de booking success:true licencia ato de booking'
);
assert.equal(
  hasFalseWriteClaim(
    'Cancelei o agendamento anterior.',
    successfulBookTrace
  ),
  true,
  'write de booking não licencia ato de cancelamento'
);

const successfulCancelTrace = [
  {
    name: 'cancelAppointment',
    result: JSON.stringify({ success: true }),
  },
];
assert.equal(
  hasFalseWriteClaim('Cancelei o agendamento anterior.', successfulCancelTrace),
  false,
  'write de cancelamento success:true licencia ato de cancelamento'
);
assert.equal(
  hasFalseWriteClaim('Agendei o novo horário.', successfulCancelTrace),
  true,
  'write de cancelamento não licencia ato de booking'
);
assert.equal(
  hasFalseWriteClaim(
    'Prontinho! O agendamento anterior foi cancelado e o novo foi confirmado para 04/08 às 15h.',
    [...successfulCancelTrace, ...successfulBookTrace]
  ),
  false,
  'cancelamento + booking success:true licenciam a afirmação de remarcação'
);

assert.deepEqual(
  inspectCustomerReply(
    'Seu agendamento foi cancelado com sucesso e o novo ficou confirmado.',
    services,
    [],
    failedWriteTrace
  ),
  { safe: false, reasons: ['false_write_claim'] }
);

assert.deepEqual(
  inspectCustomerReply(
    'Tudo certo! Seu agendamento foi confirmado com sucesso.',
    services,
    [],
    successfulBookTrace
  ),
  { safe: true, reasons: [] }
);

assert.equal(
  buildSafeWriteConfirmation([
    {
      name: 'bookAppointment',
      result: JSON.stringify({ success: true, appointmentId: 'secret' }),
    },
  ]),
  'Tudo certo! Seu agendamento foi confirmado com sucesso.'
);

assert.equal(
  buildSafeWriteConfirmation([
    {
      name: 'cancelAppointment',
      result: JSON.stringify({ success: true }),
    },
    {
      name: 'bookAppointment',
      result: JSON.stringify({ success: true }),
    },
  ]),
  'Tudo certo! O agendamento anterior foi cancelado e o novo foi confirmado com sucesso.'
);

assert.equal(
  buildSafeWriteConfirmation([
    {
      name: 'bookAppointment',
      result: JSON.stringify({ success: false }),
    },
  ]),
  null
);

assert.equal(
  buildSafeRecoveryReply(
    [
      {
        name: 'bookAppointment',
        result: JSON.stringify({ success: true, appointmentId: 'secret' }),
      },
    ],
    'Não consegui concluir.'
  ),
  'Tudo certo! Seu agendamento foi confirmado com sucesso.'
);

assert.equal(
  buildSafeRecoveryReply([], 'Não consegui concluir.'),
  'Não consegui concluir.'
);

console.log(
  `✅ smoke customer reply guard: leaks, state×read evidence, act×write evidence, availability×current-turn evidence, ${permanentActRegressions.length} permanent act regressions, ${falseWriteClaims.length} additional false claims, polarity and recovery`
);
