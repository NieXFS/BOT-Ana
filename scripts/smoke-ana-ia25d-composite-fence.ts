import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServiceSummary, ServicesResult } from '../src/services/calendarService';
import {
  clearSemanticServiceResolverCache,
  parseAndValidateSemanticServiceDecision,
  resolveSemanticService,
  SEMANTIC_SERVICE_RESOLVER_SYSTEM_PROMPT,
  type SemanticServiceCompletionFactory,
} from '../src/services/conversationalV2/semanticServiceResolver';
import {
  deriveCompositeAuthorityV2,
  licenseCompositeDecisionV2,
  type CompositeAuthorityV2,
} from '../src/services/conversationalV2/compositeFence';
import {
  buildReceptionistCompletionRequest,
  resolveReceptionistAiRuntime,
} from '../src/services/receptionistLlmProvider';

process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ??= 'sk-openai-smoke-invalid';
process.env.DEEPSEEK_API_KEY ??= 'sk-deepseek-smoke-invalid';
process.env.NODE_ENV = 'test';

const MANICURE_ID = '11111111-1111-4111-8111-111111111111';
const COMBO_ID = '22222222-2222-4222-8222-222222222222';
const PEDICURE_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDE_ID = '44444444-4444-4444-8444-444444444444';
const LAYER_A = [MANICURE_ID, COMBO_ID, PEDICURE_ID] as const;

function service(id: string, name: string): ServiceSummary {
  return {
    id,
    name,
    durationMinutes: 30,
    price: null,
    priceFormatted: null,
    aliases: [],
  };
}

const catalog: ServicesResult = {
  success: true,
  services: [
    service(MANICURE_ID, 'Manicure'),
    service(COMBO_ID, 'Manicure e pedicure'),
    service(PEDICURE_ID, 'Pedicure'),
  ],
};

const runtimeCatalog: ServicesResult = {
  success: true,
  services: [
    service(MANICURE_ID, 'Manicure'),
    service(PEDICURE_ID, 'Pedicure'),
    service(COMBO_ID, 'Manicure e pedicure'),
    service('ia25d-manicure-traditional', 'Manicure tradicional'),
    service('ia25d-pedicure-traditional', 'Pedicure tradicional'),
    service('ia25d-reposicao', 'Reposição de unha'),
    service('ia25d-unha-infantil', 'Unha infantil'),
    ...Array.from({ length: 100 }, (_, index) =>
      service(
        `ia25d-filler-${String(index + 1).padStart(3, '0')}`,
        `Serviço de laboratório ${index + 1}`
      )
    ),
  ],
  professionals: [{ id: 'ia25d-professional', name: 'Profissional de fixture' }],
};

const config = {
  tenantSlug: 'ia25d-smoke',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.2,
  aiMaxTokens: 500,
  openaiApiKey: 'sk-openai-must-not-be-used',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: 'ia25d-smoke-phone',
  isActive: true,
} as TenantBotConfig;

const plannerPolicy = {
  mode: 'planner_authorized' as const,
  attemptedInvocationReason: 'positive_reclarification' as const,
  candidateServiceIds: [...LAYER_A],
  preservePlanOnFailure: true as const,
};

const plannerDeterministic = {
  kind: 'ambiguous' as const,
  reason: 'shared_partial' as const,
  serviceIds: [...LAYER_A],
  services: catalog.services!,
  clarification: 'fixture',
};

const directPolicy = {
  mode: 'direct_unresolved' as const,
  attemptedInvocationReason: 'direct_unresolved' as const,
  preservePlanOnFailure: false as const,
};

const directNoMatch = {
  kind: 'no_match' as const,
  reason: 'no_match' as const,
};

function completion(
  content: string,
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] = 'stop'
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'ia25d-completion',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      finish_reason: finishReason,
      logprobs: null,
      message: { role: 'assistant', content, refusal: null },
    }],
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function decision(input: {
  decision: 'resolved' | 'ambiguous' | 'none';
  serviceId: string | null;
  candidateServiceIds: string[];
  evidenceText: string;
  resolutionBasis?: 'direct' | 'composite';
  componentEvidenceTexts?: string[];
}): string {
  return JSON.stringify({
    ...input,
    resolutionBasis: input.resolutionBasis ?? 'direct',
    componentEvidenceTexts: input.componentEvidenceTexts ?? [],
  });
}

function requestPayload(
  request: Parameters<SemanticServiceCompletionFactory>[0]
): Record<string, unknown> {
  const raw = request.messages.at(-1)?.content;
  assert.equal(typeof raw, 'string', 'completion payload deve ser JSON string');
  return JSON.parse(raw as string) as Record<string, unknown>;
}

function payloadCatalogIds(payload: Record<string, unknown>): string[] {
  assert.ok(Array.isArray(payload.catalog));
  return (payload.catalog as Array<Record<string, unknown>>).map((entry) => {
    assert.equal(typeof entry.id, 'string');
    return entry.id as string;
  });
}

