#!/usr/bin/env ts-node
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import {
  BEHAVIORAL_ARTIFACT_FILES_V2,
  BEHAVIORAL_FROZEN_RATES_USD_PER_MILLION_V2,
  BEHAVIORAL_ROTEIROS_REPORT_SCHEMA_VERSION,
  OPENAI_GPT_4O_MINI_MODEL,
  assertBehavioralPublishAllowedV2,
  assertBehavioralRealCallLogV2,
  assertBehavioralRealProviderCallV2,
  behavioralArmProviderSpecV2,
  completionEchoFromProviderResponseV2,
  createBehavioralAntiMockLatchV2,
  estimatedBehavioralCostUsdV2,
  expectedModelForBehavioralCallV2,
  fingerprintStatusFromCompletionV2,
  isBlockedBehavioralLiveModelV2,
  preflightBehavioralArmV2,
  preflightBehavioralRealRunV2,
  recordBehavioralTrackedCallV2,
  resolveBehavioralHarnessPricingV2,
  resolveLunaHarnessPricingV2,
  responseModelFromCompletionV2,
  systemFingerprintFromCompletionV2,
  writeBehavioralArtifactsIfAllowedV2,
  type BehavioralProviderCallKindV2,
  type BehavioralProviderCallReceiptV2,
} from '../src/services/conversationalV2/behavioralReal';
import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
  providerResponseEchoV2,
} from '../src/services/receptionistLlmProvider';
import { buildRoteirosConfig } from './benchmarks/ana-v2-roteiros/fixtures';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_behavioral_receipt';
process.env.OPENAI_API_KEY ||= 'sk-smoke-openai';
process.env.OPENAI_API_KEY_LUNA ||= 'sk-smoke-luna';
process.env.DEEPSEEK_API_KEY ||= 'sk-smoke-deepseek';
process.env.ERP_API_TOKEN = 'smoke-invalid';

function flashConfig() {
  return buildRoteirosConfig();
}

function lunaConfig() {
  return {
    ...buildRoteirosConfig(),
    aiProvider: 'luna' as const,
    aiModel: OPENAI_LUNA_MODEL,
  };
}

function openaiConfig() {
  return {
    ...buildRoteirosConfig(),
    aiProvider: 'openai' as const,
    aiModel: OPENAI_GPT_4O_MINI_MODEL,
  };
}

