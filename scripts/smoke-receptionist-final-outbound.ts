import assert from 'node:assert/strict';
import {
  buildReceptionistEnvelope,
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
  outboundBlockHash,
  validateReceptionistOutbound,
} from '../src/services/receptionistOutbound';

const catalog = {
  services: [
    { id: 'svc-1', name: 'Limpeza de Pele', priceCents: 10000, durationMinutes: 60, professionalIds: ['pro-1'] },
    { id: 'svc-2', name: 'Tratamento Completo', priceCents: 123456, durationMinutes: 90, professionalIds: ['pro-1'] },
    { id: 'svc-3', name: 'Design com Henna', priceCents: 8000, durationMinutes: 45, professionalIds: ['pro-1'] },
  ],
  professionals: [
    { id: 'pro-1', name: 'Júlia', active: true },
    { id: 'pro-2', name: 'Luzia', active: true },
  ],
};
const validate = (blocks: any[], extra: any = {}) => validateReceptionistOutbound(buildReceptionistEnvelope({
  purpose: extra.purpose ?? 'REACTIVE', blocks, authoritativeCatalog: catalog, evidence: extra.evidence,
  ...(extra.exactPayload === undefined ? {} : { exactPayload: extra.exactPayload }),
}));

assert.equal(validate([{ source: 'GENERATED', text: 'A Limpeza de Pele custa R$ 100,00.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Fazemos sim! O serviço de Limpeza de Pele custa R$ 100,00.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'O Tratamento Completo custa R$ 1.234,56.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'O valor é 1.234,56 reais.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'O valor é R$ 1.234,57.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'O valor é 1.234,57 reais.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GREETING', text: 'Avaliação custa R$ 999,00.' }]).payload, '');
assert.equal(validate([{ source: 'POST_BOOKING', text: 'Cura garantida.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Temos 09:10 disponível.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Temos 09:10 disponível.' }], { evidence: { toolTrace: [{ name: 'getAvailableSlots', result: JSON.stringify({ success: true, slots: ['09:10'] }) }] } }).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Limpeza de Pele com Júlia.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Limpeza de Pele com Marina.' }]).originalAccepted, false);
assert.equal(
  validate(
    [{ source: 'GENERATED', text: 'Olá! Como posso ajudar?' }],
    { evidence: { sourceInboundText: 'saudações' } }
  ).originalAccepted,
  true
);
const vagueOperationalDrift = validate(
  [
    {
      source: 'GENERATED',
      text: 'A Juliana estará à sua espera no salão às dez para a drenagem.',
    },
  ],
  { evidence: { sourceInboundText: 'saudações' } }
);
assert.equal(vagueOperationalDrift.originalAccepted, false);
assert.ok(vagueOperationalDrift.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'));
assert.ok(vagueOperationalDrift.reasonCodes.includes('UNKNOWN_SERVICE'));
assert.ok(vagueOperationalDrift.reasonCodes.includes('UNKNOWN_PROFESSIONAL'));
for (const [sourceInboundText, reply] of [
  ['O que vocês fazem?', 'Trabalhamos com Limpeza de Pele.'],
  ['Quem atende aí?', 'A Júlia atende por aqui.'],
  ['Oi, pode me explicar melhor?', 'Claro! Temos Limpeza de Pele.'],
] as const) {
  assert.equal(
    validate([{ source: 'GENERATED', text: reply }], {
      evidence: { sourceInboundText },
    }).originalAccepted,
    true,
    sourceInboundText
  );
}
assert.equal(
  validate([{ source: 'GENERATED', text: 'Trabalhamos com Botox.' }], {
    evidence: { sourceInboundText: 'O que vocês fazem?' },
  }).originalAccepted,
  false
);
assert.equal(
  validate(
    [
      {
        source: 'GENERATED',
        text: 'A Juliana te recebe amanhã às 10h para Limpeza de Pele.',
      },
    ],
    { evidence: { sourceInboundText: 'Pode me explicar melhor?' } }
  ).originalAccepted,
  false
);
assert.equal(
  validate([
    {
      source: 'GENERATED',
      text: 'Temos Limpeza de Pele, Tratamento Completo e Design com Henna. Qual você prefere?',
    },
  ]).originalAccepted,
  true,
  'nome de serviço com "com X" não pode ser confundido com profissional'
);
assert.equal(validate([{ source: 'GENERATED', text: 'A equipe responde em 10 minutos.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'CPF 123.456.789-00.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Tudo certo 😊 🎉' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Vou te encaminhar.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Vou te encaminhar.' }], { evidence: { actionRecorded: true } }).originalAccepted, true);
const escalationPromise = 'Vou avisar a equipe responsável pelo atendimento.';
const unlicensedEscalation = validate([{ source: 'CANONICAL', text: escalationPromise }]);
assert.equal(unlicensedEscalation.originalAccepted, false);
assert.ok(unlicensedEscalation.reasonCodes.includes('UNRECORDED_HANDOFF'));
assert.equal(
  validate([{ source: 'CANONICAL', text: escalationPromise }], {
    evidence: { authoritativeEscalationQuestionId: 'question-authoritative-fixture' },
  }).originalAccepted,
  true,
  'questionId autoritativo licencia a copy canônica de escalada'
);
const namedEscalationPromise = 'Vou avisar Heloísa, responsável por este atendimento.';
const unlicensedNamedEscalation = validate([{ source: 'CANONICAL', text: namedEscalationPromise }]);
assert.equal(unlicensedNamedEscalation.originalAccepted, false);
assert.ok(unlicensedNamedEscalation.reasonCodes.includes('UNRECORDED_HANDOFF'));
assert.equal(
  validate([{ source: 'CANONICAL', text: namedEscalationPromise }], {
    evidence: { authoritativeEscalationQuestionId: 'question-authoritative-fixture' },
  }).originalAccepted,
  true,
  'questionId autoritativo licencia a copy com responsável nominal arbitrário'
);
assert.equal(
  validate([{ source: 'CANONICAL', text: 'Irei avisar Zoraide Nunes, responsável por este atendimento.' }]).originalAccepted,
  false,
  'irei avisar <nome arbitrário> sem questionId é UNRECORDED_HANDOFF'
);
assert.equal(
  validate([{ source: 'CANONICAL', text: 'Iremos avisar Heloísa, responsável por este atendimento.' }], {
    evidence: { authoritativeEscalationQuestionId: 'question-authoritative-fixture' },
  }).originalAccepted,
  true,
  'iremos avisar <nome arbitrário> com questionId atravessa'
);
assert.equal(
  validate(
    [{ source: 'CANONICAL', text: 'Não consigo responder isso com segurança por aqui. Você pode falar diretamente com a equipe do estabelecimento.' }],
  ).originalAccepted,
  true,
  'copy de indisponibilidade não é promessa de handoff'
);
assert.equal(validate([{ source: 'GENERATED', text: 'Cura garantida.' }]).originalAccepted, false);
const validTeamReply = 'Resposta da equipe:\nA avaliação da equipe indica que isso cura a condição.';
const validTeamResult = validate([{ source: 'TEAM_REPLY', text: validTeamReply }], { evidence: { teamReplyAuthorization: { authoredAt: new Date().toISOString(), authoredBy: 'user-id', questionId: 'question-id', clinicalCapability: true } } });
assert.equal(validTeamResult.originalAccepted, true);
assert.equal(validTeamResult.payload, validTeamReply);
assert.equal(validate([{ source: 'TEAM_REPLY', text: validTeamReply }]).originalAccepted, false);

const approvedText = 'A resposta aprovada afirma que o procedimento é eficaz.';
assert.equal(validate([{ source: 'APPROVED_RESPONSE', text: approvedText }], { evidence: { clinicalAuthorization: { blockHash: outboundBlockHash(approvedText), acceptedAt: new Date().toISOString(), acceptedBy: 'actor-id', detectedAssertions: ['EFFICACY'], clinicalCapability: true } } }).originalAccepted, true);
assert.equal(validate([{ source: 'APPROVED_RESPONSE', text: 'Cura por R$ 999,00.' }], { evidence: { clinicalAuthorization: { blockHash: outboundBlockHash('Cura por R$ 999,00.'), acceptedAt: new Date().toISOString(), acceptedBy: 'actor-id', detectedAssertions: ['CURE'], clinicalCapability: true } } }).originalAccepted, false);
assert.equal(validate([{ source: 'CANONICAL', text: 'Tudo certo.' }], { exactPayload: 'adulterado' }).originalAccepted, false);
const humanAudioMarker = validate([{ source: 'GENERATED', text: '[atendente] enviou um áudio' }]);
assert.equal(humanAudioMarker.originalAccepted, false);
assert.equal(humanAudioMarker.payload, '');
assert.ok(humanAudioMarker.reasonCodes.includes('INTERNAL_CONVERSATION_MARKER'));
for (const markerVariant of [
  'A atendente enviou um áudio.',
  'A atendente mandou uma mensagem de voz.',
]) {
  const markerResult = validate([{ source: 'GENERATED', text: markerVariant }]);
  assert.equal(markerResult.originalAccepted, false, markerVariant);
  assert.ok(markerResult.reasonCodes.includes('INTERNAL_CONVERSATION_MARKER'));
}

const unsafeIncidentReply = validate([
  {
    source: 'GENERATED',
    text: 'Só pra confirmar: você quer remarcar o pé com a Luzia para amanhã às 09h30, certo?',
  },
]);
assert.equal(unsafeIncidentReply.originalAccepted, false);
assert.equal(unsafeIncidentReply.payload, '');
assert.ok(
  unsafeIncidentReply.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT')
);

const formerFallback = validate([
  {
    source: 'GENERATED',
    text: 'Desculpe, não consegui responder com segurança agora. A equipe do estabelecimento pode ajudar por aqui.',
  },
]);
assert.equal(formerFallback.originalAccepted, false);
assert.ok(formerFallback.reasonCodes.includes('INTERNAL_CONVERSATION_MARKER'));
const decoratedFormerFallback = validate([
  {
    source: 'GENERATED',
    text: `${formerFallback.payload || 'Desculpe, não consegui responder com segurança agora. A equipe do estabelecimento pode ajudar por aqui.'} 😊`,
  },
]);
assert.equal(decoratedFormerFallback.originalAccepted, false);
assert.ok(decoratedFormerFallback.reasonCodes.includes('INTERNAL_CONVERSATION_MARKER'));

const identityTrace = {
  evidence: {
    toolTrace: [
      {
        name: 'getUpcomingAppointments',
        result: JSON.stringify({
          success: false,
          reason: 'customer_identity_ambiguous',
        }),
      },
    ],
  },
};
for (const unsafeIdentityReply of [
  'Parece que há dois cadastros no seu telefone. Qual deles é o seu?',
  'Seu telefone está duplicado. Me confirme seu nome completo.',
]) {
  const result = validate(
    [{ source: 'GENERATED', text: unsafeIdentityReply }],
    identityTrace
  );
  assert.equal(result.originalAccepted, false, unsafeIdentityReply);
  assert.ok(result.reasonCodes.includes('UNSAFE_CUSTOMER_IDENTITY_RESPONSE'));
}
assert.equal(
  validate(
    [{ source: 'GENERATED', text: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE }],
    identityTrace
  ).originalAccepted,
  true
);
assert.equal(
  validate(
    [
      {
        source: 'GENERATED',
        text: 'Perfeito, Limpeza de Pele. Qual dia e horário você prefere?',
      },
    ],
    {
      evidence: {
        sourceInboundText: 'Limpeza de Pele',
        pendingQuestion: {
          source: 'ANA',
          expectedSlot: 'SERVICE',
          listedServiceNames: ['Limpeza de Pele', 'Tratamento Completo', 'Design com Henna'],
          listedProfessionalNames: [],
          alreadyAskedConfirmation: false,
        },
        disableSocialContextDrift: true,
      },
    }
  ).originalAccepted,
  true,
  'pergunta pendente da Ana desliga só SOCIAL_CONTEXT_DRIFT'
);
console.log('smoke receptionist final outbound: OK');
