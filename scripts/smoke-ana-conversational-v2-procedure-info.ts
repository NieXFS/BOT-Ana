import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type { TurnFrameV2 } from '../src/services/conversationalV2/contracts';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_procedure_info';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'true';

const now = new Date('2026-08-15T12:00:00.000Z');
let serial = 0;
const nextId = () => `procedure-info-v2-${++serial}`;

const acceptance = {
  clauseVersion: 'responsibility-v1',
  acceptedAt: '2026-08-15T01:00:00.000Z',
};

const drenagemLicense = {
  sourceHash: 'a'.repeat(64),
  policyVersion: 'licensed-service-description-v1' as const,
  clauses: [
    {
      clauseId: 'drenagem-what',
      facet: 'WHAT_IT_IS' as const,
      exactText: 'A drenagem linfática é uma técnica manual suave.',
    },
    {
      clauseId: 'drenagem-how',
      facet: 'HOW_PERFORMED' as const,
      exactText:
        'Ela é realizada com movimentos rítmicos ao longo do corpo.',
    },
  ],
};

const peelingLicense = {
  sourceHash: 'b'.repeat(64),
  policyVersion: 'licensed-service-description-v1' as const,
  clauses: [
    {
      clauseId: 'peeling-what',
      facet: 'WHAT_IT_IS' as const,
      exactText: 'O peeling é uma renovação controlada da superfície da pele.',
    },
  ],
};

const clinicalLicense = {
  sourceHash: 'c'.repeat(64),
  policyVersion: 'licensed-service-description-v1' as const,
  clauses: [
    {
      clauseId: 'clinical-what',
      facet: 'WHAT_IT_IS' as const,
      exactText: 'É seguro para gestantes.',
    },
  ],
};

const longSentenceOne = `${'Movimento ritmado '.repeat(20).trim()}.`;
const longSentenceTwo = `${'Pressão suave '.repeat(28).trim()}.`;
assert.ok(longSentenceOne.length < 700);
assert.ok(longSentenceOne.length + 1 + longSentenceTwo.length > 700);
const budgetLicense = {
  sourceHash: 'd'.repeat(64),
  policyVersion: 'licensed-service-description-v1' as const,
  clauses: [
    {
      clauseId: 'budget-what',
      facet: 'WHAT_IT_IS' as const,
      exactText: 'A massagem longa usa uma sequência contínua de movimentos.',
    },
    {
      clauseId: 'budget-how-1',
      facet: 'HOW_PERFORMED' as const,
      exactText: longSentenceOne,
    },
    {
      clauseId: 'budget-how-2',
      facet: 'HOW_PERFORMED' as const,
      exactText: longSentenceTwo,
    },
  ],
};

const rawServices: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 45,
      price: 150,
      priceFormatted: 'R$ 150,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-clinical',
      name: 'Procedimento Clínico',
      durationMinutes: 30,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-budget',
      name: 'Massagem Longa',
      durationMinutes: 60,
      price: 200,
      priceFormatted: 'R$ 200,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

function authoritativeServices(withDrenagem = true) {
  return rawServices.services!.map((service) => ({
    id: service.id,
    name: service.name,
    priceCents: Math.round((service.price ?? 0) * 100),
    durationMinutes: service.durationMinutes,
    professionalIds: service.professionalIds,
    licensedDescription:
      service.id === 'svc-drenagem'
        ? withDrenagem
          ? drenagemLicense
          : null
        : service.id === 'svc-peeling'
          ? peelingLicense
          : service.id === 'svc-clinical'
            ? clinicalLicense
            : budgetLicense,
  }));
}

function config(withDrenagem = true): TenantBotConfig {
  return {
    contractVersion: 2,
    tenantSlug: `fixture-procedure-${withDrenagem ? 'licensed' : 'empty'}`,
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
    phoneNumberId: `PN-PROCEDURE-${withDrenagem ? 'LICENSED' : 'EMPTY'}`,
    isActive: true,
    descriptionTermAcceptance: acceptance,
    authoritativeCatalog: {
      services: authoritativeServices(withDrenagem),
      professionals: [{ id: 'prof-carla', name: 'Carla Mendes', active: true }],
    },
  };
}

