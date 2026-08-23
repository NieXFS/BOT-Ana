import assert from 'node:assert/strict';
import type { ServicesResult } from '../src/services/calendarService';
import {
  UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2,
  classifyReceptionistTurnPermissionV2,
  evaluateBoundaryV2,
  isCatalogOnlyServiceOfferSpanV2,
  isV2BusinessHoursInformationRequest,
  isLicensedPreBookingSummaryV2,
  isTemporalOnlyServiceOfferSpanV2,
  shouldProhibitServiceRelistV2,
} from '../src/services/conversationalV2/boundary';
import {
  materializeServiceClarificationV2,
  materializeServiceListCopyV2,
  SERVICE_LIST_TRANSPORT_CEILING_V2,
} from '../src/services/conversationalV2/serviceList';
import { EMPTY_OPEN_SERVICE_CLARIFICATION_V2 } from '../src/services/conversationalV2/recoveryCoordinator';
import { hasPositiveClauseMatchV2 } from '../src/services/conversationalV2/polarity';
import { normalizeTemporalAssertionsV2 } from '../src/services/conversationalV2/temporalNormalizer';
import { classifyReceptionistTurnPermission } from '../src/services/receptionistSocialSafety';

const servicesResult: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-marina'],
    },
  ],
  professionals: [
    { id: 'prof-julia', name: 'Júlia' },
    { id: 'prof-marina', name: 'Marina' },
  ],
};
const flowState = {
  flowId: 'flow-v2',
  fixedServiceId: 'svc-peeling',
  fixedByProofVersion: { fixedServiceId: 1 },
};

const r8Inbound = 'obrigada!! e amanhã tem horário pra drenagem?';
const r8Accepted = boundary(
  'Obrigada! Amanhã há horários para Drenagem às 09:00 e 15:00. Qual você prefere?',
  {
    route: 'model',
    replyPurpose: 'DATE_TIME_QUESTION',
    sourceInboundText: r8Inbound,
    inboundTextsById: { 'in-current': r8Inbound },
    toolTrace: [
      {
        round: 1,
        name: 'getAvailableSlots',
        args: { date: '2026-08-14', serviceId: 'svc-drenagem' },
        argumentsValidJson: true,
        result: JSON.stringify({ success: true, slots: ['09:00', '15:00'] }),
      },
    ],
  }
);
assert.equal(r8Accepted.safe, true);
assert.equal(r8Accepted.originalAccepted, true);
assert.equal(
  r8Accepted.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'),
  false,
  'R8 misto com operação e evidência descarta drift herdado'
);
assert.match(r8Accepted.acceptedPayload, /Obrigada!/);

for (const inbound of [
  'vocês atendem sábado?',
  'funciona sábado?',
  'que horas abre?',
  'que horas fecha?',
  'atendem no feriado?',
]) {
  assert.equal(
    classifyReceptionistTurnPermissionV2(inbound, servicesResult),
    'INFORMATION_REQUEST',
    `overlay v2 licencia funcionamento: ${inbound}`
  );
}
assert.equal(
  classifyReceptionistTurnPermission('vocês atendem sábado?'),
  'NO_OPERATIONAL_INTENT',
  'classificador compartilhado/v1 permanece intocado'
);
const saturdayInformation = boundary('Sim, atendemos aos sábados.', {
  route: 'model',
  replyPurpose: 'OPERATIONAL_ANSWER',
  sourceInboundText: 'vocês atendem sábado?',
  inboundTextsById: { 'in-current': 'vocês atendem sábado?' },
  flowState: { flowId: 'flow-hours', fixedByProofVersion: {} },
});
assert.equal(
  saturdayInformation.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'),
  false,
  'R10.1: resposta legítima de funcionamento não herda drift na v2'
);
assert.equal(
  classifyReceptionistTurnPermissionV2(
    'sábado tem festa da minha filha',
    servicesResult
  ),
  'NO_OPERATIONAL_INTENT',
  'menção pessoal de sábado não ganha permissão informacional'
);
assert.equal(
  isV2BusinessHoursInformationRequest('minha irmã atende sábado?'),
  false,
  'A1: sujeito de terceira pessoa não é o estabelecimento'
);
assert.equal(
  isV2BusinessHoursInformationRequest('que horas minha irmã atende sábado?'),
  false,
  'A1: prefixo interrogativo não apaga sujeito explícito de terceira pessoa'
);
assert.equal(
  isV2BusinessHoursInformationRequest('o peeling funciona?'),
  false,
  'A1: eficácia de procedimento não é expediente'
);
assert.equal(
  isV2BusinessHoursInformationRequest('que horas o peeling funciona?'),
  false,
  'A1: prefixo interrogativo não transforma procedimento em estabelecimento'
);
assert.equal(
  isV2BusinessHoursInformationRequest('a clínica atende no feriado?'),
  true,
  'A1: sujeito explícito do estabelecimento é aceito'
);
assert.equal(
  isV2BusinessHoursInformationRequest('vocês vão atender sábado?'),
  true,
  'A1: auxiliar com infinitivo preserva o sujeito do estabelecimento'
);
assert.equal(
  isV2BusinessHoursInformationRequest('qual o horário de atendimento?'),
  true,
  'A1: expediente nominal admite estabelecimento elíptico'
);
assert.equal(
  isV2BusinessHoursInformationRequest('qual o expediente da minha irmã?'),
  false,
  'A1: expediente nominal de terceira pessoa permanece excluído'
);
assert.equal(
  isV2BusinessHoursInformationRequest('vocês atendem sábado'),
  false,
  'A1: declaração sem forma interrogativa não ativa o overlay'
);

const personalInbound = 'amanhã é aniversário da minha filha';
const personalAgendaPush = boundary('Que legal! Quer aproveitar e marcar um horário?', {
  route: 'model',
  replyPurpose: 'SERVICE_QUESTION',
  sourceInboundText: personalInbound,
  inboundTextsById: { 'in-current': personalInbound },
  flowState: { flowId: 'flow-personal', fixedByProofVersion: {} },
});
assert.equal(
  personalAgendaPush.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'),
  true,
  'papo pessoal continua protegido contra empurrão de agenda'
);

