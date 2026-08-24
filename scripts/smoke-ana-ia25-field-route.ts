/**
 * IA-25c field-like route, hermetic baseline/final gate.
 *
 * The target turn is sent through the real v2 runtime after deterministic
 * setup turns have produced a live confirmation pending frame. No FlowState,
 * PendingFrame or planner result is seeded. The catalog is synthetic, has 107
 * active services and zero aliases. The semantic completion is injected.
 */
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServiceSummary, ServicesResult } from '../src/services/calendarService';
import {
  type SemanticServiceCompletionFactory,
} from '../src/services/conversationalV2/semanticServiceResolver';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';

const MANICURE_ID = 'ia25-svc-manicure';
const PEDICURE_ID = 'ia25-svc-pedicure';
const COMBO_ID = 'ia25-svc-manicure-pedicure';
const MANICURE_TRADICIONAL_ID = 'ia25-svc-manicure-tradicional';
const PEDICURE_TRADICIONAL_ID = 'ia25-svc-pedicure-tradicional';
const REPOSICAO_ID = 'ia25-svc-reposicao';
const UNHA_INFANTIL_ID = 'ia25-svc-unha-infantil';

process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ??= 'sk-smoke-invalid';
process.env.DEEPSEEK_API_KEY ??= 'sk-deepseek-smoke-invalid';
process.env.ERP_API_TOKEN ??= 'ia25-field-no-erp';

function service(id: string, name: string): ServiceSummary {
  return {
    id,
    name,
    durationMinutes: 30,
    price: null,
    priceFormatted: null,
    aliases: [],
  } as ServiceSummary;
}

export const IA25_FIELD_CATALOG_107: ServicesResult = {
  success: true,
  services: [
    service(MANICURE_ID, 'Manicure'),
    service(PEDICURE_ID, 'Pedicure'),
    service(COMBO_ID, 'Manicure e pedicure'),
    service(MANICURE_TRADICIONAL_ID, 'Manicure tradicional'),
    service(PEDICURE_TRADICIONAL_ID, 'Pedicure tradicional'),
    service(REPOSICAO_ID, 'Reposição de unha'),
    service(UNHA_INFANTIL_ID, 'Unha infantil'),
    ...Array.from({ length: 100 }, (_, index) =>
      service(
        `ia25-svc-filler-${String(index + 1).padStart(3, '0')}`,
        `Serviço de laboratório ${index + 1}`
      )
    ),
  ],
  professionals: [{ id: 'ia25-prof-1', name: 'Profissional de fixture' }],
};

assert.equal(IA25_FIELD_CATALOG_107.services?.length, 107);
assert.equal(
  IA25_FIELD_CATALOG_107.services?.every(
    (entry) => (entry.aliases ?? []).length === 0
  ),
  true
);

const CONFIG = {
  tenantSlug: 'studio-viti',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.2,
  aiMaxTokens: 500,
  openaiApiKey: 'sk-ia25-field-never-used',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: 'ia25-field-phone-number-id',
  isActive: true,
} as TenantBotConfig;

function completion(content: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'ia25-field-completion',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: { role: 'assistant', content, refusal: null },
    }],
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function resolvedComboCompletion(): string {
  return JSON.stringify({
    decision: 'resolved',
    serviceId: COMBO_ID,
    candidateServiceIds: [COMBO_ID],
    evidenceText: 'pé e mão',
  });
}

