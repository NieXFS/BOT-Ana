/**
 * Smoke offline do terminal determinístico de service_selection.
 * Duas completions injetadas tentam a mesma tool; somente a primeira chega ao
 * executor e a resposta final vem de buildServiceQuestion, sem provider/rede.
 */
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';

process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY = 'sk-offline-smoke';
process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
const {
  runReceptionistModelLoop,
} = await import('../src/services/brainService');
const {
  buildServiceAmbiguationHint,
  buildServiceQuestion,
} = await import('../src/services/service-gate');

const services = [
  { id: 'svc-limpeza', name: 'Limpeza de Pele' },
  { id: 'svc-peeling', name: 'Peeling Facial' },
];
const canonical = buildServiceQuestion(services);
const internalHint = buildServiceAmbiguationHint(services);

const config: TenantBotConfig = {
  tenantSlug: 'tenant-tool-loop-smoke',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Prompt offline do smoke de anti-loop.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0,
  aiMaxTokens: 300,
  openaiApiKey: 'sk-offline-smoke',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'offline',
  waApiVersion: 'v21.0',
  phoneNumberId: 'phone-tool-loop-smoke',
  isActive: true,
};

function repeatedToolCompletion(round: number): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: `completion-${round}`,
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: `tool-${round}`,
              type: 'function',
              function: {
                name: 'getAvailableSlots',
                arguments: JSON.stringify({
                  date: '2026-08-07',
                  serviceId: services[0]!.id,
                }),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

function narrationCompletion(): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'completion-narration',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          refusal: null,
          content:
            'O sistema indica que preciso confirmar o serviço de forma neutra. Vou perguntar ao cliente.',
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

let completionCalls = 0;
let executedToolCalls = 0;
const result = await runReceptionistModelLoop({
  config,
  messages: [{ role: 'user', content: 'Quero agendar, mas ainda estou em dúvida.' }],
  retryOnFailure: false,
  maxToolRounds: 4,
  serviceSelectionAntiLoop: {
    services,
    intentionKey: 'turno-smoke-1',
  },
  completionFactory: async ({ round }) => {
    completionCalls += 1;
    return repeatedToolCompletion(round);
  },
  executeTool: async () => {
    executedToolCalls += 1;
    return JSON.stringify({ success: false, message: internalHint });
  },
});

assert.equal(completionCalls, 2, 'o modelo pode tentar corrigir uma vez');
assert.equal(executedToolCalls, 1, 'a segunda tool igual não pode executar');
assert.equal(result.toolTrace.length, 1, 'o trace contém só a tentativa bloqueada real');
assert.equal(result.rawReply, canonical, 'a saída final precisa ser a pergunta canônica');
assert.equal(result.exhausted, false);
assert.doesNotMatch(result.rawReply ?? '', /INTERNAL_HINT/i);
assert.doesNotMatch(result.rawReply ?? '', /o sistema indica/i);
assert.doesNotMatch(
  result.rawReply ?? '',
  /sistema|regra|ferramenta|serviceId|bloqueio|confirmação neutra|vou perguntar ao cliente/i
);
assert.doesNotMatch(result.rawReply ?? '', /\b\d{1,2}[:h]\d{2}\b/);
assert.doesNotMatch(result.rawReply ?? '', /o cliente (?:quer|pediu)|vou perguntar/i);

let narratedToolCalls = 0;
const narratedResult = await runReceptionistModelLoop({
  config,
  messages: [{ role: 'user', content: 'Quero agendar, mas ainda estou em dúvida.' }],
  retryOnFailure: false,
  serviceSelectionAntiLoop: {
    services,
    intentionKey: 'turno-smoke-2',
  },
  completionFactory: async ({ round }) =>
    round === 1 ? repeatedToolCompletion(round) : narrationCompletion(),
  executeTool: async () => {
    narratedToolCalls += 1;
    return JSON.stringify({ success: false, message: internalHint });
  },
});
assert.equal(narratedToolCalls, 1);
assert.equal(
  narratedResult.rawReply,
  canonical,
  'a narração do modelo após o primeiro bloqueio também deve ser substituída'
);
assert.doesNotMatch(narratedResult.rawReply ?? '', /o sistema indica|vou perguntar/i);

console.log('✅ smoke:ana-tool-loop passou (anti-repetição e anti-narração canônicos)');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
