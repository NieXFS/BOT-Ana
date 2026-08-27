/**
 * IA-27A1 — detector determinístico + prova de shadow mode.
 *
 * Tudo aqui é fixture sintética: não há rede, provider real, ERP, WhatsApp,
 * banco ou dado de cliente. O gate de shadow compara o mesmo turno com a
 * flag explícita OFF/ON; somente o sub-recibo pode aparecer no segundo caso.
 */
import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  PendingKindV2,
  PlanningIntentClassificationV2,
  PlanningIntentReceiptV2,
} from '../src/services/conversationalV2/contracts';
import type { ServicesResult } from '../src/services/calendarService';
import {
  buildPlanningIntentReceiptV2,
  classifyPlanningIntentV2,
} from '../src/services/conversationalV2/planningIntentV2';
import { serializeTurnPlanReceiptV2 } from '../src/services/conversationalV2/receipts';

process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
process.env.OPENAI_API_KEY ??= 'fixture-key-not-used';
process.env.ERP_API_TOKEN ??= 'fixture-token-not-used';

const FLOW_ID = 'ia27-flow';

const CATALOG: ServicesResult = {
  success: true,
  services: [
    {
      id: 'ia27-service-drenagem',
      name: 'Drenagem',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
    },
    {
      id: 'ia27-service-peeling',
      name: 'Peeling',
      durationMinutes: 45,
      price: 100,
      priceFormatted: 'R$ 100,00',
    },
    {
      id: 'ia27-service-manutencao',
      name: 'Manutenção de unha de gel',
      durationMinutes: 60,
      price: 90,
      priceFormatted: 'R$ 90,00',
    },
  ],
  professionals: [
    { id: 'ia27-professional-carla', name: 'Carla' },
    { id: 'ia27-professional-julia', name: 'Júlia' },
  ],
};

const FIXED_FLOW: FlowStateV2 = {
  flowId: FLOW_ID,
  fixedServiceId: 'ia27-service-peeling',
  fixedByProofVersion: { fixedServiceId: 1 },
};

function pending(
  kind: PendingKindV2,
  options: readonly { entityId: string; displayName: string }[] = []
): PendingFrameSnapshotV2 {
  return {
    questionId: 'ia27-question',
    askedAt: '2026-08-26T12:00:00.000Z',
    kind,
    flowId: FLOW_ID,
    version: 1,
    options: options.map((option, position) => ({
      position: position + 1,
      ...option,
    })),
  };
}

function classify(
  inboundText: string,
  input: Partial<Parameters<typeof classifyPlanningIntentV2>[0]> = {}
): PlanningIntentClassificationV2 {
  return classifyPlanningIntentV2({
    inboundText,
    services: CATALOG,
    ...input,
  });
}

function assertSignals(
  label: string,
  actual: PlanningIntentClassificationV2,
  expected: {
    answersPending: boolean;
    informationFamilies: PlanningIntentClassificationV2['signals']['informationFamilies'];
    transaction: PlanningIntentClassificationV2['signals']['transaction'];
    arbitration: PlanningIntentClassificationV2['arbitration'];
    subjectSource: PlanningIntentClassificationV2['subjectSource'];
  }
): void {
  assert.deepEqual(actual, {
    signals: {
      answersPending: expected.answersPending,
      informationFamilies: expected.informationFamilies,
      transaction: expected.transaction,
    },
    arbitration: expected.arbitration,
    subjectSource: expected.subjectSource,
  }, label);
}

