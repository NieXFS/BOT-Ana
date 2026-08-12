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

const directProfessionalQuestion =
  'Peeling é com a Júlia ou a Marina. Você prefere uma profissional específica ou tanto faz?';
assert.equal(
  normalizeCustomerReplyStyle(
    `Peeling tem dois profissionais habilitados (Júlia e Marina). Preciso perguntar a preferência antes de consultar horários.\n\n${directProfessionalQuestion}`
  ),
  directProfessionalQuestion,
  'prefácio exato de metarraciocínio de P0-CONTEXT-CORRECTION some e sobra a pergunta ao cliente'
);

for (const [label, reply, expected] of [
  [
    'o cliente quer',
    'O cliente quer marcar Peeling amanhã.\n\nQual profissional você prefere?',
    'Qual profissional você prefere?',
  ],
  [
    'o cliente pediu',
    'O cliente pediu a Limpeza de Pele.\n\nQual horário você prefere?',
    'Qual horário você prefere?',
  ],
  [
    'a cliente disse',
    'A cliente disse que quer Peeling.\n\nQual profissional você prefere?',
    'Qual profissional você prefere?',
  ],
  [
    'tool no primeiro parágrafo',
    'Vou chamar getAvailableSlots antes de responder.\n\nQual data você prefere?',
    'Qual data você prefere?',
  ],
  [
    'múltiplos prefácios internos contíguos',
    'O cliente quer Peeling.\n\nVou usar bookAppointment depois.\n\nQual profissional você prefere?',
    'Qual profissional você prefere?',
  ],
] as const) {
  assert.equal(
    normalizeCustomerReplyStyle(reply),
    expected,
    `${label} no início some somente quando resta uma resposta ao cliente`
  );
}

for (const reply of [
  'Preciso confirmar alguns dados com você.',
  'Vou verificar os horários para você.',
]) {
  assert.equal(
    normalizeCustomerReplyStyle(reply),
    reply,
    `fala ao cliente é preservada: ${reply}`
  );
}

const legitimateOpeningThenMeta =
  'Olá! Como posso ajudar?\n\nO cliente quer Peeling amanhã.';
assert.equal(
  normalizeCustomerReplyStyle(legitimateOpeningThenMeta),
  legitimateOpeningThenMeta,
  'marcador em parágrafo posterior a abertura legítima é preservado'
);
const onlyMetaParagraph =
  'O cliente pediu Peeling e preciso usar getAvailableSlots antes de responder.';
assert.equal(
  normalizeCustomerReplyStyle(onlyMetaParagraph),
  onlyMetaParagraph,
  'mensagem somente interna é preservada quando não há resposta restante'
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

const qualifiedBookFailureAvailabilityTrace = [
  {
    userTurn: 3,
    name: 'bookAppointment',
    result: JSON.stringify({
      success: false,
      reason: 'conflict',
      availableSlots: ['09:00', '10:30'],
      message: 'Esse horário acabou de ser preenchido.',
      hint: 'Estes slots já foram consultados pelo sistema.',
    }),
  },
];

const duplicateArtifactReply = `Encontrei que você já tem uma Limpeza de Pele agendada para 05/08 às 14:00 com a Júlia. Como prefere seguir?

1. Manter os dois
2. Remarcar (cancelar o anterior e marcar este novo)
3. Só cancelar o anterior
4. Pensar depois`;
assert.equal(
  hasUnverifiedAvailabilityClaim(duplicateArtifactReply, []),
  false,
  'texto de duplicidade do artefato com "Encontrei que" não é oferta de disponibilidade'
);
for (const reply of [
  'Achei que o horário às 09:00 já está ocupado.',
  duplicateArtifactReply,
]) {
  assert.equal(
    hasUnverifiedAvailabilityClaim(reply, []),
    false,
    `encontrei/achei sem contexto positivo de disponibilidade não vira oferta: ${reply}`
  );
}
for (const reply of [
  'Encontrei horários às 09:00 e 10:30.',
  'Encontrei os horários às 09:00 e 10:30.',
  'Achei opções às 09:00 e 10:30.',
]) {
  assert.equal(
    hasUnverifiedAvailabilityClaim(reply, []),
    true,
    `encontrei/achei contextualizado sem fonte atual continua bloqueado: ${reply}`
  );
  assert.equal(
    hasUnverifiedAvailabilityClaim(reply, currentAvailabilityTrace),
    false,
    `encontrei/achei contextualizado é licenciado por getAvailableSlots atual compatível: ${reply}`
  );
}

for (const reply of [
  `Identifiquei que você já tem um agendamento de Limpeza de Pele com a Júlia no dia 05/08 às 14h. Como deseja proceder?

1. Manter os dois
2. Remarcar (cancelar o anterior e marcar este novo)
3. Só cancelar o anterior
4. Pensar depois`,
  `Identifiquei que você já tem dois agendamentos futuros:

Limpeza de Pele com a Júlia em 05/08 às 14:00 e Peeling com a Marina em 06/08 às 16:00.

Como você quer proceder com o novo agendamento de amanhã? Posso manter os dois, remarcar (cancelando um deles e marcando o novo), ou só cancelar um dos anteriores?`,
]) {
  assert.equal(
    hasUnverifiedAvailabilityClaim(reply, []),
    false,
    `narrativa de duplicidade não é oferta de disponibilidade: ${reply}`
  );
}

assert.equal(
  hasUnverifiedAvailabilityClaim('Tem horário às 15h amanhã.', []),
  true,
  'tem horário sem getAvailableSlots continua bloqueado'
);
assert.equal(
  hasUnverifiedAvailabilityClaim(
    'Tem horário às 15h amanhã.',
    currentAvailabilityTrace
  ),
  false,
  'tem horário é seguro com getAvailableSlots atual compatível'
);
assert.equal(
  hasUnverifiedAvailabilityClaim('Tem horários às 09:00 e 10h30 amanhã.', []),
  true,
  'tem horários sem getAvailableSlots continua bloqueado'
);
assert.equal(
  hasUnverifiedAvailabilityClaim(
    'Tem horários às 09:00 e 10h30 amanhã.',
    currentAvailabilityTrace
  ),
  false,
  'tem horários é seguro quando todos os slots vierem do turno atual'
);
assert.equal(
  hasUnverifiedAvailabilityClaim('Não tem horários às 15h amanhã.', []),
  false,
  'não tem horários é negativa, não oferta de disponibilidade'
);

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
    'Para amanhã, temos horários disponíveis às 09:00 e 10:30. Qual você prefere?',
    services,
    [],
    qualifiedBookFailureAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'bookAppointment conflict com availableSlots atual licencia somente as alternativas já consultadas'
);

