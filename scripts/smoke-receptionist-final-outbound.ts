import assert from 'node:assert/strict';
import {
  buildReceptionistEnvelope,
  classifyReceptionistOutboundAvailabilityClaims,
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
  outboundBlockHash,
  substantiveServiceOfferResidualV2,
  validateReceptionistOutbound,
} from '../src/services/receptionistOutbound';
import { classifyAvailabilityExistenceClaimsV2 } from '../src/services/availabilityClaimScope';
import {
  AVAILABILITY_CLAIM_MATRIX,
  UNKNOWN_AVAILABILITY_CLAIM,
} from './availability-claim-matrix';

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

assert.equal(AVAILABILITY_CLAIM_MATRIX.length, 34, 'matriz IA-26b tem 34 casos');

for (const [index, matrixCase] of AVAILABILITY_CLAIM_MATRIX.entries()) {
  assert.deepEqual(
    classifyReceptionistOutboundAvailabilityClaims(matrixCase.text),
    matrixCase.claims,
    `claims receptionistOutbound #${index + 1}: ${matrixCase.label}`
  );
  const result = validate([{ source: 'GENERATED', text: matrixCase.text }]);
  const requiresEvidence = !result.originalAccepted;
  assert.equal(
    requiresEvidence,
    matrixCase.requiresEvidence,
    `matriz receptionistOutbound #${index + 1}: ${matrixCase.label}`
  );
  console.log(
    `availability matrix receptionistOutbound #${index + 1}: ${requiresEvidence ? 'evidence_required' : 'no_offer'}`
  );
}

const availabilityEvidence = (slots: readonly string[]) => ({
  evidence: {
    toolTrace: [
      {
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots }),
      },
    ],
  },
});
const afterExistenceText = 'Tenho horário depois das 17:30.';
assert.deepEqual(
  classifyAvailabilityExistenceClaimsV2(afterExistenceText),
  [{ polarity: 'positive', constraint: { kind: 'after', time: '17:30' } }]
);
for (const testCase of [
  { label: 'Tenho after trace vazio', text: afterExistenceText, extra: {}, expectedAccepted: false },
  { label: 'Tenho after trace 18:00', text: afterExistenceText, extra: availabilityEvidence(['18:00']), expectedAccepted: true },
  { label: 'Tenho after trace 17:00', text: afterExistenceText, extra: availabilityEvidence(['17:00']), expectedAccepted: false },
  { label: 'Encontrei after trace vazio', text: 'Encontrei horários depois das 17:30.', extra: {}, expectedAccepted: false },
  { label: 'Tenho between trace vazio', text: 'Tenho horários entre 10:00 e 12:00.', extra: {}, expectedAccepted: false },
  { label: 'Tenho between trace 10:30', text: 'Tenho horários entre 10:00 e 12:00.', extra: availabilityEvidence(['10:30']), expectedAccepted: true },
  { label: 'Tenho between trace 13:00', text: 'Tenho horários entre 10:00 e 12:00.', extra: availabilityEvidence(['13:00']), expectedAccepted: false },
] as const) {
  const result = validate([{ source: 'GENERATED', text: testCase.text }], testCase.extra);
  assert.equal(
    result.originalAccepted,
    testCase.expectedAccepted,
    `bloqueante A receptionistOutbound: ${testCase.label}`
  );
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
    !testCase.expectedAccepted,
    `bloqueante A reason receptionistOutbound: ${testCase.label}`
  );
  console.log(`bloqueante A receptionistOutbound: ${testCase.label} -> ${testCase.expectedAccepted ? 'PASS' : 'BLOCK'}`);
}
const negativeExistenceText = 'Não encontrei horários depois das 17:30.';
assert.deepEqual(
  classifyAvailabilityExistenceClaimsV2(negativeExistenceText),
  [{ polarity: 'negative', constraint: { kind: 'after', time: '17:30' } }]
);
const negativeExistenceResult = validate([
  { source: 'GENERATED', text: negativeExistenceText },
]);
assert.equal(negativeExistenceResult.originalAccepted, true);
assert.equal(
  negativeExistenceResult.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false
);
assert.equal(
  classifyReceptionistOutboundAvailabilityClaims(negativeExistenceText)[0]?.disposition,
  'non_availability_reference',
  'A: a negativa não transforma 17:30 em slot ofertado'
);
console.log('bloqueante A receptionistOutbound: negativa after -> PASS sem slot ofertado');