async function assertRequestCatalogPropagation(): Promise<{
  plannerAuthorized: string[];
  directUnresolved: string[];
}> {
  const propagationIds = {
    a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    c: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    d: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  } as const;
  const tenantCatalog: ServicesResult = {
    success: true,
    services: [
      service(propagationIds.a, 'Serviço A'),
      service(propagationIds.b, 'Serviço B'),
      service(propagationIds.c, 'Serviço C'),
      service(propagationIds.d, 'Serviço D'),
    ],
  };
  const directTenantCatalog: ServicesResult = {
    ...tenantCatalog,
    services: tenantCatalog.services?.slice(0, 3),
  };
  const deterministicNoMatch = {
    kind: 'no_match' as const,
    reason: 'no_match' as const,
  };
  const plannerPolicy = {
    mode: 'planner_authorized' as const,
    attemptedInvocationReason: 'positive_reclarification' as const,
    candidateServiceIds: [propagationIds.a, propagationIds.b],
    preservePlanOnFailure: true as const,
  };
  const directPolicy = {
    mode: 'direct_unresolved' as const,
    attemptedInvocationReason: 'direct_unresolved' as const,
    preservePlanOnFailure: false as const,
  };

  let plannerPayload: Record<string, unknown> | null = null;
  clearSemanticServiceResolverCache();
  const plannerOutcome = await resolveSemanticService({
    tenantSlug: config.tenantSlug,
    currentBatch: 'pé e mão',
    catalog: tenantCatalog,
    config,
    deterministicResult: deterministicNoMatch,
    invocationPolicy: plannerPolicy,
    completionFactory: async (request) => {
      plannerPayload = requestPayload(request);
      return completion(
        decision({
          decision: 'none',
          serviceId: null,
          candidateServiceIds: [],
          evidenceText: '',
        })
      );
    },
  });
  assert.equal(plannerOutcome.receipt.status, 'none');
  assert.equal(plannerOutcome.receipt.providerCallCount, 1);
  if (!plannerPayload) throw new Error('planner completion não recebeu payload');
  assert.deepEqual(payloadCatalogIds(plannerPayload), [
    propagationIds.a,
    propagationIds.b,
  ]);
  assert.equal(plannerPayload.candidateSetMode, 'planner_authorized');
  assert.equal(
    Object.prototype.hasOwnProperty.call(plannerPayload, 'candidateServiceIds'),
    false,
    'planner payload não duplica candidateServiceIds'
  );

  let directPayload: Record<string, unknown> | null = null;
  clearSemanticServiceResolverCache();
  const directOutcome = await resolveSemanticService({
    tenantSlug: config.tenantSlug,
    currentBatch: 'pé e mão',
    catalog: directTenantCatalog,
    config,
    deterministicResult: deterministicNoMatch,
    invocationPolicy: directPolicy,
    completionFactory: async (request) => {
      directPayload = requestPayload(request);
      return completion(
        decision({
          decision: 'none',
          serviceId: null,
          candidateServiceIds: [],
          evidenceText: '',
        })
      );
    },
  });
  assert.equal(directOutcome.receipt.status, 'none');
  assert.equal(directOutcome.receipt.providerCallCount, 1);
  if (!directPayload) throw new Error('direct completion não recebeu payload');
  assert.deepEqual(payloadCatalogIds(directPayload), [
    propagationIds.a,
    propagationIds.b,
    propagationIds.c,
  ]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(directPayload, 'candidateSetMode'),
    false,
    'direct_unresolved não recebe narrowing artificial'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(directPayload, 'candidateServiceIds'),
    false,
    'direct payload não duplica candidateServiceIds'
  );

  return {
    plannerAuthorized: payloadCatalogIds(plannerPayload),
    directUnresolved: payloadCatalogIds(directPayload),
  };
}

function compositeDecision(
  text: string,
  components: string[],
  serviceId = COMBO_ID
): string {
  return decision({
    decision: 'resolved',
    serviceId,
    candidateServiceIds: [serviceId],
    evidenceText: text,
    resolutionBasis: 'composite',
    componentEvidenceTexts: components,
  });
}

function fence(input: {
  text: string;
  components: string[];
  serviceId?: string | null;
  candidates?: readonly string[];
  authority?: CompositeAuthorityV2 | null;
}) {
  const authority =
    input.authority ?? {
      source: 'planner_candidates' as const,
      serviceIds: new Set(input.candidates ?? LAYER_A),
    };
  return licenseCompositeDecisionV2({
    decision: {
      decision: 'resolved',
      serviceId: input.serviceId === undefined ? COMBO_ID : input.serviceId,
      resolutionBasis: 'composite',
      componentEvidenceTexts: input.components,
    },
    currentBatch: input.text,
    authority,
  });
}

function assertPromptContract(): void {
  for (const fragment of [
    'resolutionBasis ("direct" ou "composite")',
    'ORDEM DECISÓRIA: 1. determine grupos locais de polaridade',
    'ANTES de qualquer outra decisão, verifique a polaridade. Trechos sob negação não são evidência positiva',
    'não existe intenção positiva de serviço: retorne decision="none", serviceId=null, candidateServiceIds=[] e evidenceText=""',
    'Nunca use ambiguous apenas para representar ausência de evidência positiva',
    'Uma correção posterior reabre a polaridade',
    'Nunca coloque um trecho negado em evidenceText.',
    'Use composite SOMENTE',
    'Em composite, componentEvidenceTexts deve conter os MENORES',
    'Quando os componentes explícitos positivos estiverem presentes',
    'Um termo genérico ou guarda-chuva conta como UM único componente',
    'Com um único componente positivo',
    'Alternativas com "ou" não são composição.',
    'Em resolução direct, componentEvidenceTexts deve ser um array vazio.',
  ]) {
    assert.equal(
      SEMANTIC_SERVICE_RESOLVER_SYSTEM_PROMPT.includes(fragment),
      true,
      fragment
    );
  }
}