const personalWarm = boundary('Que momento especial! Espero que seja um dia lindo para vocês 💛', {
  route: 'model',
  replyPurpose: 'SOCIAL',
  sourceInboundText: personalInbound,
  inboundTextsById: { 'in-current': personalInbound },
  flowState: { flowId: 'flow-personal', fixedByProofVersion: {} },
});
assert.equal(personalWarm.safe, true);
assert.equal(personalWarm.originalAccepted, true);

const catalogSocialInbound = 'kkk drenajem';
const catalogSocial = boundary('Temos Drenagem. Quer escolher uma data?', {
  route: 'model',
  replyPurpose: 'DATE_TIME_QUESTION',
  sourceInboundText: catalogSocialInbound,
  inboundTextsById: { 'in-current': catalogSocialInbound },
  flowState: { flowId: 'flow-catalog-social', fixedByProofVersion: {} },
});
assert.equal(
  catalogSocial.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'),
  true,
  'K4: entidade de catálogo não desarma drift em permissão social-only'
);

function spanFor(text: string, fragment: string) {
  const points = Array.from(text);
  const fragmentPoints = Array.from(fragment);
  const start = points.join('').indexOf(fragment);
  assert.notEqual(start, -1);
  // As fixtures abaixo são ASCII antes do fragmento; o cálculo explícito por
  // code points evita tornar essa suposição parte do código de produção.
  const codePointStart = Array.from(text.slice(0, start)).length;
  return { start: codePointStart, end: codePointStart + fragmentPoints.length };
}

function boundary(
  rawCandidate: string,
  extra: Record<string, unknown> = {}
) {
  return evaluateBoundaryV2({
    rawCandidate,
    servicesResult,
    flowState,
    pendingTransitionCandidate: { kind: 'preserve' },
    sourceInboundText: 'Quero agendar',
    currentInboundIds: ['in-current'],
    inboundTextsById: { 'in-current': 'Quero agendar' },
    ...extra,
  });
}

const offerMatcher = /\b(?:temos?|oferecemos?|fazemos?|realizamos?)\s+([^.!?]+)/gu;
assert.equal(hasPositiveClauseMatchV2('Não fazemos Botox.', offerMatcher), false);
assert.equal(
  hasPositiveClauseMatchV2('Não fazemos laser, mas fazemos Botox.', offerMatcher),
  true
);

const negatedOffer = boundary('Não fazemos Botox.');
assert.equal(negatedOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'), false);
assert.equal(
  negatedOffer.reasonCodes.includes('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'),
  true
);

const noSpan = boundary(UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2);
assert.equal(
  noSpan.reasonCodes.includes('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'),
  true
);
const denajemInbound = 'Vocês fazem denajem?';
const denajemDenial = boundary(UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2, {
  sourceInboundText: denajemInbound,
  inboundTextsById: { 'in-current': denajemInbound },
  unknownServiceEvidence: {
    inboundId: 'in-current',
    ...spanFor(denajemInbound, 'denajem'),
  },
});
assert.equal(
  denajemDenial.reasonCodes.includes('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'),
  true,
  'D: denajem resolve Drenagem e não licencia denial de serviço ausente'
);

for (const generic of ['retorno', 'unidade']) {
  const inbound = `Quero ${generic}`;
  const result = boundary(UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2, {
    sourceInboundText: inbound,
    inboundTextsById: { 'in-current': inbound },
    unknownServiceEvidence: {
      inboundId: 'in-current',
      span: spanFor(inbound, generic),
    },
  });
  assert.equal(
    result.reasonCodes.includes('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'),
    true,
    generic
  );
}

for (const catalogSignal of ['peeling', 'drenajem']) {
  const inbound = `Quero ${catalogSignal}`;
  const result = boundary(UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2, {
    sourceInboundText: inbound,
    inboundTextsById: { 'in-current': inbound },
    unknownServiceEvidence: {
      inboundId: 'in-current',
      span: spanFor(inbound, catalogSignal),
    },
  });
  assert.equal(
    result.reasonCodes.includes('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'),
    true,
    `${catalogSignal} deve continuar no modelo, nunca licenciar negação`
  );
}

const unknownInbound = 'Quero fazer botox';
const licensedDenial = boundary(UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2, {
  sourceInboundText: unknownInbound,
  inboundTextsById: { 'in-current': unknownInbound },
  unknownServiceEvidence: {
    inboundId: 'in-current',
    span: spanFor(unknownInbound, 'botox'),
  },
});
assert.equal(licensedDenial.safe, true);
assert.equal(licensedDenial.acceptedPayload, UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2);

const positiveOffer = boundary('Fazemos Botox e podemos agendar.');
assert.equal(positiveOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'), true);

assert.equal(
  isTemporalOnlyServiceOfferSpanV2(
    'horários às 14h, 15h e 17h',
    new Set(['14:00', '15:00', '17:00'])
  ),
  true,
  'lista canônica de horários não é entidade de serviço'
);
assert.equal(
  isTemporalOnlyServiceOfferSpanV2('drenagem a vapor'),
  false,
  'token substantivo residual impede a exceção temporal'
);
const exactR23Regression = boundary(
  'Para quinta-feira à tarde temos horários às 14h, 15h e 17h. Qual prefere?',
  {
    toolTrace: [
      {
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots: ['14:00', '15:00', '17:00'] }),
      },
    ],
  }
);
assert.equal(
  exactR23Regression.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  false,
  'texto exato do reject real R2.3 descarta falso serviço temporal'
);
assert.equal(exactR23Regression.safe, true, exactR23Regression.reasonCodes.join(','));

