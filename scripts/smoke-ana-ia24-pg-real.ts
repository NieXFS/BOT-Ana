/**
 * IA-24 PostgreSQL DEV gate.
 *
 * Opt-in only. It reads an explicitly supplied ERP .env in memory, derives a
 * direct Neon DEV endpoint (removing -pooler), rejects production/unknown
 * hosts, runs the real pgConversationalV2StateStore + delivery round-trip for
 * Laura, verifies a child-process reload, exercises the second-window read,
 * verifies takeover has no resurrection, and fail-closed cleans every
 * synthetic row it created.
 *
 * No model/provider/ERP/Meta call is made here. IA-23's frozen regression gate
 * remains a separate command (`smoke:ana-conversational-v2-ia23-pg`).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { parse as parseDotenv } from 'dotenv';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';

const OPT_IN = process.env.ANA_IA24_PG_DEV_TEST === '1';
const ENV_FILE = process.env.ANA_IA24_PG_ENV_FILE?.trim();
const DEV_HOST_RE = /^ep-restless-frost-[^.]+\.sa-east-1\.aws\.neon\.tech$/iu;
const PROD_HOST_RE = /(?:^|[.-])ep-small-frog(?:[.-]|$)/iu;
const SYNTHETIC_CONVERSATION_PREFIX = 'ia24pg:';
const SYNTHETIC_TURN_PREFIX = `ia24pg-turn:${safeTechnicalToken()}:`;

function fail(message: string): never {
  throw new Error(message);
}

function safeTechnicalToken(): string {
  // O scrub de receipts deve continuar estrito. A fixture evita tanto UUID
  // RFC-4122 embutido quanto sequências decimais de 10+ dígitos, sem criar
  // qualquer exceção nova no runtime.
  return randomUUID().replace(/[0-9]/gu, (digit) =>
    String.fromCharCode('g'.charCodeAt(0) + Number(digit))
  );
}

function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return '';
  }
}

function directUrlFromPooler(connectionString: string): string {
  const parsed = new URL(connectionString);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.|$)/iu, '');
  return parsed.toString();
}

function safeErrorKind(error: unknown): string {
  return (error instanceof Error ? error.name : 'unknown')
    .replace(/[^A-Za-z0-9_-]/gu, '')
    .slice(0, 40) || 'unknown';
}

function syntheticLike(value: string, prefix: string): boolean {
  return value.startsWith(prefix);
}

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
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 700,
  openaiApiKey: 'sk-ia24-pg-never-used',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: 'ia24pg',
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

function turnRuntime(input: {
  id: string;
  sequence: number;
  texts: readonly string[];
}) {
  const inboundIds = input.texts.map((_text, index) => `${input.id}-in-${index + 1}`);
  return {
    inputSequence: input.sequence,
    currentInboundIds: inboundIds,
    currentInboundTextsById: Object.fromEntries(
      inboundIds.map((inboundId, index) => [inboundId, input.texts[index] ?? ''])
    ),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: input.sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

async function cleanup(db: Pool, conversationKey: string): Promise<string[]> {
  const failures: string[] = [];
  const statements: Array<[string, string, unknown[]]> = [
    [
      'receipts',
      `DELETE FROM ana_v2_turn_receipts
       WHERE turn_id LIKE $1 OR receipt_id LIKE $2`,
      [`${SYNTHETIC_TURN_PREFIX}%`, `${SYNTHETIC_TURN_PREFIX}%`],
    ],
    [
      'successors',
      `DELETE FROM ana_v2_successor_batches WHERE conversation_key = $1`,
      [conversationKey],
    ],
    [
      'outbox',
      `DELETE FROM ana_v2_outbound_outbox WHERE conversation_key = $1`,
      [conversationKey],
    ],
    [
      'pending',
      `DELETE FROM ana_v2_pending_frames WHERE conversation_key = $1`,
      [conversationKey],
    ],
    [
      'invalidations',
      `DELETE FROM ana_v2_flow_state_invalidations WHERE conversation_key = $1`,
      [conversationKey],
    ],
    [
      'history',
      `DELETE FROM ana_conversation_history WHERE "conversationKey" = $1`,
      [conversationKey],
    ],
  ];
  for (const [name, sql, values] of statements) {
    try {
      await db.query(sql, values);
    } catch (error) {
      failures.push(`${name}:${safeErrorKind(error)}`);
    }
  }
  return failures;
}

async function cleanupSyntheticPrefix(db: Pool): Promise<string[]> {
  const failures: string[] = [];
  const statements: Array<[string, string]> = [
    [
      'receipts',
      `DELETE FROM ana_v2_turn_receipts
       WHERE turn_id LIKE $1 OR receipt_id LIKE $1`,
    ],
    ['successors', `DELETE FROM ana_v2_successor_batches WHERE conversation_key LIKE $1`],
    ['outbox', `DELETE FROM ana_v2_outbound_outbox WHERE conversation_key LIKE $1`],
    ['pending', `DELETE FROM ana_v2_pending_frames WHERE conversation_key LIKE $1`],
    ['invalidations', `DELETE FROM ana_v2_flow_state_invalidations WHERE conversation_key LIKE $1`],
    ['history', `DELETE FROM ana_conversation_history WHERE "conversationKey" LIKE $1`],
  ];
  for (const [name, sql] of statements) {
    try {
      await db.query(sql, [SYNTHETIC_CONVERSATION_PREFIX === 'ia24pg:' && name === 'receipts'
        ? `${SYNTHETIC_TURN_PREFIX}%`
        : `${SYNTHETIC_CONVERSATION_PREFIX}%`]);
    } catch (error) {
      failures.push(`${name}:${safeErrorKind(error)}`);
    }
  }
  return failures;
}

async function counts(db: Pool, conversationKey: string): Promise<Record<string, number> | null> {
  const queries: Record<string, [string, unknown[]]> = {
    pending: ['SELECT count(*)::int AS count FROM ana_v2_pending_frames WHERE conversation_key = $1', [conversationKey]],
    outbox: ['SELECT count(*)::int AS count FROM ana_v2_outbound_outbox WHERE conversation_key = $1', [conversationKey]],
    invalidations: ['SELECT count(*)::int AS count FROM ana_v2_flow_state_invalidations WHERE conversation_key = $1', [conversationKey]],
    successors: ['SELECT count(*)::int AS count FROM ana_v2_successor_batches WHERE conversation_key = $1', [conversationKey]],
    history: ['SELECT count(*)::int AS count FROM ana_conversation_history WHERE "conversationKey" = $1', [conversationKey]],
    receipts: [
      'SELECT count(*)::int AS count FROM ana_v2_turn_receipts WHERE turn_id LIKE $1 OR receipt_id LIKE $1',
      [`${SYNTHETIC_TURN_PREFIX}%`],
    ],
  };
  const result: Record<string, number> = {};
  try {
    for (const [name, [sql, values]] of Object.entries(queries)) {
      const row = await db.query<{ count: number }>(sql, values);
      result[name] = Number(row.rows[0]?.count ?? 0);
    }
    return result;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!OPT_IN) fail('IA-24 PG gate requires ANA_IA24_PG_DEV_TEST=1');
  if (!ENV_FILE) fail('IA-24 PG gate requires ANA_IA24_PG_ENV_FILE');
  const parsedEnv = parseDotenv(readFileSync(ENV_FILE, 'utf8')) as Record<string, string | undefined>;
  const configuredUrl = parsedEnv.DATABASE_URL?.trim();
  if (!configuredUrl) fail('authorized env has no DATABASE_URL');
  const configuredHost = hostOf(configuredUrl);
  if (PROD_HOST_RE.test(configuredHost) || !DEV_HOST_RE.test(configuredHost)) {
    fail('database host is not the authorized Neon DEV branch');
  }
  const directUrl = directUrlFromPooler(configuredUrl);
  const directHost = hostOf(directUrl);
  if (PROD_HOST_RE.test(directHost) || directHost.includes('-pooler') || !DEV_HOST_RE.test(directHost)) {
    fail('derived database endpoint is not direct authorized DEV');
  }
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    fail('IA-24 PG gate refuses NODE_ENV=production');
  }
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = directUrl;
  process.env.RECEPS_IA_DIRECT_DATABASE_URL = directUrl;
  process.env.ANA_DIRECT_DATABASE_URL = '';
  process.env.OPENAI_API_KEY = 'sk-ia24-pg-never-used';
  process.env.ERP_API_TOKEN = 'ia24-pg-no-erp-access';
  process.env.ERP_BASE_URL = 'http://127.0.0.1:1';

  const db = new Pool({
    connectionString: directUrl,
    max: 6,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: 'receps-ia-ia24-pg-gate',
  });
  db.on('error', () => undefined);
  const state = await import('../src/services/conversationalV2/stateStore');
  const contracts = await import('../src/services/conversationalV2/contracts');
  const { getReceptionistReplyV2 } = await import('../src/services/conversationalV2/runtime');
  const { deliverPreparedReceptionistTurnV2 } = await import('../src/services/conversationalV2/delivery');
  await state.ensureConversationalV2Tables();
  const contextManager = await import('../src/services/contextManager');

  const reloadKey = process.env.IA24_PG_CONVERSATION_KEY?.trim();
  if (process.argv.includes('--reload-check')) {
    if (!reloadKey || !syntheticLike(reloadKey, SYNTHETIC_CONVERSATION_PREFIX)) fail('reload conversation key missing');
    const loaded = await state.pgConversationalV2StateStore.loadLatestState(reloadKey, new Date('2026-08-24T15:05:00.000Z'));
    const expected = process.env.IA24_PG_EXPECTED_STATE;
    if (expected === 'DATE') {
      assert.equal(loaded.pending?.snapshot.kind, 'DATE');
      assert.equal(loaded.flowState?.fixedServiceId, 'svc-mani-pedi');
      assert.equal(loaded.flowState?.deferredAvailability?.schemaVersion, 2);
      assert.equal(loaded.flowState?.deferredAvailability?.windows?.length, 2);
    } else if (expected === 'TIME') {
      assert.equal(loaded.pending?.snapshot.kind, 'TIME');
      assert.deepEqual(loaded.flowState?.slotEvidence?.slots, ['18:00', '18:30', '19:00']);
    } else if (expected === 'NONE') {
      assert.equal(loaded.pending, null);
      assert.equal(loaded.flowState, null);
    } else {
      fail('unknown reload expectation');
    }
    console.log(`ia24-pg-reload-check: PASS (${expected})`);
    await contextManager.pool.end();
    await db.end();
    return;
  }

  const phone = `fixture-${safeTechnicalToken()}`;
  const conversationKey = `${CONFIG.phoneNumberId}:${phone}`;
  assert.equal(conversationKey.startsWith(SYNTHETIC_CONVERSATION_PREFIX), true);
  const now = new Date('2026-08-24T15:00:00.000Z');
  const staleCleanupFailures = await cleanupSyntheticPrefix(db);
  if (staleCleanupFailures.length > 0) {
    fail(`stale synthetic cleanup failed: ${staleCleanupFailures.join(',')}`);
  }
  const before = await counts(db, conversationKey);
  if (!before || Object.values(before).some((value) => value !== 0)) fail('synthetic prefix was not clean before test');
  let cleanupFailures: string[] = [];
  try {
    const toolNames: string[] = [];
    const runTurn = async (sequence: number, id: string, texts: readonly string[]) =>
      getReceptionistReplyV2({
        phone,
        userMessage: texts.join(' '),
        userName: 'Cliente fixture',
        config: CONFIG,
        serviceContextEnabled: true,
        serviceResolverEnabled: true,
        turnRuntime: turnRuntime({ id, sequence, texts }),
        deps: {
          store: state.pgConversationalV2StateStore,
          now: () => now,
          id: () => `${SYNTHETIC_TURN_PREFIX}${id}-${safeTechnicalToken()}`,
          loadServices: async () => SERVICES,
          loadHistory: async () => [],
          isPaused: async () => false,
          executeTool: async (name) => {
            toolNames.push(name);
            if (name === 'getAvailableSlots') {
              return JSON.stringify({ success: true, slots: ['08:00', '17:30', '18:00', '18:30', '19:00'] });
            }
            return JSON.stringify({ success: true, appointments: [] });
          },
        },
      });

    const laura = await runTurn(1, 't1', [
      'Tem horário hoje após as 17:30?',
      'Ou amanhã de manhã pra fazer a unha?',
      'Pé e mão',
    ]);
    assert.equal(laura.planReceipt.primaryProviderCalls, 0);
    assert.equal(laura.planReceipt.primaryModelRounds, 0);
    assert.equal(toolNames.length, 0);
    assert.ok(typeof laura.payload === 'string' && laura.payload.length > 0);
    assert.equal(laura.transition.kind, 'open');
    if (laura.transition.kind === 'open') {
      assert.equal(laura.transition.frame.kind, 'DATE');
      assert.deepEqual(laura.transition.frame.options.map((option) => option.entityId), ['window:0', 'window:1']);
    }
    assert.equal(laura.frame.flowState.fixedServiceId, 'svc-mani-pedi');
    const t1Delivery = await deliverPreparedReceptionistTurnV2(laura, {
      store: state.pgConversationalV2StateStore,
      now: () => now,
      id: () => `${SYNTHETIC_TURN_PREFIX}delivery-t1-${safeTechnicalToken()}`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: `${SYNTHETIC_TURN_PREFIX}provider-t1-${safeTechnicalToken()}` }),
    });
    assert.equal(t1Delivery.delivery, 'sent');

    execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', __filename, '--reload-check'],
      {
        env: {
          ...process.env,
          IA24_PG_CONVERSATION_KEY: conversationKey,
          IA24_PG_EXPECTED_STATE: 'DATE',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );

    toolNames.length = 0;
    const t2 = await runTurn(2, 't2', ['Hoje']);
    assert.equal(t2.planReceipt.primaryProviderCalls, 0);
    assert.equal(t2.planReceipt.primaryModelRounds, 0);
    assert.deepEqual(toolNames, ['getAvailableSlots']);
    assert.equal(t2.transition.kind, 'open');
    if (t2.transition.kind === 'open') {
      assert.equal(t2.transition.frame.kind, 'TIME');
      assert.deepEqual(t2.transition.frame.options.map((option) => option.entityId), ['18:00', '18:30', '19:00']);
    }
    const t2Delivery = await deliverPreparedReceptionistTurnV2(t2, {
      store: state.pgConversationalV2StateStore,
      now: () => now,
      id: () => `${SYNTHETIC_TURN_PREFIX}delivery-t2-${safeTechnicalToken()}`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 2,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: `${SYNTHETIC_TURN_PREFIX}provider-t2-${safeTechnicalToken()}` }),
    });
    assert.equal(t2Delivery.delivery, 'sent');

    execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', __filename, '--reload-check'],
      {
        env: {
          ...process.env,
          IA24_PG_CONVERSATION_KEY: conversationKey,
          IA24_PG_EXPECTED_STATE: 'TIME',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );

    const invalidated = await state.pgConversationalV2StateStore.invalidateOpenPendingByHuman(
      conversationKey,
      new Date(now.getTime() + 60_000)
    );
    assert.equal(invalidated, 1);
    const afterTakeover = await state.pgConversationalV2StateStore.loadLatestState(
      conversationKey,
      new Date(now.getTime() + 61_000)
    );
    assert.equal(afterTakeover.pending, null);
    assert.equal(afterTakeover.flowState, null);

    execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', __filename, '--reload-check'],
      {
        env: {
          ...process.env,
          IA24_PG_CONVERSATION_KEY: conversationKey,
          IA24_PG_EXPECTED_STATE: 'NONE',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );

    const persisted = await db.query<{ outbox: number; receipts: number; history: number }>(
      `SELECT
         (SELECT count(*)::int FROM ana_v2_outbound_outbox WHERE conversation_key = $1) AS outbox,
         (SELECT count(*)::int FROM ana_v2_turn_receipts WHERE turn_id LIKE $2) AS receipts,
         (SELECT count(*)::int FROM ana_conversation_history WHERE "conversationKey" = $1) AS history`,
      [conversationKey, `${SYNTHETIC_TURN_PREFIX}%`]
    );
    assert.equal(Number(persisted.rows[0]?.outbox ?? 0), 2);
    assert.equal(Number(persisted.rows[0]?.receipts ?? 0) >= 4, true);
    assert.equal(Number(persisted.rows[0]?.history ?? 0) >= 2, true);

    console.log(JSON.stringify({
      status: 'PASS',
      endpoint: 'Neon DEV direct (host withheld)',
      laura: { providerCalls: 0, modelRounds: 0, t1Tools: 0, t2Tools: 1 },
      persistence: { reloadDateWindows: true, reloadTimeSlots: true, outboxRows: 2, takeoverNoResurrection: true },
      ia23ArchitectureTouched: false,
    }));
  } finally {
    cleanupFailures = await cleanup(db, conversationKey);
    const after = await counts(db, conversationKey);
    if (cleanupFailures.length > 0) fail(`cleanup failed: ${cleanupFailures.join(',')}`);
    if (!after || Object.values(after).some((value) => value !== 0)) {
      fail('cleanup verification failed: synthetic residue or unverifiable rows');
    }
    await contextManager.pool.end();
    await db.end();
  }
}

void main().catch((error: unknown) => {
  const kind = safeErrorKind(error);
  console.error(`smoke-ana-ia24-pg-real: FAIL (${kind})`);
  process.exitCode = 1;
});
