import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
} from '../src/services/conversationalV2/contracts';
import {
  buildSystemPromptFromServices,
  type ReceptionistModelLoopResult,
} from '../src/services/brainService';
import * as runtime from '../src/services/conversationalV2/runtime';
import { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';

// O script npm fornece estes defaults antes do processo iniciar; os módulos
// importados abaixo não fazem conexão e os deps do smoke não usam provider.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana-v2-closed-catalog';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'false';

const now = new Date('2026-08-13T15:00:00.000Z');
const BASELINE_AVAILABLE_SHA256 =
  '7d55780d186df9a00593bf58b15bbcd4d2299295a0d5fdb1f004e6860e0adf0b';
const BASELINE_UNAVAILABLE_SHA256 =
  '21fe60996254b28116d7b6ed7a8775310d15b423951cbab5fd94b1d480e7e566';

const config = {
  tenantSlug: 'baseline',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  structuredConfig: undefined,
  bookingMenu: [],
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
  phoneNumberId: 'PN-CLOSED-CATALOG-V2',
  isActive: true,
} as TenantBotConfig;

const availableCatalog: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-1',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-1'],
    },
    {
      id: 'svc-2',
      name: 'Peeling Facial',
      durationMinutes: 45,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-1', 'prof-2'],
    },
  ],
  professionals: [
    { id: 'prof-1', name: 'Júlia' },
    { id: 'prof-2', name: 'Marina' },
  ],
};

// Esta é a forma que getServices devolve depois de normalizar um catálogo ERP
// vazio (ver calendarService): success=false, sem array de services.
const normalizedEmptyCatalog: ServicesResult = {
  success: false,
  message:
    'Não encontrei serviços cadastrados no momento. Pode tentar novamente em instantes?',
};