assert.deepEqual(
  inspectCustomerReply(
    'Confirmei que às 09:00 e 10h30 estão disponíveis amanhã.',
    services,
    [],
    qualifiedBookFailureAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'a mesma fonte qualificada licencia confirmação factual, não só oferta direta'
);

assert.deepEqual(
  inspectCustomerReply(
    'Para amanhã, temos horários disponíveis às 09:00 e 16:00. Qual você prefere?',
    services,
    [],
    qualifiedBookFailureAvailabilityTrace
  ),
  { safe: false, reasons: ['unverified_availability'] },
  'slot extra fora de availableSlots de falha qualificada bloqueia fail-closed'
);

for (const [label, toolTrace] of [
  [
    'package_exhausted',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'package_exhausted',
          availableSlots: ['09:00', '10:30'],
        }),
      },
    ],
  ],
  [
    'other',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'other',
          availableSlots: ['09:00', '10:30'],
        }),
      },
    ],
  ],
  [
    'book success:true',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: true,
          reason: 'conflict',
          availableSlots: ['09:00', '10:30'],
        }),
      },
    ],
  ],
  [
    'availableSlots misto com item inválido',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'conflict',
          availableSlots: ['09:00', { time: '10:30' }],
        }),
      },
    ],
  ],
  [
    'availableSlots somente inválido',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'conflict',
          availableSlots: [{ time: '09:00' }],
        }),
      },
    ],
  ],
  [
    'message e hint sem availableSlots',
    [
      {
        userTurn: 3,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'conflict',
          message: 'Tenho 09:00 e 10:30.',
          hint: 'Ofereça 09:00 e 10:30.',
        }),
      },
    ],
  ],
  [
    'evidência de book no turno anterior',
    [
      {
        userTurn: 2,
        name: 'bookAppointment',
        result: JSON.stringify({
          success: false,
          reason: 'conflict',
          availableSlots: ['09:00', '10:30'],
        }),
      },
      {
        userTurn: 3,
        name: 'getServices',
        result: JSON.stringify({ success: true }),
      },
    ],
  ],
] as const) {
  assert.deepEqual(
    inspectCustomerReply(
      'Para amanhã, temos horários disponíveis às 09:00 e 10:30. Qual você prefere?',
      services,
      [],
      toolTrace
    ),
    { safe: false, reasons: ['unverified_availability'] },
    `${label} não licencia disponibilidade`
  );
}