const surfaceFirstExistenceGate = [
  {
    label: 'Consigo after trace vazio',
    text: 'Consigo horário depois das 17:30.',
    extra: {},
    expectedClaims: [
      { polarity: 'unknown', constraint: { kind: 'after', time: '17:30' } },
    ],
    expectedAccepted: false,
    expectedAvailabilityBlocked: true,
  },
  {
    label: 'Consigo after trace 18:00',
    text: 'Consigo horário depois das 17:30.',
    extra: availabilityEvidence(['18:00']),
    expectedClaims: [
      { polarity: 'unknown', constraint: { kind: 'after', time: '17:30' } },
    ],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'Consigo after trace 17:00',
    text: 'Consigo horário depois das 17:30.',
    extra: availabilityEvidence(['17:00']),
    expectedClaims: [
      { polarity: 'unknown', constraint: { kind: 'after', time: '17:30' } },
    ],
    expectedAccepted: false,
    expectedAvailabilityBlocked: true,
  },
  {
    label: 'Talvez role vaga after trace vazio',
    text: 'Talvez role uma vaga depois das 17:30.',
    extra: {},
    expectedClaims: [
      { polarity: 'unknown', constraint: { kind: 'after', time: '17:30' } },
    ],
    expectedAccepted: false,
    expectedAvailabilityBlocked: true,
  },
  {
    label: 'Não consigo after trace vazio',
    text: 'Não consigo horário depois das 17:30.',
    extra: {},
    expectedClaims: [
      { polarity: 'unknown', constraint: { kind: 'after', time: '17:30' } },
    ],
    expectedAccepted: false,
    expectedAvailabilityBlocked: true,
  },
  {
    label: 'pedido do cliente não cria existência',
    text: 'Você pediu horário depois das 17:30.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'pergunta de preferência não cria existência',
    text: 'Prefere um horário depois das 17:30?',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'horário de funcionamento não cria existência',
    text: 'Nosso horário de funcionamento vai até 20:00.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'agendamento do cliente não cria existência',
    text: 'Seu agendamento era às 17:30.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: false,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'responder depois não cria existência',
    text: 'Vou responder depois das 17:30.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'preferir falar depois não cria existência',
    text: 'Prefiro falar depois das 17:30.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
  {
    label: 'procedimento terminar depois não cria existência',
    text: 'O procedimento termina depois das 17:30.',
    extra: {},
    expectedClaims: [],
    expectedAccepted: true,
    expectedAvailabilityBlocked: false,
  },
];
for (const testCase of surfaceFirstExistenceGate) {
  assert.deepEqual(
    classifyAvailabilityExistenceClaimsV2(testCase.text),
    testCase.expectedClaims,
    `surface-first existence receptionistOutbound: ${testCase.label}`
  );
  const result = validate(
    [{ source: 'GENERATED', text: testCase.text }],
    testCase.extra
  );
  assert.equal(
    result.originalAccepted,
    testCase.expectedAccepted,
    `surface-first gate receptionistOutbound: ${testCase.label}`
  );
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
    testCase.expectedAvailabilityBlocked,
    `surface-first reason receptionistOutbound: ${testCase.label}`
  );
  console.log(
    `surface-first receptionistOutbound: ${testCase.label} -> ${testCase.expectedAvailabilityBlocked ? 'BLOCK' : testCase.expectedAccepted ? 'PASS' : 'OTHER-GUARD'}`
  );
}

