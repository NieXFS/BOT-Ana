import assert from 'node:assert/strict';
import {
  bookingConfirmationGate,
  cancellationIntentGate,
  isExplicitBookingConfirmation,
  priorUserSelectedDuplicateAction,
  RESCHEDULE_CANCELLATION_EVIDENCE_WINDOW_MS,
  RescheduleCancellationEvidenceStore,
  type BookingProposal,
} from '../src/services/bookingConfirmationGate';

const colloquialAcceptances = [
  'Sim',
  'Sim!',
  'SIM, POR FAVOR',
  'Sim, pode marcar.',
  'Sim pode agendar',
  'Sim, tudo certo',
  'sim sim',
  'sim, sim!!!',
  'isso',
  'Isso mesmo.',
  'é isso',
  'perfeito',
  'Beleza!',
  'blz',
  'show',
  'tá bom',
  'ta bom',
  'tá ótimo',
  'ta otimo',
  'pode sim',
  'quero sim',
  'bora',
  'bora sim',
  'vamos',
  'vamos sim',
  'aham',
  'uhum',
  'por favor',
  'pode marcar sim',
  'pode agendar, por favor',
  'pode confirmar',
  'confirma',
  'confirma sim',
  'confirmo!',
  'confirmado',
  'confirmado sim',
  'confirmado, sim',
  'tudo certo',
  'fechado',
  'combinado',
  'manda ver',
  'ok',
  'okay',
  'pode ser sim',
  'pode ser, pode marcar',
  'pode ser então',
  'pode ser, então',
  '👍',
  '👍🏽',
  '🆗',
  '👌',
  '👌🏻',
];

for (const message of colloquialAcceptances) {
  assert.equal(
    isExplicitBookingConfirmation(message),
    true,
    `aceite coloquial deveria passar: ${message}`
  );
}

const ambiguousOrCorrective = [
  'Acho que pode.',
  'Talvez possa marcar.',
  'Quem sabe.',
  'Se der, pode marcar.',
  'Provavelmente.',
  'Não sei.',
  'Pode ser.',
  'Pode ser?',
  'Acho que pode ser.',
  'Quero às 15h.',
  'Sim, mas quero às 16h.',
  'Sim, mas troca o horário.',
  'Beleza, mas às 16h.',
  'Sim, porém prefiro amanhã.',
  'Sim, só que mais tarde.',
  'Na verdade prefiro outro dia.',
  'Pode sim, mas muda o horário.',
];

for (const message of ambiguousOrCorrective) {
  assert.equal(
    isExplicitBookingConfirmation(message),
    false,
    `mensagem ambígua/corretiva deveria bloquear: ${message}`
  );
}

const expectedBooking: BookingProposal = {
  date: '2026-08-04',
  time: '15:00',
  serviceName: 'Limpeza de Pele',
  professionalName: 'Júlia',
};

const confirmationHistory = [
  {
    role: 'assistant',
    content:
      'Vou agendar Limpeza de Pele com a Júlia no dia 04/08/2026 às 15h. Tudo certo?',
  },
];
assert.deepEqual(
  bookingConfirmationGate({
    currentUserMessage: 'Sim, pode marcar.',
    history: confirmationHistory,
    confirmedDuplicate: false,
    expectedBooking,
  }),
  { ok: true, consumesCancellationEvidence: false }
);

for (const message of colloquialAcceptances) {
  assert.deepEqual(
    bookingConfirmationGate({
      currentUserMessage: message,
      history: confirmationHistory,
      confirmedDuplicate: false,
      expectedBooking,
    }),
    { ok: true, consumesCancellationEvidence: false },
    `gate completo deveria aceitar após resumo: ${message}`
  );
}

const structuralConfirmationHistories = [
  [
    {
      role: 'assistant',
      content:
        'Fica assim: Limpeza de Pele com a Júlia, amanhã, dia 04/08/2026 às 15h. Confirma?',
    },
  ],
  [
    {
      role: 'assistant',
      content:
        'Limpeza de Pele com a Júlia no dia 04/08/2026 às 15h. Posso agendar?',
    },
  ],
  [
    {
      role: 'assistant',
      content:
        'Limpeza de Pele com a Júlia, 04/08/2026, 15h. Fica assim? 😊',
    },
  ],
];

for (const history of structuralConfirmationHistories) {
  assert.deepEqual(
    bookingConfirmationGate({
      currentUserMessage: 'isso mesmo',
      history,
      confirmedDuplicate: false,
      expectedBooking,
    }),
    { ok: true, consumesCancellationEvidence: false }
  );
}

const vague = bookingConfirmationGate({
  currentUserMessage: 'Acho que pode.',
  history: confirmationHistory,
  confirmedDuplicate: false,
  expectedBooking,
});
assert.equal(vague.ok, false);
assert.match(vague.ok ? '' : vague.hintMessage, /^INTERNAL_HINT:/);