function turnRuntime(sequence: number, id: string, texts: readonly string[]) {
  const inboundIds = texts.map((_text, index) => `ia25-${id}-in-${index + 1}`);
  return {
    turnId: `ia25-${id}-turn`,
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

async function main(): Promise<void> {
  const store = new MemoryConversationalV2StateStore();
  const customer = 'ia25-field-customer';
  let semanticCalls = 0;
  let primaryProviderCalls = 0;
  let regenerationProviderCalls = 0;
  let toolEffects = 0;
  const now = new Date('2026-08-24T15:00:00.000Z');

  const semanticFactory: SemanticServiceCompletionFactory = async (request) => {
    semanticCalls += 1;
    assert.deepEqual(request.tools, []);
    assert.equal(request.thinkingMode, 'disabled');
    assert.equal(request.responseFormat, 'json_object');
    assert.equal(request.provider, 'deepseek');
    assert.equal(request.model, 'deepseek-v4-flash');
    assert.equal(request.messages.length, 2);
    return completion(resolvedComboCompletion());
  };

  const runTurn = async (input: {
    sequence: number;
    id: string;
    texts: readonly string[];
    semantic: boolean;
  }) => {
    const prepared = await getReceptionistReplyV2({
      phone: customer,
      userMessage: input.texts.at(-1) ?? '',
      userName: 'fixture',
      config: CONFIG,
      serviceContextEnabled: true,
      serviceResolverEnabled: true,
      semanticServiceResolverEnabled: input.semantic,
      turnRuntime: turnRuntime(input.sequence, input.id, input.texts),
      deps: {
        store,
        now: () => now,
        id: () => `ia25-${input.id}-id`,
        loadServices: async () => IA25_FIELD_CATALOG_107,
        loadHistory: async () => [],
        isPaused: async () => false,
        semanticServiceCompletionFactory: semanticFactory,
        escalate: async () => ({ matched: false }),
        escalateSilent: async () => ({ kind: 'pending' as const }),
        runModelLoop: async () => {
          primaryProviderCalls += 1;
          throw new Error(`IA-25 field route must not call the general model: ${input.id}`);
        },
        regenerate: async () => {
          regenerationProviderCalls += 1;
          throw new Error('IA-25 field route must not regenerate');
        },
        executeTool: async (name) => {
          toolEffects += 1;
          if (name === 'getAvailableSlots') {
            return JSON.stringify({ success: true, slots: ['18:00'] });
          }
          if (name === 'getUpcomingAppointments') {
            return JSON.stringify({ success: true, appointments: [] });
          }
          throw new Error(`unexpected field fixture tool: ${name}`);
        },
        executeProactiveDuplicateRead: async () =>
          JSON.stringify({ success: true, appointments: [] }),
      },
    });
    return prepared;
  };

  // Real setup path: exact catalog service -> temporal slot -> live
  // confirmation pending. No frame/pending/flow state is fabricated.
  const setupOne = await runTurn({
    sequence: 1,
    id: 'setup-one',
    texts: ['Tem horário amanhã para Manicure e pedicure?'],
    semantic: false,
  });
  await deliverPreparedReceptionistTurnV2(setupOne, {
    store,
    now: () => now,
    id: () => 'ia25-setup-one-delivery',
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: 'ia25-setup-one-provider' }),
  });
  const setupTwo = await runTurn({
    sequence: 2,
    id: 'setup-two',
    texts: ['18:00'],
    semantic: false,
  });
  await deliverPreparedReceptionistTurnV2(setupTwo, {
    store,
    now: () => now,
    id: () => 'ia25-setup-two-delivery',
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 2,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: 'ia25-setup-two-provider' }),
  });

  // Only target-turn effects belong to the IA-25 gate below; setup reads are
  // real route preparation, not evidence for the semantic-call budget.
  semanticCalls = 0;
  primaryProviderCalls = 0;
  regenerationProviderCalls = 0;
  toolEffects = 0;
  assert.equal(setupOne.planReceipt.primaryProviderCalls, 0);
  assert.equal(setupTwo.planReceipt.primaryProviderCalls, 0);
  assert.equal(setupTwo.transition.kind, 'open');
  assert.equal(
    setupTwo.transition.kind === 'open' ? setupTwo.transition.frame.kind : null,
    'CONFIRMATION'
  );

  const targetTexts = [
    'Tem horário hoje após as 17:30?',
    'ou amanhã de manhã pra fazer a unha?',
    'pé e mão',
  ] as const;
  const target = await runTurn({
    sequence: 3,
    id: 'target',
    texts: targetTexts,
    semantic: true,
  });
  const receipt = target.planReceipt.semanticServiceResolution;

  console.log(JSON.stringify({
    stage: 'IA25C_FIELD_ROUTE',
    catalogActiveServiceCount: IA25_FIELD_CATALOG_107.services?.length ?? 0,
    aliases: 0,
    serviceContextDecision: target.planReceipt.serviceContextDecision ?? null,
    attemptedInvocationReason: receipt?.attemptedInvocationReason ?? receipt?.invocationReason ?? null,
    invocationReason: receipt?.invocationReason ?? null,
    semanticStatus: receipt?.status ?? null,
    providerCallCount: receipt?.providerCallCount ?? 0,
    skipReason: receipt?.skipReason ?? null,
    exactVetoPredicate: receipt?.skipReason ?? null,
    providerCalls: semanticCalls,
    primaryProviderCalls,
    regenerationProviderCalls,
    tools: toolEffects,
    route: target.planReceipt.route,
    writeCommitted: target.hasCommittedWrite,
  }));

  // The target route must remain a single planner-authorized B call even with
  // the live confirmation pending produced by the setup turns.
  assert.equal(target.planReceipt.serviceContextDecision, 'positive_reclarification');
  assert.equal(receipt?.attemptedInvocationReason ?? receipt?.invocationReason, 'positive_reclarification');
  assert.equal(receipt?.status, 'resolved');
  assert.equal(receipt?.providerCallCount, 1);
  assert.equal(target.transition.kind, 'open');
  assert.equal(
    target.transition.kind === 'open'
      ? target.transition.nextFlowState.fixedServiceId
      : null,
    COMBO_ID
  );
  assert.match(target.payload ?? '', /hoje|amanh[ãa]|janela|consultar/iu);
  assert.doesNotMatch(target.payload ?? '', /Você quer (?:Manicure|Pedicure)/iu);
  assert.deepEqual(target.planReceipt.toolEffects, []);
  assert.equal(primaryProviderCalls, 0);
  assert.equal(regenerationProviderCalls, 0);
  assert.equal(toolEffects, 0);
  assert.equal(target.hasCommittedWrite, false);
  console.log('smoke-ana-ia25-field-route: ok');
}

void main().catch((error: unknown) => {
  console.error(`smoke-ana-ia25-field-route: FAIL (${error instanceof Error ? error.message : 'unknown'})`);
  process.exitCode = 1;
});