const realUnknownServiceVariant = boundary('Temos drenagem a vapor.');
assert.equal(
  realUnknownServiceVariant.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  true,
  'serviço composto inexistente não é licenciado pelo prefixo Drenagem'
);
const typoEchoOffer = boundary('Boa tarde! Sim, fazemos drenajem. Qual dia você prefere?');
assert.equal(
  typoEchoOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  false,
  'eco de typo resolvido univocamente pelo matcher canônico não vira oferta desconhecida'
);
const canaryDistanceTwoEchoInbound = 'Vocês fazem denajem?';
const canaryDistanceTwoEcho = boundary('Sim, fazemos denajem.', {
  sourceInboundText: canaryDistanceTwoEchoInbound,
  inboundTextsById: { 'in-current': canaryDistanceTwoEchoInbound },
});
assert.equal(
  canaryDistanceTwoEcho.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  false,
  'D: denajem resolve Drenagem pelo matcher compartilhado restrito'
);
const canaryEchoWithUnknownRemainder = boundary(
  'Sim, fazemos denajem a vapor.',
  {
    sourceInboundText: canaryDistanceTwoEchoInbound,
    inboundTextsById: { 'in-current': canaryDistanceTwoEchoInbound },
  }
);
assert.equal(
  canaryEchoWithUnknownRemainder.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  true,
  'D: modificador substantivo fora do catálogo continua bloqueado'
);
for (const [label, inbound] of [
  ['C-1 afirmação ecoada', 'Eu faço botox em casa.'],
  ['C-3 pergunta ecoada', 'Vocês fazem botox?'],
] as const) {
  const echoedUnknown = boundary('Sim, fazemos botox.', {
    sourceInboundText: inbound,
    inboundTextsById: { 'in-current': inbound },
  });
  assert.equal(
    echoedUnknown.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
    true,
    `${label}: inbound não entra no perdão C*`
  );
}
const closedResidualCatalog = {
  services: [
    { id: 'svc-drenagem-cstar', name: 'Drenagem' },
    { id: 'svc-denajem-other', name: 'Denajem Terapia' },
  ],
  professionals: [],
};
assert.equal(
  isCatalogOnlyServiceOfferSpanV2(
    'Drenagem denajem',
    closedResidualCatalog
  ),
  false,
  'C-2: canônico de Drenagem não lava token canônico de outra entidade'
);
assert.equal(
  isCatalogOnlyServiceOfferSpanV2(
    'Drenagem denajem',
    {
      services: [{ id: 'svc-drenagem-cstar', name: 'Drenagem' }],
      professionals: [],
    }
  ),
  true,
  'C*: E prévio e bola fechada permitem somente o resíduo restrito'
);
const enumerationServices: ServicesResult = {
  ...servicesResult,
  services: [
    {
      id: 'svc-drenagem-enum',
      name: 'Drenagem linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla-enum'],
    },
    {
      id: 'svc-limpeza-enum',
      name: 'Limpeza de pele profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-carla-enum'],
    },
    {
      id: 'svc-peeling-enum',
      name: 'Peeling facial',
      durationMinutes: 45,
      price: 140,
      priceFormatted: 'R$ 140,00',
      professionalIds: ['prof-carla-enum'],
    },
  ],
  professionals: [{ id: 'prof-carla-enum', name: 'Carla Mendes' }],
};
const realR41FaithfulOffer = boundary(
  'Boa tarde! Sim, fazemos drenagem linfática, que dura 50 minutos e custa R$ 160,00. Gostaria de agendar?',
  { servicesResult: enumerationServices }
);
assert.equal(
  realR41FaithfulOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  false,
  'R4.1 real: oração relativa de duração/preço não vira resíduo do nome'
);
assert.equal(
  realR41FaithfulOffer.safe,
  true,
  `R4.1 real fiel ao catálogo deve atravessar: ${realR41FaithfulOffer.reasonCodes.join(',')}`
);
const pricedUnknownServiceR41 = boundary(
  'Fazemos drenagem a vapor por R$ 90,00.',
  { servicesResult: enumerationServices }
);
assert.equal(
  pricedUnknownServiceR41.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  true,
  'preço removido da cauda não lava o modificador desconhecido a vapor'
);
for (const knownCatalogSequence of [
  'Fazemos drenajem e posso te ajudar a agendar.',
  'Temos Drenagem, Limpeza e Peeling.',
  'Temos Drenagem linfática, Limpeza de pele profunda e Peeling facial, quer agendar?',
  'Claro, fazemos Peeling, sim.',
  'Boa tarde! Sim, fazemos drenagem linfática (50min, R$ 160,00). Gostaria de agendar?',
  'Temos sim! Peeling facial, 45 minutos, R$ 140, com a Carla Mendes. Quer agendar?',
  'Temos sim! Peeling facial é com a Carla Mendes, 45 minutos, R$ 140. Qual dia você prefere?',
]) {
  const knownOffer = boundary(knownCatalogSequence, {
    servicesResult: enumerationServices,
  });
  assert.equal(
    knownOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
    false,
    `lista/adjunto composto só de catálogo não vira serviço desconhecido: ${knownCatalogSequence}`
  );
}
for (const unknownCatalogSequence of [
  'Temos Drenagem linfática, Limpeza de pele profunda e Drenagem a vapor.',
  'Temos Drenagem linfática, Limpeza de pele profunda e Ozonioterapia, quer agendar?',
]) {
  const unknownOffer = boundary(unknownCatalogSequence, {
    servicesResult: enumerationServices,
  });
  assert.equal(
    unknownOffer.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
    true,
    `item desconhecido na enumeração continua bloqueado: ${unknownCatalogSequence}`
  );
}
const temporalPlusUnknownClaim = boundary(
  'Temos horários às 14h. Seu agendamento é para a drenagem a vapor.',
  {
    toolTrace: [
      {
        name: 'getAvailableSlots',
        result: JSON.stringify({ success: true, slots: ['14:00'] }),
      },
    ],
  }
);
assert.equal(
  temporalPlusUnknownClaim.reasonCodes.includes('UNKNOWN_SERVICE_OFFER'),
  true,
  'oferta temporal não apaga outro claim de serviço desconhecido'
);

for (const candidate of [
  'Tem vaga amanhã.',
  'Tem horário amanhã.',
  'Está cheio hoje.',
  'Tem espaço na agenda.',
  'A agenda está cheia.',
]) {
  const result = boundary(candidate);
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
    true,
    candidate
  );
}
const licensedAvailability = boundary('Tem vaga amanhã.', {
  toolTrace: [
    {
      name: 'getAvailableSlots',
      result: JSON.stringify({ success: true, slots: ['09:00'] }),
    },
  ],
});
assert.equal(
  licensedAvailability.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false
);
const contradictoryAvailability = boundary('Tem vaga amanhã.', {
  toolTrace: [
    {
      name: 'getAvailableSlots',
      result: JSON.stringify({ success: true, slots: [] }),
    },
  ],
});
assert.equal(
  contradictoryAvailability.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  true
);
const licensedOccupied = boundary('A agenda está cheia.', {
  toolTrace: [
    {
      name: 'getAvailableSlots',
      result: JSON.stringify({ success: true, slots: [] }),
    },
  ],
});
assert.equal(
  licensedOccupied.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false
);

