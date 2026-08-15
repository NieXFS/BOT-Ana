#!/usr/bin/env ts-node
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';
import { interpretPowerZeroV2 } from '../src/services/conversationalV2/powerZeroInterpreter';
import {
  DEEPSEEK_V4_FLASH_MODEL,
  OPENAI_LUNA_MODEL,
} from '../src/services/receptionistLlmProvider';
import {
  TAU2_ARM_IDS,
  TAU2_ARM_VECTORS,
  TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2,
  TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
  TAU2_REPORT_SCHEMA_VERSION,
  aggregatePassKByTaskV2,
  applyTau2ArmProviderSpecV2,
  assertTau2RealJudgeReceiptV2,
  assertTau2RealVoiceReceiptV2,
  auditSimulatorTranscriptsV2,
  assertToneJudgePanelV2,
  buildPairwiseJudgeProviderRequestV2,
  canonicalPairwiseJudgeProviderV2,
  consistentPairwisePreferenceV2,
  defaultPairwiseJudgeSpecV2,
  emptyCanonicalStateV2,
  emptyToneScoresV2,
  evaluatePairwiseToneV2,
  evaluateStateV2,
  evaluateTau2RewardV2,
  generatorModelsForVoicePairV2,
  isToneJudgeAttachedToRewardV2,
  labelSimulatorTranscriptV2,
  macroPassKFromTasksV2,
  mapPairwiseSideToPreferenceV2,
  notRunPairwiseToneReportV2,
  pairVoiceArmTurnsForToneV2,
  parsePairwiseJudgeSideV2,
  parseTau2TaskV2,
  passAt1,
  passAt4,
  passAtK,
  pairwiseJudgeCompletionInputV2,
  pairwiseJudgeCredentialPresentV2,
  pairwiseJudgeRuntimeConfigV2,
  preflightTau2ArmV2,
  preflightTau2RealRunV2,
  projectSessionStateV2,
  recommendedVoiceBaselineV2,
  replayIncompatibleResultV2,
  requiredSimulatorAuditCountV2,
  resolvePairwiseJudgeCredentialV2,
  resolvePairwiseJudgeRuntimeV2,
  resolvePairwiseJudgeSpecV2,
  runPairwiseToneHarnessV2,
  runTau2TrialV2,
  sanitizePairwiseJudgeErrorV2,
  scrubFixtureLlmCredentialsFromEnvV2,
  summarizeSimulatorAuditV2,
  tau2ArmProviderSpecV2,
  tau2PairwiseToneFailsProcessV2,
  voicePairingIsValidV2,
  isFixtureLlmCredentialV2,
  isLiveOpenAiCredentialShapeV2,
  liveLlmCredentialV2,
  livePairwiseJudgeEnvV2,
  type Tau2ArmId,
  type Tau2CanonicalState,
  type Tau2PairwiseArmTurnV2,
  type Tau2PairwiseToneHarnessReportV2,
  type Tau2PairwiseToneItemV2,
  type Tau2SessionTranscriptV2,
  type Tau2Task,
  type Tau2TrialRecordV2,
} from '../src/services/conversationalV2/tau2';
import type { VoiceCopyIdV2 } from '../src/services/conversationalV2/voice/types';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/tau2';
process.env.OPENAI_API_KEY ||= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN = 'smoke-invalid';

const SMOKE_LUNA_FIXTURE_KEY = 'sk-smoke-luna-invalid';

function liveProjectKeyV2(length = 164, fill = 'A'): string {
  const prefix = 'sk-proj-';
  const key = prefix + fill.repeat(Math.max(0, length - prefix.length));
  return key.slice(0, length);
}

function unluckyLiveProjectKeyV2(): string {
  const prefix = 'sk-proj-';
  const needle = 'smoke';
  const fillLen = 164 - prefix.length - needle.length;
  return `${prefix}${'C'.repeat(fillLen)}${needle}`;
}

const TASKS_DIR = path.join(
  __dirname,
  'benchmarks/ana-v2-tau2/tasks'
);

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-peeling',
      name: 'Peeling facial',
      durationMinutes: 45,
      price: 140,
      priceFormatted: 'R$ 140,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

function parseMode(argv: string[]): 'mock' | 'real' {
  let mode: 'mock' | 'real' = 'mock';
  for (const arg of argv) {
    if (arg === '--real') mode = 'real';
    else if (arg === '--mock-provider') mode = 'mock';
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Uso: npm run smoke:ana-v2-tau2 -- [--mock-provider|--real]'
      );
      console.log(
        'Juiz pairwise --real: ANA_V2_TAU2_JUDGE_PROVIDER / ANA_V2_TAU2_JUDGE_MODEL'
      );
      process.exit(0);
    }
  }
  return mode;
}

function armConfig(arm: Tau2ArmId, mode: 'mock' | 'real'): TenantBotConfig {
  const spec = tau2ArmProviderSpecV2(arm);
  const base = {
    tenantSlug: 'tenant-v2-tau2',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Atenda.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: spec.provider,
    aiModel: spec.requestedModel,
    aiTemperature: 0.2,
    aiMaxTokens: 900,
    openaiApiKey:
      mode === 'real'
        ? null
        : spec.provider === 'luna'
          ? SMOKE_LUNA_FIXTURE_KEY
          : null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'smoke-token',
    waApiVersion: 'v21.0',
    phoneNumberId: `PN-TAU2-${arm}`,
    isActive: true,
    authoritativeCatalog: {
      tenant: { name: 'Clínica Fixture', address: 'Rua Fixture, 1' },
      services: [],
      professionals: [],
    },
  } as TenantBotConfig;
  return applyTau2ArmProviderSpecV2(base, arm);
}

function completionFor(
  content: string,
  model = 'deepseek-v4-flash-mock',
  usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'tau2-completion',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null },
      },
    ],
    usage,
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function fakeTrial(
  taskId: string,
  armId: Tau2ArmId,
  trialId: number,
  success: boolean
): Tau2TrialRecordV2 {
  const state = emptyCanonicalStateV2();
  return {
    taskId,
    armId,
    trialId,
    userActs: ['quero agendar'],
    deliveredPayloads: ['payload'],
    actual: state,
    expected: state,
    reward: {
      state: success ? 1 : 0,
      envAssertion: success ? 1 : 0,
      communicate: success ? 1 : 0,
      reward: success ? 1 : 0,
    },
    controllerErrors: 0,
  };
}

