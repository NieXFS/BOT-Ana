import assert from 'node:assert/strict';
import type { TenantBotConfig, TenantBusinessAddress } from '../src/configProvider';
import {
  normalizeBusinessAddressPayload,
  parseDirectionsModePayload,
} from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import { evaluateBoundaryV2 } from '../src/services/conversationalV2/boundary';
import {
  composeBusinessAddressComponentV2,
  isUsableBusinessAddressV2,
  matchBusinessAddressQuestionV2,
  materializeAfterConfirmationBusinessAddressCopyV2,
  materializeCityBusinessAddressCopyV2,
  materializeFullBusinessAddressCopyV2,
  resolveBusinessAddressPlanV2,
  resolveDirectionsModeV2,
} from '../src/services/conversationalV2/businessAddress';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';
import { buildConversationKey } from '../src/services/contextManager';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_business_address';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';

const now = new Date('2026-08-15T12:00:00.000Z');
let serial = 0;
const nextId = () => `business-address-v2-${++serial}`;

const FULL_ADDRESS: TenantBusinessAddress = {
  full: 'Avenida Paulista, 1000',
  city: 'São Paulo',
  state: 'SP',
  zipCode: '01310930',
};
const CITY_ONLY: TenantBusinessAddress = {
  full: null,
  city: 'Recife',
  state: 'PE',
  zipCode: null,
};
/** Shape EXATO do ERP sem cadastro (Exec ERP-1): objeto presente, campos null. */
const ERP_UNREGISTERED_ADDRESS: TenantBusinessAddress = {
  full: null,
  city: null,
  state: null,
  zipCode: null,
};
const ZIP_ONLY: TenantBusinessAddress = {
  full: null,
  city: null,
  state: null,
  zipCode: '01310930',
};
const CITY_WITHOUT_REST: TenantBusinessAddress = {
  full: null,
  city: 'Recife',
  state: null,
  zipCode: null,
};
const GRACEFUL_TEAM_REPLY = 'O endereço é com a equipe da clínica.';
const expectedFull =
  'Estamos em Avenida Paulista, 1000, São Paulo - SP, CEP 01310930.';
const expectedCity =
  'Estamos em São Paulo - SP. O endereço completo a equipe confirma com você no contato.';
const expectedApos =
  'Estamos em São Paulo - SP. Assim que seu agendamento estiver confirmado te passo o endereço completinho.';
const expectedCityRecife =
  'Estamos em Recife - PE. O endereço completo a equipe confirma com você no contato.';
const expectedCityWithoutState =
  'Estamos em Recife. O endereço completo a equipe confirma com você no contato.';
const expectedAposTiete =
  'Estamos em Tietê - SP. Assim que seu agendamento estiver confirmado te passo o endereço completinho.';

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-julia'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 45,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia', 'prof-marina'],
    },
  ],
  professionals: [
    { id: 'prof-julia', name: 'Júlia' },
    { id: 'prof-marina', name: 'Marina' },
  ],
};

function baseConfig(
  overrides: Partial<TenantBotConfig> = {}
): TenantBotConfig {
  return {
    tenantSlug: 'fixture-business-address',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Atenda com segurança.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0.2,
    aiMaxTokens: 900,
    openaiApiKey: 'sk-smoke-no-network',
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'fixture',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN-BUSINESS-ADDRESS',
    isActive: true,
    ...overrides,
  };
}

const futureAppointment = {
  id: 'apt-future',
  startTime: '2026-08-20T18:00:00.000Z',
  endTime: '2026-08-20T19:00:00.000Z',
  serviceName: 'Drenagem Linfática',
  professionalName: 'Júlia',
  status: 'CONFIRMED',
};
const cancelledAppointment = {
  ...futureAppointment,
  id: 'apt-cancelled',
  status: 'CANCELLED',
};
const pastAppointment = {
  ...futureAppointment,
  id: 'apt-past',
  startTime: '2026-08-01T18:00:00.000Z',
  endTime: '2026-08-01T19:00:00.000Z',
};