const implicitCommitment = boundary('Te aguardo às oito amanhã.');
assert.equal(
  implicitCommitment.reasonCodes.includes('UNVERIFIED_IMPLICIT_COMMITMENT'),
  true
);
const licensedCommitment = boundary('Te aguardo às oito amanhã.', {
  toolTrace: [
    {
      name: 'bookAppointment',
      result: JSON.stringify({ success: true }),
    },
  ],
});
assert.equal(
  licensedCommitment.reasonCodes.includes('UNVERIFIED_IMPLICIT_COMMITMENT'),
  false
);

const incompatibleProfessional = boundary('A Marina vai te atender.');
assert.equal(
  incompatibleProfessional.reasonCodes.includes('INELIGIBLE_PROFESSIONAL'),
  true
);

const preBookingServices: ServicesResult = {
  ...servicesResult,
  services: [
    ...(servicesResult.services ?? []),
    {
      id: 'svc-limpeza',
      name: 'Limpeza de pele profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [
    ...(servicesResult.professionals ?? []),
    { id: 'prof-carla', name: 'Carla Mendes' },
  ],
};
const cleaningFlowState = {
  flowId: 'flow-pre-booking',
  fixedServiceId: 'svc-limpeza',
  fixedProfessionalId: 'prof-carla',
  resolvedDate: '2026-08-13',
  fixedByProofVersion: { fixedServiceId: 2, fixedProfessionalId: 2 },
};
const slotEvidence = [
  {
    name: 'getAvailableSlots',
    result: JSON.stringify({ success: true, slots: ['14:00', '15:00', '17:00'] }),
  },
];
const exactR24Text =
  'Ótimo, tenho horário às 15h disponível hoje. Confirmando: Limpeza de pele profunda, hoje (quinta, 13/08) às 15h, com a Carla. Posso marcar?';
const exactR24Regression = boundary(exactR24Text, {
  servicesResult: preBookingServices,
  flowState: cleaningFlowState,
  sourceInboundText: 'pode ser às 15h',
  inboundTextsById: { 'in-current': 'pode ser às 15h' },
  toolTrace: slotEvidence,
  temporalContext: { now: new Date('2026-08-13T12:00:00.000Z'), timezone: 'America/Sao_Paulo' },
  pendingTransitionCandidate: {
    kind: 'open',
    pendingKind: 'CONFIRMATION',
    flowId: cleaningFlowState.flowId,
    optionEntityIds: ['confirm-booking'],
  },
});
assert.equal(
  exactR24Regression.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  false,
  'texto exato do reject real R2.4 é resumo pré-booking licenciado'
);
assert.equal(exactR24Regression.safe, true, exactR24Regression.reasonCodes.join(','));
assert.equal(
  isLicensedPreBookingSummaryV2(exactR24Text, {
    rawCandidate: exactR24Text,
    servicesResult: preBookingServices,
    flowState: cleaningFlowState,
    sourceInboundText: 'pode ser às 15h',
    toolTrace: slotEvidence,
    temporalContext: { now: new Date('2026-08-13T12:00:00.000Z'), timezone: 'America/Sao_Paulo' },
  }),
  true
);

const chosenTimeWithoutRead = boundary(
  'Confirmando: Limpeza de pele profunda, hoje às 15h, com a Carla. Podemos confirmar?',
  {
    servicesResult: preBookingServices,
    flowState: cleaningFlowState,
    sourceInboundText: 'pode ser às 15h',
    inboundTextsById: { 'in-current': 'pode ser às 15h' },
    toolTrace: [],
  }
);
assert.equal(
  chosenTimeWithoutRead.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  true,
  'K3: horário escolhido sem leitura é contraprova e não licencia resumo'
);

const crossTurnTimeFlowState = {
  ...cleaningFlowState,
  slotEvidence: {
    turnId: 'turn-that-opened-time',
    serviceId: 'svc-limpeza',
    professionalId: 'prof-carla',
    date: '2026-08-13',
    slots: ['14:00', '15:00', '17:00'],
  },
  fixedByProofVersion: {
    ...cleaningFlowState.fixedByProofVersion,
    resolvedDate: 3,
  },
};
const crossTurnTimePending = {
  questionId: 'question-time-cross-turn',
  askedAt: '2026-08-13T11:55:00.000Z',
  kind: 'TIME' as const,
  flowId: cleaningFlowState.flowId,
  version: 4,
  options: [
    { position: 1, entityId: '14:00', displayName: '14:00' },
    { position: 2, entityId: '15:00', displayName: '15:00' },
    { position: 3, entityId: '17:00', displayName: '17:00' },
  ],
};
const crossTurnSummary = boundary(
  'Ótimo, tenho horário às 17h disponível hoje. Confirmando: Limpeza de pele profunda, hoje às 17h, com a Carla. Posso marcar?',
  {
    servicesResult: preBookingServices,
    flowState: crossTurnTimeFlowState,
    sourceInboundText: '17',
    inboundTextsById: { 'in-current': '17' },
    toolTrace: [],
    pendingAnaOpen: true,
    pendingSnapshot: crossTurnTimePending,
    temporalContext: {
      now: new Date('2026-08-13T12:00:00.000Z'),
      timezone: 'America/Sao_Paulo',
    },
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'CONFIRMATION',
      flowId: cleaningFlowState.flowId,
      optionEntityIds: [`booking-confirmation:${cleaningFlowState.flowId}`],
    },
  }
);
assert.equal(
  crossTurnSummary.safe,
  true,
  `TIME OPEN entregue licencia seu próprio slot: ${crossTurnSummary.reasonCodes.join(',')}`
);
assert.equal(
  crossTurnSummary.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false
);
assert.equal(
  crossTurnSummary.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  false
);