function assertThinkingDisabledAtAdapter(): void {
  const runtime = resolveReceptionistAiRuntime(config);
  const request = buildReceptionistCompletionRequest(runtime, {
    messages: [{ role: 'user', content: 'fixture' }],
    tools: [],
    temperature: 0.1,
    maxTokens: 160,
    thinkingMode: 'disabled',
    responseFormat: 'json_object',
  });
  assert.deepEqual((request as { thinking?: unknown }).thinking, {
    type: 'disabled',
  });
  assert.deepEqual(request.tools, []);
  assert.deepEqual(
    (request as { response_format?: unknown }).response_format,
    { type: 'json_object' }
  );
  assert.equal(request.model, 'deepseek-v4-flash');
}

async function resolveWith(
  text: string,
  output: string | OpenAI.Chat.Completions.ChatCompletion,
  calls: { value: number }
) {
  clearSemanticServiceResolverCache();
  const completionFactory: SemanticServiceCompletionFactory = async () => {
    calls.value += 1;
    return typeof output === 'string' ? completion(output) : output;
  };
  return resolveSemanticService({
    tenantSlug: config.tenantSlug,
    currentBatch: text,
    catalog,
    config,
    deterministicResult: plannerDeterministic,
    invocationPolicy: plannerPolicy,
    completionFactory,
    now: () => 1_000,
  });
}

async function resolveDirectWith(
  text: string,
  output: string | OpenAI.Chat.Completions.ChatCompletion,
  calls: { value: number },
  input: {
    catalog?: ServicesResult;
    deterministicResult?: typeof directNoMatch | typeof plannerDeterministic;
  } = {}
) {
  clearSemanticServiceResolverCache();
  const completionFactory: SemanticServiceCompletionFactory = async () => {
    calls.value += 1;
    return typeof output === 'string' ? completion(output) : output;
  };
  return resolveSemanticService({
    tenantSlug: config.tenantSlug,
    currentBatch: text,
    catalog: input.catalog ?? catalog,
    config,
    deterministicResult: input.deterministicResult ?? directNoMatch,
    invocationPolicy: directPolicy,
    completionFactory,
    now: () => 1_000,
  });
}

function runtimeTurn(
  sequence: number,
  id: string,
  texts: readonly string[]
) {
  const inboundIds = texts.map((_text, index) => `ia25d-${id}-in-${index + 1}`);
  return {
    turnId: `ia25d-${id}-turn`,
    inputSequence: sequence,
    currentInboundIds: inboundIds,
    currentInboundTextsById: Object.fromEntries(
      inboundIds.map((inboundId, index) => [inboundId, texts[index] ?? ''])
    ),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

async function runPlannerAuthorizedEnvelopeScenario(output: string) {
  clearSemanticServiceResolverCache();
  const [runtime, stateStore, delivery] = await Promise.all([
    import('../src/services/conversationalV2/runtime'),
    import('../src/services/conversationalV2/stateStore'),
    import('../src/services/conversationalV2/delivery'),
  ]);
  const store = new stateStore.MemoryConversationalV2StateStore();
  const customer = 'ia25d-runtime-customer';
  const now = new Date('2026-08-24T15:00:00.000Z');
  const counters = {
    semantic: 0,
    primary: 0,
    regeneration: 0,
    tools: 0,
  };

  const semanticFactory: SemanticServiceCompletionFactory = async (request) => {
    counters.semantic += 1;
    assert.deepEqual(request.tools, []);
    assert.equal(request.thinkingMode, 'disabled');
    assert.equal(request.responseFormat, 'json_object');
    assert.equal(request.provider, 'deepseek');
    assert.equal(request.model, 'deepseek-v4-flash');
    assert.equal(request.messages.length, 2);
    return completion(output);
  };

  const runTurn = async (input: {
    sequence: number;
    id: string;
    texts: readonly string[];
    semantic: boolean;
  }) => runtime.getReceptionistReplyV2({
    phone: customer,
    userMessage: input.texts.at(-1) ?? '',
    userName: 'fixture',
    config,
    serviceContextEnabled: true,
    serviceResolverEnabled: true,
    semanticServiceResolverEnabled: input.semantic,
    turnRuntime: runtimeTurn(input.sequence, input.id, input.texts),
    deps: {
      store,
      now: () => now,
      id: () => `ia25d-${input.id}-id`,
      loadServices: async () => runtimeCatalog,
      loadHistory: async () => [],
      isPaused: async () => false,
      semanticServiceCompletionFactory: semanticFactory,
      escalate: async () => ({ matched: false }),
      escalateSilent: async () => ({ kind: 'pending' as const }),
      runModelLoop: async () => {
        counters.primary += 1;
        throw new Error('IA-25d envelope smoke must not call the general model');
      },
      regenerate: async () => {
        counters.regeneration += 1;
        throw new Error('IA-25d envelope smoke must not regenerate');
      },
      executeTool: async (name) => {
        counters.tools += 1;
        if (name === 'getAvailableSlots') {
          return JSON.stringify({ success: true, slots: ['18:00'] });
        }
        if (name === 'getUpcomingAppointments') {
          return JSON.stringify({ success: true, appointments: [] });
        }
        throw new Error(`unexpected IA-25d envelope smoke tool: ${name}`);
      },
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({ success: true, appointments: [] }),
    },
  });

  const deliverSetup = async (
    prepared: Awaited<ReturnType<typeof runTurn>>,
    sequence: number,
    id: string
  ) => {
    await delivery.deliverPreparedReceptionistTurnV2(prepared, {
      store,
      now: () => now,
      id: () => `ia25d-${id}-delivery`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: sequence,
        successorInputSequence: null,
        successorInboundMessageIds: [] as string[],
      }),
      sendTransport: async () => ({ providerMessageId: `ia25d-${id}-provider` }),
    });
  };

  const setupOne = await runTurn({
    sequence: 1,
    id: 'setup-one',
    texts: ['Tem horário amanhã para Manicure e pedicure?'],
    semantic: false,
  });
  await deliverSetup(setupOne, 1, 'setup-one');
  const setupTwo = await runTurn({
    sequence: 2,
    id: 'setup-two',
    texts: ['18:00'],
    semantic: false,
  });
  await deliverSetup(setupTwo, 2, 'setup-two');

  counters.semantic = 0;
  counters.primary = 0;
  counters.regeneration = 0;
  counters.tools = 0;
  const target = await runTurn({
    sequence: 3,
    id: 'target',
    texts: [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ],
    semantic: true,
  });
  const { semanticServiceResolution: _semantic, ...layerAPlanReceipt } =
    target.planReceipt;
  return { target, layerAPlanReceipt, counters };
}