async function main(): Promise<void> {
  const erpPayload = {
    structuredConfig: { directionsMode: 'ENDERECO_COMPLETO' },
    businessAddress: {
      full: 'Avenida Paulista, 1000',
      city: 'São Paulo',
      state: 'SP',
      zipCode: '01310930',
    },
  };
  assert.equal(
    parseDirectionsModePayload(erpPayload.structuredConfig.directionsMode),
    'ENDERECO_COMPLETO'
  );
  assert.deepEqual(
    normalizeBusinessAddressPayload(erpPayload.businessAddress),
    FULL_ADDRESS
  );
  assert.equal(normalizeBusinessAddressPayload(undefined), undefined);
  assert.deepEqual(
    normalizeBusinessAddressPayload(ERP_UNREGISTERED_ADDRESS),
    ERP_UNREGISTERED_ADDRESS
  );
  assert.equal(isUsableBusinessAddressV2(undefined), false);
  assert.equal(isUsableBusinessAddressV2(ERP_UNREGISTERED_ADDRESS), false);
  assert.equal(isUsableBusinessAddressV2(ZIP_ONLY), false);
  assert.equal(
    isUsableBusinessAddressV2({
      full: '  ',
      city: '',
      state: null,
      zipCode: '01310930',
    }),
    false
  );
  assert.equal(isUsableBusinessAddressV2(CITY_ONLY), true);
  assert.equal(isUsableBusinessAddressV2(CITY_WITHOUT_REST), true);
  assert.equal(isUsableBusinessAddressV2(FULL_ADDRESS), true);
  assert.equal(parseDirectionsModePayload(undefined), undefined);
  assert.equal(parseDirectionsModePayload('MODO_NOVO'), undefined);
  assert.equal(resolveDirectionsModeV2({}), 'SO_CIDADE');
  assert.equal(
    resolveDirectionsModeV2({ directionsMode: 'ENDERECO_COMPLETO' }),
    'ENDERECO_COMPLETO'
  );

  assert.equal(materializeFullBusinessAddressCopyV2(FULL_ADDRESS), expectedFull);
  assert.equal(materializeCityBusinessAddressCopyV2(FULL_ADDRESS), expectedCity);
  assert.equal(
    materializeAfterConfirmationBusinessAddressCopyV2(FULL_ADDRESS),
    expectedApos
  );
  assert.equal(
    materializeAfterConfirmationBusinessAddressCopyV2({
      full: null,
      city: 'Tietê',
      state: 'SP',
      zipCode: null,
    }),
    expectedAposTiete
  );
  assert.doesNotMatch(
    expectedApos,
    /equipe confirma/u,
    'APOS_CONFIRMACAO sem upcoming não emenda a frase da equipe'
  );
  assert.equal(materializeFullBusinessAddressCopyV2(CITY_ONLY), null);
  assert.equal(materializeCityBusinessAddressCopyV2(CITY_ONLY), expectedCityRecife);
  assert.equal(
    materializeCityBusinessAddressCopyV2(CITY_WITHOUT_REST),
    expectedCityWithoutState
  );
  assert.equal(materializeFullBusinessAddressCopyV2(ERP_UNREGISTERED_ADDRESS), null);
  assert.equal(materializeCityBusinessAddressCopyV2(ERP_UNREGISTERED_ADDRESS), null);
  assert.equal(materializeFullBusinessAddressCopyV2(ZIP_ONLY), null);
  assert.equal(materializeCityBusinessAddressCopyV2(ZIP_ONLY), null);
  assert.equal(
    materializeFullBusinessAddressCopyV2({
      full: 'Rua das Flores, 10',
      city: 'Recife',
      state: null,
      zipCode: null,
    }),
    'Estamos em Rua das Flores, 10, Recife.'
  );

  for (const text of [
    'Qual o endereço de vocês?',
    'onde fica?',
    'Onde vocês ficam?',
    'como chegar',
    'Como chego aí?',
    'qual a localização',
    'qual o local',
    'me passa o endereço da clínica',
  ]) {
    assert.equal(
      matchBusinessAddressQuestionV2(text).matched,
      true,
      text
    );
  }
  for (const text of [
    'qual o endereço do site?',
    'me manda o endereço do instagram',
    'endereço de email de vocês',
    'não quero o endereço',
    'não me passa a localização',
    'oi, tudo bem?',
    'quero agendar drenagem',
  ]) {
    assert.equal(
      matchBusinessAddressQuestionV2(text).matched,
      false,
      text
    );
  }
  const mixedMatch = matchBusinessAddressQuestionV2(
    'qual o endereço? e tem vaga amanhã?'
  );
  assert.equal(mixedMatch.matched, true);
  assert.equal(mixedMatch.requiresOperationalContinuation, true);

  const fullPlan = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('ENDERECO_COMPLETO não lê upcoming');
    },
  });
  assert.equal(fullPlan.decision.kind, 'answer');
  assert.equal(
    fullPlan.decision.kind === 'answer' && fullPlan.decision.text,
    expectedFull
  );

  const cityPlan = await resolveBusinessAddressPlanV2({
    inboundText: 'onde fica?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('SO_CIDADE não lê upcoming');
    },
  });
  assert.equal(
    cityPlan.decision.kind === 'answer' && cityPlan.decision.text,
    expectedCity
  );

  let aposReads = 0;
  const aposEmpty = await resolveBusinessAddressPlanV2({
    inboundText: 'como chegar',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () => {
      aposReads += 1;
      return JSON.stringify({ success: true, appointments: [] });
    },
  });
  assert.equal(aposReads, 1);
  assert.equal(
    aposEmpty.decision.kind === 'answer' && aposEmpty.decision.text,
    expectedApos
  );

  const aposWithUpcoming = await resolveBusinessAddressPlanV2({
    inboundText: 'qual o local',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () =>
      JSON.stringify({ success: true, appointments: [futureAppointment] }),
  });
  assert.equal(
    aposWithUpcoming.decision.kind === 'answer' && aposWithUpcoming.decision.text,
    expectedFull
  );

  const aposCancelled = await resolveBusinessAddressPlanV2({
    inboundText: 'endereço',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () =>
      JSON.stringify({
        success: true,
        appointments: [cancelledAppointment, pastAppointment],
      }),
  });
  assert.equal(
    aposCancelled.decision.kind === 'answer' && aposCancelled.decision.text,
    expectedApos,
    'upcoming cancelado/passado não libera o endereço completo'
  );

  const aposIdentity = await resolveBusinessAddressPlanV2({
    inboundText: 'onde fica?',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () =>
      JSON.stringify({
        success: false,
        reason: 'customer_identity_ambiguous',
      }),
  });
  assert.equal(
    aposIdentity.decision.kind === 'answer' && aposIdentity.decision.text,
    expectedApos,
    'identidade fail-closed não vaza FULL'
  );

  const missingFull = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: CITY_ONLY,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('não deveria ler upcoming');
    },
  });
  assert.equal(missingFull.decision.kind, 'none');
  assert.equal(
    missingFull.decision.kind === 'none' && missingFull.decision.reason,
    'full_address_missing'
  );

  const missingCity = await resolveBusinessAddressPlanV2({
    inboundText: 'onde fica?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: {
        full: 'Avenida Paulista, 1000',
        city: null,
        state: 'SP',
        zipCode: null,
      },
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('não deveria ler upcoming');
    },
  });
  assert.equal(missingCity.decision.kind, 'none');

  const oldErp = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço de vocês?',
    config: baseConfig(),
    now,
    executeUpcomingRead: async () => {
      throw new Error('ERP velho não lê upcoming');
    },
  });
  assert.equal(oldErp.decision.kind, 'none');
  assert.equal(
    oldErp.decision.kind === 'none' && oldErp.decision.reason,
    'business_address_absent'
  );

  const erpUnregisteredPlan = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: ERP_UNREGISTERED_ADDRESS,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('endereço todo-null não lê upcoming');
    },
  });
  assert.equal(erpUnregisteredPlan.decision.kind, 'none');
  assert.equal(
    erpUnregisteredPlan.decision.kind === 'none' &&
      erpUnregisteredPlan.decision.reason,
    'business_address_absent'
  );

  const zipOnlyPlan = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: ZIP_ONLY,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('só zipCode não lê upcoming');
    },
  });
  assert.equal(zipOnlyPlan.decision.kind, 'none');
  assert.equal(
    zipOnlyPlan.decision.kind === 'none' && zipOnlyPlan.decision.reason,
    'business_address_absent'
  );

  const cityUsablePlan = await resolveBusinessAddressPlanV2({
    inboundText: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: CITY_WITHOUT_REST,
    }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('city utilizável não lê upcoming em SO_CIDADE');
    },
  });
  assert.equal(
    cityUsablePlan.decision.kind === 'answer' && cityUsablePlan.decision.text,
    expectedCityWithoutState
  );

  const unknownMode = await resolveBusinessAddressPlanV2({
    inboundText: 'onde fica?',
    config: baseConfig({ businessAddress: FULL_ADDRESS }),
    now,
    executeUpcomingRead: async () => {
      throw new Error('modo ausente é SO_CIDADE e não lê upcoming');
    },
  });
  assert.equal(
    unknownMode.decision.kind === 'answer' && unknownMode.decision.text,
    expectedCity
  );

  const invented = evaluateBoundaryV2({
    rawCandidate: 'Estamos na Rua da Outra Unidade, 999.',
    servicesResult: services,
    sourceInboundText: 'Qual o endereço?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(invented.safe, false);
  assert.equal(invented.reasonCodes.includes('UNKNOWN_ADDRESS'), true);

  const licensedFull = evaluateBoundaryV2({
    rawCandidate: expectedFull,
    servicesResult: services,
    sourceInboundText: 'Qual o endereço?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(licensedFull.safe, true, String(licensedFull.reasonCodes));

  const licensedCity = evaluateBoundaryV2({
    rawCandidate: expectedCity,
    servicesResult: services,
    sourceInboundText: 'onde fica?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'onde fica?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(licensedCity.safe, true, String(licensedCity.reasonCodes));

  const licensedApos = evaluateBoundaryV2({
    rawCandidate: expectedApos,
    servicesResult: services,
    sourceInboundText: 'Qual o endereço?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(licensedApos.safe, true, String(licensedApos.reasonCodes));

  const modelPhonePlain = evaluateBoundaryV2({
    rawCandidate: 'Telefone: 01310930',
    servicesResult: services,
    sourceInboundText: 'Qual o telefone?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o telefone?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(modelPhonePlain.safe, false);
  assert.equal(
    modelPhonePlain.reasonCodes.includes('EXPLICIT_PII'),
    true,
    String(modelPhonePlain.reasonCodes)
  );

  const modelPhoneHyphen = evaluateBoundaryV2({
    rawCandidate: 'Telefone: 01310-930',
    servicesResult: services,
    sourceInboundText: 'Qual o telefone?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o telefone?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(modelPhoneHyphen.safe, false);
  assert.equal(
    modelPhoneHyphen.reasonCodes.includes('EXPLICIT_PII'),
    true,
    String(modelPhoneHyphen.reasonCodes)
  );

  const mixedModelZip = composeBusinessAddressComponentV2({
    baseText: 'Telefone: 01310930',
    componentText: expectedFull,
  });
  assert.match(mixedModelZip, /Avenida Paulista, 1000/u);
  assert.match(mixedModelZip, /Telefone: 01310930/u);
  const mixedPii = evaluateBoundaryV2({
    rawCandidate: mixedModelZip,
    servicesResult: services,
    sourceInboundText: 'Qual o endereço?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: FULL_ADDRESS,
    route: 'model',
  });
  assert.equal(mixedPii.safe, false);
  assert.equal(
    mixedPii.reasonCodes.includes('EXPLICIT_PII'),
    true,
    String(mixedPii.reasonCodes)
  );

  const oldErpInvented = evaluateBoundaryV2({
    rawCandidate: 'Estamos na Rua da Outra Unidade, 999.',
    servicesResult: services,
    sourceInboundText: 'Qual o endereço?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    route: 'model',
  });
  assert.equal(
    oldErpInvented.reasonCodes.includes('UNKNOWN_ADDRESS'),
    false,
    'sem businessAddress o bloqueio novo não entra'
  );

  const unregisteredGraceful = evaluateBoundaryV2({
    rawCandidate: GRACEFUL_TEAM_REPLY,
    servicesResult: services,
    sourceInboundText: 'Qual o endereço de vocês?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço de vocês?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: ERP_UNREGISTERED_ADDRESS,
    route: 'model',
  });
  assert.equal(
    unregisteredGraceful.safe,
    true,
    String(unregisteredGraceful.reasonCodes)
  );
  assert.equal(
    unregisteredGraceful.reasonCodes.includes('UNKNOWN_ADDRESS'),
    false,
    'objeto todo-null do ERP não arma UNKNOWN_ADDRESS'
  );

  const unregisteredInvented = evaluateBoundaryV2({
    rawCandidate: 'Estamos na Rua da Outra Unidade, 999.',
    servicesResult: services,
    sourceInboundText: 'Qual o endereço de vocês?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço de vocês?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: ERP_UNREGISTERED_ADDRESS,
    route: 'model',
  });
  assert.equal(
    unregisteredInvented.reasonCodes.includes('UNKNOWN_ADDRESS'),
    false,
    'todo-null não veta invenção — legado do modelo'
  );

  const zipOnlyGraceful = evaluateBoundaryV2({
    rawCandidate: GRACEFUL_TEAM_REPLY,
    servicesResult: services,
    sourceInboundText: 'Qual o endereço de vocês?',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': 'Qual o endereço de vocês?' },
    flowState: { flowId: 'flow-v2', fixedByProofVersion: {} },
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'GENERATED',
    businessAddress: ZIP_ONLY,
    route: 'model',
  });
  assert.equal(zipOnlyGraceful.safe, true, String(zipOnlyGraceful.reasonCodes));
  assert.equal(
    zipOnlyGraceful.reasonCodes.includes('UNKNOWN_ADDRESS'),
    false,
    'só zipCode não arma UNKNOWN_ADDRESS'
  );

  const mixedComposed = composeBusinessAddressComponentV2({
    baseText: 'Pra 16/08/2026 eu tenho 10:00, 11:00. Qual fica melhor pra você?',
    componentText: expectedFull,
  });
  assert.match(mixedComposed, /10:00/);
  assert.match(mixedComposed, /Avenida Paulista, 1000/);

  const runRuntime = async (input: {
    text: string;
    config: TenantBotConfig;
    seedService?: boolean;
    upcoming?: unknown;
    modelReply?: string;
    forceRegenFail?: boolean;
  }) => {
    const store = new MemoryConversationalV2StateStore();
    const conversationKey = buildConversationKey(
      input.config.phoneNumberId,
      '+5511988880000'
    );
    store.setInputSequence(conversationKey, 1);
    if (input.seedService) {
      store.pending.set(conversationKey, [
        {
          conversationKey,
          state: 'RESOLVED',
          snapshot: {
            questionId: nextId(),
            askedAt: now.toISOString(),
            kind: 'SERVICE',
            flowId: 'flow-address',
            version: 1,
            options: [
              {
                position: 1,
                entityId: 'svc-drenagem',
                displayName: 'Drenagem Linfática',
              },
            ],
          },
          flowState: {
            flowId: 'flow-address',
            fixedServiceId: 'svc-drenagem',
            lastOperationalAt: now.toISOString(),
            fixedByProofVersion: { fixedServiceId: 1 },
          },
          updatedAt: now.toISOString(),
        },
      ]);
    }
    const inboundId = nextId();
    let upcomingReads = 0;
    let slotReads = 0;
    let modelLoopCalls = 0;
    const prepared = await getReceptionistReplyV2({
      phone: '+5511988880000',
      userMessage: input.text,
      userName: 'Cliente Fixture',
      config: input.config,
      turnRuntime: {
        turnId: nextId(),
        inputSequence: 1,
        currentInboundIds: [inboundId],
        currentInboundTextsById: { [inboundId]: input.text },
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: 1,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
      },
      deps: {
        store,
        now: () => now,
        id: nextId,
        loadServices: async () => services,
        loadHistory: async () => [],
        isPaused: async () => false,
        executeTool: async (name) => {
          if (name === 'getUpcomingAppointments') {
            upcomingReads += 1;
            if (input.upcoming !== undefined) {
              return JSON.stringify(input.upcoming);
            }
            return JSON.stringify({ success: true, appointments: [] });
          }
          if (name === 'getAvailableSlots') {
            slotReads += 1;
            return JSON.stringify({ success: true, slots: ['10:00', '11:00'] });
          }
          return JSON.stringify({ success: false });
        },
        runModelLoop: async (loopInput) => {
          modelLoopCalls += 1;
          const mixedSlots = /tem\s+vaga/iu.test(input.text);
          const toolTrace: Array<{
            round: number;
            name: string;
            args: Record<string, unknown>;
            argumentsValidJson: boolean;
            result: string;
          }> = [];
          if (mixedSlots) {
            const slots = await loopInput.executeTool('getAvailableSlots', {
              date: '2026-08-16',
              serviceId: 'svc-drenagem',
            });
            toolTrace.push({
              round: 1,
              name: 'getAvailableSlots',
              args: { date: '2026-08-16', serviceId: 'svc-drenagem' },
              argumentsValidJson: true,
              result: slots,
            });
          }
          return {
            rawReply: JSON.stringify({
              reply: mixedSlots
                ? 'Pra 16/08/2026 eu tenho 10:00, 11:00. Qual fica melhor pra você?'
                : input.modelReply ?? 'Posso te ajudar com o agendamento.',
              nextPending: mixedSlots ? 'TIME' : 'PRESERVE',
              chosenOptionText: null,
              unknownServiceText: null,
            }),
            exhausted: false,
            provider: 'openai' as const,
            model: 'gpt-4o-mini',
            providerReportedModels: ['gpt-4o-mini'],
            rounds: 1,
            messages: [],
            toolTrace,
            usage: [],
          };
        },
        ...(input.forceRegenFail
          ? {
              regenerate: async () => ({
                ok: false as const,
                reasonCode: 'REGEN_PROVIDER_ERROR' as const,
                providerCalls: 1 as const,
              }),
            }
          : {}),
      },
    });
    return { prepared, upcomingReads, slotReads, modelLoopCalls };
  };

  const runtimeFull = await runRuntime({
    text: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
  });
  assert.equal(runtimeFull.prepared.payload, expectedFull);
  assert.equal(runtimeFull.prepared.planReceipt.route, 'fast_path');
  assert.equal(runtimeFull.upcomingReads, 0);
  assert.equal(runtimeFull.modelLoopCalls, 0);

  const runtimeOndeFica = await runRuntime({
    text: 'onde fica?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: FULL_ADDRESS,
    }),
  });
  assert.equal(runtimeOndeFica.prepared.payload, expectedCity);
  assert.equal(runtimeOndeFica.upcomingReads, 0);

  const runtimeComoChegar = await runRuntime({
    text: 'como chegar',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
  });
  assert.equal(runtimeComoChegar.prepared.payload, expectedFull);

  const runtimeAposEmpty = await runRuntime({
    text: 'Qual o endereço?',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    upcoming: { success: true, appointments: [] },
  });
  assert.equal(runtimeAposEmpty.prepared.payload, expectedApos);
  assert.equal(runtimeAposEmpty.upcomingReads, 1);
  assert.equal(runtimeAposEmpty.modelLoopCalls, 0);

  const runtimeAposUpcoming = await runRuntime({
    text: 'onde vocês ficam?',
    config: baseConfig({
      directionsMode: 'APOS_CONFIRMACAO',
      businessAddress: FULL_ADDRESS,
    }),
    upcoming: { success: true, appointments: [futureAppointment] },
  });
  assert.equal(runtimeAposUpcoming.prepared.payload, expectedFull);
  assert.equal(runtimeAposUpcoming.upcomingReads, 1);

  const runtimeMissing = await runRuntime({
    text: 'Qual o endereço?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: CITY_ONLY,
    }),
    modelReply: 'Posso te ajudar com o agendamento.',
  });
  assert.equal(runtimeMissing.modelLoopCalls, 1);
  assert.doesNotMatch(runtimeMissing.prepared.payload ?? '', /Estamos em/u);
  assert.doesNotMatch(
    runtimeMissing.prepared.payload ?? '',
    /não tenho essa informação/i
  );

  const runtimeOldErp = await runRuntime({
    text: 'Qual o endereço de vocês?',
    config: baseConfig(),
    modelReply: 'Posso te ajudar com o agendamento.',
  });
  assert.equal(runtimeOldErp.modelLoopCalls, 1);
  assert.equal(runtimeOldErp.upcomingReads, 0);
  assert.doesNotMatch(runtimeOldErp.prepared.payload ?? '', /Estamos em/u);

  const runtimeErpUnregistered = await runRuntime({
    text: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: ERP_UNREGISTERED_ADDRESS,
    }),
    modelReply: GRACEFUL_TEAM_REPLY,
  });
  assert.equal(runtimeErpUnregistered.modelLoopCalls, 1);
  assert.equal(runtimeErpUnregistered.upcomingReads, 0);
  assert.notEqual(runtimeErpUnregistered.prepared.planReceipt.route, 'fast_path');
  assert.equal(runtimeErpUnregistered.prepared.payload, GRACEFUL_TEAM_REPLY);

  const runtimeZipOnly = await runRuntime({
    text: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: ZIP_ONLY,
    }),
    modelReply: GRACEFUL_TEAM_REPLY,
  });
  assert.equal(runtimeZipOnly.modelLoopCalls, 1);
  assert.notEqual(runtimeZipOnly.prepared.planReceipt.route, 'fast_path');
  assert.equal(runtimeZipOnly.prepared.payload, GRACEFUL_TEAM_REPLY);

  const runtimeCityUsable = await runRuntime({
    text: 'Qual o endereço de vocês?',
    config: baseConfig({
      directionsMode: 'SO_CIDADE',
      businessAddress: CITY_WITHOUT_REST,
    }),
  });
  assert.equal(runtimeCityUsable.modelLoopCalls, 0);
  assert.equal(runtimeCityUsable.prepared.planReceipt.route, 'fast_path');
  assert.equal(runtimeCityUsable.prepared.payload, expectedCityWithoutState);

  const runtimeNegative = await runRuntime({
    text: 'não quero o endereço',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
    modelReply: 'Posso te ajudar com o agendamento.',
  });
  assert.equal(runtimeNegative.modelLoopCalls, 1);
  assert.equal(runtimeNegative.upcomingReads, 0);
  assert.doesNotMatch(runtimeNegative.prepared.payload ?? '', /Avenida Paulista/u);

  const runtimeForeign = await runRuntime({
    text: 'qual o endereço do instagram?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
    modelReply: 'Posso te ajudar com o agendamento.',
  });
  assert.equal(runtimeForeign.modelLoopCalls, 1);
  assert.doesNotMatch(runtimeForeign.prepared.payload ?? '', /Avenida Paulista/u);

  const runtimeMixed = await runRuntime({
    text: 'qual o endereço? e tem vaga amanhã?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: FULL_ADDRESS,
    }),
    seedService: true,
  });
  assert.equal(runtimeMixed.slotReads, 1);
  assert.equal(runtimeMixed.upcomingReads, 0);
  assert.match(runtimeMixed.prepared.payload ?? '', /10:00|10h/u);
  assert.match(runtimeMixed.prepared.payload ?? '', /Avenida Paulista, 1000/u);

  const runtimeInvented = await runRuntime({
    text: 'Qual o endereço?',
    config: baseConfig({
      directionsMode: 'ENDERECO_COMPLETO',
      businessAddress: CITY_ONLY,
    }),
    modelReply: 'Estamos na Rua da Outra Unidade, 999.',
    forceRegenFail: true,
  });
  assert.equal(runtimeInvented.modelLoopCalls, 1);
  assert.doesNotMatch(
    runtimeInvented.prepared.payload ?? '',
    /Rua da Outra Unidade/u
  );

  console.log('smoke ana conversational v2 business address: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