const crossTurnOutsideOptions = boundary(
  'Tenho horário às 16h disponível hoje. Confirmando: Limpeza de pele profunda, hoje às 16h, com a Carla. Posso marcar?',
  {
    servicesResult: preBookingServices,
    flowState: crossTurnTimeFlowState,
    sourceInboundText: '16',
    inboundTextsById: { 'in-current': '16' },
    toolTrace: [],
    pendingAnaOpen: true,
    pendingSnapshot: crossTurnTimePending,
    temporalContext: {
      now: new Date('2026-08-13T12:00:00.000Z'),
      timezone: 'America/Sao_Paulo',
    },
  }
);
assert.equal(crossTurnOutsideOptions.safe, false);
assert.equal(
  crossTurnOutsideOptions.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  true,
  'hora fora das options continua exigindo leitura no turno'
);
assert.equal(
  crossTurnOutsideOptions.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  true,
  'hora fora das options não licencia resumo'
);

for (const [label, candidate, extra] of [
  [
    'sem pergunta de confirmação',
    'Confirmando: Limpeza de pele profunda, hoje às 15h, com a Carla.',
    { sourceInboundText: 'pode ser às 15h', toolTrace: slotEvidence },
  ],
  [
    'serviço diferente do fixo',
    'Confirmando: Peeling Facial, hoje às 15h, com a Carla. Posso marcar?',
    { sourceInboundText: 'pode ser às 15h', toolTrace: slotEvidence },
  ],
  [
    'horário sem evidência',
    'Confirmando: Limpeza de pele profunda, hoje às 15h, com a Carla. Confirma?',
    { sourceInboundText: 'pode ser às 16h', toolTrace: [] },
  ],
  [
    'estado consumado',
    'Seu horário está confirmado para Limpeza de pele profunda hoje às 15h com a Carla. Confirma?',
    { sourceInboundText: 'pode ser às 15h', toolTrace: slotEvidence },
  ],
] as const) {
  const result = boundary(candidate, {
    servicesResult: preBookingServices,
    flowState: cleaningFlowState,
    inboundTextsById: { 'in-current': extra.sourceInboundText },
    temporalContext: { now: new Date('2026-08-13T12:00:00.000Z'), timezone: 'America/Sao_Paulo' },
    ...extra,
  });
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
    true,
    label
  );
}

const ungroundedExistingClaim = boundary('Seu horário está confirmado.', {
  servicesResult: preBookingServices,
  flowState: cleaningFlowState,
  sourceInboundText: 'obrigada',
  inboundTextsById: { 'in-current': 'obrigada' },
  toolTrace: [],
});
assert.equal(ungroundedExistingClaim.safe, false);
assert.equal(
  ungroundedExistingClaim.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  true,
  'claim de agendamento existente continua exigindo leitura/write'
);

const uniquePartialProfessional = boundary('Tudo certo com a Júlia.', {
  sourceInboundText: 'Quero atendimento com a Júlia',
  inboundTextsById: { 'in-current': 'Quero atendimento com a Júlia' },
});
assert.equal(
  uniquePartialProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  false,
  'primeiro nome unívoco da profissional é aceito na saída v2'
);
assert.equal(uniquePartialProfessional.safe, true);

const ambiguousProfessionals: ServicesResult = {
  ...servicesResult,
  services: servicesResult.services?.map((service) => ({
    ...service,
    professionalIds: ['prof-julia-costa', 'prof-julia-souza'],
  })),
  professionals: [
    { id: 'prof-julia-costa', name: 'Júlia Costa' },
    { id: 'prof-julia-souza', name: 'Júlia Souza' },
  ],
};
const ambiguousPartialProfessional = boundary('Tudo certo com a Júlia.', {
  servicesResult: ambiguousProfessionals,
  sourceInboundText: 'Quero atendimento com a Júlia',
  inboundTextsById: { 'in-current': 'Quero atendimento com a Júlia' },
});
assert.equal(
  ambiguousPartialProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  'duas profissionais com o mesmo primeiro nome continuam ambíguas'
);

const negatedPartialProfessional = boundary('Tudo certo com a Carla.', {
  servicesResult: preBookingServices,
  sourceInboundText: 'Não quero atendimento com a Carla',
  inboundTextsById: { 'in-current': 'Não quero atendimento com a Carla' },
});
assert.equal(
  negatedPartialProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  'K5: primeiro nome em oração negada não ancora profissional'
);

const toolAnchoredProfessional = boundary('Encontrei opções com a Carla.', {
  servicesResult: preBookingServices,
  sourceInboundText: 'quinta-feira',
  inboundTextsById: { 'in-current': 'quinta-feira' },
  toolTrace: [
    {
      name: 'getAvailableSlots',
      result: JSON.stringify({
        success: true,
        professionalId: 'prof-carla',
        slots: ['14:00'],
      }),
    },
  ],
});
assert.equal(
  toolAnchoredProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  false,
  'K5: read do turno com professionalId ancora primeiro nome unívoco'
);

const trustedProfessional = boundary('Tudo certo com a Carla.', {
  servicesResult: preBookingServices,
  sourceInboundText: 'pode continuar',
  inboundTextsById: { 'in-current': 'pode continuar' },
  flowState: {
    flowId: 'flow-trusted-professional',
    fixedServiceId: 'svc-limpeza',
    fixedProfessionalId: 'prof-carla',
    fixedByProofVersion: { fixedServiceId: 4, fixedProfessionalId: 4 },
  },
});
assert.equal(
  trustedProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  false,
  'K5: profissional fixada na versão atual e elegível é trustedProfessional'
);

const staleTrustedProfessional = boundary('Tudo certo com a Carla.', {
  servicesResult: {
    ...preBookingServices,
    services: preBookingServices.services?.map((service) =>
      service.id === 'svc-limpeza'
        ? { ...service, professionalIds: ['prof-carla', 'prof-marina'] }
        : service
    ),
  },
  sourceInboundText: 'pode continuar',
  inboundTextsById: { 'in-current': 'pode continuar' },
  flowState: {
    flowId: 'flow-stale-professional',
    fixedServiceId: 'svc-limpeza',
    fixedProfessionalId: 'prof-carla',
    fixedByProofVersion: { fixedServiceId: 5, fixedProfessionalId: 4 },
  },
});
assert.equal(
  staleTrustedProfessional.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  'K5: profissional de versão anterior não é trustedProfessional'
);