async function main(): Promise<void> {
  assertPromptContract();
  assertThinkingDisabledAtAdapter();
  const propagation = await assertRequestCatalogPropagation();

  const malicious = [
    {
      name: 'componente-reconstruido',
      result: fence({
        text: 'as unhas dos pés e das mãos',
        components: ['pés e mãos', 'unhas'],
      }),
      expected: 'component_not_literal',
    },
    {
      name: 'componente-negado',
      result: fence({
        text: 'não quero pé e mão',
        components: ['pé', 'mão'],
      }),
      expected: 'component_negated',
    },
    {
      name: 'substring-token-cheat',
      result: fence({
        text: 'quero peeling e mão',
        components: ['pe', 'mão'],
      }),
      expected: 'component_not_token_bounded',
    },
    {
      name: 'spans-sobrepostos',
      result: fence({
        text: 'quero pacote facial premium',
        components: ['pacote facial', 'facial premium'],
      }),
      expected: 'components_overlap',
    },
    {
      name: 'relacao-disjuntiva',
      result: fence({
        text: 'manicure ou pedicure',
        components: ['manicure', 'pedicure'],
      }),
      expected: 'disjunctive_relation',
    },
    {
      name: 'componente-duplicado',
      result: fence({
        text: 'pé e mão',
        components: ['pé', 'pé', 'mão'],
      }),
      expected: 'components_not_distinct',
    },
    {
      name: 'componente-unico',
      result: fence({
        text: 'só o pé',
        components: ['pé'],
      }),
      expected: 'components_not_distinct',
    },
    {
      name: 'servico-fora-da-camada-a',
      result: fence({
        text: 'pé e mão',
        components: ['pé', 'mão'],
        serviceId: OUTSIDE_ID,
      }),
      expected: 'service_outside_composite_authority',
    },
  ] as const;

  for (const test of malicious) {
    assert.deepEqual(test.result, { ok: false, reason: test.expected }, test.name);
  }

  // IA-25d direct authority: when A says exactly `no_match`, the active
  // request catalog licenses a stricter composite proof without becoming a
  // planner candidate set.
  const directAcceptedCalls = { value: 0 };
  const directAccepted = await resolveDirectWith(
    'gostaria de fazer as unhas dos pés e das mãos',
    compositeDecision('gostaria de fazer as unhas dos pés e das mãos', ['pés', 'mãos']),
    directAcceptedCalls
  );
  assert.equal(directAccepted.receipt.status, 'resolved');
  assert.equal(directAccepted.decision?.serviceId, COMBO_ID);
  assert.equal(directAccepted.decision?.resolutionBasis, 'composite');
  assert.deepEqual(directAccepted.decision?.componentEvidenceTexts, ['pés', 'mãos']);
  assert.equal(directAccepted.receipt.compositeAuthoritySource, 'direct_active_catalog');
  assert.equal(directAccepted.receipt.compositeAuthorityCount, 3);
  assert.equal(directAcceptedCalls.value, 1);

  // The ID is active in the tenant's larger catalog but is not in the
  // requestCatalog authority passed to this fence. It cannot enter the
  // composite envelope merely because it is active elsewhere.
  const directRequestCatalogAuthority = deriveCompositeAuthorityV2({
    policy: directPolicy,
    deterministicResult: directNoMatch,
    activeServiceIds: LAYER_A,
  });
  const directTenantCatalogWithOutsideActive: ServicesResult = {
    ...catalog,
    services: [
      ...(catalog.services ?? []),
      service(OUTSIDE_ID, 'Serviço ativo fora do requestCatalog'),
    ],
  };
  assert.equal(
    directTenantCatalogWithOutsideActive.services?.some(
      (entry) => entry.id === OUTSIDE_ID
    ),
    true
  );
  const directOutsideRequestCatalog = licenseCompositeDecisionV2({
    decision: {
      decision: 'resolved',
      serviceId: OUTSIDE_ID,
      resolutionBasis: 'composite',
      componentEvidenceTexts: ['pé', 'mão'],
    },
    currentBatch: 'pé e mão',
    authority: directRequestCatalogAuthority,
  });
  assert.deepEqual(directOutsideRequestCatalog, {
    ok: false,
    reason: 'service_outside_composite_authority',
  });

  // A knows something (`ambiguous`) but did not open the planner-authorized
  // port. The full catalog must not be used to override that fact.
  const directAmbiguousCalls = { value: 0 };
  const directAmbiguous = await resolveDirectWith(
    'pé e mão',
    compositeDecision('pé e mão', ['pé', 'mão']),
    directAmbiguousCalls,
    { deterministicResult: plannerDeterministic }
  );
  assert.equal(directAmbiguous.receipt.status, 'composite_fence_rejected');
  assert.equal(
    directAmbiguous.compositeFenceReason,
    'composite_authority_unavailable'
  );
  assert.equal(directAmbiguous.receipt.compositeAuthoritySource, null);
  assert.equal(directAmbiguous.receipt.compositeAuthorityCount, 0);
  assert.equal(directAmbiguousCalls.value, 1);
  assert.equal(
    deriveCompositeAuthorityV2({
      policy: directPolicy,
      deterministicResult: { kind: 'no_match', reason: 'catalog_unavailable' },
      activeServiceIds: LAYER_A,
    }),
    null,
    'catalog_unavailable não licencia composite direto'
  );
  assert.equal(
    deriveCompositeAuthorityV2({
      policy: directPolicy,
      deterministicResult: { kind: 'no_match', reason: 'inactive_only' },
      activeServiceIds: LAYER_A,
    }),
    null,
    'inactive_only não licencia composite direto'
  );

  for (const test of [
    { text: 'pé e mão', components: ['pé', 'mão'] },
    { text: 'pe e mao', components: ['pe', 'mao'] },
    { text: 'pés e mãos', components: ['pés', 'mãos'] },
    { text: 'as unhas dos pés e das mãos', components: ['pés', 'mãos'] },
    { text: 'não quero manicure, agora quero pé e mão', components: ['pé', 'mão'] },
    { text: 'não quero manicure agora quero pé e mão', components: ['pé', 'mão'] },
  ]) {
    assert.deepEqual(
      fence(test),
      { ok: true, reason: 'composite_licensed' },
      test.text
    );
  }

  for (const test of [
    'agora não quero pé e mão',
    'não quero pé e mão agora',
  ]) {
    assert.deepEqual(
      fence({ text: test, components: ['pé', 'mão'] }),
      { ok: false, reason: 'component_negated' },
      test
    );
  }

  const direct = parseAndValidateSemanticServiceDecision({
    raw: decision({
      decision: 'resolved',
      serviceId: MANICURE_ID,
      candidateServiceIds: [MANICURE_ID],
      evidenceText: 'Manicure',
    }),
    currentBatch: 'Manicure',
    catalog,
  });
  assert.equal(direct.ok, true);
  if (direct.ok) {
    assert.equal(direct.value.resolutionBasis, 'direct');
    assert.deepEqual(direct.value.componentEvidenceTexts, []);
  }

  const composite = parseAndValidateSemanticServiceDecision({
    raw: compositeDecision('pé e mão', ['pé', 'mão']),
    currentBatch: 'pé e mão',
    catalog,
    deterministicResult: plannerDeterministic,
  });
  assert.equal(composite.ok, true);
  if (composite.ok) {
    assert.equal(composite.value.resolutionBasis, 'composite');
    assert.deepEqual(composite.value.componentEvidenceTexts, ['pé', 'mão']);
  }

  const negativeAmbiguous = parseAndValidateSemanticServiceDecision({
    raw: decision({
      decision: 'ambiguous',
      serviceId: null,
      candidateServiceIds: [...LAYER_A],
      evidenceText: 'não quero pé e mão',
    }),
    currentBatch: 'não quero pé e mão',
    catalog,
    deterministicResult: plannerDeterministic,
  });
  assert.equal(
    negativeAmbiguous.ok,
    false,
    'ambiguous com evidência negada é rejeitado'
  );
  if (!negativeAmbiguous.ok) {
    assert.equal(negativeAmbiguous.reason, 'negated_evidence');
  }

  const noneDecision = parseAndValidateSemanticServiceDecision({
    raw: decision({
      decision: 'none',
      serviceId: null,
      candidateServiceIds: [],
      evidenceText: '',
    }),
    currentBatch: 'não quero pé e mão',
    catalog,
    deterministicResult: plannerDeterministic,
  });
  assert.equal(noneDecision.ok, true, 'none sem evidência positiva é aceito');
  if (noneDecision.ok) {
    assert.deepEqual(noneDecision.value, {
      decision: 'none',
      serviceId: null,
      candidateServiceIds: [],
      evidenceText: '',
      resolutionBasis: 'direct',
      componentEvidenceTexts: [],
    });
  }

  const ambiguousWithoutEvidence = parseAndValidateSemanticServiceDecision({
    raw: decision({
      decision: 'ambiguous',
      serviceId: null,
      candidateServiceIds: [...LAYER_A],
      evidenceText: '',
    }),
    currentBatch: 'não quero pé e mão',
    catalog,
    deterministicResult: plannerDeterministic,
  });
  assert.equal(
    ambiguousWithoutEvidence.ok,
    false,
    'ambiguous sem evidência positiva continua incoerente'
  );
  if (!ambiguousWithoutEvidence.ok) {
    assert.equal(
      ambiguousWithoutEvidence.reason,
      'ambiguous_shape_incoherent'
    );
  }

  const agoraQueroMatrix = [
    {
      text: 'não quero manicure, agora quero pé e mão',
      expected: 'resolved' as const,
    },
    {
      text: 'não quero manicure agora quero pé e mão',
      expected: 'resolved' as const,
    },
    {
      text: 'agora não quero pé e mão',
      expected: 'rejected_evidence' as const,
    },
    {
      text: 'não quero pé e mão agora',
      expected: 'rejected_evidence' as const,
    },
  ];
  for (const test of agoraQueroMatrix) {
    const parsed = parseAndValidateSemanticServiceDecision({
      raw: decision({
        decision: 'resolved',
        serviceId: COMBO_ID,
        candidateServiceIds: [COMBO_ID],
        evidenceText: 'pé e mão',
        resolutionBasis: 'composite',
        componentEvidenceTexts: ['pé', 'mão'],
      }),
      currentBatch: test.text,
      catalog,
      deterministicResult: plannerDeterministic,
    });
    if (test.expected === 'resolved') {
      assert.equal(parsed.ok, true, test.text);
    } else {
      assert.equal(parsed.ok, false, test.text);
      if (!parsed.ok) assert.equal(parsed.reason, 'negated_evidence', test.text);
    }
  }

  const successfulCalls = { value: 0 };
  const successful = await resolveWith(
    'pé e mão',
    compositeDecision('pé e mão', ['pé', 'mão']),
    successfulCalls
  );
  assert.equal(successful.receipt.status, 'resolved');
  assert.equal(successful.decision?.resolutionBasis, 'composite');
  assert.deepEqual(successful.decision?.componentEvidenceTexts, ['pé', 'mão']);
  assert.equal(successfulCalls.value, 1);

  const substringTokenCalls = { value: 0 };
  const substringToken = await resolveDirectWith(
    'quero peeling e mão',
    compositeDecision('quero peeling e mão', ['pe', 'mão']),
    substringTokenCalls
  );
  assert.equal(substringToken.receipt.status, 'composite_fence_rejected');
  assert.equal(
    substringToken.compositeFenceReason,
    'component_not_token_bounded'
  );
  assert.equal(substringToken.decision, null);
  assert.equal(substringToken.receipt.providerCallCount, 1);
  assert.equal(substringTokenCalls.value, 1);

  const overlappingSpansCalls = { value: 0 };
  const overlappingSpans = await resolveDirectWith(
    'quero pacote facial premium para unha',
    compositeDecision('quero pacote facial premium para unha', [
      'pacote facial',
      'facial premium',
    ]),
    overlappingSpansCalls
  );
  assert.equal(overlappingSpans.receipt.status, 'composite_fence_rejected');
  assert.equal(overlappingSpans.compositeFenceReason, 'components_overlap');
  assert.equal(overlappingSpans.decision, null);
  assert.equal(overlappingSpans.receipt.providerCallCount, 1);
  assert.equal(overlappingSpansCalls.value, 1);

  const negativeAmbiguousCalls = { value: 0 };
  const negativeAmbiguousCompletion = await resolveDirectWith(
    'não quero pé e mão',
    decision({
      decision: 'ambiguous',
      serviceId: null,
      candidateServiceIds: [...LAYER_A],
      evidenceText: 'não quero pé e mão',
    }),
    negativeAmbiguousCalls
  );
  assert.equal(negativeAmbiguousCompletion.receipt.status, 'rejected_evidence');
  assert.equal(
    negativeAmbiguousCompletion.parseRejectionReason,
    'negated_evidence'
  );
  assert.equal(negativeAmbiguousCompletion.decision, null);
  assert.equal(negativeAmbiguousCompletion.receipt.providerCallCount, 1);
  assert.equal(negativeAmbiguousCalls.value, 1);

  const rejectedEvidenceCalls = { value: 0 };
  const rejectedEvidence = await resolveWith(
    'agora não quero pé e mão',
    compositeDecision('pé e mão', ['pé', 'mão']),
    rejectedEvidenceCalls
  );
  assert.equal(rejectedEvidence.receipt.status, 'rejected_evidence');
  assert.equal(rejectedEvidence.parseRejectionReason, 'negated_evidence');
  assert.deepEqual(rejectedEvidence.shape, {
    decision: 'resolved',
    resolutionBasis: 'composite',
    candidateCount: 1,
    componentCount: 2,
    evidenceEmpty: false,
    serviceInsideFence: true,
  });
  assert.equal(rejectedEvidenceCalls.value, 1);

  const outsideCandidateCatalog: ServicesResult = {
    ...catalog,
    services: [
      ...(catalog.services ?? []),
      service(OUTSIDE_ID, 'Serviço C fora do conjunto'),
    ],
  };
  let maliciousOutsidePayload: Record<string, unknown> | null = null;
  clearSemanticServiceResolverCache();
  const maliciousOutside = await resolveSemanticService({
    tenantSlug: config.tenantSlug,
    currentBatch: 'pé e mão',
    catalog: outsideCandidateCatalog,
    config,
    deterministicResult: plannerDeterministic,
    invocationPolicy: plannerPolicy,
    completionFactory: async (request) => {
      maliciousOutsidePayload = requestPayload(request);
      return completion(
        compositeDecision('pé e mão', ['pé', 'mão'], OUTSIDE_ID)
      );
    },
    now: () => 1_000,
  });
  assert.equal(maliciousOutside.receipt.status, 'rejected_evidence');
  assert.equal(
    maliciousOutside.parseRejectionReason,
    'invented_or_inactive_id'
  );
  assert.equal(maliciousOutside.decision, null);
  if (!maliciousOutsidePayload) {
    throw new Error('completion maliciosa não recebeu payload');
  }
  assert.deepEqual(payloadCatalogIds(maliciousOutsidePayload), [...LAYER_A]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      maliciousOutsidePayload,
      'candidateServiceIds'
    ),
    false
  );

  const reconstructedCalls = { value: 0 };
  const reconstructed = await resolveWith(
    'as unhas dos pés e das mãos',
    compositeDecision('as unhas dos pés e das mãos', ['pés e mãos', 'unhas']),
    reconstructedCalls
  );
  assert.equal(reconstructed.receipt.status, 'composite_fence_rejected');
  assert.equal(reconstructed.compositeFenceReason, 'component_not_literal');
  assert.deepEqual(reconstructed.shape, {
    decision: 'resolved',
    resolutionBasis: 'composite',
    candidateCount: 1,
    componentCount: 2,
    evidenceEmpty: false,
    serviceInsideFence: true,
  });
  assert.equal(reconstructed.decision, null);
  assert.equal(reconstructed.receipt.providerCallCount, 1);
  assert.equal(reconstructed.receipt.cacheHit, false);
  assert.equal(reconstructedCalls.value, 1);

  const truncatedCalls = { value: 0 };
  const truncated = await resolveWith(
    'pé e mão',
    completion(
      '{"decision":"resolved","serviceId":"22222222-2222-4222-8222-222222222222"',
      'length'
    ),
    truncatedCalls
  );
  assert.equal(truncated.receipt.status, 'provider_truncated');
  assert.equal(truncated.receipt.providerFinishReason, 'length');
  assert.equal(truncated.receipt.providerCallCount, 1);
  assert.equal(truncated.receipt.cacheHit, false);
  assert.equal(truncated.receipt.skipReason, null);
  assert.equal(truncated.decision, null);
  const truncatedAgain = await resolveWith(
    'pé e mão',
    completion(
      '{"decision":"resolved","serviceId":"22222222-2222-4222-8222-222222222222"',
      'length'
    ),
    truncatedCalls
  );
  assert.equal(truncatedAgain.receipt.status, 'provider_truncated');
  assert.equal(truncatedCalls.value, 2, 'truncamento nunca entra no cache');

  const protocol = await resolveWith(
    'pé e mão',
    completion('', 'stop'),
    { value: 0 }
  );
  assert.equal(protocol.receipt.status, 'protocol_failure');
  assert.equal(protocol.receipt.providerCallCount, 1);
  assert.equal(protocol.receipt.cacheHit, false);
  assert.equal(protocol.receipt.skipReason, null);
  assert.equal(protocol.decision, null);

  const noneCalls = { value: 0 };
  const none = await resolveWith(
    'não quero pé e mão',
    decision({
      decision: 'none',
      serviceId: null,
      candidateServiceIds: [],
      evidenceText: '',
    }),
    noneCalls
  );
  assert.equal(none.receipt.status, 'none');
  assert.equal(none.reason, 'accepted');
  assert.deepEqual(none.decision, {
    decision: 'none',
    serviceId: null,
    candidateServiceIds: [],
    evidenceText: '',
    resolutionBasis: 'direct',
    componentEvidenceTexts: [],
  });
  assert.equal(none.receipt.providerCallCount, 1);
  assert.equal(noneCalls.value, 1);

  const ambiguousWithoutEvidenceCalls = { value: 0 };
  const ambiguousWithoutEvidenceOutcome = await resolveWith(
    'não quero pé e mão',
    decision({
      decision: 'ambiguous',
      serviceId: null,
      candidateServiceIds: [...LAYER_A],
      evidenceText: '',
    }),
    ambiguousWithoutEvidenceCalls
  );
  assert.equal(ambiguousWithoutEvidenceOutcome.receipt.status, 'invalid_response');
  assert.equal(ambiguousWithoutEvidenceOutcome.reason, 'invalid_response');
  assert.equal(
    ambiguousWithoutEvidenceOutcome.parseRejectionReason,
    'ambiguous_shape_incoherent'
  );
  assert.deepEqual(ambiguousWithoutEvidenceOutcome.shape, {
    decision: 'ambiguous',
    resolutionBasis: 'direct',
    candidateCount: 3,
    componentCount: 0,
    evidenceEmpty: true,
    serviceInsideFence: true,
  });
  assert.equal(ambiguousWithoutEvidenceOutcome.decision, null);
  assert.equal(
    ambiguousWithoutEvidenceOutcome.receipt.providerCallCount,
    1
  );
  assert.equal(ambiguousWithoutEvidenceCalls.value, 1);

  const runtimeNone = await runPlannerAuthorizedEnvelopeScenario(
    decision({
      decision: 'none',
      serviceId: null,
      candidateServiceIds: [],
      evidenceText: '',
    })
  );
  const runtimeAmbiguousEmpty = await runPlannerAuthorizedEnvelopeScenario(
    decision({
      decision: 'ambiguous',
      serviceId: null,
      candidateServiceIds: [...LAYER_A],
      evidenceText: '',
    })
  );
  assert.equal(
    runtimeNone.target.planReceipt.semanticServiceResolution?.status,
    'none'
  );
  assert.equal(
    runtimeAmbiguousEmpty.target.planReceipt.semanticServiceResolution?.status,
    'invalid_response'
  );
  assert.deepEqual(
    runtimeNone.layerAPlanReceipt,
    runtimeAmbiguousEmpty.layerAPlanReceipt,
    'none e ambiguous vazio preservam o plano da Camada A byte a byte'
  );
  for (const scenario of [runtimeNone, runtimeAmbiguousEmpty]) {
    assert.equal(scenario.counters.semantic, 1);
    assert.equal(scenario.counters.primary, 0);
    assert.equal(scenario.counters.regeneration, 0);
    assert.equal(scenario.counters.tools, 0);
  }

  console.log(
    JSON.stringify({
      smoke: 'ana-ia25d-composite-fence',
      thinking: 'disabled',
      propagation: {
        plannerAuthorized: propagation.plannerAuthorized,
        directUnresolved: propagation.directUnresolved,
      },
      maliciousOutsideCandidate: {
        status: maliciousOutside.receipt.status,
        parseRejectionReason: maliciousOutside.parseRejectionReason,
        candidateCatalog: payloadCatalogIds(maliciousOutsidePayload),
      },
      malicious: malicious.map((test) => ({
        completion: test.name,
        result: test.result.reason,
      })),
      directAuthority: {
        noMatch: {
          status: directAccepted.receipt.status,
          resolutionBasis: directAccepted.decision?.resolutionBasis,
          authoritySource: directAccepted.receipt.compositeAuthoritySource,
          authorityCount: directAccepted.receipt.compositeAuthorityCount,
          providerCalls: directAccepted.receipt.providerCallCount,
        },
        outsideRequestCatalog: directOutsideRequestCatalog,
        deterministicAmbiguous: {
          status: directAmbiguous.receipt.status,
          fenceReason: directAmbiguous.compositeFenceReason,
          authoritySource: directAmbiguous.receipt.compositeAuthoritySource,
          authorityCount: directAmbiguous.receipt.compositeAuthorityCount,
          providerCalls: directAmbiguous.receipt.providerCallCount,
        },
      },
      providerTruncated: truncated.receipt.status,
      protocolFailure: protocol.receipt.status,
      adversarialServerFences: {
        substringToken: {
          status: substringToken.receipt.status,
          reason: substringToken.compositeFenceReason,
          providerCalls: substringToken.receipt.providerCallCount,
        },
        overlappingSpans: {
          status: overlappingSpans.receipt.status,
          reason: overlappingSpans.compositeFenceReason,
          providerCalls: overlappingSpans.receipt.providerCallCount,
        },
      },
      negativeEnvelope: {
        none: {
          completion: 'none + evidenceText=""',
          status: runtimeNone.target.planReceipt.semanticServiceResolution?.status,
          layerA: 'preserved',
          semanticCalls: runtimeNone.counters.semantic,
          retry: 0,
          generalModel: 0,
          regeneration: 0,
          tools: 0,
        },
        ambiguousEmpty: {
          completion: 'ambiguous + evidenceText=""',
          status:
            runtimeAmbiguousEmpty.target.planReceipt.semanticServiceResolution
              ?.status,
          parserReason: 'ambiguous_shape_incoherent',
          layerA: 'preserved',
          semanticCalls: runtimeAmbiguousEmpty.counters.semantic,
          retry: 0,
          generalModel: 0,
          regeneration: 0,
          tools: 0,
        },
        ambiguousNegatedEvidence: {
          completion: 'ambiguous + evidenceText="não quero pé e mão"',
          status: negativeAmbiguousCompletion.receipt.status,
          parserReason: negativeAmbiguousCompletion.parseRejectionReason,
          decision: negativeAmbiguousCompletion.decision,
          semanticCalls: negativeAmbiguousCompletion.receipt.providerCallCount,
        },
      },
      agoraQuero: agoraQueroMatrix.map((test) => ({
        case: test.expected,
        result: test.expected,
      })),
      status: 'ok',
    })
  );
}

void main().catch((error: unknown) => {
  console.error(
    `smoke-ana-ia25d-composite-fence: FAIL (${error instanceof Error ? error.message : 'unknown'})`
  );
  process.exitCode = 1;
});