function mainSyncChecks(): void {
  assert.equal(BEHAVIORAL_ROTEIROS_REPORT_SCHEMA_VERSION, 5);
  assert.equal(
    behavioralArmProviderSpecV2('luna').requestedModel,
    OPENAI_LUNA_MODEL
  );
  assert.equal(
    behavioralArmProviderSpecV2('deepseek').requestedModel,
    DEEPSEEK_V4_FLASH_MODEL
  );
  assert.notEqual(
    behavioralArmProviderSpecV2('deepseek').requestedModel,
    OPENAI_GPT_4O_MINI_MODEL
  );
  assert.equal(
    expectedModelForBehavioralCallV2('luna', 'resume_thinking').requestedModel,
    DEEPSEEK_V4_FLASH_MODEL
  );
  assert.equal(
    expectedModelForBehavioralCallV2('luna', 'brain').requestedModel,
    OPENAI_LUNA_MODEL
  );

  assert.equal(isBlockedBehavioralLiveModelV2('gpt-5.6-luna-mock'), true);
  assert.equal(isBlockedBehavioralLiveModelV2('deepseek-v4-flash-mock'), true);
  assert.equal(isBlockedBehavioralLiveModelV2('gpt-5.6-luna'), false);
  assert.equal(isBlockedBehavioralLiveModelV2(OPENAI_GPT_4O_MINI_MODEL), false);

  const plumbed = {
    model: OPENAI_LUNA_MODEL,
    system_fingerprint: 'fp_luna_live',
  };
  assert.equal(responseModelFromCompletionV2(plumbed), OPENAI_LUNA_MODEL);
  assert.equal(systemFingerprintFromCompletionV2(plumbed), 'fp_luna_live');
  assert.equal(fingerprintStatusFromCompletionV2(plumbed), 'present');
  assert.equal(responseModelFromCompletionV2({ model: '  ' }), null);
  assert.equal(systemFingerprintFromCompletionV2({}), null);
  assert.equal(fingerprintStatusFromCompletionV2({}), 'absent');
  assert.equal(
    fingerprintStatusFromCompletionV2({ model: OPENAI_LUNA_MODEL }),
    'absent'
  );
  assert.equal(
    systemFingerprintFromCompletionV2({
      model: OPENAI_LUNA_MODEL,
      systemFingerprint: 'fp_camel',
    }),
    'fp_camel'
  );
  assert.equal(
    systemFingerprintFromCompletionV2({
      model: OPENAI_LUNA_MODEL,
      metadata: { system_fingerprint: 'fp_meta' },
    }),
    'fp_meta'
  );
  assert.equal(
    completionEchoFromProviderResponseV2({
      model: OPENAI_LUNA_MODEL,
      metadata: { fingerprint: 'fp_alias' },
    }).fingerprintStatus,
    'present'
  );
  assert.equal(
    providerResponseEchoV2({
      response: { model: OPENAI_LUNA_MODEL, system_fingerprint: 'fp_nested' },
    }).systemFingerprint,
    'fp_nested'
  );

  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'luna',
        kind: 'brain',
        requestedModel: '',
        returnedModel: OPENAI_LUNA_MODEL,
      }),
    /requestedModel ausente/
  );
  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'luna',
        kind: 'brain',
        requestedModel: OPENAI_LUNA_MODEL,
        returnedModel: null,
      }),
    /response\.model ausente/
  );
  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'luna',
        kind: 'brain',
        requestedModel: 'gpt-5.6-luna-mock',
        returnedModel: 'gpt-5.6-luna-mock',
      }),
    /recibo mock/
  );
  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'luna',
        kind: 'brain',
        requestedModel: OPENAI_LUNA_MODEL,
        returnedModel: 'gpt-5.6-luna-mock',
      }),
    /recibo mock \(response\.model/
  );
  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'luna',
        kind: 'brain',
        requestedModel: OPENAI_GPT_4O_MINI_MODEL,
        returnedModel: OPENAI_GPT_4O_MINI_MODEL,
      }),
    /modelo divergente do braço luna/
  );
  assert.throws(
    () =>
      assertBehavioralRealProviderCallV2({
        callProvider: 'deepseek',
        kind: 'brain',
        requestedModel: OPENAI_GPT_4O_MINI_MODEL,
        returnedModel: OPENAI_GPT_4O_MINI_MODEL,
      }),
    /modelo divergente do braço deepseek/
  );
  assert.doesNotThrow(() =>
    assertBehavioralRealProviderCallV2({
      callProvider: 'luna',
      kind: 'brain',
      requestedModel: OPENAI_LUNA_MODEL,
      returnedModel: OPENAI_LUNA_MODEL,
      systemFingerprint: 'fp_ok',
    })
  );
  assert.doesNotThrow(() =>
    assertBehavioralRealProviderCallV2({
      callProvider: 'luna',
      kind: 'brain',
      requestedModel: OPENAI_LUNA_MODEL,
      returnedModel: OPENAI_LUNA_MODEL,
      systemFingerprint: null,
    })
  );
  assert.doesNotThrow(() =>
    assertBehavioralRealProviderCallV2({
      callProvider: 'openai',
      kind: 'brain',
      requestedModel: OPENAI_GPT_4O_MINI_MODEL,
      returnedModel: OPENAI_GPT_4O_MINI_MODEL,
    })
  );
  assert.doesNotThrow(() =>
    assertBehavioralRealProviderCallV2({
      callProvider: 'luna',
      kind: 'resume_thinking',
      requestedModel: DEEPSEEK_V4_FLASH_MODEL,
      returnedModel: DEEPSEEK_V4_FLASH_MODEL,
    })
  );

  assert.throws(
    () =>
      assertBehavioralRealCallLogV2(
        [
          {
            callProvider: 'luna',
            kind: 'brain',
            requestedModel: OPENAI_LUNA_MODEL,
            returnedModel: OPENAI_LUNA_MODEL,
          },
          {
            callProvider: 'luna',
            kind: 'brain',
            requestedModel: OPENAI_LUNA_MODEL,
            returnedModel: 'gpt-5.6-luna-mock',
          },
        ],
        'luna'
      ),
    /recibo mock/
  );

  const flashReceipt = preflightBehavioralArmV2(flashConfig(), 'deepseek');
  assert.equal(flashReceipt.resolvedModel, DEEPSEEK_V4_FLASH_MODEL);
  const lunaReceipt = preflightBehavioralArmV2(lunaConfig(), 'luna');
  assert.equal(lunaReceipt.resolvedModel, OPENAI_LUNA_MODEL);
  assert.throws(
    () => preflightBehavioralArmV2(flashConfig(), 'luna'),
    /esperado luna\/gpt-5.6-luna/
  );
  assert.throws(
    () => preflightBehavioralArmV2(openaiConfig(), 'luna'),
    /esperado luna\/gpt-5.6-luna/
  );

  const savedLunaInput = process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION;
  const savedLunaOutput = process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION;
  const savedLunaCached = process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION;
  delete process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION;
  delete process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION;
  delete process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION;
  try {
    assert.throws(
      () =>
        preflightBehavioralRealRunV2({
          provider: 'luna',
          config: lunaConfig(),
          includesResumeClassifier: false,
          env: {
            ...process.env,
            OPENAI_API_KEY_LUNA: 'sk-smoke-luna',
            OPENAI_LUNA_INPUT_USD_PER_MILLION: '0',
            OPENAI_LUNA_OUTPUT_USD_PER_MILLION: '0',
          },
        }),
      /tabela .* está 0/
    );
    const savedDeepseek = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.throws(
        () =>
          preflightBehavioralRealRunV2({
            provider: 'deepseek',
            config: flashConfig(),
            includesResumeClassifier: false,
            env: { ...process.env, DEEPSEEK_API_KEY: '' },
          }),
        /DEEPSEEK_API_KEY/
      );
    } finally {
      if (savedDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDeepseek;
    }

    process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION = '5';
    process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION = '15';
    process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION = '1';
    const live = preflightBehavioralRealRunV2({
      provider: 'luna',
      config: lunaConfig(),
      includesResumeClassifier: false,
    });
    assert.equal(live.resolvedProvider, 'luna');
    assert.equal(live.resolvedModel, OPENAI_LUNA_MODEL);
    assert.equal(isBlockedBehavioralLiveModelV2(live.resolvedModel), false);
  } finally {
    if (savedLunaInput === undefined) {
      delete process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION;
    } else {
      process.env.OPENAI_LUNA_INPUT_USD_PER_MILLION = savedLunaInput;
    }
    if (savedLunaOutput === undefined) {
      delete process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION;
    } else {
      process.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION = savedLunaOutput;
    }
    if (savedLunaCached === undefined) {
      delete process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION;
    } else {
      process.env.OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION = savedLunaCached;
    }
  }

  const unpriced = resolveLunaHarnessPricingV2({});
  assert.equal(unpriced.status, 'unpriced');
  assert.equal(unpriced.rates.promptCacheMiss, 0);
  assert.equal(unpriced.rates.completion, 0);
  const lunaCallUnpriced = estimatedBehavioralCostUsdV2({
    promptTokens: 2_500,
    completionTokens: 400,
    cachedPromptTokens: 0,
    cacheMissPromptTokens: null,
    rates: unpriced.rates,
  });
  assert.equal(lunaCallUnpriced, 0);

  const flashThinking = estimatedBehavioralCostUsdV2({
    promptTokens: 200,
    completionTokens: 4_000,
    cachedPromptTokens: 0,
    cacheMissPromptTokens: null,
    rates: BEHAVIORAL_FROZEN_RATES_USD_PER_MILLION_V2.deepseek,
  });
  const contaminatedTotal = lunaCallUnpriced * 62 + flashThinking;
  assert.ok(
    flashThinking > 0.001 && flashThinking < 0.0013,
    `custo Flash thinking fora da banda do relatório contaminado: ${flashThinking}`
  );
  assert.ok(
    contaminatedTotal > 0.001 && contaminatedTotal < 0.0013,
    `62 Luna a US$0 + 1 Flash thinking reproduz ~US$0,0012, não mock: ${contaminatedTotal}`
  );

  const pricedLuna = resolveLunaHarnessPricingV2({
    OPENAI_LUNA_INPUT_USD_PER_MILLION: '5',
    OPENAI_LUNA_OUTPUT_USD_PER_MILLION: '15',
    OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION: '1',
  });
  assert.equal(pricedLuna.status, 'priced');
  const onePricedLuna = estimatedBehavioralCostUsdV2({
    promptTokens: 2_500,
    completionTokens: 400,
    cachedPromptTokens: 0,
    cacheMissPromptTokens: null,
    rates: pricedLuna.rates,
  });
  assert.ok(
    onePricedLuna > flashThinking,
    'com tabela Luna preenchida, uma chamada brain não fica 20× mais barata que Flash thinking'
  );

  const flashPricing = resolveBehavioralHarnessPricingV2('deepseek');
  assert.equal(flashPricing.status, 'priced');
  assert.equal(flashPricing.rates.promptCacheMiss, 0.14);
}