const uniqueEligibleWithoutOtherAnchor = boundary(
  'Limpeza de pele profunda é com a Carla. Qual dia você prefere?',
  {
    servicesResult: preBookingServices,
    sourceInboundText: 'limpeza',
    inboundTextsById: { 'in-current': 'limpeza' },
    flowState: {
      flowId: 'flow-unique-eligible',
      fixedServiceId: 'svc-limpeza',
      fixedByProofVersion: { fixedServiceId: 7 },
    },
  }
);
assert.equal(
  uniqueEligibleWithoutOtherAnchor.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  false,
  'K5 pós-matriz: única profissional elegível do serviço atual é 4ª âncora tipada'
);
const twoEligibleServices: ServicesResult = {
  ...preBookingServices,
  services: preBookingServices.services?.map((service) =>
    service.id === 'svc-limpeza'
      ? { ...service, professionalIds: ['prof-carla', 'prof-marina'] }
      : service
  ),
  professionals: [
    ...(preBookingServices.professionals ?? []),
    { id: 'prof-marina', name: 'Marina Costa' },
  ],
};
const nonUniqueEligibleWithoutAnchor = boundary('Tudo certo com a Carla.', {
  servicesResult: twoEligibleServices,
  sourceInboundText: 'limpeza',
  inboundTextsById: { 'in-current': 'limpeza' },
  flowState: {
    flowId: 'flow-two-eligible',
    fixedServiceId: 'svc-limpeza',
    fixedByProofVersion: { fixedServiceId: 8 },
  },
});
assert.equal(
  nonUniqueEligibleWithoutAnchor.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  '4ª âncora falha fechado quando há 2 profissionais elegíveis'
);
const undefinedEligibilityUsesGlobal = boundary('Tudo certo com a Carla.', {
  servicesResult: {
    success: true,
    services: [
      {
        id: 'svc-global-fallback',
        name: 'Serviço legado',
        durationMinutes: 30,
        price: 90,
        priceFormatted: 'R$ 90,00',
      },
    ],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  },
  sourceInboundText: 'serviço legado',
  inboundTextsById: { 'in-current': 'serviço legado' },
  flowState: {
    flowId: 'flow-global-fallback',
    fixedServiceId: 'svc-global-fallback',
    fixedByProofVersion: { fixedServiceId: 9 },
  },
});
assert.equal(
  undefinedEligibilityUsesGlobal.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  false,
  'A2: professionalIds undefined usa a lista global ativa'
);
const emptyEligibilityAnchorsNobody = boundary('Tudo certo com a Carla.', {
  servicesResult: {
    success: true,
    services: [
      {
        id: 'svc-no-professional',
        name: 'Serviço sem profissional',
        durationMinutes: 30,
        price: 90,
        priceFormatted: 'R$ 90,00',
        professionalIds: [],
      },
    ],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  },
  sourceInboundText: 'serviço sem profissional',
  inboundTextsById: { 'in-current': 'serviço sem profissional' },
  flowState: {
    flowId: 'flow-no-professional',
    fixedServiceId: 'svc-no-professional',
    fixedByProofVersion: { fixedServiceId: 10 },
  },
});
assert.equal(
  emptyEligibilityAnchorsNobody.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  'A2: professionalIds [] não ancora nenhuma profissional'
);

const botNameCatalog: ServicesResult = {
  ...servicesResult,
  services: servicesResult.services?.map((service) => ({
    ...service,
    professionalIds: [...(service.professionalIds ?? []), 'prof-ana'],
  })),
  professionals: [
    ...(servicesResult.professionals ?? []),
    { id: 'prof-ana', name: 'Ana Silva' },
  ],
};
const stoplistedBotName = boundary('Tudo certo com a Ana.', {
  servicesResult: botNameCatalog,
  sourceInboundText: 'Quero atendimento com a Ana',
  inboundTextsById: { 'in-current': 'Quero atendimento com a Ana' },
});
assert.equal(
  stoplistedBotName.reasonCodes.includes('UNKNOWN_PROFESSIONAL'),
  true,
  'K5: nome da bot permanece na stoplist mesmo se aparecer no catálogo'
);

const temporalInbound = 'sexta às 20h';
const temporalSpan = spanFor(temporalInbound, temporalInbound);
const socialLicensed = boundary('Sexta às 20h então!', {
  replyPurpose: 'SOCIAL',
  sourceInboundText: temporalInbound,
  inboundTextsById: { 'in-current': temporalInbound },
  socialTemporalEvidence: { inboundId: 'in-current', ...temporalSpan },
  flowState: { flowId: 'social-flow', fixedByProofVersion: {} },
});
assert.equal(socialLicensed.safe, true, socialLicensed.reasonCodes.join(','));
const socialUnlicensed = boundary('Sexta às 20h então!', {
  replyPurpose: 'SOCIAL',
  sourceInboundText: temporalInbound,
  inboundTextsById: { 'in-current': temporalInbound },
  flowState: { flowId: 'social-flow', fixedByProofVersion: {} },
});
assert.equal(
  socialUnlicensed.reasonCodes.includes('UNLICENSED_SOCIAL_TEMPORAL_ECHO'),
  true
);

const relist = boundary('Temos Peeling Facial e Drenagem. Qual você prefere?');
assert.equal(relist.reasonCodes.includes('SERVICE_RELIST_AFTER_FIXED'), true);
assert.equal(
  shouldProhibitServiceRelistV2(flowState, {
    kind: 'open',
    pendingKind: 'SERVICE',
    flowId: 'flow-v2',
    optionEntityIds: ['svc-peeling', 'svc-drenagem'],
  }),
  false
);