const noPriorSummary = bookingConfirmationGate({
  currentUserMessage: 'Pode marcar.',
  history: [],
  confirmedDuplicate: false,
  expectedBooking,
});
assert.equal(noPriorSummary.ok, false);

for (const message of ['isso', 'perfeito', 'pode sim', '👍']) {
  const withoutSummary = bookingConfirmationGate({
    currentUserMessage: message,
    history: [],
    confirmedDuplicate: false,
    expectedBooking,
  });
  assert.equal(
    withoutSummary.ok,
    false,
    `aceite sem resumo anterior deve continuar bloqueado: ${message}`
  );
}

const onlySlots = bookingConfirmationGate({
  currentUserMessage: 'Sim.',
  history: [
    {
      role: 'assistant',
      content: 'Tenho horários às 9h, 10h30 e 15h. Qual você prefere?',
    },
  ],
  confirmedDuplicate: false,
  expectedBooking,
});
assert.equal(onlySlots.ok, false);

const changedArgs = bookingConfirmationGate({
  currentUserMessage: 'Sim, pode marcar.',
  history: confirmationHistory,
  confirmedDuplicate: false,
  expectedBooking: { ...expectedBooking, time: '16:00' },
});
assert.equal(changedArgs.ok, false);

const changedDate = bookingConfirmationGate({
  currentUserMessage: 'Sim, pode marcar.',
  history: confirmationHistory,
  confirmedDuplicate: false,
  expectedBooking: { ...expectedBooking, date: '2026-08-05' },
});
assert.equal(changedDate.ok, false);

const changedService = bookingConfirmationGate({
  currentUserMessage: 'Sim, pode marcar.',
  history: confirmationHistory,
  confirmedDuplicate: false,
  expectedBooking: { ...expectedBooking, serviceName: 'Peeling' },
});
assert.equal(changedService.ok, false);

const duplicateHistory = [
  ...confirmationHistory,
  { role: 'user', content: 'Sim, pode marcar.' },
  {
    role: 'assistant',
    content:
      'Vi que você já tem outro agendamento futuro. Quer manter os dois, remarcar, só cancelar o anterior ou pensar depois?',
  },
];

const noDuplicateContext = bookingConfirmationGate({
  currentUserMessage: 'Quero manter os dois.',
  history: [],
  confirmedDuplicate: true,
  expectedBooking,
});
assert.equal(noDuplicateContext.ok, false);

assert.deepEqual(
  bookingConfirmationGate({
    currentUserMessage: 'Quero manter os dois.',
    history: duplicateHistory,
    confirmedDuplicate: true,
    expectedBooking,
  }),
  { ok: true, consumesCancellationEvidence: false }
);

const sameTurnBypass = bookingConfirmationGate({
  currentUserMessage: 'Sim, pode marcar.',
  history: confirmationHistory,
  confirmedDuplicate: true,
  expectedBooking,
});
assert.equal(sameTurnBypass.ok, false);

const remarriageBeforeCancel = bookingConfirmationGate({
  currentUserMessage:
    'Quero remarcar: cancele o anterior e mantenha este novo.',
  history: duplicateHistory,
  confirmedDuplicate: true,
  expectedBooking,
  duplicateCancellationSucceeded: false,
});
assert.equal(remarriageBeforeCancel.ok, false);

assert.deepEqual(
  bookingConfirmationGate({
    currentUserMessage:
      'Quero remarcar: cancele o anterior e mantenha este novo.',
    history: duplicateHistory,
    confirmedDuplicate: true,
    expectedBooking,
    duplicateCancellationSucceeded: true,
  }),
  { ok: true, consumesCancellationEvidence: true }
);

const crossTurnHistory = [
  ...duplicateHistory,
  {
    role: 'user',
    content:
      'Quero remarcar. Cancele o anterior; escolho o novo horário depois.',
  },
  {
    role: 'assistant',
    content: 'Tudo certo. O anterior foi cancelado.',
  },
  {
    role: 'user',
    content: 'Para o novo, quero às 10h30.',
  },
  {
    role: 'assistant',
    content:
      'Limpeza de Pele com a Júlia no dia 04/08/2026 às 10h30. Confirma?',
  },
  { role: 'user', content: 'sim' },
];
const crossTurnBooking: BookingProposal = {
  ...expectedBooking,
  time: '10:30',
};
const evidenceStore = new RescheduleCancellationEvidenceStore();
const conversationKey = 'phone-number-id:customer';
const otherConversationKey = 'phone-number-id:other-customer';
const cancelledAppointmentId = 'cmappt-authoritative';
const cancellationSucceededAt = Date.UTC(2026, 7, 4, 12, 0, 0);