async function loadTasks(): Promise<Tau2Task[]> {
  const names = (await readdir(TASKS_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const tasks: Tau2Task[] = [];
  for (const name of names) {
    const raw = JSON.parse(await readFile(path.join(TASKS_DIR, name), 'utf8'));
    tasks.push(parseTau2TaskV2(raw));
  }
  return tasks;
}

async function executeSessionTurn(input: {
  task: Tau2Task;
  arm: Tau2ArmId;
  trialId: number;
  act: string;
  turnIndex: number;
  store: MemoryConversationalV2StateStore;
  voiceCalls: { count: number };
  now: Date;
  mode: 'mock' | 'real';
}): Promise<{
  payload: string;
  actual: Tau2CanonicalState;
  wrote: boolean;
  copyId: VoiceCopyIdV2 | null;
}> {
  const vector = TAU2_ARM_VECTORS[input.arm];
  const config = armConfig(input.arm, input.mode);
  const phone = `5511999${String(input.trialId).padStart(3, '0')}${input.task.id.length}`;
  const conversationKey = `${config.phoneNumberId}:${phone}`;
  const sequence = input.turnIndex + 1;
  input.store.setInputSequence(conversationKey, sequence);
  const inboundId = `${input.task.id}-${input.arm}-${input.trialId}-${sequence}`;
  let serial = 0;
  const prepared = await getReceptionistReplyV2({
    phone,
    userMessage: input.act,
    userName: 'Cliente',
    config,
    interpreterEnabled: vector.interpreter,
    voiceEnabled: vector.voice,
    turnRuntime: {
      inputSequence: sequence,
      currentInboundIds: [inboundId],
      currentInboundTextsById: { [inboundId]: input.act },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: sequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store: input.store,
      now: () => input.now,
      id: () => `${inboundId}-id-${++serial}`,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      interpreterEnabled: vector.interpreter,
      voiceEnabled: vector.voice,
      runInterpreter: vector.interpreter
        ? (candidate) =>
            interpretPowerZeroV2({
              ...candidate,
              ...(input.mode === 'mock'
                ? {
                    completionFactory: async () =>
                      completionFor(JSON.stringify({ choice: 'OPT_1' })),
                  }
                : {}),
            })
        : undefined,
      runModelLoop: async () => {
        throw new Error(`${input.arm} task ${input.task.id} não chama brain no oracle`);
      },
      ...(input.mode === 'mock'
        ? {
            rephraseCompletion: async (completionInput) => {
              input.voiceCalls.count += 1;
              const prompt = String(completionInput.messages[0]?.content ?? '');
              const connectiveId = prompt.includes('- perfeito →')
                ? 'perfeito'
                : 'vamos_la';
              return completionFor(`{"connectiveId":"${connectiveId}"}`);
            },
          }
        : {}),
    },
  });
  if (vector.voice && prepared.planReceipt.voice?.providerCallCount === 1) {
    if (input.mode === 'real') input.voiceCalls.count += 1;
  }
  if (input.mode === 'real' && vector.voice) {
    const voice = prepared.planReceipt.voice;
    assert.ok(voice, `${input.arm} --real sem recibo de voz`);
    if (voice.providerCallCount === 1) {
      assertTau2RealVoiceReceiptV2({
        armId: input.arm,
        provider: voice.provider,
        requestedModel: voice.requestedModel,
        returnedModel: voice.returnedModel,
        decision: voice.decision,
      });
    }
  }
  await deliverPreparedReceptionistTurnV2(prepared, {
    store: input.store,
    now: () => input.now,
    id: () => `${inboundId}-del-${++serial}`,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: `${inboundId}-wamid` }),
  });
  const payload = prepared.payload ?? '';
  const bookEffects = prepared.planReceipt.toolEffects.filter(
    (effect) => effect.tool === 'bookAppointment' && effect.writeCommitted
  ).length;
  const cancelEffects = prepared.planReceipt.toolEffects.filter(
    (effect) => effect.tool === 'cancelAppointment' && effect.writeCommitted
  ).length;
  const pendingKind =
    prepared.transition.kind === 'open'
      ? prepared.transition.frame.kind
      : prepared.frame.pending?.kind ?? null;
  const flowServiceId =
    prepared.transition.kind === 'open'
      ? prepared.transition.nextFlowState.fixedServiceId ??
        prepared.frame.flowState.fixedServiceId ??
        null
      : prepared.frame.flowState.fixedServiceId ?? null;
  return {
    payload,
    copyId: prepared.planReceipt.voice?.copyId ?? null,
    wrote: bookEffects > 0 || cancelEffects > 0,
    actual: projectSessionStateV2({
      appointmentCount: 0,
      bookEffects,
      cancelEffects,
      pendingKind,
      flowServiceId,
      optOut: false,
      paused: false,
      outboundCount: sequence,
    }),
  };
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'real') {
    scrubFixtureLlmCredentialsFromEnvV2();
  } else {
    process.env.DEEPSEEK_API_KEY ||= 'sk-smoke-invalid';
  }
  assert.equal(passAt4(3, 8), 0);
  assert.equal(passAt4(8, 8), 1);
  assert.equal(passAt4(4, 4), 1);
  assert.equal(passAt4(3, 4), 0);
  assert.ok(passAt4(4, 8) > 0 && passAt4(4, 8) < 1);
  assert.ok(passAt4(5, 8) >= passAt4(4, 8));
  assert.ok(passAtK(4, 8, 4) >= 0 && passAtK(4, 8, 4) <= 1);
  assert.equal(passAt1(4, 8), 0.5);
  assert.equal(isToneJudgeAttachedToRewardV2(), false);
  assert.equal(replayIncompatibleResultV2(), 'replay_incompatible');
  assert.equal(TAU2_REPORT_SCHEMA_VERSION, 6);
  assert.equal(requiredSimulatorAuditCountV2(40), 30);
  assert.equal(requiredSimulatorAuditCountV2(200), 40);

  const pairing = recommendedVoiceBaselineV2();
  assert.equal(
    voicePairingIsValidV2(
      TAU2_ARM_VECTORS[pairing.baseline],
      TAU2_ARM_VECTORS[pairing.voiced]
    ),
    true
  );
  assert.equal(
    voicePairingIsValidV2(TAU2_ARM_VECTORS.flash, TAU2_ARM_VECTORS.flash_interpreter_voice),
    false
  );

  assert.equal(
    mapPairwiseSideToPreferenceV2('ab', 'right'),
    'variant'
  );
  assert.equal(
    mapPairwiseSideToPreferenceV2('ba', 'left'),
    'variant'
  );
  assert.equal(
    consistentPairwisePreferenceV2('variant', 'variant'),
    'variant'
  );
  assert.equal(
    consistentPairwisePreferenceV2('template', 'variant'),
    null
  );
  assert.throws(
    () =>
      assertToneJudgePanelV2({
        judges: [{ id: 'flash', provider: 'deepseek', model: 'deepseek-v4-flash' }],
        generatorModels: ['deepseek-v4-flash'],
        lengthBandMaxRelativeDelta: 0.35,
      }),
    /não pode julgar variante do próprio modelo/
  );
  assertToneJudgePanelV2({
    judges: [{ id: 'luna', provider: 'luna', model: 'gpt-5.6-luna' }],
    generatorModels: ['deepseek-v4-flash'],
    lengthBandMaxRelativeDelta: 0.35,
  });

  const serviceTemplate =
    'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?';
  const serviceVariant =
    'Combinado! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?';
  const pairwiseItems: Tau2PairwiseToneItemV2[] = [
    {
      id: 'eligible-variant',
      copyId: 'initial_service_question',
      template: serviceTemplate,
      variant: serviceVariant,
      catalog: {
        services: ['Peeling facial', 'Drenagem Linfática'],
        professionals: ['Carla Mendes'],
      },
    },
    {
      id: 'fidelity-gate',
      copyId: 'availability_slots_offer',
      template: 'Encontrei horários para 14/08/2026: 15h e 16h. Qual você prefere?',
      variant: 'Encontrei horários para 14/08/2026: 15h. Qual você prefere?',
      catalog: {
        services: ['Peeling facial'],
        professionals: ['Carla Mendes'],
      },
    },
    {
      id: 'length-band',
      copyId: 'availability_slots_offer',
      template: 'Encontrei horários para 14/08/2026: 15h e 16h. Qual você prefere?',
      variant:
        'Encontrei horários para 14/08/2026: 15h e 16h. Qual você prefere? Certo. Certo. Certo. Certo. Certo. Certo. Certo. Certo.',
      catalog: {
        services: ['Peeling facial'],
        professionals: ['Carla Mendes'],
      },
    },
  ];
  const pairwiseToneProbe = await evaluatePairwiseToneV2({
    items: pairwiseItems,
    config: {
      judges: [{ id: 'luna', provider: 'luna', model: OPENAI_LUNA_MODEL }],
      generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
      lengthBandMaxRelativeDelta: TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
    },
    askJudge: async ({ order }) => (order === 'ab' ? 'right' : 'left'),
  });
  assert.equal(pairwiseToneProbe.nExcludedFidelity, 1);
  assert.equal(pairwiseToneProbe.nExcludedLength, 1);
  assert.equal(pairwiseToneProbe.nEligible, 1);
  assert.equal(pairwiseToneProbe.nComparisons, 2);
  assert.equal(pairwiseToneProbe.nConsistent, 1);
  assert.equal(pairwiseToneProbe.nInconsistent, 0);
  assert.equal(pairwiseToneProbe.variantWins, 1);
  assert.equal(pairwiseToneProbe.templateWins, 0);
  assert.equal(pairwiseToneProbe.preferenceRate, 1);
  const leftBias = await evaluatePairwiseToneV2({
    items: [pairwiseItems[0]!],
    config: {
      judges: [{ id: 'luna', provider: 'luna', model: OPENAI_LUNA_MODEL }],
      generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
      lengthBandMaxRelativeDelta: TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2,
    },
    askJudge: async () => 'left',
  });
  assert.equal(leftBias.nComparisons, 2);
  assert.equal(leftBias.nInconsistent, 1);
  assert.equal(leftBias.nConsistent, 0);
  assert.equal(leftBias.preferenceRate, null);

  assert.deepEqual(defaultPairwiseJudgeSpecV2([DEEPSEEK_V4_FLASH_MODEL]), {
    id: 'luna',
    provider: 'luna',
    model: OPENAI_LUNA_MODEL,
  });
  assert.deepEqual(defaultPairwiseJudgeSpecV2([OPENAI_LUNA_MODEL]), {
    id: 'flash',
    provider: 'deepseek',
    model: DEEPSEEK_V4_FLASH_MODEL,
  });
  assert.equal(
    defaultPairwiseJudgeSpecV2([DEEPSEEK_V4_FLASH_MODEL, OPENAI_LUNA_MODEL]),
    null
  );
  assert.equal(parsePairwiseJudgeSideV2('{"side":"right"}'), 'right');
  assert.equal(parsePairwiseJudgeSideV2('```json\n{"side":"LEFT"}\n```'), 'left');
  const pairedTurns = pairVoiceArmTurnsForToneV2({
    turns: [
      {
        taskId: 't',
        armId: 'flash_interpreter',
        trialId: 1,
        turnIndex: 0,
        payload: serviceTemplate,
        copyId: null,
      },
      {
        taskId: 't',
        armId: 'flash_interpreter_voice',
        trialId: 1,
        turnIndex: 0,
        payload: serviceVariant,
        copyId: 'initial_service_question',
      },
      {
        taskId: 't',
        armId: 'flash_interpreter_voice',
        trialId: 1,
        turnIndex: 1,
        payload: 'sem copyId',
        copyId: null,
      },
    ],
    baselineArm: pairing.baseline,
    voicedArm: pairing.voiced,
    catalog: {
      services: ['Peeling facial'],
      professionals: ['Carla Mendes'],
    },
  });
  assert.equal(pairedTurns.length, 1);
  assert.equal(pairedTurns[0]!.id, 't:1:initial_service_question:0');
  assert.equal(pairedTurns[0]!.template, serviceTemplate);
  assert.equal(pairedTurns[0]!.variant, serviceVariant);
  assert.throws(
    () =>
      pairVoiceArmTurnsForToneV2({
        turns: [],
        baselineArm: 'flash',
        voicedArm: 'flash_interpreter_voice',
        catalog: { services: [], professionals: [] },
      }),
    /inválido/
  );

  const liveCalls: Array<{
    order: 'ab' | 'ba';
    left: string;
    right: string;
    itemId: string;
  }> = [];
  const injected = await runPairwiseToneHarnessV2({
    items: pairwiseItems,
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    judges: [{ id: 'luna', provider: 'luna', model: OPENAI_LUNA_MODEL }],
    completionFactory: async (input) => {
      liveCalls.push({
        order: input.order,
        left: input.left,
        right: input.right,
        itemId: input.itemId,
      });
      return completionFor(
        JSON.stringify({ side: input.order === 'ab' ? 'right' : 'left' }),
        OPENAI_LUNA_MODEL
      );
    },
  });
  assert.equal(liveCalls.length, 2, 'juiz injetável faz exatamente duas chamadas');
  assert.equal(liveCalls[0]!.order, 'ab');
  assert.equal(liveCalls[0]!.left, serviceTemplate);
  assert.equal(liveCalls[0]!.right, serviceVariant);
  assert.equal(liveCalls[1]!.order, 'ba');
  assert.equal(liveCalls[1]!.left, serviceVariant);
  assert.equal(liveCalls[1]!.right, serviceTemplate);
  assert.ok(liveCalls.every((call) => call.itemId === 'eligible-variant'));
  assert.equal(injected.status, 'judged');
  assert.equal(injected.reason, null);
  assert.equal(injected.nExcludedFidelity, 1);
  assert.equal(injected.nExcludedLength, 1);
  assert.equal(injected.nEligible, 1);
  assert.equal(injected.nComparisons, 2);
  assert.equal(injected.receipts.length, 2);
  assert.equal(injected.receipts[0]!.order, 'ab');
  assert.equal(injected.receipts[1]!.order, 'ba');
  assert.equal(injected.cost.totalTokens, 10);
  assert.equal(injected.preferenceRate, 1);
  assert.equal(injected.nPairedItems, 3);
  assert.deepEqual(injected.judges, ['luna']);

  const selfJudgeCalls: number[] = [];
  const selfJudge = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    judges: [
      {
        id: 'flash',
        provider: 'deepseek',
        model: DEEPSEEK_V4_FLASH_MODEL,
      },
    ],
    completionFactory: async () => {
      selfJudgeCalls.push(1);
      return completionFor('{"side":"left"}', DEEPSEEK_V4_FLASH_MODEL);
    },
  });
  assert.equal(selfJudge.status, 'not_run');
  assert.equal(selfJudge.reason, 'self_judge');
  assert.equal(selfJudgeCalls.length, 0);
  assert.equal(selfJudge.preferenceRate, null);
  assert.equal(selfJudge.nComparisons, 0);
  assert.equal(selfJudge.inconclusive, true);

  const missingJudge = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: {},
  });
  assert.equal(missingJudge.status, 'not_run');
  assert.equal(missingJudge.reason, 'missing_credential');
  assert.equal(missingJudge.preferenceRate, null);
  assert.equal(missingJudge.attemptedProvider, 'luna');
  assert.equal(missingJudge.attemptedModel, OPENAI_LUNA_MODEL);
  assert.equal(missingJudge.judgeError, null);

  assert.equal(isFixtureLlmCredentialV2(SMOKE_LUNA_FIXTURE_KEY), true);
  assert.equal(isFixtureLlmCredentialV2('sk-smoke-invalid'), true);
  assert.equal(isFixtureLlmCredentialV2('sk-proj-live-credential-test'), false);
  assert.equal(
    liveLlmCredentialV2(SMOKE_LUNA_FIXTURE_KEY, 'sk-smoke-invalid'),
    null
  );
  assert.equal(
    liveLlmCredentialV2(SMOKE_LUNA_FIXTURE_KEY, 'sk-proj-live-credential-test'),
    'sk-proj-live-credential-test'
  );
  assert.equal(
    pairwiseJudgeCredentialPresentV2('luna', {
      OPENAI_API_KEY: 'sk-smoke-invalid',
    }),
    false
  );
  assert.equal(
    pairwiseJudgeCredentialPresentV2('luna', {
      OPENAI_API_KEY_LUNA: SMOKE_LUNA_FIXTURE_KEY,
      OPENAI_API_KEY: 'sk-smoke-invalid',
    }),
    false
  );
  assert.equal(
    pairwiseJudgeCredentialPresentV2('luna', {
      OPENAI_API_KEY: 'sk-proj-live-credential-test',
    }),
    true
  );
  const fixtureJudge = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: {
      OPENAI_API_KEY: 'sk-smoke-invalid',
      OPENAI_API_KEY_LUNA: SMOKE_LUNA_FIXTURE_KEY,
    },
  });
  assert.equal(fixtureJudge.status, 'not_run');
  assert.equal(fixtureJudge.reason, 'missing_credential');
  assert.equal(fixtureJudge.inconclusive, true);
  assert.equal(fixtureJudge.nComparisons, 0);

  const live164 = liveProjectKeyV2(164);
  const unlucky164 = unluckyLiveProjectKeyV2();
  assert.equal(live164.length, 164);
  assert.equal(unlucky164.length, 164);
  assert.ok(unlucky164.includes('smoke'));
  assert.equal(isLiveOpenAiCredentialShapeV2(live164), true);
  assert.equal(isLiveOpenAiCredentialShapeV2(unlucky164), true);
  assert.equal(isFixtureLlmCredentialV2(live164), false);
  assert.equal(isFixtureLlmCredentialV2(unlucky164), false);

  const scrubbedLive: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: live164,
    OPENAI_API_KEY_LUNA: unlucky164,
  };
  scrubFixtureLlmCredentialsFromEnvV2(scrubbedLive);
  assert.equal(scrubbedLive.OPENAI_API_KEY, live164);
  assert.equal(scrubbedLive.OPENAI_API_KEY_LUNA, unlucky164);

  const npmClobber: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: 'sk-smoke-invalid',
    OPENAI_API_KEY_LUNA: live164,
  };
  scrubFixtureLlmCredentialsFromEnvV2(npmClobber);
  assert.equal('OPENAI_API_KEY' in npmClobber, false);
  assert.equal(npmClobber.OPENAI_API_KEY_LUNA, live164);
  assert.equal(pairwiseJudgeCredentialPresentV2('luna', npmClobber), true);
  assert.equal(
    pairwiseJudgeCredentialPresentV2('openai', {
      OPENAI_API_KEY_LUNA: live164,
    }),
    true
  );
  assert.equal(
    resolvePairwiseJudgeCredentialV2('openai', {
      OPENAI_API_KEY_LUNA: live164,
    }),
    live164
  );
  assert.equal(
    resolvePairwiseJudgeCredentialV2('openai', {
      OPENAI_API_KEY: live164,
    }),
    live164
  );

  const lunaJudgeSpec = {
    id: 'luna',
    provider: 'luna',
    model: OPENAI_LUNA_MODEL,
  } as const;
  const openaiLunaJudgeSpec = {
    id: 'openai-luna',
    provider: 'openai',
    model: OPENAI_LUNA_MODEL,
  } as const;
  const judgeCompletionInput = pairwiseJudgeCompletionInputV2([
    { role: 'user', content: 'Compare A e B.' },
  ]);
  assert.equal(judgeCompletionInput.maxTokens, TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2);
  for (const spec of [lunaJudgeSpec, openaiLunaJudgeSpec]) {
    assert.equal(canonicalPairwiseJudgeProviderV2(spec), 'luna');
    const providerRequest = buildPairwiseJudgeProviderRequestV2(
      spec,
      judgeCompletionInput,
      live164
    );
    assert.equal(providerRequest.transport, 'responses');
    assert.equal('max_tokens' in providerRequest.request, false);
    assert.equal('max_completion_tokens' in providerRequest.request, false);
    assert.equal(
      providerRequest.request.max_output_tokens,
      TAU2_PAIRWISE_JUDGE_MAX_TOKENS_V2
    );
    assert.equal(providerRequest.request.model, OPENAI_LUNA_MODEL);
    assert.ok(Array.isArray(providerRequest.request.input));
    assert.equal(
      (providerRequest.request.text as { format?: { type?: string } } | undefined)
        ?.format?.type,
      'json_object'
    );
  }

  const runtimeConfigWithResolvedKey = pairwiseJudgeRuntimeConfigV2(
    openaiLunaJudgeSpec,
    live164
  );
  assert.equal(runtimeConfigWithResolvedKey.openaiApiKey, live164);
  assert.equal(runtimeConfigWithResolvedKey.aiProvider, 'luna');
  const runtimeWithResolvedKey = resolvePairwiseJudgeRuntimeV2(
    openaiLunaJudgeSpec,
    live164
  );
  assert.equal(runtimeWithResolvedKey.apiKey, live164);
  assert.equal(runtimeWithResolvedKey.provider, 'luna');
  assert.equal(runtimeWithResolvedKey.transport, 'responses');

  let openaiLunaCalls = 0;
  const openaiWithOnlyLuna = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: { OPENAI_API_KEY_LUNA: live164 },
    judges: [openaiLunaJudgeSpec],
    completionFactory: async (input) => {
      openaiLunaCalls += 1;
      assert.equal(input.resolvedApiKey, live164);
      assert.equal(input.runtimeConfig?.openaiApiKey, live164);
      assert.equal(input.runtime?.apiKey, live164);
      assert.equal(input.runtime?.provider, 'luna');
      assert.equal(input.runtimeProvider, 'luna');
      assert.equal(input.runtimeTransport, 'responses');
      return completionFor(
        JSON.stringify({ side: input.order === 'ab' ? 'right' : 'left' }),
        OPENAI_LUNA_MODEL
      );
    },
  });
  assert.equal(openaiWithOnlyLuna.status, 'judged');
  assert.equal(openaiWithOnlyLuna.reason, null);
  assert.equal(openaiWithOnlyLuna.attemptedProvider, 'openai');
  assert.equal(openaiWithOnlyLuna.attemptedModel, OPENAI_LUNA_MODEL);
  assert.equal(openaiLunaCalls, 2);

  let noCredentialCalls = 0;
  const openaiWithoutCredential = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: {},
    judges: [openaiLunaJudgeSpec],
    completionFactory: async () => {
      noCredentialCalls += 1;
      return completionFor('{"side":"left"}', OPENAI_LUNA_MODEL);
    },
  });
  assert.equal(openaiWithoutCredential.status, 'not_run');
  assert.equal(openaiWithoutCredential.reason, 'missing_credential');
  assert.equal(openaiWithoutCredential.attemptedProvider, 'openai');
  assert.equal(openaiWithoutCredential.attemptedModel, OPENAI_LUNA_MODEL);
  assert.equal(openaiWithoutCredential.nComparisons, 0);
  assert.equal(noCredentialCalls, 0);

  // Regressão da sonda 7c: o gate aceitava LUNA para provider openai, mas o
  // adapter lia só OPENAI_API_KEY. O mesmo runtime agora carrega a chave LUNA.
  const legacyOpenAiJudgeSpec = {
    id: 'openai-legacy-probe',
    provider: 'openai',
    model: 'gpt-4o-mini',
  } as const;
  let legacyProbeCalls = 0;
  const formerGateAdapterDivergence = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: { OPENAI_API_KEY_LUNA: live164 },
    judges: [legacyOpenAiJudgeSpec],
    completionFactory: async (input) => {
      legacyProbeCalls += 1;
      assert.equal(input.resolvedApiKey, live164);
      assert.equal(input.runtimeConfig?.openaiApiKey, live164);
      assert.equal(input.runtime?.apiKey, live164);
      assert.equal(input.runtime?.provider, 'openai');
      assert.equal(input.runtimeTransport, 'chat_completions');
      return completionFor(
        JSON.stringify({ side: input.order === 'ab' ? 'right' : 'left' }),
        legacyOpenAiJudgeSpec.model
      );
    },
  });
  assert.equal(formerGateAdapterDivergence.status, 'judged');
  assert.equal(formerGateAdapterDivergence.reason, null);
  assert.equal(legacyProbeCalls, 2);

  let failingJudgeCalls = 0;
  const syntheticJudgeFailure = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: { OPENAI_API_KEY_LUNA: live164 },
    judges: [openaiLunaJudgeSpec],
    completionFactory: async (input) => {
      failingJudgeCalls += 1;
      if (failingJudgeCalls === 1) {
        return completionFor('{"side":"right"}', OPENAI_LUNA_MODEL);
      }
      const error = new Error(
        `Use 'max_completion_tokens' instead; credential=${live164}`
      ) as Error & { status: number };
      error.status = 400;
      throw error;
    },
  });
  assert.equal(failingJudgeCalls, 2);
  assert.equal(syntheticJudgeFailure.status, 'not_run');
  assert.equal(syntheticJudgeFailure.reason, 'judge_call_failed');
  assert.equal(syntheticJudgeFailure.inconclusive, true);
  assert.equal(syntheticJudgeFailure.preferenceRate, null);
  assert.equal(syntheticJudgeFailure.nEligible, 1);
  assert.equal(syntheticJudgeFailure.nComparisons, 1);
  assert.equal(syntheticJudgeFailure.nConsistent, 0);
  assert.equal(syntheticJudgeFailure.receipts.length, 1);
  assert.equal(syntheticJudgeFailure.cost.totalTokens, 5);
  assert.deepEqual(syntheticJudgeFailure.judges, ['openai-luna']);
  assert.equal(syntheticJudgeFailure.attemptedProvider, 'openai');
  assert.equal(syntheticJudgeFailure.attemptedModel, OPENAI_LUNA_MODEL);
  assert.match(syntheticJudgeFailure.judgeError ?? '', /^400 /);
  assert.match(
    syntheticJudgeFailure.judgeError ?? '',
    /max_completion_tokens/
  );
  assert.equal(
    syntheticJudgeFailure.judgeError?.includes(live164) ?? false,
    false
  );
  assert.equal(tau2PairwiseToneFailsProcessV2(syntheticJudgeFailure), true);
  assert.equal(tau2PairwiseToneFailsProcessV2(openaiWithOnlyLuna), false);
  assert.equal(sanitizePairwiseJudgeErrorV2({ status: 400, message: live164 }), '400 [redacted]');

  const armSnapshotBeforeJudgeFailure = TAU2_ARM_IDS.map((arm) => ({
    arm,
    vector: TAU2_ARM_VECTORS[arm],
    spec: tau2ArmProviderSpecV2(arm),
  }));
  const serializedFailureReport = JSON.parse(
    JSON.stringify({
      schemaVersion: TAU2_REPORT_SCHEMA_VERSION,
      arms: armSnapshotBeforeJudgeFailure,
      pairwiseTone: syntheticJudgeFailure,
    })
  ) as {
    schemaVersion: number;
    arms: typeof armSnapshotBeforeJudgeFailure;
    pairwiseTone: Tau2PairwiseToneHarnessReportV2;
  };
  assert.equal(serializedFailureReport.schemaVersion, 6);
  assert.deepEqual(serializedFailureReport.arms, armSnapshotBeforeJudgeFailure);
  assert.equal(serializedFailureReport.pairwiseTone.reason, 'judge_call_failed');

  const staleClone: NodeJS.Dict<string> = {
    OPENAI_API_KEY: 'sk-smoke-invalid',
  };
  assert.equal(pairwiseJudgeCredentialPresentV2('luna', staleClone), false);
  assert.equal(
    pairwiseJudgeCredentialPresentV2('luna', {
      ...staleClone,
      OPENAI_API_KEY: live164,
      OPENAI_API_KEY_LUNA: live164,
    }),
    true
  );
  assert.equal(livePairwiseJudgeEnvV2(), process.env);

  let liveFactoryCalls = 0;
  const liveEnvJudge = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: {
      OPENAI_API_KEY: live164,
      OPENAI_API_KEY_LUNA: live164,
    },
    completionFactory: async (input) => {
      liveFactoryCalls += 1;
      return completionFor(
        JSON.stringify({ side: input.order === 'ab' ? 'right' : 'left' }),
        OPENAI_LUNA_MODEL
      );
    },
  });
  assert.equal(liveEnvJudge.status, 'judged', 'env válido presente ⇒ juiz RODA');
  assert.equal(liveEnvJudge.reason, null);
  assert.equal(liveFactoryCalls, 2);
  assert.equal(liveEnvJudge.nComparisons, 2);
  assert.equal(liveEnvJudge.preferenceRate, 1);
  assert.equal(liveEnvJudge.inconclusive, false);

  let mustNotCall = 0;
  const fixtureWithFactory = await runPairwiseToneHarnessV2({
    items: [pairwiseItems[0]!],
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: {
      OPENAI_API_KEY: 'sk-smoke-invalid',
      OPENAI_API_KEY_LUNA: SMOKE_LUNA_FIXTURE_KEY,
    },
    completionFactory: async () => {
      mustNotCall += 1;
      return completionFor('{"side":"left"}', OPENAI_LUNA_MODEL);
    },
  });
  assert.equal(fixtureWithFactory.status, 'not_run');
  assert.equal(fixtureWithFactory.reason, 'missing_credential');
  assert.equal(mustNotCall, 0);
  assert.equal(armConfig('luna', 'real').openaiApiKey, null);
  assert.equal(armConfig('luna', 'mock').openaiApiKey, SMOKE_LUNA_FIXTURE_KEY);
  assert.equal(
    JSON.stringify(armConfig('luna', 'real')).includes(SMOKE_LUNA_FIXTURE_KEY),
    false
  );

  await assert.rejects(
    () =>
      runPairwiseToneHarnessV2({
        items: [pairwiseItems[0]!],
        generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
        judges: [{ id: 'luna', provider: 'luna', model: OPENAI_LUNA_MODEL }],
        completionFactory: async () =>
          completionFor('{"side":"left"}', `${OPENAI_LUNA_MODEL}-mock`),
      }),
    /rejeitado/
  );
  assert.throws(
    () =>
      assertTau2RealJudgeReceiptV2({
        requestedModel: OPENAI_LUNA_MODEL,
        returnedModel: 'luna-mock',
      }),
    /rejeitado/
  );
  const blockedJudge = resolvePairwiseJudgeSpecV2({
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    judges: [{ id: 'luna', provider: 'luna', model: 'gpt-5.6-luna-mock' }],
    requireCredential: false,
  });
  assert.equal(blockedJudge.ok, false);
  if (!blockedJudge.ok) assert.equal(blockedJudge.reason, 'blocked_model');
  const envSelfJudge = resolvePairwiseJudgeSpecV2({
    generatorModels: [DEEPSEEK_V4_FLASH_MODEL],
    env: { ANA_V2_TAU2_JUDGE_PROVIDER: 'deepseek' },
    requireCredential: false,
  });
  assert.equal(envSelfJudge.ok, false);
  if (!envSelfJudge.ok) assert.equal(envSelfJudge.reason, 'self_judge');

  const flashSpec = tau2ArmProviderSpecV2('flash');
  const lunaSpec = tau2ArmProviderSpecV2('luna');
  const voiceSpec = tau2ArmProviderSpecV2('flash_interpreter_voice');
  assert.equal(flashSpec.provider, 'deepseek');
  assert.equal(flashSpec.requestedModel, DEEPSEEK_V4_FLASH_MODEL);
  assert.notEqual(flashSpec.requestedModel, 'gpt-4o-mini');
  assert.equal(lunaSpec.provider, 'luna');
  assert.equal(lunaSpec.requestedModel, 'gpt-5.6-luna');
  assert.equal(voiceSpec.requestedModel, DEEPSEEK_V4_FLASH_MODEL);

  assert.throws(
    () =>
      assertTau2RealVoiceReceiptV2({
        armId: 'flash_interpreter_voice',
        provider: 'deepseek',
        requestedModel: DEEPSEEK_V4_FLASH_MODEL,
        returnedModel: 'deepseek-v4-flash-mock',
        decision: 'accepted',
      }),
    /rejeitado/
  );
  assert.throws(
    () =>
      assertTau2RealVoiceReceiptV2({
        armId: 'flash_interpreter_voice',
        provider: 'deepseek',
        requestedModel: 'gpt-4o-mini',
        returnedModel: 'gpt-4o-mini',
        decision: 'accepted',
      }),
    /rejeitado|exige/
  );
  assert.doesNotThrow(() =>
    assertTau2RealVoiceReceiptV2({
      armId: 'flash_interpreter_voice',
      provider: 'deepseek',
      requestedModel: DEEPSEEK_V4_FLASH_MODEL,
      returnedModel: DEEPSEEK_V4_FLASH_MODEL,
      decision: 'accepted',
    })
  );

  const mixed = [
    ...[0, 1, 2, 3].map((trialId) =>
      fakeTrial('booking-service-date-time', 'flash', trialId, true)
    ),
    ...[0, 1, 2, 3].map((trialId) =>
      fakeTrial('booking-service-date-time', 'luna', trialId, false)
    ),
  ];
  const mixedRows = aggregatePassKByTaskV2(mixed);
  assert.equal(mixedRows.length, 2, 'Flash 4/4 + Luna 0/4 vira duas linhas');
  const flashRow = mixedRows.find((row) => row.armId === 'flash');
  const lunaRow = mixedRows.find((row) => row.armId === 'luna');
  assert.ok(flashRow && lunaRow);
  assert.equal(flashRow.taskId, lunaRow.taskId);
  assert.equal(flashRow.trials, 4);
  assert.equal(flashRow.successes, 4);
  assert.equal(flashRow.pass1, 1);
  assert.equal(flashRow.pass4, 1);
  assert.equal(lunaRow.trials, 4);
  assert.equal(lunaRow.successes, 0);
  assert.equal(lunaRow.pass1, 0);
  assert.equal(lunaRow.pass4, 0);

  const savedDeepseek = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.throws(
      () =>
        preflightTau2RealRunV2({
          flash: armConfig('flash', 'real'),
          luna: armConfig('luna', 'real'),
          flash_interpreter: armConfig('flash_interpreter', 'real'),
          luna_interpreter: armConfig('luna_interpreter', 'real'),
          flash_interpreter_voice: armConfig('flash_interpreter_voice', 'real'),
        }),
      /DEEPSEEK_API_KEY/
    );
  } finally {
    if (savedDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeepseek;
  }

  const expected = emptyCanonicalStateV2();
  const extraEffect = projectSessionStateV2({
    ...expected,
    cancelEffects: 99,
    paused: true,
    outboundCount: 42,
  });
  assert.equal(evaluateStateV2(extraEffect, expected), 0);
  const extraReward = evaluateTau2RewardV2({
    actual: extraEffect,
    expected,
    envAssertions: [],
    communicateInfo: [],
    deliveredPayloads: [],
  });
  assert.equal(extraReward.state, 0);
  assert.equal(extraReward.reward, 0);
  void emptyToneScoresV2();
  assert.equal(isToneJudgeAttachedToRewardV2(), false);
  assert.equal(
    evaluateTau2RewardV2({
      actual: expected,
      expected,
      envAssertions: [],
      communicateInfo: [],
      deliveredPayloads: [],
    }).reward,
    1
  );

  assert.equal(
    summarizeSimulatorAuditV2({
      mode: 'oracle_user',
      labeled: [],
      totalTranscripts: 40,
    }).inconclusive,
    true
  );
  assert.equal(
    summarizeSimulatorAuditV2({
      mode: 'oracle_user',
      labeled: [
        {
          taskId: 't',
          armId: 'flash',
          trialId: 0,
          labels: ['ok'],
          failed: false,
          critical: false,
        },
      ],
      totalTranscripts: 40,
    }).inconclusive,
    true
  );

  const tasks = await loadTasks();
  assert.ok(tasks.length >= 2, 'harness precisa de pelo menos duas tasks');
  const multi = tasks.find((task) => (task.oracle_acts?.length ?? 0) > 1);
  assert.ok(multi, 'precisa de task multi-step');
  const single = tasks.find((task) => (task.oracle_acts?.length ?? 0) === 1);
  assert.ok(single);

  const invented = labelSimulatorTranscriptV2({
    transcript: {
      taskId: single.id,
      armId: 'luna',
      trialId: 0,
      userActs: ['ato inventado pelo simulador'],
      agentPayloads: ['ok'],
    },
    task: single,
    mode: 'oracle_user',
  });
  assert.equal(invented.failed, true);
  assert.equal(invented.critical, true);
  assert.ok(invented.labels.includes('act_not_in_controller'));
  assert.ok(invented.labels.includes('oracle_sequence_mismatch'));
  assert.equal(invented.labels.includes('ok'), false);

  const emptyPayload = labelSimulatorTranscriptV2({
    transcript: {
      taskId: single.id,
      armId: 'flash',
      trialId: 1,
      userActs: [...(single.oracle_acts ?? [single.user_scenario.first_act])],
      agentPayloads: ['   '],
    },
    task: single,
    mode: 'oracle_user',
  });
  assert.equal(emptyPayload.failed, true);
  assert.ok(emptyPayload.labels.includes('empty_agent_payload'));

  if (mode === 'real') {
    const configs = Object.fromEntries(
      TAU2_ARM_IDS.map((arm) => [arm, armConfig(arm, mode)])
    ) as Record<Tau2ArmId, TenantBotConfig>;
    const receipts = preflightTau2RealRunV2(configs);
    for (const receipt of receipts) {
      if (TAU2_ARM_VECTORS[receipt.armId].brain === 'flash') {
        assert.equal(receipt.resolvedProvider, 'deepseek');
        assert.equal(receipt.resolvedModel, DEEPSEEK_V4_FLASH_MODEL);
      }
    }
  } else {
    for (const arm of TAU2_ARM_IDS) {
      const receipt = preflightTau2ArmV2(armConfig(arm, mode), arm);
      if (arm.startsWith('flash')) {
        assert.equal(receipt.resolvedModel, DEEPSEEK_V4_FLASH_MODEL);
        assert.notEqual(receipt.resolvedModel, 'gpt-4o-mini');
      }
    }
  }

  const repeats = 4;
  const now = new Date('2026-08-14T15:00:00.000Z');
  const records: Tau2TrialRecordV2[] = [];
  const transcripts: Tau2SessionTranscriptV2[] = [];
  const pairwiseTurns: Tau2PairwiseArmTurnV2[] = [];
  const voiceCallsByArm: Record<Tau2ArmId, number> = {
    flash: 0,
    luna: 0,
    flash_interpreter: 0,
    luna_interpreter: 0,
    flash_interpreter_voice: 0,
  };

  for (const task of tasks) {
    for (const arm of TAU2_ARM_IDS) {
      for (let trialId = 0; trialId < repeats; trialId += 1) {
        const store = new MemoryConversationalV2StateStore();
        const voiceCalls = { count: 0 };
        const record = await runTau2TrialV2({
          task,
          armId: arm,
          trialId,
          applyUserAct: async ({ act, turnIndex, initialState }) => {
            void initialState;
            const turn = await executeSessionTurn({
              task,
              arm,
              trialId,
              act,
              turnIndex,
              store,
              voiceCalls,
              now,
              mode,
            });
            pairwiseTurns.push({
              taskId: task.id,
              armId: arm,
              trialId,
              turnIndex,
              payload: turn.payload,
              copyId: turn.copyId,
            });
            return turn;
          },
        });
        records.push(record);
        voiceCallsByArm[arm] += voiceCalls.count;
        transcripts.push({
          taskId: record.taskId,
          armId: arm,
          trialId,
          userActs: record.userActs,
          agentPayloads: record.deliveredPayloads,
        });
        assert.equal(record.controllerErrors, 0, `${task.id} ${arm} controller`);
        if (mode === 'mock') {
          assert.equal(
            record.reward.reward,
            1,
            `${task.id} ${arm} trial ${trialId} FAIL state=${record.reward.state} env=${record.reward.envAssertion} comm=${record.reward.communicate} pending=${record.actual.pendingKind} flow=${record.actual.flowServiceId} out=${record.actual.outboundCount}`
          );
        }
        if (task.id === multi.id) {
          assert.equal(record.userActs.length, 2);
        }
      }
    }
  }

  const perTaskArm = aggregatePassKByTaskV2(records);
  assert.equal(perTaskArm.length, tasks.length * TAU2_ARM_IDS.length);
  if (mode === 'mock') {
    for (const entry of perTaskArm) {
      assert.equal(entry.pass1, 1, `${entry.taskId} ${entry.armId}`);
      assert.equal(entry.pass4, 1, `${entry.taskId} ${entry.armId}`);
      assert.equal(entry.trials, repeats);
    }
  }
  const macro = macroPassKFromTasksV2(perTaskArm);

  assert.equal(voiceCallsByArm.flash, 0);
  assert.equal(voiceCallsByArm.luna, 0);
  assert.equal(voiceCallsByArm.flash_interpreter, 0);
  assert.equal(voiceCallsByArm.luna_interpreter, 0);
  assert.ok(voiceCallsByArm.flash_interpreter_voice > 0);

  const audit = auditSimulatorTranscriptsV2({
    mode: 'oracle_user',
    transcripts,
    tasks,
    seed: 7,
  });
  if (mode === 'mock') {
    assert.equal(audit.inconclusive, false);
    assert.ok(audit.transcriptsAudited >= 30);
    assert.equal(audit.totalErrorRate, 0);
    assert.ok(audit.labeled.every((entry) => entry.labels.includes('ok')));
  }

  const generatorModels = generatorModelsForVoicePairV2();
  const pairwiseItemsFromArms = pairVoiceArmTurnsForToneV2({
    turns: pairwiseTurns,
    baselineArm: pairing.baseline,
    voicedArm: pairing.voiced,
    catalog: {
      services: (services.services ?? []).map((entry) => entry.name),
      professionals: (services.professionals ?? []).map((entry) => entry.name),
    },
  });
  const pairwiseTone: Tau2PairwiseToneHarnessReportV2 =
    mode === 'real'
      ? await runPairwiseToneHarnessV2({
          items: pairwiseItemsFromArms,
          generatorModels,
          env: livePairwiseJudgeEnvV2(),
        })
      : notRunPairwiseToneReportV2(
          'mock_harness',
          generatorModels,
          pairwiseItemsFromArms.length
        );
  if (mode === 'mock') {
    assert.ok(
      pairwiseItemsFromArms.length > 0,
      'mock deve parear outputs baseline×voz por taskId×trialId×copyId'
    );
  }
  if (mode === 'real') {
    if (pairwiseTone.status === 'judged') {
      assert.equal(pairwiseTone.nComparisons, pairwiseTone.receipts.length);
      assert.ok(
        pairwiseTone.receipts.every(
          (receipt) =>
            !/mock/i.test(receipt.requestedModel) &&
            !/mock/i.test(receipt.returnedModel ?? '')
        )
      );
      assert.ok(pairwiseTone.judges.length > 0);
    } else {
      assert.equal(pairwiseTone.status, 'not_run');
      assert.equal(pairwiseTone.preferenceRate, null);
      assert.equal(pairwiseTone.inconclusive, true);
      if (pairwiseTone.reason === 'judge_call_failed') {
        assert.equal(pairwiseTone.nComparisons, pairwiseTone.receipts.length);
        assert.ok(pairwiseTone.attemptedProvider);
        assert.ok(pairwiseTone.attemptedModel);
        assert.ok(pairwiseTone.judgeError);
      } else {
        assert.equal(pairwiseTone.nComparisons, 0);
        assert.equal(pairwiseTone.receipts.length, 0);
        assert.equal(pairwiseTone.judgeError, null);
      }
    }
  } else {
    assert.equal(pairwiseTone.status, 'not_run');
    assert.equal(pairwiseTone.reason, 'mock_harness');
    assert.equal(pairwiseTone.preferenceRate, null);
    assert.equal(pairwiseTone.nComparisons, 0);
    assert.equal(pairwiseTone.judges.length, 0);
    assert.equal(pairwiseTone.inconclusive, true);
    assert.ok(pairwiseTone.nPairedItems > 0);
    assert.equal(pairwiseTone.attemptedProvider, null);
    assert.equal(pairwiseTone.attemptedModel, null);
  }

  const publishedReport = {
    schemaVersion: TAU2_REPORT_SCHEMA_VERSION,
    harness: mode === 'real' ? 'ana-v2-tau2-real' : 'ana-v2-tau2-mock',
    userMode: 'oracle_user',
    FAIL: records.filter((record) => record.reward.reward !== 1).length,
    tasks: perTaskArm,
    macro,
    simulator: {
      ...audit,
      labeled: audit.labeled.map((entry) => ({
        taskId: entry.taskId,
        armId: entry.armId,
        trialId: entry.trialId,
        labels: entry.labels,
      })),
    },
    arms: TAU2_ARM_IDS.map((arm) => ({
      arm,
      vector: TAU2_ARM_VECTORS[arm],
      spec: tau2ArmProviderSpecV2(arm),
      voiceCalls: voiceCallsByArm[arm],
    })),
    pairwiseTone,
  };
  console.log(JSON.stringify(publishedReport));
  if (mode === 'real' && tau2PairwiseToneFailsProcessV2(pairwiseTone)) {
    console.error(
      'smoke-ana-v2-tau2: judge_call_failed; relatório schema-6 publicado antes do exit 1'
    );
    process.exitCode = 1;
    return;
  }
  console.log('smoke-ana-v2-tau2: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