const canonicalServiceList = materializeServiceListCopyV2(servicesResult);
assert.ok(canonicalServiceList);
const licensedCanonicalList = boundary(canonicalServiceList!, {
  source: 'CANONICAL',
  exactCanonicalServiceListText: canonicalServiceList,
});
assert.equal(
  licensedCanonicalList.safe,
  true,
  `lista canônica testemunhada deve passar: ${licensedCanonicalList.reasonCodes.join(',')}`
);
const familyClarification = materializeServiceClarificationV2(
  (servicesResult.services ?? []).slice(0, 2)
);
assert.ok(familyClarification);
const familyBoundary = boundary(familyClarification!.text, {
  source: 'CANONICAL',
  exactCanonicalServiceListText: familyClarification!.text,
});
assert.equal(
  familyBoundary.safe,
  true,
  `subset SERVICE/FAMILY canônico deve passar: ${familyBoundary.reasonCodes.join(',')}`
);
const familyOutOfCatalog = boundary(
  `${familyClarification!.text}\n\nAs opções são Botox e Massagem`,
  {
    source: 'GENERATED',
    exactCanonicalServiceListText: familyClarification!.text,
  }
);
assert.equal(
  familyOutOfCatalog.reasonCodes.includes('UNLICENSED_SERVICE_LIST'),
  true,
  `subset FAMILY + enumeração fora do catálogo deve bloquear: ${familyOutOfCatalog.reasonCodes.join(',')}`
);
assert.equal(familyOutOfCatalog.safe, false);
const solProbe = boundary(
  `As opções são Botox e Drenagem Linfática\n\n${canonicalServiceList}`,
  {
    source: 'GENERATED',
    exactCanonicalServiceListText: canonicalServiceList,
  }
);
assert.equal(
  solProbe.reasonCodes.includes('UNLICENSED_SERVICE_LIST'),
  true,
  'sonda Sol: base gerada que enumera + lista canônica bloqueia'
);
assert.equal(solProbe.safe, false);
const licensedCanonicalReading = boundary(
  `Encontrei estes agendamentos: Drenagem e Peeling Facial em 20/08/2026.\n\n${canonicalServiceList}`,
  {
    source: 'CANONICAL',
    exactCanonicalServiceListText: canonicalServiceList,
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
  }
);
assert.equal(
  licensedCanonicalReading.safe,
  true,
  `leitura canônica com 2 serviços + lista não é falso positivo: ${licensedCanonicalReading.reasonCodes.join(',')}`
);
  assert.equal(
    licensedCanonicalReading.reasonCodes.includes('UNLICENSED_SERVICE_LIST'),
    false
  );
  const handoffListCopy =
    `Vou avisar a equipe responsável pelo atendimento.\n\n${canonicalServiceList}`;
  const unrecordedHandoffList = boundary(handoffListCopy, {
    source: 'CANONICAL',
    exactCanonicalServiceListText: canonicalServiceList,
  });
  assert.equal(
    unrecordedHandoffList.reasonCodes.includes('UNRECORDED_HANDOFF'),
    true,
    'IA-16d: handoff + lista sem evidência continua UNRECORDED_HANDOFF'
  );
  const recordedHandoffList = boundary(handoffListCopy, {
    source: 'CANONICAL',
    exactCanonicalServiceListText: canonicalServiceList,
    actionRecorded: true,
    outboundEvidence: {
      authoritativeEscalationQuestionId: 'question-authoritative-fixture',
    },
  });
  assert.equal(
    recordedHandoffList.safe,
    true,
    `IA-16d: handoff registrado + lista passa: ${recordedHandoffList.reasonCodes.join(',')}`
  );
  assert.equal(
    recordedHandoffList.reasonCodes.includes('UNRECORDED_HANDOFF'),
    false
  );
  const overCeiling = boundary('x'.repeat(SERVICE_LIST_TRANSPORT_CEILING_V2 + 1));
assert.equal(
  overCeiling.reasonCodes.includes('PAYLOAD_EXCEEDS_TRANSPORT'),
  true
);

const temporal = normalizeTemporalAssertionsV2(
  'Atendo 15 horas, das 8 às 18, 17 e meia e oito da manhã.'
).map((entry) => entry.normalized);
assert.ok(temporal.includes('15:00'));
assert.ok(temporal.includes('08:00'));
assert.ok(temporal.includes('18:00'));
assert.ok(temporal.includes('17:30'));

const repeatedTimeQuestion = boundary('17h ou 17h30?', {
  replyPurpose: 'CLARIFICATION',
  recentAssistantReplies: ['17h ou 17h30?'],
  pendingAnaOpen: true,
  pendingSnapshot: {
    questionId: 'question-time-clarification',
    askedAt: '2026-08-14T10:00:00.000Z',
    kind: 'TIME',
    flowId: 'flow-v2',
    version: 3,
    options: [
      { position: 1, entityId: '17:00', displayName: '17:00' },
      { position: 2, entityId: '17:30', displayName: '17:30' },
    ],
  },
});
assert.equal(
  repeatedTimeQuestion.reasonCodes.includes('REPEATED_CLARIFICATION'),
  true,
  'a mesma clarificação não pode ser aceita duas vezes consecutivas'
);
const repeatedGenericClarification = boundary(
  'Pode me dizer novamente o que você prefere?',
  {
    replyPurpose: 'CLARIFICATION',
    recentAssistantReplies: ['Pode me dizer novamente o que você prefere?'],
    pendingSnapshot: null,
    pendingAnaOpen: false,
  }
);
assert.equal(
  repeatedGenericClarification.reasonCodes.includes('REPEATED_CLARIFICATION'),
  true,
  'ask-repeat sem PendingFrame também não pode repetir consecutivamente'
);
const repeatedConfirmationAnchor = boundary('Você confirma essa opção?', {
  replyPurpose: 'CLARIFICATION',
  recentAssistantReplies: ['Você confirma essa opção?'],
  pendingAnaOpen: true,
  pendingSnapshot: {
    questionId: 'question-booking-confirmation',
    askedAt: '2026-08-14T10:00:00.000Z',
    kind: 'CONFIRMATION',
    flowId: 'flow-v2',
    version: 4,
    options: [
      {
        position: 1,
        entityId: 'booking-confirmation:flow-v2',
        displayName: 'Confirmar agendamento',
      },
    ],
  },
});
assert.equal(
  repeatedConfirmationAnchor.reasonCodes.includes('REPEATED_CLARIFICATION'),
  false,
  'a âncora de confirmação permanece reemitível para proteger o gate'
);