// Turno do cancelamento: só success:true autoritativo chama record em produção.
evidenceStore.record(
  conversationKey,
  cancelledAppointmentId,
  cancellationSucceededAt
);
assert.equal(
  evidenceStore.peek(otherConversationKey, cancellationSucceededAt + 1),
  null,
  'a evidência nunca atravessa conversas'
);

const crossTurnWithinWindow = bookingConfirmationGate({
  currentUserMessage: 'sim',
  history: crossTurnHistory,
  currentUserMessageIndex: crossTurnHistory.length - 1,
  confirmedDuplicate: true,
  expectedBooking: crossTurnBooking,
  duplicateCancellationSucceeded:
    evidenceStore.peek(conversationKey, cancellationSucceededAt + 1_000) !==
    null,
});
assert.deepEqual(crossTurnWithinWindow, {
  ok: true,
  consumesCancellationEvidence: true,
});

const consumedEvidence = evidenceStore.consume(
  conversationKey,
  cancellationSucceededAt + 1_000
);
assert.equal(consumedEvidence?.appointmentId, cancelledAppointmentId);
assert.equal(
  evidenceStore.consume(conversationKey, cancellationSucceededAt + 1_001),
  null,
  'um cancelamento não autoriza dois bookings'
);
assert.equal(
  bookingConfirmationGate({
    currentUserMessage: 'sim',
    history: crossTurnHistory,
    currentUserMessageIndex: crossTurnHistory.length - 1,
    confirmedDuplicate: true,
    expectedBooking: crossTurnBooking,
    duplicateCancellationSucceeded:
      evidenceStore.peek(conversationKey, cancellationSucceededAt + 1_001) !==
      null,
  }).ok,
  false,
  'o segundo booking fica bloqueado após o consumo'
);

evidenceStore.record(
  conversationKey,
  cancelledAppointmentId,
  cancellationSucceededAt
);
const afterExpiration =
  cancellationSucceededAt +
  RESCHEDULE_CANCELLATION_EVIDENCE_WINDOW_MS +
  1;
assert.equal(evidenceStore.peek(conversationKey, afterExpiration), null);
assert.equal(
  bookingConfirmationGate({
    currentUserMessage: 'sim',
    history: crossTurnHistory,
    currentUserMessageIndex: crossTurnHistory.length - 1,
    confirmedDuplicate: true,
    expectedBooking: crossTurnBooking,
    duplicateCancellationSucceeded:
      evidenceStore.peek(conversationKey, afterExpiration) !== null,
  }).ok,
  false,
  'evidência expirada não libera remarcação cross-turn'
);

const wrongDuplicateFlag = bookingConfirmationGate({
  currentUserMessage: 'Tanto faz.',
  history: confirmationHistory,
  confirmedDuplicate: true,
  expectedBooking,
});
assert.equal(wrongDuplicateFlag.ok, false);

assert.deepEqual(
  cancellationIntentGate({
    currentUserMessage: 'Quero remarcar.',
    history: duplicateHistory,
  }),
  { ok: true }
);

const standaloneCancel = cancellationIntentGate({
  currentUserMessage: 'Cancele meu horário de amanhã.',
  history: confirmationHistory,
});
assert.equal(standaloneCancel.ok, false);

const staleDuplicateContext = cancellationIntentGate({
  currentUserMessage: 'Quero cancelar meu horário.',
  history: [
    ...duplicateHistory,
    { role: 'user', content: 'Vou pensar.' },
    {
      role: 'assistant',
      content: 'Sem problema. Se precisar de algo, estou por aqui.',
    },
  ],
});
assert.equal(staleDuplicateContext.ok, false);

assert.deepEqual(
  cancellationIntentGate({
    currentUserMessage: 'O do dia 05/08 às 14h.',
    history: [
      ...duplicateHistory,
      {
        role: 'user',
        content: 'Quero remarcar, mas qual deles?',
      },
      {
        role: 'assistant',
        content: 'Qual agendamento você quer cancelar? Informe data e horário.',
      },
    ],
  }),
  { ok: true }
);

const repeatedCurrentMessageHistory = [
  {
    role: 'assistant',
    content:
      'Você já tem outro agendamento futuro. Quer manter os dois, remarcar ou pensar?',
  },
  { role: 'user', content: 'remarcar' },
  { role: 'assistant', content: 'Vou verificar.' },
  { role: 'user', content: 'remarcar' },
];
assert.equal(
  priorUserSelectedDuplicateAction(repeatedCurrentMessageHistory, 1),
  false,
  'a ocorrência atual é excluída por posição e a repetição posterior não pode abri-la'
);
assert.equal(
  priorUserSelectedDuplicateAction(repeatedCurrentMessageHistory, 3),
  true,
  'uma escolha realmente anterior à posição atual continua reconhecida'
);

console.log(
  `✅ smoke booking confirmation gate: ${colloquialAcceptances.length} colloquial accepts, structured summaries, duplicate/cancellation guards, cross-turn expiry and single-use evidence`
);