assert.deepEqual(
  inspectCustomerReply(
    'Confirmei que 15h está disponível amanhã.',
    services,
    [],
    currentAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'confirmação factual de disponibilidade com slot atual não é escrita'
);

assert.deepEqual(
  inspectCustomerReply(
    'Confirmei que às 09:00 e 10h30 estão disponíveis amanhã.',
    services,
    [],
    currentAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'confirmação factual plural exige todos os slots no resultado atual'
);

assert.deepEqual(
  inspectCustomerReply(
    'Confirmei que 15h tá disponível amanhã.',
    services,
    [],
    currentAvailabilityTrace
  ),
  { safe: true, reasons: [] },
  'confirmação factual aceita a forma coloquial de estado disponível'
);

for (const [reply, toolTrace, label] of [
  [
    'Confirmei que 16h está disponível amanhã.',
    currentAvailabilityTrace,
    'slot divergente não licencia confirmação factual',
  ],
  [
    'Confirmei que 15h está disponível amanhã.',
    [],
    'sem tool não licencia confirmação factual',
  ],
  [
    'Confirmei que 15h está disponível amanhã.',
    [
      {
        userTurn: 3,
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: false, message: 'indisponível' }),
      },
    ],
    'tool com success:false não licencia confirmação factual',
  ],
  [
    'Confirmei que 15h está disponível amanhã.',
    [
      {
        userTurn: 2,
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots: ['15:00'] }),
      },
      {
        userTurn: 3,
        name: 'getServices',
        result: JSON.stringify({ success: true }),
      },
    ],
    'evidência de disponibilidade em turno anterior não licencia confirmação factual',
  ],
  [
    'Confirmei que 09:00 e 16h estão disponíveis amanhã.',
    currentAvailabilityTrace,
    'todos os slots da confirmação factual precisam estar no resultado atual',
  ],
] as const) {
  assert.equal(
    hasFalseWriteClaim(reply, toolTrace),
    true,
    label
  );
}

for (const reply of [
  'Confirmei seu agendamento para amanhã.',
  'Confirmei que o agendamento está confirmado.',
  'Agendei seu agendamento para amanhã.',
  'Marquei seu agendamento para amanhã.',
]) {
  assert.equal(
    hasFalseWriteClaim(reply, currentAvailabilityTrace),
    true,
    `gramática de agendamento continua bloqueada: ${reply}`
  );
}

for (const reply of [
  'Confirmei que 15h está disponível amanhã e marquei seu agendamento.',
  'Confirmei que 15h está disponível amanhã e agendei seu agendamento.',
  'Confirmei que 15h está disponível amanhã e seu agendamento foi confirmado.',
  'Confirmei que 15h está disponível amanhã e seu agendamento foi realizado.',
]) {
  assert.equal(
    hasFalseWriteClaim(reply, currentAvailabilityTrace),
    true,
    `claim de escrita posterior continua bloqueada: ${reply}`
  );
}

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

assert.deepEqual(
  inspectCustomerReply(
    'Tenho horário às 09:00 amanhã.',
    services,
    [],
    [
      {
        userTurn: 3,
        name: 'getAvailableSlots',
        result: JSON.stringify({
          success: true,
          slots: ['09:00', { time: '10:30' }],
        }),
      },
    ]
  ),
  { safe: false, reasons: ['unverified_availability'] },
  'slots mistos de getAvailableSlots também rejeitam a fonte inteira fail-closed'
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

const appointmentTemporalContext = {
  now: '2026-08-05T12:00:00-03:00',
  timezone: 'America/Sao_Paulo',
};

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
    hasFalseWriteClaim(
      reply,
      successfulUpcomingReadTrace,
      appointmentTemporalContext
    ),
    false,
    `leitura autoritativa compatível deveria licenciar estado: ${reply}`
  );
  assert.equal(
    hasFalseWriteClaim(reply, [], appointmentTemporalContext),
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
assert.equal(
  hasFalseWriteClaim(
    'O Peeling é realizado pelas profissionais Júlia e Marina.',
    []
  ),
  false,
  'descrição factual plural de quem realiza o serviço não é ato de agenda'
);
for (const reply of [
  'O agendamento foi realizado.',
  'O agendamento foi confirmado.',
]) {
  assert.equal(
    hasFalseWriteClaim(reply, []),
    true,
    `ato de agendamento sem write success:true continua bloqueado: ${reply}`
  );
}

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

// Uma negação explícita de estado com percentual não é uma afirmação de
// escrita. O trace vazio garante que esta regressão não depende de chamada ou
// efeito de booking para ser considerada segura.
for (const reply of [
  'Entendo que ainda não está 100% confirmado. Posso confirmar o agendamento para você?',
  'O agendamento não está totalmente confirmado.',
  'O agendamento não está completamente confirmado.',
]) {
  assert.equal(
    hasFalseWriteClaim(reply, []),
    false,
    `negação explícita de estado não deve virar falsa escrita: ${reply}`
  );
}

assert.equal(
  hasFalseWriteClaim('O agendamento está 100% confirmado.', []),
  true,
  'confirmação positiva com percentual continua bloqueada sem write success:true'
);
assert.equal(
  hasFalseWriteClaim(
    'Ainda não está 100% confirmado, mas o novo ficou confirmado.',
    []
  ),
  true,
  'contraste posterior positivo continua bloqueado sem write success:true'
);

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
  {
    safe: false,
    reasons: ['false_write_claim', 'unverified_appointment_context'],
  }
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