const rawLeak = boundary('**INTERNAL_HINT svc-peeling**');
assert.deepEqual(
  rawLeak.stages.map((entry) => entry.stage),
  [
    'raw_candidate_scan',
    'mechanical_normalization',
    'customer_reply_guard',
    'receptionist_outbound',
  ]
);
assert.equal(rawLeak.stages[0]!.reasonCodes.includes('INTERNAL_HINT'), true);
assert.equal(rawLeak.stages[0]!.reasonCodes.includes('CATALOG_SERVICE_ID'), true);
const unrecordedHandoff = boundary('Vou te encaminhar para a equipe.');
assert.equal(
  unrecordedHandoff.stages[0]!.reasonCodes.includes('UNRECORDED_HANDOFF'),
  true,
  'handoff global roda no scan bruto, antes de qualquer exceção social'
);
const unrecordedAvisar = boundary(
  'Vou avisar a equipe responsável pelo atendimento.'
);
assert.equal(
  unrecordedAvisar.reasonCodes.includes('UNRECORDED_HANDOFF'),
  true,
  'vou avisar a equipe é promessa de handoff sem questionId'
);
const recordedAvisar = boundary(
  'Vou avisar a equipe responsável pelo atendimento.',
  {
    source: 'CANONICAL',
    actionRecorded: true,
    outboundEvidence: {
      authoritativeEscalationQuestionId: 'question-authoritative-fixture',
    },
  }
);
assert.equal(recordedAvisar.safe, true);
assert.equal(recordedAvisar.originalAccepted, true);
assert.equal(
  recordedAvisar.reasonCodes.includes('UNRECORDED_HANDOFF'),
  false,
  'questionId confirmado licencia a copy canônica de escalada na boundary'
);
const namedAvisarCopy =
  'Vou avisar Heloísa, responsável por este atendimento.';
const unrecordedNamedAvisar = boundary(namedAvisarCopy);
assert.equal(
  unrecordedNamedAvisar.reasonCodes.includes('UNRECORDED_HANDOFF'),
  true,
  'vou avisar <responsável arbitrário> é promessa de handoff sem questionId'
);
const recordedNamedAvisar = boundary(namedAvisarCopy, {
  source: 'CANONICAL',
  actionRecorded: true,
  outboundEvidence: {
    authoritativeEscalationQuestionId: 'question-authoritative-fixture',
  },
});
assert.equal(recordedNamedAvisar.safe, true);
assert.equal(recordedNamedAvisar.originalAccepted, true);
assert.equal(
  recordedNamedAvisar.reasonCodes.includes('UNRECORDED_HANDOFF'),
  false,
  'questionId confirmado licencia a copy com responsável nominal arbitrário'
);

const deferredOpenAcceptedCopy =
  'Para eu consultar a agenda de hoje, depois das 17h30, qual serviço você quer fazer?';
const deferredOpenBlockedCopy =
  'Para eu verificar os horários de hoje depois das 17h30, qual serviço você quer fazer?';
const deferredOpenFlowState = {
  flowId: 'flow-deferred-open',
  lastOperationalAt: '2026-08-13T15:00:00.000Z',
  deferredAvailability: {
    schemaVersion: 1 as const,
    capturedAt: '2026-08-13T15:00:00.000Z',
    capturedTurnId: 'turn-deferred-open',
    capturedInputSequence: 1,
    date: '2026-08-13',
    timeWindow: { kind: 'AFTER_EXCLUSIVE' as const, minuteOfDay: 17 * 60 + 30 },
  },
  fixedByProofVersion: {},
};
const deferredOpenPending = {
  questionId: 'q-deferred-open',
  askedAt: '2026-08-13T15:00:00.000Z',
  kind: 'SERVICE' as const,
  flowId: 'flow-deferred-open',
  version: 1,
  options: [] as Array<{ position: number; entityId: string; displayName: string }>,
};
const deferredOpenInbound = 'Boa tarde! Tem horário hoje após as 17:30?';
const deferredOpenAccepted = evaluateBoundaryV2({
  rawCandidate: deferredOpenAcceptedCopy,
  servicesResult,
  flowState: deferredOpenFlowState,
  pendingTransitionCandidate: {
    kind: 'open',
    pendingKind: 'SERVICE',
    flowId: 'flow-deferred-open',
    optionEntityIds: [],
  },
  replyPurpose: 'SERVICE_QUESTION',
  source: 'CANONICAL',
  toolTrace: [],
  sourceInboundText: deferredOpenInbound,
  currentInboundIds: ['in-deferred-open'],
  inboundTextsById: { 'in-deferred-open': deferredOpenInbound },
  pendingSnapshot: deferredOpenPending,
});
assert.equal(deferredOpenAccepted.safe, true);
assert.equal(deferredOpenAccepted.originalAccepted, true);
assert.deepEqual(deferredOpenAccepted.reasonCodes, []);
assert.equal(
  deferredOpenAccepted.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  false,
  'consultar a agenda não afirma disponibilidade'
);
const deferredOpenBlocked = evaluateBoundaryV2({
  rawCandidate: deferredOpenBlockedCopy,
  servicesResult,
  flowState: deferredOpenFlowState,
  pendingTransitionCandidate: {
    kind: 'open',
    pendingKind: 'SERVICE',
    flowId: 'flow-deferred-open',
    optionEntityIds: [],
  },
  replyPurpose: 'SERVICE_QUESTION',
  source: 'CANONICAL',
  toolTrace: [],
  sourceInboundText: deferredOpenInbound,
  currentInboundIds: ['in-deferred-open'],
  inboundTextsById: { 'in-deferred-open': deferredOpenInbound },
  pendingSnapshot: deferredOpenPending,
});
assert.equal(
  deferredOpenBlocked.reasonCodes.includes('UNVERIFIED_AVAILABILITY'),
  true,
  'verificar os horários reabre UNVERIFIED_AVAILABILITY'
);

const emptyOpenClarificationEval = evaluateBoundaryV2({
  rawCandidate: EMPTY_OPEN_SERVICE_CLARIFICATION_V2,
  servicesResult,
  flowState: deferredOpenFlowState,
  pendingTransitionCandidate: {
    kind: 'preserve',
  },
  replyPurpose: 'CLARIFICATION',
  source: 'CANONICAL',
  toolTrace: [],
  sourceInboundText: 'quero fazer o cabelo',
  currentInboundIds: ['in-hair-clarification'],
  inboundTextsById: { 'in-hair-clarification': 'quero fazer o cabelo' },
  pendingSnapshot: deferredOpenPending,
});
assert.equal(emptyOpenClarificationEval.safe, true);
assert.equal(emptyOpenClarificationEval.originalAccepted, true);
assert.deepEqual(emptyOpenClarificationEval.reasonCodes, []);
assert.equal(
  emptyOpenClarificationEval.acceptedPayload,
  EMPTY_OPEN_SERVICE_CLARIFICATION_V2
);

console.log('smoke ana conversational v2 boundary: OK');