assert.equal(substantiveServiceOfferResidualV2('Botox às 10:00'), 'botox');
assert.equal(substantiveServiceOfferResidualV2('hoje às 10:00'), '');
assert.equal(substantiveServiceOfferResidualV2('10:00'), '');
const unknownServiceVerified = validate(
  [{ source: 'GENERATED', text: 'Temos Botox às 10:00.' }],
  availabilityEvidence(['10:00'])
);
assert.equal(unknownServiceVerified.originalAccepted, false);
assert.equal(unknownServiceVerified.reasonCodes.includes('UNKNOWN_SERVICE'), true);
assert.equal(
  unknownServiceVerified.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false
);
console.log('bloqueante B: Botox + 10:00 verificado -> UNKNOWN_SERVICE');
const unknownServiceUnverified = validate([
  { source: 'GENERATED', text: 'Temos Botox às 10:00.' },
]);
assert.equal(unknownServiceUnverified.originalAccepted, false);
assert.equal(unknownServiceUnverified.reasonCodes.includes('UNKNOWN_SERVICE'), true);
assert.equal(
  unknownServiceUnverified.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  true
);
console.log('bloqueante B: Botox + trace vazio -> UNKNOWN_SERVICE + UNVERIFIED_AVAILABILITY');
for (const temporalOnly of ['Temos hoje às 10:00.', 'Temos 10:00.'] as const) {
  const result = validate(
    [{ source: 'GENERATED', text: temporalOnly }],
    availabilityEvidence(['10:00'])
  );
  assert.equal(result.originalAccepted, true, temporalOnly);
  assert.equal(result.reasonCodes.includes('UNKNOWN_SERVICE'), false, temporalOnly);
  console.log(`bloqueante B: ${temporalOnly} -> PASS sem UNKNOWN_SERVICE`);
}

for (const exclusion of [
  {
    text: 'depois das 17:30',
    time: '17:30',
    rawToken: '17:30',
    exclusionReason: 'customer_constraint' as const,
  },
  {
    text: 'fechamos às 20h',
    time: '20:00',
    rawToken: '20h',
    exclusionReason: 'business_hours' as const,
  },
]) {
  const claims = classifyReceptionistOutboundAvailabilityClaims(exclusion.text);
  assert.deepEqual(
    claims,
    [
      {
        time: exclusion.time,
        span: {
          start: exclusion.text.indexOf(exclusion.rawToken),
          end:
            exclusion.text.indexOf(exclusion.rawToken) +
            exclusion.rawToken.length,
        },
        disposition: 'non_availability_reference',
        source: 'explicit_exclusion',
        exclusionReason: exclusion.exclusionReason,
      },
    ],
    `exclusão tipada preserva a menção no outbound: ${exclusion.text}`
  );
  assert.equal(
    validate([{ source: 'GENERATED', text: exclusion.text }]).originalAccepted,
    true,
    `exclusão tipada não gera UNVERIFIED_AVAILABILITY: ${exclusion.text}`
  );
}