function runClassificationMatrix(): void {
  assertSignals(
    'mixed price + booking',
    classify('Qual o valor e tem horário amanhã?'),
    {
      answersPending: false,
      informationFamilies: ['PRICE'],
      transaction: 'BOOKING',
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'none',
    }
  );
  assertSignals(
    'mixed pending professional + price',
    classify('Com a Carla, e quanto custa?', {
      pending: pending('PROFESSIONAL', [
        { entityId: 'ia27-professional-carla', displayName: 'Carla' },
      ]),
      flowState: FIXED_FLOW,
    }),
    {
      answersPending: true,
      informationFamilies: ['PRICE'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'fixed_service',
    }
  );
  assertSignals(
    'all three independent signals',
    classify('Com a Carla, quanto custa e tem horário amanhã?', {
      pending: pending('PROFESSIONAL', [
        { entityId: 'ia27-professional-carla', displayName: 'Carla' },
      ]),
      flowState: FIXED_FLOW,
    }),
    {
      answersPending: true,
      informationFamilies: ['PRICE'],
      transaction: 'BOOKING',
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'fixed_service',
    }
  );
  assertSignals(
    'mixed service existence + booking',
    classify('Vocês fazem drenagem e tem vaga hoje?'),
    {
      answersPending: false,
      informationFamilies: ['SERVICE_EXISTENCE'],
      transaction: 'BOOKING',
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'current_inbound',
    }
  );
  assertSignals(
    'catalog price with current subject',
    classify('Qual valor manutenção de unha de gel'),
    {
      answersPending: false,
      informationFamilies: ['PRICE'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'current_inbound',
    }
  );
  assertSignals(
    'bare price word',
    classify('Valor'),
    {
      answersPending: false,
      informationFamilies: ['PRICE'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'none',
    }
  );
  assertSignals(
    'service name question',
    classify('como que chama o peeling que a Jaque faz?'),
    {
      answersPending: false,
      informationFamilies: ['SERVICE_NAME'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'current_inbound',
    }
  );
  assertSignals(
    'professional and service existence',
    classify('No espaço vocês tem profissional que realiza drenagem?'),
    {
      answersPending: false,
      informationFamilies: ['SERVICE_EXISTENCE', 'PROFESSIONAL_EXISTENCE'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'current_inbound',
    }
  );
  assertSignals(
    'address',
    classify('Onde você atende'),
    {
      answersPending: false,
      informationFamilies: ['ADDRESS'],
      transaction: null,
      arbitration: 'INFORMATION_FIRST',
      subjectSource: 'none',
    }
  );
  assertSignals(
    'date pending answer plus booking',
    classify('Pode ser amanhã', {
      pending: pending('DATE', [{ entityId: 'date-tomorrow', displayName: 'amanhã' }]),
    }),
    {
      answersPending: true,
      informationFamilies: [],
      transaction: 'BOOKING',
      arbitration: 'PENDING_ANSWER',
      subjectSource: 'none',
    }
  );
  assertSignals(
    'affirmative pending answer',
    classify('Sim.', {
      pending: pending('PROFESSIONAL', [
        { entityId: 'ia27-professional-carla', displayName: 'Carla' },
      ]),
    }),
    {
      answersPending: true,
      informationFamilies: [],
      transaction: null,
      arbitration: 'PENDING_ANSWER',
      subjectSource: 'none',
    }
  );
  assertSignals(
    'question mark alone is not information authority',
    classify('?'),
    {
      answersPending: false,
      informationFamilies: [],
      transaction: null,
      arbitration: 'GENERAL',
      subjectSource: 'none',
    }
  );

  const receipt = buildPlanningIntentReceiptV2({
    inboundText: 'Qual o valor e tem horário amanhã?',
    services: CATALOG,
  });
  const expectedReceipt: PlanningIntentReceiptV2 = {
    version: 1,
    mode: 'shadow',
    hasPendingAnswerSignal: false,
    informationFamilies: ['PRICE'],
    transactionSignal: 'BOOKING',
    arbitrationCandidate: 'information_first',
    subjectSource: 'none',
  };
  assert.deepEqual(receipt, expectedReceipt, 'receipt redacted contract');
  const receiptJson = JSON.stringify(receipt);
  assert.doesNotMatch(receiptJson, /drenagem|carla|ia27|amanha|horario/iu);
  console.log('ia27a1 classification matrix: PASS');
}

const CONFIG = {
  tenantSlug: 'ia27a1-fixture',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 500,
  openaiApiKey: 'fixture-key-not-used',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-whatsapp-not-used',
  waApiVersion: 'v21.0',
  phoneNumberId: 'ia27a1-fixture-channel',
  isActive: true,
} as TenantBotConfig;

const SHADOW_TEXT = 'Qual o valor e tem horário amanhã?';

async function runShadowFixture(enabled: boolean) {
  const { getReceptionistReplyV2 } = await import(
    '../src/services/conversationalV2/runtime'
  );
  const { MemoryConversationalV2StateStore } = await import(
    '../src/services/conversationalV2/stateStore'
  );
  const store = new MemoryConversationalV2StateStore();
  let modelCalls = 0;
  const toolCalls: string[] = [];
  const prepared = await getReceptionistReplyV2({
    phone: 'synthetic-customer',
    userMessage: SHADOW_TEXT,
    userName: 'Cliente',
    config: CONFIG,
    planningIntentShadowEnabled: enabled,
    turnRuntime: {
      turnId: 'ia27a1-turn',
      inputSequence: 1,
      currentInboundIds: ['ia27a1-inbound'],
      currentInboundTextsById: { 'ia27a1-inbound': SHADOW_TEXT },
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
    },
    deps: {
      store,
      now: () => new Date('2026-08-26T15:00:00.000Z'),
      id: () => 'ia27a1-id',
      loadServices: async () => CATALOG,
      loadHistory: async () => [],
      isPaused: async () => false,
      runModelLoop: async () => {
        modelCalls += 1;
        return {
          rawReply: JSON.stringify({
            reply: 'Posso te ajudar com isso.',
            nextPending: 'PRESERVE',
            chosenOptionText: null,
            unknownServiceText: null,
          }),
          exhausted: false,
          provider: 'openai' as const,
          model: 'gpt-4o-mini',
          providerReportedModels: ['gpt-4o-mini'],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [{
            round: 1,
            durationMs: 0,
            finishReason: 'stop',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            cachedPromptTokens: null,
            cacheMissPromptTokens: null,
            reasoningTokens: null,
          }],
        };
      },
      executeTool: async (name) => {
        toolCalls.push(name);
        if (name === 'getAvailableSlots') {
          return JSON.stringify({ success: true, slots: ['18:00'] });
        }
        return JSON.stringify({ success: true, appointments: [] });
      },
    },
  });
  return { prepared, modelCalls, toolCalls };
}

function behaviorProjection(prepared: {
  payload: string | null;
  transition: unknown;
  frame: { flowState: unknown };
  planReceipt: {
    route: unknown;
    pendingTransitionCandidate: unknown;
    toolEffects: unknown;
    primaryProviderCalls: unknown;
    regenProviderCalls: unknown;
    boundaryAttempts: unknown;
  };
}) {
  return {
    route: prepared.planReceipt.route,
    reply: prepared.payload,
    pendingTransition: prepared.transition,
    pendingTransitionCandidate: prepared.planReceipt.pendingTransitionCandidate,
    flowState: prepared.frame.flowState,
    tools: prepared.planReceipt.toolEffects,
    primaryProviderCalls: prepared.planReceipt.primaryProviderCalls,
    regenProviderCalls: prepared.planReceipt.regenProviderCalls,
    boundary: prepared.planReceipt.boundaryAttempts,
  };
}

async function runShadowGate(): Promise<void> {
  const off = await runShadowFixture(false);
  const on = await runShadowFixture(true);
  const offBehavior = behaviorProjection(off.prepared);
  const onBehavior = behaviorProjection(on.prepared);

  for (const field of [
    'route',
    'reply',
    'pendingTransition',
    'pendingTransitionCandidate',
    'flowState',
    'tools',
    'primaryProviderCalls',
    'regenProviderCalls',
    'boundary',
  ] as const) {
    assert.deepEqual(onBehavior[field], offBehavior[field], `shadow ${field}`);
    console.log(`ia27a1 shadow ${field}: IDENTICAL`);
  }
  assert.equal(off.prepared.planReceipt.planningIntent, undefined);
  assert.ok(on.prepared.planReceipt.planningIntent);
  const { planningIntent: _offPlanningIntent, ...offReceiptWithoutPlanning } =
    off.prepared.planReceipt;
  const { planningIntent: _onPlanningIntent, ...onReceiptWithoutPlanning } =
    on.prepared.planReceipt;
  assert.deepEqual(
    onReceiptWithoutPlanning,
    offReceiptWithoutPlanning,
    'shadow receipt differs only by planningIntent'
  );
  console.log('ia27a1 receipt other fields: IDENTICAL');
  assert.equal(off.modelCalls, on.modelCalls);
  assert.deepEqual(off.toolCalls, on.toolCalls);
  assert.deepEqual(
    on.prepared.planReceipt.planningIntent,
    buildPlanningIntentReceiptV2({
      inboundText: SHADOW_TEXT,
      services: CATALOG,
    })
  );
  assert.doesNotThrow(() => serializeTurnPlanReceiptV2(on.prepared.planReceipt));
  console.log('ia27a1 shadow subreceipt: ON only; receipt serializes: PASS');
  console.log('ia27a1 shadow OFF/ON gate: PASS');
}

async function main(): Promise<void> {
  runClassificationMatrix();
  await runShadowGate();
  console.log('smoke ana ia27a1 planning intent: OK');
}

void main().catch((error: unknown) => {
  console.error(
    `smoke ana ia27a1 planning intent: FAIL (${error instanceof Error ? error.message : 'unknown'})`
  );
  process.exitCode = 1;
});