const httpFailureCatalog: ServicesResult = {
  success: false,
  message:
    'Tive um problema ao consultar os serviços agora. Pode tentar de novo em instantes?',
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function emptyLoop(): ReceptionistModelLoopResult {
  return {
    rawReply: null,
    exhausted: true,
    provider: 'openai',
    model: 'smoke-no-provider',
    providerReportedModels: [],
    rounds: 0,
    messages: [],
    toolTrace: [],
    usage: [],
  };
}

function pendingService(flowId: string): PendingFrameSnapshotV2 {
  return {
    questionId: `pending-${flowId}`,
    askedAt: now.toISOString(),
    kind: 'SERVICE',
    flowId,
    version: 1,
    options: [
      {
        position: 1,
        entityId: 'svc-old-1',
        displayName: 'Serviço anterior',
      },
      {
        position: 2,
        entityId: 'svc-old-2',
        displayName: 'Outro serviço anterior',
      },
    ],
  };
}

type CaseResult = {
  prepared: Awaited<ReturnType<typeof runtime.getReceptionistReplyV2>>;
  modelPrompts: string[];
  modelToolSets: string[][];
  toolCalls: string[];
  regenerateCalls: number;
};

async function runCase(input: {
  catalog: ServicesResult;
  text: string;
  seedPending?: boolean;
}): Promise<CaseResult> {
  const store = new MemoryConversationalV2StateStore();
  const modelPrompts: string[] = [];
  const modelToolSets: string[][] = [];
  const toolCalls: string[] = [];
  let regenerateCalls = 0;
  const phone = '5511999999999';
  const conversationKey = `${config.phoneNumberId}:${phone}`;
  const flowId = 'flow-existing-catalog';
  if (input.seedPending) {
    const snapshot = pendingService(flowId);
    const flowState: FlowStateV2 = {
      flowId,
      fixedByProofVersion: {},
    };
    store.pending.set(conversationKey, [
      {
        conversationKey,
        state: 'OPEN',
        snapshot,
        flowState,
        updatedAt: now.toISOString(),
      },
    ]);
  }

  let serial = 0;
  const id = () => `closed-catalog-${++serial}`;
  const inboundId = id();
  const prepared = await runtime.getReceptionistReplyV2({
    phone,
    userMessage: input.text,
    userName: '',
    config,
    turnRuntime: {
      turnId: id(),
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
      id,
      loadServices: async () => input.catalog,
      loadHistory: async () => [],
      isPaused: async () => false,
      executeTool: async (name) => {
        toolCalls.push(name);
        return JSON.stringify({
          success: false,
          reason: 'blocked',
          message: 'smoke tool result',
        });
      },
      executeProactiveDuplicateRead: async () => {
        toolCalls.push('getUpcomingAppointments');
        return JSON.stringify({ success: true, appointments: [] });
      },
      runModelLoop: async (loopInput) => {
        modelPrompts.push(String(loopInput.messages[0]?.content ?? ''));
        modelToolSets.push(
          (loopInput.tools ?? []).map((tool) => tool.function.name)
        );
        return emptyLoop();
      },
      regenerate: async () => {
        regenerateCalls += 1;
        return {
          ok: false as const,
          reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
          providerCalls: 1 as const,
        };
      },
      escalate: async () => ({ matched: false as const }),
      escalateSilent: async () => ({ kind: 'pending' as const }),
      interpreterEnabled: false,
      serviceContextEnabled: false,
      serviceResolverEnabled: false,
      semanticServiceResolverEnabled: false,
      voiceEnabled: false,
    },
  });

  return {
    prepared,
    modelPrompts,
    modelToolSets,
    toolCalls,
    regenerateCalls,
  };
}

function assertCatalogUnavailableFallback(result: CaseResult): void {
  assert.equal(result.prepared.frame.catalogState, 'unavailable');
  assert.equal(
    result.prepared.payload,
    'Não consegui consultar os serviços agora. Pode tentar novamente em instantes?'
  );
  assert.deepEqual(
    result.toolCalls.filter((name) =>
      ['bookAppointment', 'cancelAppointment'].includes(name)
    ),
    [],
    'catálogo indisponível não pode alcançar writes'
  );
  assert.ok(
    result.modelToolSets.every((names) => !names.includes('getServices')),
    'arsenal v2 nunca expõe getServices'
  );
  assert.equal(result.modelPrompts.length > 0, true);
  assert.ok(result.modelPrompts.every((prompt) => !/\bgetServices\b/u.test(prompt)));
}

async function main(): Promise<void> {
  // (6) Prova exata, sem git em runtime: estes hashes foram calculados com os
  // outputs literais do baseline def0832 para as mesmas fixtures/config.
  const baselineAvailable = buildSystemPromptFromServices(
    config,
    availableCatalog,
    now
  );
  const refreshableAvailable = buildSystemPromptFromServices(
    config,
    availableCatalog,
    now,
    { catalogMode: 'refreshable' }
  );
  const baselineUnavailable = buildSystemPromptFromServices(
    config,
    httpFailureCatalog,
    now
  );
  const refreshableUnavailable = buildSystemPromptFromServices(
    config,
    httpFailureCatalog,
    now,
    { catalogMode: 'refreshable' }
  );
  assert.equal(hash(baselineAvailable), BASELINE_AVAILABLE_SHA256);
  assert.equal(hash(refreshableAvailable), BASELINE_AVAILABLE_SHA256);
  assert.equal(hash(baselineUnavailable), BASELINE_UNAVAILABLE_SHA256);
  assert.equal(hash(refreshableUnavailable), BASELINE_UNAVAILABLE_SHA256);
  assert.equal(refreshableAvailable, baselineAvailable);
  assert.equal(refreshableUnavailable, baselineUnavailable);

  // (5) O prompt fechado é produzido já sem a referência de refresh, tanto
  // para catálogo disponível quanto para o resultado indisponível.
  const closedAvailable = buildSystemPromptFromServices(
    config,
    availableCatalog,
    now,
    { catalogMode: 'closed_snapshot' }
  );
  const closedUnavailable = buildSystemPromptFromServices(
    config,
    httpFailureCatalog,
    now,
    { catalogMode: 'closed_snapshot' }
  );
  for (const prompt of [closedAvailable, closedUnavailable]) {
    assert.doesNotMatch(prompt, /\bgetServices\b/u);
    assert.doesNotMatch(prompt, /atualiz(?:ar|ada)|recarreg|refresh|reload/iu);
    assert.doesNotMatch(prompt, /nova (?:leitura|consulta).*cat[aá]logo/iu);
  }
  assert.match(closedAvailable, /snapshot imutável/u);
  assert.match(closedAvailable, /Se a ferramenta retornar erro de "Serviço não encontrado"/u);
  assert.match(closedUnavailable, /A lista de serviços não está disponível neste turno/u);

  // (1) Falha HTTP com frame novo: fallback canônico, sem provider/rede e sem
  // qualquer tentativa de escrita.
  const httpFailure = await runCase({
    catalog: httpFailureCatalog,
    text: 'Quero agendar',
  });
  assertCatalogUnavailableFallback(httpFailure);

  // (2) A mesma falha com flowState/PendingFrame já existentes não ressuscita
  // catálogo antigo nem permite book/cancel.
  const pendingFailure = await runCase({
    catalog: httpFailureCatalog,
    text: 'Quero agendar',
    seedPending: true,
  });
  assertCatalogUnavailableFallback(pendingFailure);
  assert.equal(pendingFailure.prepared.frame.pending?.flowId, 'flow-existing-catalog');

  // (3) Catálogo vazio normalizado usa exatamente o mesmo envelope seguro da
  // indisponibilidade HTTP.
  const emptyCatalog = await runCase({
    catalog: normalizedEmptyCatalog,
    text: 'Quero agendar',
  });
  assertCatalogUnavailableFallback(emptyCatalog);
  assert.equal(emptyCatalog.prepared.payload, httpFailure.prepared.payload);

  // (4) Catálogo disponível mantém o fast-path V2 que já existia: pergunta
  // canônica para a escolha do serviço, sem writes e com frame available.
  const available = await runCase({
    catalog: availableCatalog,
    text: 'Quero agendar',
  });
  assert.equal(available.prepared.frame.catalogState, 'available');
  assert.equal(
    available.prepared.payload,
    'Por aqui: Drenagem Linfática e Peeling Facial. Algum desses te interessa?'
  );
  assert.equal(available.prepared.planReceipt.route, 'fast_path');
  assert.deepEqual(available.toolCalls, []);

  // (7) A constante pública do arsenal também permanece fechada.
  assert.equal(
    runtime.RECEPTIONIST_V2_TOOLS.some(
      (tool) => tool.function.name === 'getServices'
    ),
    false
  );

  // Garante ainda que getReceptionistReplyV2 entregou um prompt fechado no
  // caminho de modelo (os casos indisponíveis acima passam por ele).
  assert.ok(httpFailure.modelPrompts.length > 0);
  assert.ok(httpFailure.modelPrompts.every((prompt) => !/\bgetServices\b/u.test(prompt)));
  assert.equal(httpFailure.regenerateCalls, 1);

  console.log('smoke-ana-conversational-v2-closed-catalog: 7 gates passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