function mockCompletion(
  model: string,
  content = '{"choice":"NENHUMA"}'
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'anti-mock-completion',
    object: 'chat.completion',
    created: 0,
    model,
    system_fingerprint: 'fp_ana_v2_mock',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function mockReceipt(
  kind: BehavioralProviderCallKindV2
): BehavioralProviderCallReceiptV2 {
  const resume = kind === 'resume_thinking';
  return {
    callProvider: resume ? 'deepseek' : 'luna',
    kind,
    requestedModel: resume ? DEEPSEEK_V4_FLASH_MODEL : OPENAI_LUNA_MODEL,
    returnedModel: resume ? 'deepseek-v4-flash-mock' : 'gpt-5.6-luna-mock',
    systemFingerprint: 'fp_ana_v2_mock',
    fingerprintStatus: 'present',
    poisoned: false,
    antiMockReason: null,
  };
}

async function assertLayerDoesNotPublish(input: {
  layer: string;
  invoke: (
    recordMock: () => OpenAI.Chat.Completions.ChatCompletion
  ) => Promise<unknown>;
}): Promise<void> {
  const latch = createBehavioralAntiMockLatchV2();
  const calls: BehavioralProviderCallReceiptV2[] = [];
  const writes: string[] = [];
  const recordMock = () => {
    recordBehavioralTrackedCallV2({
      mode: 'real',
      latch,
      calls,
      receipt: mockReceipt(
        input.layer === 'resume_thinking' ? 'resume_thinking' : (input.layer as BehavioralProviderCallKindV2)
      ),
    });
    return mockCompletion(
      input.layer === 'resume_thinking'
        ? 'deepseek-v4-flash-mock'
        : 'gpt-5.6-luna-mock'
    );
  };
  let layerOutcome: unknown;
  let escaped = false;
  try {
    layerOutcome = await input.invoke(recordMock);
  } catch {
    escaped = true;
  }
  assert.equal(latch.tripped, true, `${input.layer}: latch não disparou`);
  assert.ok(
    calls.some((call) => call.poisoned),
    `${input.layer}: recibo mock não entrou em calls`
  );
  assert.throws(
    () =>
      assertBehavioralPublishAllowedV2({
        mode: 'real',
        armProvider: 'luna',
        latch,
        calls,
      }),
    /latch anti-mock|poisoned|recibo mock/
  );
  await assert.rejects(
    () =>
      writeBehavioralArtifactsIfAllowedV2({
        mode: 'real',
        armProvider: 'luna',
        latch,
        calls,
        outputDir: '/tmp/ana-v2-anti-mock-must-not-exist',
        files: {
          'raw.json': '{}',
          'summary.md': '# no',
          'comparison.md': '# no',
        },
        mkdir: async (dir) => {
          writes.push(`mkdir:${dir}`);
        },
        writeFile: async (file) => {
          writes.push(`write:${file}`);
        },
      }),
    /latch anti-mock|poisoned|recibo mock/
  );
  assert.equal(
    writes.length,
    0,
    `${input.layer}: publicou artefato após mock (${writes.join(',')})`
  );
  void layerOutcome;
  void escaped;
}

async function runAntiMockSwallowFixtures(): Promise<void> {
  assert.deepEqual(BEHAVIORAL_ARTIFACT_FILES_V2, [
    'raw.json',
    'summary.md',
    'comparison.md',
  ]);
  const luna = lunaConfig();
  const services = {
    success: true as const,
    services: [
      {
        id: 'svc-peeling',
        name: 'Peeling facial',
        durationMinutes: 45,
        price: 140,
        priceFormatted: 'R$ 140,00',
        professionalIds: ['prof-carla'],
      },
    ],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  };
  const now = new Date('2026-08-14T15:00:00.000Z');
  const inboundId = 'in-anti-mock';
  const frame = {
    schemaVersion: 2 as const,
    turnId: 'turn-anti-mock',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available' as const,
    humanControl: 'NO_ACTIVE_TAKEOVER' as const,
    currentInboundIds: [inboundId],
    pending: null,
    flowState: { flowId: 'flow-anti-mock', fixedByProofVersion: {} },
  };

  const brain = await import('../src/services/brainService');
  await assertLayerDoesNotPublish({
    layer: 'brain',
    invoke: async (recordMock) =>
      brain.runReceptionistModelLoop({
        config: luna,
        messages: [{ role: 'user', content: 'oi' }],
        executeTool: async () => '{}',
        tools: [],
        retryOnFailure: false,
        completionFactory: async () => recordMock(),
      }),
  });

  const interpreter = await import(
    '../src/services/conversationalV2/powerZeroInterpreter'
  );
  await assertLayerDoesNotPublish({
    layer: 'interpreter',
    invoke: async (recordMock) => {
      const result = await interpreter.interpretPowerZeroV2({
        config: luna,
        frame,
        inboundId,
        inboundText: 'Tenho algum atendimento marcado pra amanhã?',
        inboundTextsById: {
          [inboundId]: 'Tenho algum atendimento marcado pra amanhã?',
        },
        servicesResult: services,
        now,
        completionFactory: async () => recordMock(),
      });
      assert.equal(result.kind, 'error');
      if (result.kind === 'error') {
        assert.equal(result.reason, 'provider_error');
      }
      return result;
    },
  });

  const social = await import('../src/services/conversationalV2/social');
  await assertLayerDoesNotPublish({
    layer: 'social',
    invoke: async (recordMock) => {
      const result = await social.composeSocialReplyV2({
        config: luna,
        inboundText: 'oi',
        completionFactory: async () => recordMock(),
      });
      assert.equal(result.ok, false);
      assert.equal(result.failureReason, 'SOCIAL_PROVIDER_ERROR');
      return result;
    },
  });

  const regenerator = await import(
    '../src/services/conversationalV2/regenerator'
  );
  await assertLayerDoesNotPublish({
    layer: 'regen',
    invoke: async (recordMock) => {
      const result = await regenerator.regenerateReceptionistCopyV2({
        config: luna,
        snapshot: {
          frame,
          catalogSnapshot: {
            services: services.services,
            professionals: services.professionals,
          },
          messages: [{ role: 'user', content: 'Quero agendar amanhã' }],
          rejectedCandidate: 'Tem vaga amanhã.',
        },
        reasonCodes: ['UNVERIFIED_AVAILABILITY'],
        validationContext: {
          frame,
          inboundTextsById: { [inboundId]: 'Quero agendar amanhã' },
          catalogEntities: {
            services: services.services.map((service) => ({
              id: service.id,
              displayName: service.name,
            })),
            professionals: services.professionals.map((professional) => ({
              id: professional.id,
              displayName: professional.name,
            })),
          },
          now,
        },
        completionFactory: async () => recordMock(),
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reasonCode, 'REGEN_PROVIDER_ERROR');
      return result;
    },
  });

  const voice = await import('../src/services/conversationalV2/voice/rephraser');
  await assertLayerDoesNotPublish({
    layer: 'voice',
    invoke: async (recordMock) => {
      const result = await voice.rephraseVoiceCopyV2({
        config: luna,
        copyId: 'initial_service_question',
        template:
          'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial. Qual você prefere?',
        completionFactory: async () => recordMock(),
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'provider_error');
        assert.equal(result.returnedModel, null);
      }
      return result;
    },
  });

  const classifier = await import('../src/services/anaResumeClassifier');
  await assertLayerDoesNotPublish({
    layer: 'resume_thinking',
    invoke: async (recordMock) => {
      const result = await classifier.classifyAnaResume(
        {
          history: [
            {
              role: 'assistant',
              content: '[atendente] pode deixar marcado para sexta',
              createdAt: '2026-08-11T11:37:00.000Z',
            },
            {
              role: 'user',
              content: 'quero remarcar',
              createdAt: '2026-08-11T12:08:00.000Z',
            },
          ],
          config: flashConfig(),
          customerName: 'Aline Sintética',
        },
        {
          now: Date.now,
          complete: async () => {
            recordMock();
            return '{"decision":"RESUME_ANA","reasonCode":"NEW_INDEPENDENT_REQUEST"}';
          },
        }
      );
      assert.equal(result.reasonCode, 'PROVIDER_FAILURE');
      return result;
    },
  });

  const tau2 = await import('../src/services/conversationalV2/tau2');
  await assertLayerDoesNotPublish({
    layer: 'brain',
    invoke: async (recordMock) =>
      tau2.runPairwiseToneHarnessV2({
        items: [
          {
            id: 'anti-mock-judge',
            copyId: 'initial_service_question',
            template:
              'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?',
            variant:
              'Combinado! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?',
            catalog: {
              services: ['Peeling facial', 'Drenagem Linfática'],
              professionals: ['Carla Mendes'],
            },
          },
        ],
        generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
        judges: [{ id: 'luna', provider: 'luna', model: OPENAI_LUNA_MODEL }],
        completionFactory: async () => recordMock(),
      }),
  });
}

async function main(): Promise<void> {
  mainSyncChecks();
  await runAntiMockSwallowFixtures();
  console.log(
    'PASS smoke behavioral receipt: schema 5, fingerprintStatus, latch anti-mock fail-closed, mutações voice/interpreter/social/regen/brain/R10/juiz.'
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
