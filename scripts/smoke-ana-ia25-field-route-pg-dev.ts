/**
 * IA-25c field-route PostgreSQL DEV gate.
 *
 * Opt-in only. It uses the real intake, the real PG v2 state store, the real
 * delivery commit and a fresh child process reload. The semantic completion,
 * calendar tools and transport are all synthetic/injected; no ERP, Meta or
 * provider network call is possible from this script.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { parse as parseDotenv } from 'dotenv';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServiceSummary, ServicesResult } from '../src/services/calendarService';

const OPT_IN = process.env.ANA_IA25_FIELD_PG_DEV_TEST === '1';
const ENV_FILE = process.env.ANA_IA25_FIELD_PG_ENV_FILE?.trim();
const DEV_HOST_RE = /^ep-restless-frost-[^.]+\.sa-east-1\.aws\.neon\.tech$/iu;
const PROD_HOST_RE = /(?:^|[.-])ep-small-frog(?:[.-]|$)/iu;

function safeTechnicalToken(): string {
  return randomUUID().replace(/[0-9]/gu, (digit) =>
    String.fromCharCode('g'.charCodeAt(0) + Number(digit))
  );
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function directUrlFromPooler(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/-pooler(?=\.|$)/iu, '');
  return url.toString();
}

function technicalErrorKind(error: unknown): string {
  return (error instanceof Error ? error.name : 'unknown')
    .replace(/[^A-Za-z0-9_-]/gu, '')
    .slice(0, 40) || 'unknown';
}

function fail(message: string): never {
  throw new Error(message);
}

const MANICURE_ID = 'ia25pg-svc-manicure';
const PEDICURE_ID = 'ia25pg-svc-pedicure';
const COMBO_ID = 'ia25pg-svc-manicure-pedicure';

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

const SERVICES: ServicesResult = {
  success: true,
  services: [
    service(MANICURE_ID, 'Manicure'),
    service(PEDICURE_ID, 'Pedicure'),
    service(COMBO_ID, 'Manicure e pedicure'),
    service('ia25pg-svc-manicure-tradicional', 'Manicure tradicional'),
    service('ia25pg-svc-pedicure-tradicional', 'Pedicure tradicional'),
    service('ia25pg-svc-reposicao', 'Reposição de unha'),
    service('ia25pg-svc-unha-infantil', 'Unha infantil'),
    ...Array.from({ length: 100 }, (_, index) =>
      service(
        `ia25pg-svc-filler-${String(index + 1).padStart(3, '0')}`,
        `Serviço de laboratório ${index + 1}`
      )
    ),
  ],
  professionals: [{ id: 'ia25pg-prof-1', name: 'Profissional de fixture' }],
};

assert.equal(SERVICES.services?.length, 107);
assert.equal(
  SERVICES.services?.every((entry) => (entry.aliases ?? []).length === 0),
  true
);

let namespace = '';
let phoneNumberId = '';
let turnPrefix = '';
let conversationKeys: string[] = [];
let messageIds: string[] = [];

function config(): TenantBotConfig {
  return {
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
    openaiApiKey: 'ia25pg-openai-never-used',
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'ia25pg-no-whatsapp',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  } as TenantBotConfig;
}

function completion(content: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: `${namespace}:completion`,
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

async function cleanup(db: Pool): Promise<string[]> {
  const failures: string[] = [];
  const statements: Array<[string, string, unknown[]]> = [
    ['receipts', 'DELETE FROM ana_v2_turn_receipts WHERE turn_id LIKE $1 OR receipt_id LIKE $1', [`${turnPrefix}%`]],
    ['successors', 'DELETE FROM ana_v2_successor_batches WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['v2_outbox', 'DELETE FROM ana_v2_outbound_outbox WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['pending', 'DELETE FROM ana_v2_pending_frames WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['invalidations', 'DELETE FROM ana_v2_flow_state_invalidations WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['inbound_outbox', 'DELETE FROM inbound_event_outbox WHERE conversation_key = ANY($1::text[]) OR message_id = ANY($2::text[])', [conversationKeys, messageIds]],
    ['question_replies', 'DELETE FROM sent_question_replies WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['history', 'DELETE FROM ana_conversation_history WHERE "conversationKey" = ANY($1::text[])', [conversationKeys]],
    ['sequence', 'DELETE FROM ana_conversation_seq WHERE conversation_key = ANY($1::text[])', [conversationKeys]],
    ['processed_messages', 'DELETE FROM processed_messages WHERE conversation_key = ANY($1::text[]) OR message_id = ANY($2::text[])', [conversationKeys, messageIds]],
  ];
  for (const [name, sql, values] of statements) {
    try {
      await db.query(sql, values);
    } catch (error) {
      failures.push(`${name}:${technicalErrorKind(error)}`);
    }
  }
  return failures;
}

async function counts(db: Pool): Promise<Record<string, number> | null> {
  try {
    const values = await Promise.all([
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_pending_frames WHERE conversation_key = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_outbound_outbox WHERE conversation_key = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_turn_receipts WHERE turn_id LIKE $1 OR receipt_id LIKE $1', [`${turnPrefix}%`]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_successor_batches WHERE conversation_key = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_flow_state_invalidations WHERE conversation_key = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM inbound_event_outbox WHERE conversation_key = ANY($1::text[]) OR message_id = ANY($2::text[])', [conversationKeys, messageIds]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_conversation_history WHERE "conversationKey" = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_conversation_seq WHERE conversation_key = ANY($1::text[])', [conversationKeys]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM processed_messages WHERE conversation_key = ANY($1::text[]) OR message_id = ANY($2::text[])', [conversationKeys, messageIds]),
    ]);
    const names = ['pending', 'outbox', 'receipts', 'successors', 'invalidations', 'inboundOutbox', 'history', 'sequence', 'processedMessages'];
    return Object.fromEntries(names.map((name, index) => [name, Number(values[index]?.rows[0]?.count ?? 0)]));
  } catch {
    return null;
  }
}

async function reloadCheck(conversationKey: string, now: Date): Promise<void> {
  const state = await import('../src/services/conversationalV2/stateStore');
  const loaded = await state.pgConversationalV2StateStore.loadLatestState(conversationKey, now);
  const expectedFlowId = process.env.ANA_IA25_FIELD_RELOAD_FLOW_ID?.trim();
  const stage = process.env.ANA_IA25_FIELD_RELOAD_STAGE?.trim();
  if (!expectedFlowId) fail('reload flow id missing');
  assert.equal(loaded.flowState?.fixedServiceId, COMBO_ID);
  assert.equal(loaded.pending?.snapshot.kind, 'DATE');
  assert.equal(loaded.pending?.snapshot.flowId, expectedFlowId);
  assert.equal(loaded.flowState?.flowId, expectedFlowId);
  if (stage === 'remaining_morning') {
    assert.equal(loaded.flowState?.deferredAvailability?.schemaVersion, 1);
    assert.equal(loaded.flowState?.deferredAvailability?.date, '2026-08-25');
    assert.deepEqual(loaded.flowState?.deferredAvailability?.timeWindow, {
      kind: 'PERIOD',
      period: 'morning',
    });
    assert.equal(loaded.flowState?.deferredAvailability?.windows, undefined);
    assert.deepEqual(
      loaded.pending?.snapshot.options.map((option) => option.entityId),
      ['window:0']
    );
  } else if (stage === 'initial_two_windows') {
    assert.equal(loaded.flowState?.deferredAvailability?.schemaVersion, 2);
    assert.equal(loaded.flowState?.deferredAvailability?.windows?.length, 2);
  } else {
    fail('reload stage missing');
  }
  let morningRoute: Record<string, unknown> | undefined;
  const contextManager = await import('../src/services/contextManager');
  if (stage === 'remaining_morning') {
    const reloadPhoneNumberId = process.env.ANA_IA25_FIELD_RELOAD_PHONE_NUMBER_ID?.trim();
    const reloadCustomerPhone = process.env.ANA_IA25_FIELD_RELOAD_CUSTOMER_PHONE?.trim();
    const reloadInboundId = process.env.ANA_IA25_FIELD_RELOAD_INBOUND_ID?.trim();
    const reloadTurnId = process.env.ANA_IA25_FIELD_RELOAD_TURN_ID?.trim();
    const reloadSequence = Number(process.env.ANA_IA25_FIELD_RELOAD_SEQUENCE);
    if (
      !reloadPhoneNumberId ||
      !reloadCustomerPhone ||
      !reloadInboundId ||
      !reloadTurnId ||
      !Number.isInteger(reloadSequence) ||
      reloadSequence < 1
    ) {
      fail('fresh-process morning route inputs missing');
    }
    phoneNumberId = reloadPhoneNumberId;
    const runtime = await import('../src/services/conversationalV2/runtime');
    const delivery = await import('../src/services/conversationalV2/delivery');
    const toolCalls: string[] = [];
    let primaryCalls = 0;
    let regenCalls = 0;
    const prepared = await runtime.getReceptionistReplyV2({
      phone: reloadCustomerPhone,
      userMessage: 'amanhã de manhã',
      userName: 'fixture',
      config: config(),
      serviceContextEnabled: true,
      serviceResolverEnabled: true,
      semanticServiceResolverEnabled: false,
      turnRuntime: {
        turnId: reloadTurnId,
        inputSequence: reloadSequence,
        currentInboundIds: [reloadInboundId],
        currentInboundTextsById: { [reloadInboundId]: 'amanhã de manhã' },
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: reloadSequence,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
      },
      deps: {
        store: state.pgConversationalV2StateStore,
        now: () => now,
        id: () => `${reloadTurnId}:id`,
        loadServices: async () => SERVICES,
        loadHistory: async (key) => contextManager.getHistory(key),
        isPaused: async () => false,
        executeProactiveDuplicateRead: async () =>
          JSON.stringify({ success: true, appointments: [] }),
        escalate: async () => ({ matched: false }),
        escalateSilent: async () => ({ kind: 'pending' as const }),
        runModelLoop: async () => {
          primaryCalls += 1;
          throw new Error('fresh-process morning must not call general provider');
        },
        regenerate: async () => {
          regenCalls += 1;
          throw new Error('fresh-process morning must not regenerate');
        },
        executeTool: async (name) => {
          toolCalls.push(name);
          if (name === 'getAvailableSlots') {
            return JSON.stringify({
              success: true,
              slots: ['08:00', '10:00', '12:00', '18:00'],
            });
          }
          if (name === 'getUpcomingAppointments') {
            return JSON.stringify({ success: true, appointments: [] });
          }
          throw new Error('unexpected fresh-process synthetic tool');
        },
      },
    });
    assert.equal(prepared.planReceipt.route, 'fast_path');
    assert.equal(prepared.planReceipt.primaryProviderCalls, 0);
    assert.equal(prepared.planReceipt.regenProviderCalls, 0);
    assert.equal(primaryCalls, 0);
    assert.equal(regenCalls, 0);
    assert.deepEqual(toolCalls, ['getAvailableSlots']);
    assert.equal(prepared.transition.kind, 'open');
    if (prepared.transition.kind !== 'open') fail('fresh-process morning did not open');
    assert.equal(prepared.transition.frame.kind, 'TIME');
    assert.deepEqual(
      prepared.transition.frame.options.map((option) => option.entityId),
      ['08:00', '10:00']
    );
    assert.doesNotMatch(prepared.payload ?? '', /12h|18h/iu);
    const delivered = await delivery.deliverPreparedReceptionistTurnV2(prepared, {
      store: state.pgConversationalV2StateStore,
      now: () => now,
      id: () => `${reloadTurnId}:delivery`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: reloadSequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({
        providerMessageId: `${reloadTurnId}:provider`,
      }),
    });
    assert.equal(delivered.receipt.outboxState, 'accepted_by_provider');
    assert.equal(delivered.receipt.flowStateCommitOutcome, 'committed');
    morningRoute = {
      morningRoute: prepared.planReceipt.route,
      morningReadCalls: toolCalls.length,
      morningSlots: ['08:00', '10:00'],
      primaryProviderCalls: primaryCalls,
      regenProviderCalls: regenCalls,
      delivery: delivered.receipt.flowStateCommitOutcome,
    };
  }
  console.log(JSON.stringify({
    status: 'PASS',
    reload: 'fresh_process',
    stage,
    serviceResolved: true,
    pendingKind: 'DATE',
    deferredAvailabilitySchemaVersion:
      loaded.flowState?.deferredAvailability?.schemaVersion,
    deferredAvailabilityWindows:
      loaded.flowState?.deferredAvailability?.windows?.length ?? 1,
    ...(morningRoute ?? {}),
  }));
  await contextManager.pool.end();
}

function reloadCheckInNewProcess(
  conversationKey: string,
  now: Date,
  flowId: string,
  stage: 'initial_two_windows' | 'remaining_morning',
  morning?: {
    phoneNumberId: string;
    customerPhone: string;
    inboundId: string;
    inputSequence: number;
    turnId: string;
  }
): void {
  const output = execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', __filename, '--reload-check'],
    {
      env: {
        ...process.env,
        ANA_IA25_FIELD_RELOAD_CONVERSATION: conversationKey,
        ANA_IA25_FIELD_RELOAD_NOW: now.toISOString(),
        ANA_IA25_FIELD_RELOAD_FLOW_ID: flowId,
        ANA_IA25_FIELD_RELOAD_STAGE: stage,
        ...(morning
          ? {
              ANA_IA25_FIELD_RELOAD_PHONE_NUMBER_ID: morning.phoneNumberId,
              ANA_IA25_FIELD_RELOAD_CUSTOMER_PHONE: morning.customerPhone,
              ANA_IA25_FIELD_RELOAD_INBOUND_ID: morning.inboundId,
              ANA_IA25_FIELD_RELOAD_SEQUENCE: String(morning.inputSequence),
              ANA_IA25_FIELD_RELOAD_TURN_ID: morning.turnId,
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }
  );
  assert.match(output, /"status":"PASS"/u);
  if (stage === 'remaining_morning') {
    assert.match(output, /"morningRoute":"fast_path"/u);
    assert.match(output, /"morningReadCalls":1/u);
    assert.match(output, /"morningSlots":\["08:00","10:00"\]/u);
  }
}

async function main(): Promise<void> {
  if (!OPT_IN) fail('IA-25 field PG gate requires ANA_IA25_FIELD_PG_DEV_TEST=1');
  if (!ENV_FILE) fail('IA-25 field PG gate requires ANA_IA25_FIELD_PG_ENV_FILE');
  if (process.argv.includes('--real')) fail('IA-25 field PG gate refuses --real');
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    fail('IA-25 field PG gate refuses NODE_ENV=production');
  }

  const parsed = parseDotenv(readFileSync(ENV_FILE, 'utf8')) as Record<string, string | undefined>;
  const configured = parsed.DATABASE_URL?.trim();
  if (!configured) fail('authorized env has no DATABASE_URL');
  const configuredHost = hostOf(configured);
  if (PROD_HOST_RE.test(configuredHost) || !DEV_HOST_RE.test(configuredHost)) {
    fail('database host is not the authorized Neon DEV branch');
  }
  const direct = directUrlFromPooler(configured);
  const directHost = hostOf(direct);
  if (PROD_HOST_RE.test(directHost) || directHost.includes('-pooler') || !DEV_HOST_RE.test(directHost)) {
    fail('derived database endpoint is not direct authorized DEV');
  }

  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = direct;
  process.env.RECEPS_IA_DIRECT_DATABASE_URL = direct;
  process.env.OPENAI_API_KEY = 'ia25pg-openai-never-used';
  process.env.DEEPSEEK_API_KEY = 'ia25pg-deepseek-never-used';
  process.env.ERP_API_TOKEN = 'ia25pg-erp-never-used';
  process.env.ERP_BASE_URL = 'http://127.0.0.1:1';

  namespace = `ia25pg:${safeTechnicalToken()}`;
  phoneNumberId = `${namespace}:phone-number`;
  turnPrefix = `${namespace}:turn:`;
  const targetPhone = `${namespace}:customer`;
  const idempotencyPhone = `${namespace}:idempotency`;
  const targetConversationKey = `${phoneNumberId}:${targetPhone}`;
  const idempotencyConversationKey = `${phoneNumberId}:${idempotencyPhone}`;
  conversationKeys = [targetConversationKey, idempotencyConversationKey];
  messageIds = [];

  const db = new Pool({
    connectionString: direct,
    max: 6,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: 'receps-ia-ia25-field-pg-gate',
  });
  db.on('error', () => undefined);
  let contextManager: typeof import('../src/services/contextManager') | null = null;
  let cleanupFailures: string[] = [];
  try {
    const processedMessages = await import('../src/services/processedMessages');
    contextManager = await import('../src/services/contextManager');
    const anaWave2Store = await import('../src/services/anaWave2Store');
    const state = await import('../src/services/conversationalV2/stateStore');
    const runtime = await import('../src/services/conversationalV2/runtime');
    const delivery = await import('../src/services/conversationalV2/delivery');
    await processedMessages.ensureProcessedMessagesTable();
    await anaWave2Store.ensureAnaWave2Tables();
    await state.ensureConversationalV2Tables();

    cleanupFailures = await cleanup(db);
    if (cleanupFailures.length > 0) fail('pre-test cleanup failed');
    const before = await counts(db);
    if (!before || Object.values(before).some((value) => value !== 0)) {
      fail('synthetic namespace not clean before test');
    }

    const cfg = config();
    const baseNow = new Date('2026-08-24T15:00:00.000Z');
    let semanticCalls = 0;
    let primaryCalls = 0;
    let regenCalls = 0;
    const targetToolCalls: string[] = [];
    const ordinaryToolCalls: string[] = [];
    const proactiveReadCalls: string[] = [];

    const completionFactory = async (request: {
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      tools: [];
      temperature: number;
      maxTokens: number;
      thinkingMode: 'disabled' | 'enabled';
      responseFormat: 'json_object';
      provider: 'deepseek';
      model: 'deepseek-v4-flash';
      timeoutMs: 5_000;
    }): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
      semanticCalls += 1;
      assert.deepEqual(request.tools, []);
      assert.equal(request.thinkingMode, 'disabled');
      assert.equal(request.responseFormat, 'json_object');
      assert.equal(request.messages.length, 2);
      assert.ok(!request.messages.some((message) => message.role === 'assistant'));
      return completion(JSON.stringify({
        decision: 'resolved',
        serviceId: COMBO_ID,
        candidateServiceIds: [COMBO_ID],
        evidenceText: 'pé e mão',
      }));
    };

    const persist = async (id: string, phone: string, content: string) => {
      messageIds.push(id);
      return anaWave2Store.persistInboundAtomically({
        messageId: id,
        phoneNumberId,
        customerPhone: phone,
        content,
        messageType: 'text',
        contentStatus: 'final',
        receivedAt: baseNow,
      });
    };

    const idempotencyText = 'texto repetido de fixture';
    const probeId = `${namespace}:idempotency:one`;
    const probeReplay = `${namespace}:idempotency:one`;
    const probeNewId = `${namespace}:idempotency:two`;
    const probeFirst = await persist(probeId, idempotencyPhone, idempotencyText);
    const probeReplayResult = await anaWave2Store.persistInboundAtomically({
      messageId: probeReplay,
      phoneNumberId,
      customerPhone: idempotencyPhone,
      content: idempotencyText,
      messageType: 'text',
      contentStatus: 'final',
      receivedAt: baseNow,
    });
    messageIds.push(probeNewId);
    const probeNew = await anaWave2Store.persistInboundAtomically({
      messageId: probeNewId,
      phoneNumberId,
      customerPhone: idempotencyPhone,
      content: idempotencyText,
      messageType: 'text',
      contentStatus: 'final',
      receivedAt: baseNow,
    });
    assert.equal(probeFirst.fresh, true);
    assert.equal(probeReplayResult.fresh, false);
    assert.equal(probeNew.fresh, true);

    const checkpoint = async (sequence: number) => ({
      paused: false,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    });

    const runTurn = async (input: {
      id: string;
      phone: string;
      sequence: number;
      texts: readonly string[];
      semantic: boolean;
      availabilitySlots?: readonly string[];
    }) => {
      const inboundIds = input.texts.map((_text, index) => `${namespace}:msg:${input.id}:${index + 1}`);
      for (const inboundId of inboundIds) messageIds.push(inboundId);
      const prepared = await runtime.getReceptionistReplyV2({
        phone: input.phone,
        userMessage: input.texts.at(-1) ?? '',
        userName: 'fixture',
        config: cfg,
        serviceContextEnabled: true,
        serviceResolverEnabled: true,
        semanticServiceResolverEnabled: input.semantic,
        turnRuntime: {
          turnId: `${turnPrefix}${input.id}`,
          inputSequence: input.sequence,
          currentInboundIds: inboundIds,
          currentInboundTextsById: Object.fromEntries(
            inboundIds.map((inboundId, index) => [inboundId, input.texts[index] ?? ''])
          ),
          checkpoint: () => checkpoint(input.sequence),
        },
        deps: {
          store: state.pgConversationalV2StateStore,
          now: () => baseNow,
          id: () => `${turnPrefix}${input.id}:id`,
          loadServices: async () => SERVICES,
          loadHistory: async (conversationKey) => contextManager!.getHistory(conversationKey),
          isPaused: async () => false,
          semanticServiceCompletionFactory: completionFactory,
          executeProactiveDuplicateRead: async () => {
            proactiveReadCalls.push('getUpcomingAppointments');
            if (input.semantic) targetToolCalls.push('getUpcomingAppointments');
            return JSON.stringify({ success: true, appointments: [] });
          },
          escalate: async () => ({ matched: false }),
          escalateSilent: async () => ({ kind: 'pending' as const }),
          runModelLoop: async () => {
            primaryCalls += 1;
            throw new Error('IA-25 PG field route must not call general provider');
          },
          regenerate: async () => {
            regenCalls += 1;
            throw new Error('IA-25 PG field route must not regenerate');
          },
          executeTool: async (name) => {
            ordinaryToolCalls.push(name);
            if (input.semantic) targetToolCalls.push(name);
            if (name === 'getAvailableSlots') {
              return JSON.stringify({
                success: true,
                slots: input.availabilitySlots ?? ['18:00'],
              });
            }
            if (name === 'getUpcomingAppointments') return JSON.stringify({ success: true, appointments: [] });
            throw new Error('unexpected synthetic tool');
          },
        },
      });
      return prepared;
    };

    const deliver = async (prepared: Awaited<ReturnType<typeof runtime.getReceptionistReplyV2>>, sequence: number, id: string) =>
      delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store: state.pgConversationalV2StateStore,
        now: () => baseNow,
        id: () => `${turnPrefix}delivery:${id}`,
        checkpoint: () => checkpoint(sequence),
        sendTransport: async () => ({ providerMessageId: `${namespace}:provider:${id}` }),
      });

    const setupInboundOne = `${namespace}:msg:setup-one:1`;
    const setupOneIntake = await persist(setupInboundOne, targetPhone, 'Tem horário amanhã para Manicure e pedicure?');
    const setupOne = await runTurn({
      id: 'setup-one',
      phone: targetPhone,
      sequence: setupOneIntake.sequence ?? 1,
      texts: ['Tem horário amanhã para Manicure e pedicure?'],
      semantic: false,
    });
    assert.equal(setupOne.planReceipt.primaryProviderCalls, 0);
    await deliver(setupOne, setupOneIntake.sequence ?? 1, 'setup-one');

    const setupInboundTwo = `${namespace}:msg:setup-two:1`;
    const setupTwoIntake = await persist(setupInboundTwo, targetPhone, '18:00');
    const setupTwo = await runTurn({
      id: 'setup-two',
      phone: targetPhone,
      sequence: setupTwoIntake.sequence ?? 2,
      texts: ['18:00'],
      semantic: false,
    });
    assert.equal(setupTwo.planReceipt.primaryProviderCalls, 0);
    assert.equal(setupTwo.transition.kind, 'open');
    assert.equal(setupTwo.transition.kind === 'open' ? setupTwo.transition.frame.kind : null, 'CONFIRMATION');
    await deliver(setupTwo, setupTwoIntake.sequence ?? 2, 'setup-two');
    assert.deepEqual(
      setupOne.planReceipt.toolEffects.map((effect) => effect.tool),
      ['getAvailableSlots']
    );
    assert.deepEqual(
      setupTwo.planReceipt.toolEffects.map((effect) => effect.tool),
      ['getUpcomingAppointments']
    );
    assert.deepEqual(ordinaryToolCalls, ['getAvailableSlots']);
    assert.deepEqual(proactiveReadCalls, ['getUpcomingAppointments']);

    semanticCalls = 0;
    primaryCalls = 0;
    regenCalls = 0;
    targetToolCalls.length = 0;
    const targetTexts = [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ] as const;
    const targetIds = targetTexts.map((_text, index) => `${namespace}:msg:target:${index + 1}`);
    const targetIntakes = [];
    for (const [index, text] of targetTexts.entries()) {
      const intake = await persist(targetIds[index]!, targetPhone, text);
      targetIntakes.push(intake);
    }
    const targetSequence = targetIntakes.at(-1)?.sequence ?? 5;
    const target = await runTurn({
      id: 'target',
      phone: targetPhone,
      sequence: targetSequence,
      texts: targetTexts,
      semantic: true,
    });
    assert.equal(target.planReceipt.serviceContextDecision, 'positive_reclarification');
    assert.equal(target.planReceipt.semanticServiceResolution?.attemptedInvocationReason, 'positive_reclarification');
    assert.equal(target.planReceipt.semanticServiceResolution?.invocationReason, 'positive_reclarification');
    assert.equal(target.planReceipt.semanticServiceResolution?.status, 'resolved');
    assert.equal(target.planReceipt.semanticServiceResolution?.skipReason, null);
    assert.equal(target.planReceipt.semanticServiceResolution?.providerCallCount, 1);
    assert.equal(semanticCalls, 1);
    assert.equal(target.planReceipt.primaryProviderCalls, 0);
    assert.equal(target.planReceipt.regenProviderCalls, 0);
    assert.deepEqual(target.planReceipt.toolEffects, []);
    assert.deepEqual(targetToolCalls, []);
    assert.equal(target.hasCommittedWrite, false);
    assert.equal(target.transition.kind, 'open');
    assert.equal(target.transition.kind === 'open' ? target.transition.nextFlowState.fixedServiceId : null, COMBO_ID);
    assert.equal(target.transition.kind === 'open' ? target.transition.frame.kind : null, 'DATE');
    const targetFlowId = target.transition.kind === 'open'
      ? target.transition.nextFlowState.flowId
      : null;
    assert.ok(targetFlowId);
    assert.equal(
      target.transition.kind === 'open' ? target.transition.frame.flowId : null,
      targetFlowId
    );
    assert.equal(
      target.transition.kind === 'open'
        ? target.transition.nextFlowState.deferredAvailability?.schemaVersion
        : null,
      2
    );
    assert.equal(
      target.transition.kind === 'open'
        ? target.transition.nextFlowState.deferredAvailability?.windows?.length
        : null,
      2
    );
    const targetDelivery = await deliver(target, targetSequence, 'target');
    assert.equal(targetDelivery.receipt.outboxState, 'accepted_by_provider');
    assert.equal(targetDelivery.receipt.flowStateCommitOutcome, 'committed');
    reloadCheckInNewProcess(
      targetConversationKey,
      baseNow,
      targetFlowId,
      'initial_two_windows'
    );

    // IA-26/26b PG lifecycle: a seleção de hoje faz uma leitura válida vazia,
    // consome somente essa janela e persiste a manhã restante.
    const selectTodayId = `${namespace}:msg:ia26-select-today:1`;
    const selectTodayIntake = await persist(
      selectTodayId,
      targetPhone,
      'hoje'
    );
    const selectToday = await runTurn({
      id: 'ia26-select-today',
      phone: targetPhone,
      sequence: selectTodayIntake.sequence ?? targetSequence + 1,
      texts: ['hoje'],
      semantic: false,
      availabilitySlots: [],
    });
    assert.equal(selectToday.planReceipt.route, 'fast_path');
    assert.equal(selectToday.planReceipt.primaryProviderCalls, 0);
    assert.equal(selectToday.planReceipt.regenProviderCalls, 0);
    assert.deepEqual(
      selectToday.planReceipt.toolEffects.map((effect) => effect.tool),
      ['getAvailableSlots']
    );
    assert.equal(selectToday.transition.kind, 'open');
    if (selectToday.transition.kind !== 'open') fail('IA-26 PG selection did not open pending');
    assert.equal(selectToday.transition.frame.kind, 'DATE');
    assert.deepEqual(
      selectToday.transition.frame.options.map((option) => option.entityId),
      ['window:0']
    );
    assert.equal(
      selectToday.transition.nextFlowState.deferredAvailability?.schemaVersion,
      1
    );
    assert.equal(
      selectToday.transition.nextFlowState.deferredAvailability?.date,
      '2026-08-25'
    );
    assert.deepEqual(
      selectToday.transition.nextFlowState.deferredAvailability?.timeWindow,
      { kind: 'PERIOD', period: 'morning' }
    );
    assert.equal(
      selectToday.transition.nextFlowState.deferredAvailability?.windows,
      undefined
    );
    assert.match(selectToday.payload ?? '', /amanh[ãa] de manh[ãa]/iu);
    const selectTodayDelivery = await deliver(
      selectToday,
      selectTodayIntake.sequence ?? targetSequence + 1,
      'ia26-select-today'
    );
    assert.equal(selectTodayDelivery.receipt.outboxState, 'accepted_by_provider');
    assert.equal(selectTodayDelivery.receipt.flowStateCommitOutcome, 'committed');
    // O processo novo recarrega o schema 1 e executa o turno seguinte; a
    // seleção conhecida consulta uma vez e conserva somente a manhã.
    const morningId = `${namespace}:msg:ia26-morning:1`;
    const morningIntake = await persist(
      morningId,
      targetPhone,
      'amanhã de manhã'
    );
    const morningSequence =
      morningIntake.sequence ??
      (selectTodayIntake.sequence ?? targetSequence + 1) + 1;
    reloadCheckInNewProcess(
      targetConversationKey,
      baseNow,
      targetFlowId,
      'remaining_morning',
      {
        phoneNumberId,
        customerPhone: targetPhone,
        inboundId: morningId,
        inputSequence: morningSequence,
        turnId: `${turnPrefix}ia26-morning-fresh`,
      }
    );

    const beforeCleanup = await counts(db);
    assert.ok(beforeCleanup);
    cleanupFailures = await cleanup(db);
    const afterCleanup = await counts(db);
    if (cleanupFailures.length > 0) fail('cleanup failed');
    if (!afterCleanup || Object.values(afterCleanup).some((value) => value !== 0)) {
      fail('cleanup verification failed');
    }
    console.log(JSON.stringify({
      status: 'PASS',
      catalogActiveServiceCount: 107,
      aliases: 0,
      serviceContextDecision: 'positive_reclarification',
      attemptedInvocationReason: 'positive_reclarification',
      semanticStatus: 'resolved',
      providerCallCount: 1,
      primaryProviderCalls: 0,
      regenProviderCalls: 0,
      tools: 0,
      writes: 0,
      route: 'fast_path',
      idempotency: { first: true, replay: false, repeatedTextNewId: true },
      toolCalls: {
        ordinary: ordinaryToolCalls,
        proactiveRead: proactiveReadCalls,
        target: targetToolCalls,
      },
      reload: 'fresh_process',
      ia26Lifecycle: {
        initialWindows: 2,
        selectedTodayReadSlots: 0,
        remainingSchemaVersion: 1,
        remainingWindow: 'morning',
        morningReadCalls: 1,
        morningSlots: ['08:00', '10:00'],
      },
      cleanup: 'zero',
      beforeCleanupCounts: beforeCleanup,
    }));
  } finally {
    const finalCleanupFailures = await cleanup(db);
    if (finalCleanupFailures.length > 0) {
      console.error(`smoke-ana-ia25-field-route-pg-dev: CLEANUP_FAIL (${finalCleanupFailures.join(',')})`);
      cleanupFailures = [...cleanupFailures, ...finalCleanupFailures];
    }
    if (contextManager) await contextManager.pool.end();
    await db.end();
    if (cleanupFailures.length > 0) {
      fail('cleanup failed');
    }
  }
}

async function dispatch(): Promise<void> {
  if (process.argv.includes('--reload-check')) {
    if (!ENV_FILE) fail('IA-25 PG reload requires the authorized DEV env file');
    const conversationKey = process.env.ANA_IA25_FIELD_RELOAD_CONVERSATION?.trim();
    if (!conversationKey?.startsWith('ia25pg:')) fail('reload namespace missing');
    const parsed = parseDotenv(readFileSync(ENV_FILE, 'utf8')) as Record<string, string | undefined>;
    const configured = parsed.DATABASE_URL?.trim();
    if (!configured) fail('authorized env has no DATABASE_URL');
    const direct = directUrlFromPooler(configured);
    const directHost = hostOf(direct);
    if (PROD_HOST_RE.test(directHost) || directHost.includes('-pooler') || !DEV_HOST_RE.test(directHost)) {
      fail('reload endpoint is not direct authorized DEV');
    }
    if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
      fail('IA-25 PG reload refuses NODE_ENV=production');
    }
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = direct;
    process.env.DEEPSEEK_API_KEY = 'ia25pg-deepseek-never-used';
    process.env.OPENAI_API_KEY = 'ia25pg-openai-never-used';
    const state = await import('../src/services/conversationalV2/stateStore');
    await state.ensureConversationalV2Tables();
    await reloadCheck(conversationKey, new Date(process.env.ANA_IA25_FIELD_RELOAD_NOW ?? '2026-08-24T15:00:00.000Z'));
    return;
  }
  await main();
}

void dispatch().catch((error: unknown) => {
  console.error(`smoke-ana-ia25-field-route-pg-dev: FAIL (${technicalErrorKind(error)})`);
  process.exitCode = 1;
});