const exclusionDoesNotInherit = 'Fechamos às 20:00 e 18:00.';
assert.deepEqual(
  classifyReceptionistOutboundAvailabilityClaims(exclusionDoesNotInherit),
  [
    {
      time: '20:00',
      span: { start: 12, end: 17 },
      disposition: 'non_availability_reference',
      source: 'explicit_exclusion',
      exclusionReason: 'business_hours',
    },
    {
      time: '18:00',
      span: { start: 20, end: 25 },
      disposition: 'unknown',
      source: 'unclassified',
    },
  ],
  'exclusão tipada nunca se propaga por coordenação no outbound'
);
const exclusionDoesNotInheritResult = validate([
  { source: 'GENERATED', text: exclusionDoesNotInherit },
]);
assert.ok(
  exclusionDoesNotInheritResult.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  'horário coordenado sem governança própria continua evidence_required no outbound'
);
const constrainedRangeWithOffer = 'Entre 10:00 e 10:30 eu tenho 10:15';
assert.deepEqual(
  classifyReceptionistOutboundAvailabilityClaims(constrainedRangeWithOffer),
  [
    {
      time: '10:00',
      span: { start: 6, end: 11 },
      disposition: 'non_availability_reference',
      source: 'explicit_exclusion',
      exclusionReason: 'customer_constraint',
    },
    {
      time: '10:30',
      span: { start: 14, end: 19 },
      disposition: 'non_availability_reference',
      source: 'explicit_exclusion',
      exclusionReason: 'customer_constraint',
    },
    {
      time: '10:15',
      span: { start: 29, end: 34 },
      disposition: 'positive_availability',
      source: 'predicate_before',
    },
  ],
  'faixa de restrição continua local e a oferta posterior permanece positiva no outbound'
);
assert.ok(
  validate([{ source: 'GENERATED', text: constrainedRangeWithOffer }]).reasonCodes.includes(
    'UNVERIFIED_AVAILABILITY'
  ),
  'oferta dentro de uma frase com faixa de restrição continua evidence_required no outbound'
);
for (const pureExclusion of [
  {
    text: 'Você pediu depois das 17:30.',
    claim: {
      time: '17:30',
      span: { start: 22, end: 27 },
      disposition: 'non_availability_reference' as const,
      source: 'explicit_exclusion' as const,
      exclusionReason: 'customer_constraint' as const,
    },
  },
  {
    text: 'Não encontrei nada depois das 17:30.',
    claim: {
      time: '17:30',
      span: { start: 30, end: 35 },
      disposition: 'non_availability_reference' as const,
      source: 'explicit_exclusion' as const,
      exclusionReason: 'customer_constraint' as const,
    },
  },
  {
    text: 'Funcionamos até 20:00.',
    claim: {
      time: '20:00',
      span: { start: 16, end: 21 },
      disposition: 'non_availability_reference' as const,
      source: 'explicit_exclusion' as const,
      exclusionReason: 'business_hours' as const,
    },
  },
  {
    text: 'Seu agendamento anterior era às 10:00.',
    claim: {
      time: '10:00',
      span: { start: 32, end: 37 },
      disposition: 'non_availability_reference' as const,
      source: 'explicit_exclusion' as const,
      exclusionReason: 'appointment_context' as const,
    },
  },
] as const) {
  assert.deepEqual(
    classifyReceptionistOutboundAvailabilityClaims(pureExclusion.text),
    [pureExclusion.claim],
    `negativa pura tipada permanece visível no outbound: ${pureExclusion.text}`
  );
  const pureExclusionResult = validate([
    { source: 'GENERATED', text: pureExclusion.text },
  ]);
  assert.equal(
    pureExclusionResult.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
    false,
    `negativa pura não exige prova de disponibilidade no outbound: ${pureExclusion.text}`
  );
}

assert.deepEqual(
  classifyReceptionistOutboundAvailabilityClaims(UNKNOWN_AVAILABILITY_CLAIM.text),
  UNKNOWN_AVAILABILITY_CLAIM.claims,
  'unknown availability claim remains visible in the shared classifier'
);
const unknownAvailabilityResult = validate([
  { source: 'GENERATED', text: UNKNOWN_AVAILABILITY_CLAIM.text },
]);
assert.ok(
  unknownAvailabilityResult.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  'unknown availability claim falls to evidence_required'
);
const mixedNegativeLater = AVAILABILITY_CLAIM_MATRIX.find(
  (matrixCase) => matrixCase.label === 'positive then negative result lead'
)!;
assert.equal(
  validate(
    [{ source: 'GENERATED', text: mixedNegativeLater.text }],
    { evidence: { verifiedAvailabilitySlots: ['10:00'] } }
  ).originalAccepted,
  true,
  'evidence for the positive earlier time is not suppressed by a later negative time'
);

console.log('smoke receptionist final outbound: OK');