function frame(input: {
  fixedServiceId?: string;
  pending?: boolean;
  bookingDraft?: boolean;
} = {}): TurnFrameV2 {
  const flowId = nextId();
  const fixedServiceId = input.fixedServiceId;
  return {
    schemaVersion: 2,
    turnId: nextId(),
    inputSequence: 1,
    catalogSnapshotHash: 'f'.repeat(64),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: [nextId()],
    pending: input.pending
      ? {
          questionId: nextId(),
          askedAt: now.toISOString(),
          kind: 'DATE',
          flowId,
          version: 1,
          options: [{ position: 1, entityId: 'date-freeform', displayName: 'Data' }],
        }
      : null,
    flowState: {
      flowId,
      ...(fixedServiceId ? { fixedServiceId } : {}),
      ...(fixedServiceId && input.bookingDraft
        ? {
            bookingDraft: {
              serviceId: fixedServiceId,
              date: '2026-08-16',
              time: '10:00',
              slotEvidenceTurnId: nextId(),
            },
          }
        : {}),
      fixedByProofVersion: fixedServiceId ? { fixedServiceId: 1 } : {},
    },
  };
}

async function main(): Promise<void> {
  const procedure = await import(
    '../src/services/conversationalV2/procedureInfo'
  );
  const boundary = await import('../src/services/conversationalV2/boundary');
  const regenerator = await import(
    '../src/services/conversationalV2/regenerator'
  );
  const escalation = await import('../src/services/questionEscalation');
  const runtime = await import('../src/services/conversationalV2/runtime');
  const stateStore = await import('../src/services/conversationalV2/stateStore');
  const context = await import('../src/services/contextManager');

  const licensedServices = procedure.hydrateLicensedServiceDescriptionsV2({
    servicesResult: rawServices,
    authoritativeCatalog: config(true).authoritativeCatalog,
    termAcceptance: acceptance,
    contractVersion: 2,
  });
  const unlicensedServices = procedure.hydrateLicensedServiceDescriptionsV2({
    servicesResult: rawServices,
    authoritativeCatalog: config(false).authoritativeCatalog,
    termAcceptance: acceptance,
    contractVersion: 2,
  });
  const unacceptedServices = procedure.hydrateLicensedServiceDescriptionsV2({
    servicesResult: rawServices,
    authoritativeCatalog: config(true).authoritativeCatalog,
    termAcceptance: null,
    contractVersion: 2,
  });
  assert.equal(
    unacceptedServices.services?.find((entry) => entry.id === 'svc-drenagem')
      ?.licensedDescription,
    null,
    'descrição sem termo aceito fica unavailable_for_ana'
  );
  assert.equal(
    procedure.decideProcedureInfoV2({
      inboundText: 'Como funciona a Drenagem?',
      frame: frame(),
      servicesResult: unacceptedServices,
    }).decision.kind,
    'escalate',
    'termo ausente precisa seguir exatamente o fluxo de descrição indisponível'
  );
  const malformedFacetOrder = procedure.hydrateLicensedServiceDescriptionsV2({
    servicesResult: rawServices,
    authoritativeCatalog: {
      ...config(true).authoritativeCatalog!,
      services: authoritativeServices(true).map((service) =>
        service.id === 'svc-drenagem'
          ? {
              ...service,
              licensedDescription: {
                ...drenagemLicense,
                clauses: [
                  {
                    clauseId: 'drenagem-how-first',
                    facet: 'HOW_PERFORMED' as const,
                    exactText: 'Ela é realizada com movimentos suaves.',
                  },
                ],
              },
            }
          : service
      ),
    },
    termAcceptance: acceptance,
    contractVersion: 2,
  });
  assert.equal(
    malformedFacetOrder.services?.find(
      (entry) => entry.id === 'svc-drenagem'
    )?.licensedDescription,
    null,
    'faceta fora da ordem v1 torna a descrição inteira indisponível'
  );
  const descriptionWithPii = procedure.hydrateLicensedServiceDescriptionsV2({
    servicesResult: rawServices,
    authoritativeCatalog: {
      ...config(true).authoritativeCatalog!,
      services: authoritativeServices(true).map((service) =>
        service.id === 'svc-drenagem'
          ? {
              ...service,
              licensedDescription: {
                ...drenagemLicense,
                clauses: [
                  {
                    clauseId: 'drenagem-what-pii',
                    facet: 'WHAT_IT_IS' as const,
                    exactText: 'Contato: equipe@fixture.invalid.',
                  },
                ],
              },
            }
          : service
      ),
    },
    termAcceptance: acceptance,
    contractVersion: 2,
  });
  assert.equal(
    descriptionWithPii.services?.find(
      (entry) => entry.id === 'svc-drenagem'
    )?.licensedDescription,
    null,
    'PII técnico torna a descrição inteira indisponível'
  );
  const modelVisibleServices = runtime.__modelVisibleServicesForSmokeV2(
    licensedServices
  );
  assert.doesNotMatch(
    JSON.stringify(modelVisibleServices),
    /movimentos rítmicos ao longo do corpo/u
  );
  const regenerationMessages = regenerator.buildRegenerationMessagesV2(
    {
      frame: frame(),
      catalogSnapshot: {
        services: modelVisibleServices.services ?? [],
        professionals: modelVisibleServices.professionals ?? [],
      },
      messages: [],
      rejectedCandidate: 'Resposta rejeitada.',
    },
    ['MODEL_RESULT_INVALID']
  );
  assert.doesNotMatch(
    JSON.stringify(regenerationMessages),
    /movimentos rítmicos ao longo do corpo/u
  );

  const how = procedure.decideProcedureInfoV2({
    inboundText: 'Como funciona a Drenagem?',
    frame: frame(),
    servicesResult: licensedServices,
  });
  assert.deepEqual(how.decision, {
    kind: 'answer_from_license',
    serviceId: 'svc-drenagem',
    requestedFacets: ['HOW_PERFORMED'],
    clauseIds: ['drenagem-how'],
  });
  assert.equal(how.requiresOperationalContinuation, false);
  assert.equal(
    procedure.decideProcedureInfoV2({
      inboundText: 'Como funciona a Drenagem(',
      frame: frame(),
      servicesResult: licensedServices,
    }).decision.kind,
    'answer_from_license',
    'pontuação malformada não transforma pergunta procedural em fallback'
  );

  const missing = procedure.decideProcedureInfoV2({
    inboundText: 'Como funciona a Drenagem?',
    frame: frame(),
    servicesResult: unlicensedServices,
  });
  assert.deepEqual(missing.decision, {
    kind: 'escalate',
    reasonCode: 'UNCADASTRED_INFO',
    topicCode: 'PROCEDURE_INFO',
    serviceId: 'svc-drenagem',
    requestedFacets: ['HOW_PERFORMED'],
    uncoveredFacets: ['HOW_PERFORMED'],
  });

  const anaphoric = procedure.decideProcedureInfoV2({
    inboundText: 'Certo, mas queria saber como funciona o procedimento',
    frame: frame({ fixedServiceId: 'svc-drenagem', pending: true }),
    servicesResult: licensedServices,
  });
  assert.equal(anaphoric.decision.kind, 'answer_from_license');
  assert.equal(
    anaphoric.decision.kind === 'answer_from_license'
      ? anaphoric.decision.serviceId
      : null,
    'svc-drenagem'
  );
  assert.equal(
    procedure.decideProcedureInfoV2({
      inboundText: 'Certo, mas queria saber como funciona o procedimento',
      frame: frame({ fixedServiceId: 'svc-drenagem' }),
      servicesResult: licensedServices,
    }).decision.kind,
    'none',
    'histórico/fixedServiceId sem PendingFrame ou BookingDraft não ancora anáfora'
  );
  assert.equal(
    procedure.decideProcedureInfoV2({
      inboundText: 'Certo, mas queria saber como funciona esse tratamento',
      frame: frame({ fixedServiceId: 'svc-drenagem', bookingDraft: true }),
      servicesResult: licensedServices,
    }).decision.kind,
    'answer_from_license'
  );

  for (const operational of [
    'Como funciona o agendamento da Drenagem?',
    'Como funciona o pagamento da Drenagem?',
    'Como funciona a sessão de amanhã da Drenagem?',
  ]) {
    assert.equal(
      procedure.decideProcedureInfoV2({
        inboundText: operational,
        frame: frame(),
        servicesResult: licensedServices,
      }).decision.kind,
      'none',
      operational
    );
  }

  const peelingWhat = procedure.decideProcedureInfoV2({
    inboundText: 'O que é peeling?',
    frame: frame(),
    servicesResult: licensedServices,
  });
  assert.equal(peelingWhat.decision.kind, 'answer_from_license');
  assert.deepEqual(
    peelingWhat.decision.kind === 'answer_from_license'
      ? peelingWhat.decision.clauseIds
      : [],
    ['peeling-what']
  );
  const peelingHow = procedure.decideProcedureInfoV2({
    inboundText: 'Como é feito o peeling?',
    frame: frame(),
    servicesResult: licensedServices,
  });
  assert.deepEqual(peelingHow.decision, {
    kind: 'escalate',
    reasonCode: 'UNCADASTRED_INFO',
    topicCode: 'PROCEDURE_INFO',
    serviceId: 'svc-peeling',
    requestedFacets: ['HOW_PERFORMED'],
    uncoveredFacets: ['HOW_PERFORMED'],
  });

  const budgetDecision = procedure.decideProcedureInfoV2({
    inboundText: 'Como funciona a Massagem Longa?',
    frame: frame(),
    servicesResult: licensedServices,
  });
  assert.equal(budgetDecision.decision.kind, 'answer_from_license');
  assert.deepEqual(
    budgetDecision.decision.kind === 'answer_from_license'
      ? budgetDecision.decision.clauseIds
      : [],
    ['budget-how-1']
  );
  const budgetMaterialized =
    budgetDecision.decision.kind === 'answer_from_license'
      ? procedure.materializeProcedureInfoAnswerV2({
          decision: budgetDecision.decision,
          servicesResult: licensedServices,
          termAcceptance: acceptance,
        })
      : null;
  assert.equal(budgetMaterialized?.text, longSentenceOne);
  assert.ok((budgetMaterialized?.text.length ?? Infinity) <= 700);
  assert.doesNotMatch(budgetMaterialized?.text ?? '', /Pressão suave/u);

  assert.equal(how.decision.kind, 'answer_from_license');
  if (how.decision.kind !== 'answer_from_license') throw new Error('unreachable');
  const materialized = procedure.materializeProcedureInfoAnswerV2({
    decision: how.decision,
    servicesResult: licensedServices,
    termAcceptance: acceptance,
  });
  assert.ok(materialized);
  const exactBoundary = boundary.evaluateBoundaryV2({
    rawCandidate: materialized!.text,
    servicesResult: licensedServices,
    sourceInboundText: 'Como funciona a Drenagem?',
    flowState: frame().flowState,
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    outboundEvidence: {
      licensedServiceDescription: materialized!.evidence,
    },
  });
  assert.equal(
    exactBoundary.safe,
    true,
    `descrição licenciada legítima foi rejeitada: ${exactBoundary.reasonCodes.join(',')}`
  );
  assert.equal(exactBoundary.acceptedPayload, materialized!.text);
  const mutatedBoundary = boundary.evaluateBoundaryV2({
    rawCandidate: materialized!.text.replace('rítmicos', 'suaves'),
    servicesResult: licensedServices,
    sourceInboundText: 'Como funciona a Drenagem?',
    flowState: frame().flowState,
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    outboundEvidence: {
      licensedServiceDescription: materialized!.evidence,
    },
  });
  assert.equal(mutatedBoundary.safe, false);
  assert.ok(
    mutatedBoundary.reasonCodes.includes('UNLICENSED_SERVICE_DESCRIPTION') ||
      mutatedBoundary.reasonCodes.includes('PAYLOAD_BLOCK_MISMATCH')
  );

  const clinicalDecision = procedure.decideProcedureInfoV2({
    inboundText: 'O que é o Procedimento Clínico?',
    frame: frame(),
    servicesResult: licensedServices,
  });
  assert.equal(clinicalDecision.decision.kind, 'answer_from_license');
  if (clinicalDecision.decision.kind !== 'answer_from_license') {
    throw new Error('unreachable');
  }
  const clinicalMaterialized = procedure.materializeProcedureInfoAnswerV2({
    decision: clinicalDecision.decision,
    servicesResult: licensedServices,
    termAcceptance: acceptance,
  })!;
  const clinicalBoundary = boundary.evaluateBoundaryV2({
    rawCandidate: clinicalMaterialized.text,
    servicesResult: licensedServices,
    sourceInboundText: 'O que é o Procedimento Clínico?',
    flowState: frame().flowState,
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    outboundEvidence: {
      licensedServiceDescription: clinicalMaterialized.evidence,
    },
  });
  assert.equal(
    clinicalBoundary.safe,
    true,
    'termo + igualdade exata autorizam a cláusula clínica aceita pelo tenant'
  );

  const falseWriteText = 'Seu agendamento foi confirmado.';
  const falseWriteLicense = {
    sourceHash: 'e'.repeat(64),
    policyVersion: 'licensed-service-description-v1' as const,
    clauses: [
      {
        clauseId: 'drenagem-false-write',
        facet: 'WHAT_IT_IS' as const,
        exactText: falseWriteText,
      },
    ],
  };
  const falseWriteServices: ServicesResult = {
    ...licensedServices,
    services: licensedServices.services?.map((service) =>
      service.id === 'svc-drenagem'
        ? { ...service, licensedDescription: falseWriteLicense }
        : service
    ),
  };
  const falseWriteBoundary = boundary.evaluateBoundaryV2({
    rawCandidate: falseWriteText,
    servicesResult: falseWriteServices,
    sourceInboundText: 'O que é drenagem?',
    flowState: frame().flowState,
    pendingTransitionCandidate: { kind: 'preserve' },
    replyPurpose: 'OPERATIONAL_ANSWER',
    source: 'CANONICAL',
    outboundEvidence: {
      licensedServiceDescription: {
        serviceId: 'svc-drenagem',
        sourceHash: falseWriteLicense.sourceHash,
        policyVersion: falseWriteLicense.policyVersion,
        clauseIds: ['drenagem-false-write'],
        exactText: falseWriteText,
        termAcceptance: acceptance,
      },
    },
  });
  assert.equal(
    falseWriteBoundary.safe,
    false,
    'termo não licencia claim de write sem success:true no turno'
  );
  assert.ok(falseWriteBoundary.reasonCodes.includes('FALSE_WRITE_CLAIM'));

  let topicCalls = 0;
  const retryOutcome = await escalation.escalateQuestion(
    {
      phoneNumberId: 'PN-RETRY',
      customerPhone: '+5511999999999',
      reasonCode: 'UNCADASTRED_INFO',
      topicCode: 'PROCEDURE_INFO',
      messageId: nextId(),
    },
    {
      post: async (posted) => {
        topicCalls += 1;
        if (topicCalls === 1) {
          assert.equal(posted.topicCode, 'PROCEDURE_INFO');
          throw {
            response: {
              status: 400,
              data: { error: 'Unrecognized key: topicCode' },
            },
          };
        }
        assert.equal(posted.topicCode, undefined);
        return { questionId: 'question-retry-v1', version: 1 };
      },
    }
  );
  assert.deepEqual(retryOutcome, {
    kind: 'created',
    questionId: 'question-retry-v1',
  });
  assert.equal(topicCalls, 2);

  const runRuntime = async (input: {
    text: string;
    activeConfig: TenantBotConfig;
    mixed?: boolean;
    attemptWrite?: boolean;
  }) => {
    const store = new stateStore.MemoryConversationalV2StateStore();
    const conversationKey = context.buildConversationKey(
      input.activeConfig.phoneNumberId,
      '+5511988880000'
    );
    store.setInputSequence(conversationKey, 1);
    const inboundId = nextId();
    let reads = 0;
    let writesReachedAdapter = 0;
    let escalations = 0;
    const prepared = await runtime.getReceptionistReplyV2({
      phone: '+5511988880000',
      userMessage: input.text,
      userName: 'Cliente Fixture',
      config: input.activeConfig,
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
        loadServices: async () => rawServices,
        loadHistory: async () => [],
        isPaused: async () => false,
        executeTool: async (name) => {
          if (name === 'getAvailableSlots') {
            reads += 1;
            return JSON.stringify({ success: true, slots: ['10:00', '11:00'] });
          }
          if (name === 'bookAppointment' || name === 'cancelAppointment') {
            writesReachedAdapter += 1;
            return JSON.stringify({ success: true });
          }
          return JSON.stringify({ success: false });
        },
        runModelLoop: async (loopInput) => {
          const prompt = loopInput.messages
            .map((message) =>
              typeof message.content === 'string' ? message.content : ''
            )
            .join('\n');
          assert.doesNotMatch(prompt, /movimentos rítmicos ao longo do corpo/u);
          assert.match(prompt, /COMPONENTE PROCEDURAL SERVER-OWNED/u);
          const slots = await loopInput.executeTool('getAvailableSlots', {
            date: '2026-08-16',
            serviceId: 'svc-drenagem',
          });
          const toolTrace = [
            {
              round: 1,
              name: 'getAvailableSlots',
              args: { date: '2026-08-16', serviceId: 'svc-drenagem' },
              argumentsValidJson: true,
              result: slots,
            },
          ];
          if (input.attemptWrite) {
            const blocked = await loopInput.executeTool('bookAppointment', {
              serviceId: 'svc-drenagem',
              date: '2026-08-16',
              time: '10:00',
            });
            assert.equal(
              (JSON.parse(blocked) as { success?: unknown }).success,
              false,
              'escalada planejada bloqueia write antes do adapter'
            );
            toolTrace.push({
              round: 1,
              name: 'bookAppointment',
              args: {
                serviceId: 'svc-drenagem',
                date: '2026-08-16',
                time: '10:00',
              },
              argumentsValidJson: true,
              result: blocked,
            });
          }
          return {
            rawReply: JSON.stringify({
              reply:
                'Obrigada! Encontrei horários para 16/08/2026: 10:00, 11:00. Qual você prefere?',
              nextPending: 'TIME',
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
        escalateProcedure: async () => {
          escalations += 1;
          return {
            matched: true,
            reply: 'Vou avisar a equipe responsável pelo atendimento.',
            actionRecorded: true,
            questionId: `question-procedure-${escalations}`,
            outcome: 'created',
          };
        },
      },
    });
    return { prepared, reads, writesReachedAdapter, escalations };
  };

  const pureLicensed = await runRuntime({
    text: 'Como funciona a Drenagem?',
    activeConfig: config(true),
  });
  assert.equal(pureLicensed.reads, 0);
  assert.equal(pureLicensed.prepared.payload, drenagemLicense.clauses[1]!.exactText);
  assert.equal(pureLicensed.prepared.planReceipt.route, 'fast_path');

  const pureEscalated = await runRuntime({
    text: 'Como funciona a Drenagem?',
    activeConfig: config(false),
  });
  assert.equal(pureEscalated.escalations, 1);
  assert.equal(
    pureEscalated.prepared.payload,
    'Vou avisar a equipe responsável pelo atendimento.'
  );
  assert.equal(
    pureEscalated.prepared.authoritativeEscalationQuestionId,
    'question-procedure-1'
  );

  const mixedLicensed = await runRuntime({
    text: 'obrigada! como funciona a drenagem? tem vaga amanhã?',
    activeConfig: config(true),
    mixed: true,
  });
  assert.equal(mixedLicensed.reads, 1);
  assert.equal(mixedLicensed.writesReachedAdapter, 0);
  assert.match(mixedLicensed.prepared.payload ?? '', /10h e 11h/u);
  assert.match(
    mixedLicensed.prepared.payload ?? '',
    new RegExp(drenagemLicense.clauses[1]!.exactText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')
  );

  const mixedEscalated = await runRuntime({
    text: 'obrigada! como funciona a drenagem? tem vaga amanhã?',
    activeConfig: config(false),
    mixed: true,
    attemptWrite: true,
  });
  assert.equal(mixedEscalated.reads, 1);
  assert.equal(mixedEscalated.writesReachedAdapter, 0);
  assert.equal(mixedEscalated.escalations, 1);
  assert.equal(mixedEscalated.prepared.hasCommittedWrite, false);
  assert.match(mixedEscalated.prepared.payload ?? '', /10h e 11h/u);
  assert.match(
    mixedEscalated.prepared.payload ?? '',
    /Vou avisar a equipe responsável pelo atendimento\./u
  );
  assert.equal(
    mixedEscalated.prepared.authoritativeEscalationQuestionId,
    'question-procedure-1'
  );

  console.log(
    '✅ Ana conversational v2 procedure info: decisão, licença exata, boundary, retry e composição mista verificados.'
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
