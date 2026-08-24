/**
 * Gate IA-24 DeepSeek real.
 *
 * Opt-in: nunca injeta modelReply/runModelLoop. A Laura passa pelo fast-path
 * com zero provider calls; um turno adjacente deixa o brain real executar para
 * provar provider/model/configuração sem tocar ERP, PG, Meta ou WhatsApp.
 *
 * A chave é lida somente da env ou do .env ERP explicitamente indicado por
 * RECEPS_ERP_ROOT (fallback para o worktree ERP conhecido). Ela nunca é
 * impressa, persistida ou incluída no relatório.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://ia24-deepseek:ia24-deepseek@127.0.0.1:1/ia24-deepseek';
process.env.OPENAI_API_KEY ??= 'sk-ia24-never-used';
process.env.ERP_API_TOKEN ??= 'ia24-no-erp-access';
process.env.ERP_BASE_URL ??= 'http://127.0.0.1:1';
process.env.RECEPS_INTERNAL_API_URL ??= 'http://127.0.0.1:1';

function keyPresent(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return trimmed.length >= 12 && !/replace|your-|xxx|smoke|mock|invalid/i.test(trimmed);
}

function loadDeepSeekKey(): void {
  if (keyPresent(process.env.DEEPSEEK_API_KEY)) return;
  const root = process.env.RECEPS_ERP_ROOT?.trim() || '/Users/niexfs/dev/Receps ERP';
  try {
    const envText = readFileSync(path.join(root, '.env'), 'utf8');
    const raw = envText.match(/^DEEPSEEK_API_KEY=(.*)$/m)?.[1]?.trim();
    const value = raw?.replace(/^['"]|['"]$/g, '');
    if (keyPresent(value)) process.env.DEEPSEEK_API_KEY = value;
  } catch {
    // O preflight abaixo reporta a ausência sem revelar o caminho/segredo.
  }
}

loadDeepSeekKey();
if (!keyPresent(process.env.DEEPSEEK_API_KEY)) {
  console.error('smoke-ana-ia24-deepseek-real: BLOCKED (DEEPSEEK_API_KEY ausente/placeholder)');
  process.exit(2);
}

async function main(): Promise<void> {
const { DEEPSEEK_V4_FLASH_MODEL } = await import(
  '../src/services/receptionistLlmProvider'
);
const { getReceptionistReplyV2 } = await import(
  '../src/services/conversationalV2/runtime'
);
const { MemoryConversationalV2StateStore } = await import(
  '../src/services/conversationalV2/stateStore'
);

const NOW = new Date('2026-08-24T15:00:00.000Z');
const PHONE_NUMBER_ID = 'ia24-deepseek-fixture';
const SERVICES: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-mani',
      name: 'Manicure',
      durationMinutes: 40,
      price: 40,
      priceFormatted: 'R$ 40,00',
      aliases: ['fazer a mao', 'so a mao', 'manicure normal'],
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-pedi',
      name: 'Pedicure',
      durationMinutes: 40,
      price: 45,
      priceFormatted: 'R$ 45,00',
      aliases: ['fazer o pe', 'so o pe'],
      professionalIds: ['prof-ana'],
    },
    {
      id: 'svc-mani-pedi',
      name: 'Manicure e pedicure',
      durationMinutes: 70,
      price: 70,
      priceFormatted: 'R$ 70,00',
      aliases: ['pe e mao', 'mao e pe', 'fazer pe e mao', 'fazer mao e pe'],
      professionalIds: ['prof-ana'],
    },
  ],
  professionals: [{ id: 'prof-ana', name: 'Ana Silva' }],
};

const CONFIG: TenantBotConfig = {
  tenantSlug: 'studio-viti',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança e concisão.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: DEEPSEEK_V4_FLASH_MODEL,
  aiTemperature: 0.2,
  aiMaxTokens: 700,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: PHONE_NUMBER_ID,
  isActive: true,
  authoritativeCatalog: {
    tenant: { name: 'Studio Fixture', address: null, city: 'São Paulo', state: 'SP' },
    services: SERVICES.services!.map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      price: service.price,
      aliases: service.aliases,
      professionalIds: service.professionalIds,
    })),
    professionals: [{ id: 'prof-ana', name: 'Ana Silva', active: true }],
  },
};

function runtimeForTurn(input: {
  id: string;
  sequence: number;
  text: string;
  texts?: readonly string[];
}) {
  const texts = input.texts ?? [input.text];
  const inboundIds = texts.map((_text, index) => `${input.id}-in-${index + 1}`);
  return {
    inputSequence: input.sequence,
    currentInboundIds: inboundIds,
    currentInboundTextsById: Object.fromEntries(
      inboundIds.map((inboundId, index) => [inboundId, texts[index] ?? ''])
    ),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: input.sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

async function runTurn(input: {
  phone: string;
  id: string;
  sequence: number;
  text: string;
  texts?: readonly string[];
  serviceContextEnabled: boolean;
  serviceResolverEnabled: boolean;
  store: InstanceType<typeof MemoryConversationalV2StateStore>;
}) {
  return getReceptionistReplyV2({
    phone: input.phone,
    userMessage: input.text,
    userName: 'Cliente fixture',
    config: CONFIG,
    serviceContextEnabled: input.serviceContextEnabled,
    serviceResolverEnabled: input.serviceResolverEnabled,
    turnRuntime: runtimeForTurn(input),
    deps: {
      store: input.store,
      now: () => NOW,
      id: () => `${input.id}-id`,
      loadServices: async () => SERVICES,
      loadHistory: async () => [],
      isPaused: async () => false,
      executeTool: async (name) => {
        if (name === 'getAvailableSlots') {
          return JSON.stringify({ success: true, slots: ['18:00', '18:30'] });
        }
        if (name === 'getUpcomingAppointments') {
          return JSON.stringify({ success: true, appointments: [] });
        }
        return JSON.stringify({ success: false, reason: 'other' });
      },
    },
  });
}

const lauraStore = new MemoryConversationalV2StateStore();
lauraStore.setInputSequence(`${PHONE_NUMBER_ID}:ia24-deepseek-laura`, 1);
const laura = await runTurn({
  phone: 'ia24-deepseek-laura',
  id: 'laura',
  sequence: 1,
  text: 'Tem horário hoje após as 17:30?',
  texts: [
    'Tem horário hoje após as 17:30?',
    'Ou amanhã de manhã pra fazer a unha?',
    'Pé e mão',
  ],
  serviceContextEnabled: true,
  serviceResolverEnabled: true,
  store: lauraStore,
});
assert.equal(laura.planReceipt.provider, 'deepseek');
assert.equal(laura.planReceipt.requestedModel, DEEPSEEK_V4_FLASH_MODEL);
assert.equal(laura.planReceipt.primaryProviderCalls, 0);
assert.equal(laura.planReceipt.primaryModelRounds, 0);
assert.equal(laura.planReceipt.toolEffects.length, 0);
assert.ok(typeof laura.payload === 'string' && laura.payload.length > 0);
assert.match(laura.payload ?? '', /hoje|amanh[ãa]/iu);
assert.doesNotMatch(laura.payload ?? '', /Reposição de unha|Unha infantil/iu);

const adjacentStore = new MemoryConversationalV2StateStore();
adjacentStore.setInputSequence(`${PHONE_NUMBER_ID}:ia24-deepseek-adjacent`, 1);
const adjacent = await runTurn({
  phone: 'ia24-deepseek-adjacent',
  id: 'adjacent',
  sequence: 1,
  text: 'Você pode me ajudar com uma dúvida?',
  serviceContextEnabled: false,
  serviceResolverEnabled: false,
  store: adjacentStore,
});
assert.equal(adjacent.planReceipt.provider, 'deepseek');
assert.equal(adjacent.planReceipt.requestedModel, DEEPSEEK_V4_FLASH_MODEL);
assert.ok(adjacent.planReceipt.primaryProviderCalls > 0);
assert.ok(adjacent.planReceipt.primaryModelRounds > 0);
assert.ok(adjacent.planReceipt.response.model);

console.log(
  JSON.stringify({
    status: 'PASS',
    provider: 'deepseek',
    model: DEEPSEEK_V4_FLASH_MODEL,
    laura: {
      providerCalls: laura.planReceipt.primaryProviderCalls,
      modelRounds: laura.planReceipt.primaryModelRounds,
      toolEffects: laura.planReceipt.toolEffects.length,
    },
    adjacent: {
      providerCalls: adjacent.planReceipt.primaryProviderCalls,
      modelRounds: adjacent.planReceipt.primaryModelRounds,
      responseModel: adjacent.planReceipt.response.model,
      fingerprintObserved: Boolean(adjacent.planReceipt.response.systemFingerprint),
    },
  })
);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown_error';
  console.error(`smoke-ana-ia24-deepseek-real: FAIL (${message.slice(0, 240)})`);
  process.exitCode = 1;
});
