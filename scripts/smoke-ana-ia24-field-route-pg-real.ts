/**
 * IA-24b field-path PostgreSQL DEV gate.
 *
 * This is intentionally opt-in. It exercises the production v2 runtime and
 * delivery path against the authorized DEV branch, then starts a fresh
 * process to hydrate the PendingFrame before the TIME answer. No model,
 * ERP, Meta, or booking write is used: only deterministic catalog/tool
 * fixtures are injected into the runtime.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { parse as parseDotenv } from 'dotenv';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';

const OPT_IN = process.env.ANA_IA24_FIELD_PG_DEV_TEST === '1';
const ENV_FILE = process.env.ANA_IA24_FIELD_PG_ENV_FILE?.trim();
const DEV_HOST_RE = /^ep-restless-frost-[^.]+\.sa-east-1\.aws\.neon\.tech$/iu;
const PROD_HOST_RE = /(?:^|[.-])ep-small-frog(?:[.-]|$)/iu;
const CONVERSATION_PREFIX = 'ia24field:';
const TURN_PREFIX = `ia24field-turn:${safeTechnicalToken()}:`;

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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TARGET_SERVICES = [
  {
    id: 'svc-field-manicure',
    name: 'Manicure',
    durationMinutes: 50,
    price: 80,
    priceFormatted: 'R$ 80,00',
    aliases: ['fazer a mao'],
    professionalIds: ['prof-field-one'],
  },
  {
    id: 'svc-field-pedicure',
    name: 'Pedicure',
    durationMinutes: 50,
    price: 80,
    priceFormatted: 'R$ 80,00',
    aliases: ['fazer o pe'],
    professionalIds: ['prof-field-two'],
  },
  {
    id: 'svc-field-mani-pedi',
    name: 'Manicure e pedicure',
    durationMinutes: 120,
    price: 120,
    priceFormatted: 'R$ 120,00',
    aliases: ['pe e mao', 'mao e pe', 'fazer pe e mao'],
    // The laboratory has two active professionals; this combined service is
    // deliberately eligible for one of them so the quoted field dialogue does
    // not acquire an unrecorded professional question.
    professionalIds: ['prof-field-one'],
  },
  {
    id: 'svc-field-manicure-tradicional',
    name: 'Manicure tradicional',
    durationMinutes: 50,
    price: 80,
    priceFormatted: 'R$ 80,00',
    professionalIds: ['prof-field-one'],
  },
  {
    id: 'svc-field-reposicao',
    name: 'Reposição de unha',
    durationMinutes: 60,
    price: 100,
    priceFormatted: 'R$ 100,00',
    professionalIds: ['prof-field-one'],
  },
  {
    id: 'svc-field-unha-infantil',
    name: 'Unha infantil',
    durationMinutes: 50,
    price: 70,
    priceFormatted: 'R$ 70,00',
    professionalIds: ['prof-field-one'],
  },
] as const;

const SERVICES: ServicesResult = {
  success: true,
  services: [
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `svc-field-generic-${String(index + 1).padStart(3, '0')}`,
      name: `Serviço de laboratório ${index + 1}`,
      durationMinutes: 30,
      price: 30,
      priceFormatted: 'R$ 30,00',
      professionalIds: ['prof-field-one', 'prof-field-two'],
    })),
    ...TARGET_SERVICES,
  ],
  professionals: [
    { id: 'prof-field-one', name: 'Vitin' },
    { id: 'prof-field-two', name: 'Marina Alves' },
  ],
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
  openaiApiKey: 'sk-ia24-field-never-used',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: 'ia24field',
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
    professionals: SERVICES.professionals!.map((professional) => ({
      ...professional,
      active: true,
    })),
  },
};

type ToolCall = { name: string; args: Record<string, unknown>; result: string };

function turnRuntime(input: {
  id: string;
  sequence: number;
  texts: readonly string[];
}) {
  const ids = input.texts.map((_text, index) => `${input.id}-in-${index + 1}`);
  return {
    turnId: `${TURN_PREFIX}${input.id}`,
    inputSequence: input.sequence,
    currentInboundIds: ids,
    currentInboundTextsById: Object.fromEntries(
      ids.map((id, index) => [id, input.texts[index] ?? ''])
    ),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: input.sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [] as string[],
    }),
  };
}

async function cleanup(db: Pool): Promise<string[]> {
  const failures: string[] = [];
  const statements: Array<[string, string]> = [
    ['receipts', `DELETE FROM ana_v2_turn_receipts WHERE turn_id LIKE $1 OR receipt_id LIKE $1`],
    ['successors', `DELETE FROM ana_v2_successor_batches WHERE conversation_key LIKE $1`],
    ['outbox', `DELETE FROM ana_v2_outbound_outbox WHERE conversation_key LIKE $1`],
    ['pending', `DELETE FROM ana_v2_pending_frames WHERE conversation_key LIKE $1`],
    ['invalidations', `DELETE FROM ana_v2_flow_state_invalidations WHERE conversation_key LIKE $1`],
    ['history', `DELETE FROM ana_conversation_history WHERE "conversationKey" LIKE $1`],
  ];
  for (const [name, sql] of statements) {
    try {
      await db.query(sql, [name === 'receipts' ? `${TURN_PREFIX}%` : `${CONVERSATION_PREFIX}%`]);
    } catch (error) {
      failures.push(`${name}:${technicalErrorKind(error)}`);
    }
  }
  return failures;
}

async function counts(db: Pool, conversationKey: string): Promise<Record<string, number> | null> {
  try {
    const values = await Promise.all([
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_pending_frames WHERE conversation_key = $1', [conversationKey]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_outbound_outbox WHERE conversation_key = $1', [conversationKey]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_conversation_history WHERE "conversationKey" = $1', [conversationKey]),
      db.query<{ count: string }>('SELECT count(*)::text AS count FROM ana_v2_turn_receipts WHERE turn_id LIKE $1 OR receipt_id LIKE $1', [`${TURN_PREFIX}%`]),
    ]);
    return {
      pending: Number(values[0].rows[0]?.count ?? 0),
      outbox: Number(values[1].rows[0]?.count ?? 0),
      history: Number(values[2].rows[0]?.count ?? 0),
      receipts: Number(values[3].rows[0]?.count ?? 0),
    };
  } catch {
    return null;
  }
}

async function reloadCheck(
  conversationKey: string,
  expected: 'DATE' | 'TIME',
  now: Date
): Promise<void> {
  const state = await import('../src/services/conversationalV2/stateStore');
  const loaded = await state.pgConversationalV2StateStore.loadLatestState(
    conversationKey,
    now
  );
  assert.equal(loaded.pending?.snapshot.kind, expected);
  assert.equal(loaded.pending?.snapshot.flowId, loaded.flowState?.flowId);
  assert.equal(loaded.flowState?.fixedServiceId, 'svc-field-mani-pedi');
  if (expected === 'TIME') {
    assert.equal(loaded.flowState?.slotEvidence?.serviceId, 'svc-field-mani-pedi');
    assert.deepEqual(loaded.flowState?.slotEvidence?.slots, ['18:00']);
    assert.equal(loaded.flowState?.resolvedDate, '2026-08-24');
  }
  console.log(JSON.stringify({
    status: 'PASS',
    reload: expected,
    flowIdHash: hash(loaded.flowState?.flowId ?? ''),
    pendingKind: loaded.pending?.snapshot.kind ?? null,
    pendingOptionCount: loaded.pending?.snapshot.options.length ?? 0,
    fixedServiceId: loaded.flowState?.fixedServiceId ?? null,
    slotEvidence: loaded.flowState?.slotEvidence?.slots ?? [],
  }));
  const contextManager = await import('../src/services/contextManager');
  await contextManager.pool.end();
}

function reloadCheckInNewProcess(
  conversationKey: string,
  expected: 'DATE' | 'TIME',
  now: Date
): void {
  const output = execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', __filename, '--reload-check'],
    {
      env: {
        ...process.env,
        ANA_IA24_FIELD_RELOAD_KEY: conversationKey,
        ANA_IA24_FIELD_RELOAD_EXPECTED: expected,
        ANA_IA24_FIELD_RELOAD_NOW: now.toISOString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }
  );
  assert.match(output, /"status":"PASS"/u);
}

async function main(): Promise<void> {
  if (!OPT_IN) fail('IA-24 field PG gate requires ANA_IA24_FIELD_PG_DEV_TEST=1');
  if (!ENV_FILE) fail('IA-24 field PG gate requires ANA_IA24_FIELD_PG_ENV_FILE');
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
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    fail('IA-24 field PG gate refuses NODE_ENV=production');
  }
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = direct;
  process.env.RECEPS_IA_DIRECT_DATABASE_URL = direct;
  process.env.OPENAI_API_KEY = 'sk-ia24-field-never-used';
  process.env.ERP_API_TOKEN = 'ia24-field-no-erp-access';
  process.env.ERP_BASE_URL = 'http://127.0.0.1:1';

  const db = new Pool({
    connectionString: direct,
    max: 6,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: 'receps-ia-ia24-field-pg-gate',
  });
  db.on('error', () => undefined);
  const contextManager = await import('../src/services/contextManager');
  const state = await import('../src/services/conversationalV2/stateStore');
  const { resolveServiceFromCatalog } = await import('../src/services/conversationalV2/serviceResolver');
  const { getReceptionistReplyV2 } = await import('../src/services/conversationalV2/runtime');
  const { deliverPreparedReceptionistTurnV2 } = await import('../src/services/conversationalV2/delivery');
  await state.ensureConversationalV2Tables();
  if (process.argv.includes('--reload-check')) {
    const reloadKey = process.env.ANA_IA24_FIELD_RELOAD_KEY?.trim();
    const expected = process.env.ANA_IA24_FIELD_RELOAD_EXPECTED?.trim();
    if (!reloadKey?.startsWith(CONVERSATION_PREFIX)) fail('reload conversation key missing');
    if (expected !== 'DATE' && expected !== 'TIME') fail('reload expectation missing');
    await reloadCheck(
      reloadKey,
      expected,
      new Date(process.env.ANA_IA24_FIELD_RELOAD_NOW ?? '2026-08-24T15:00:00.000Z')
    );
    await db.end();
    return;
  }
  const conversationKey = `${CONFIG.phoneNumberId}:fixture-${safeTechnicalToken()}`;
  const conversationKeys = [conversationKey];
  const baseNow = new Date('2026-08-24T15:00:00.000Z');
  const onlyNoConflict = process.env.ANA_IA24D_ONLY_NOCONFLICT === '1';
  const beforeProbe = process.env.ANA_IA24D_BEFORE === '1';
  await cleanup(db);
  const before = await counts(db, conversationKey);
  if (!before || Object.values(before).some((value) => value !== 0)) fail('synthetic prefix not clean before test');
  assert.equal(
    resolveServiceFromCatalog({
      text: 'Tem horário hoje após as 17:30? ou amanhã de manhã pra fazer a unha? pé e mão',
      catalog: SERVICES,
    }).kind,
    'resolved'
  );
  assert.equal(SERVICES.services?.length, 107);
  assert.equal(SERVICES.professionals?.length, 2);

  const toolCalls: ToolCall[] = [];
  const regenCalls: string[] = [];
  let upcomingResult = JSON.stringify({
    success: true,
    appointments: [{
      id: 'appt-field-conflict',
      startTime: '2026-08-24T21:00:00.000Z',
      endTime: '2026-08-24T23:00:00.000Z',
      serviceName: 'Esmaltação em gel',
      professionalName: 'Profissional Dois',
      status: 'CONFIRMED',
    }],
  });
  let activeConversationKey = conversationKey;
  const rejected: Array<{ stage: string; candidateHash: string; reasonCodes: readonly string[] }> = [];
  const runTurn = async (sequence: number, id: string, texts: readonly string[]) => {
    const turnNow = new Date(baseNow.getTime() + (sequence - 1) * 45 * 60 * 1_000);
    const prepared = await getReceptionistReplyV2({
      phone: activeConversationKey.slice(activeConversationKey.indexOf(':') + 1),
      userMessage: texts.join(' '),
      userName: 'fixture',
      config: CONFIG,
      serviceContextEnabled: true,
      serviceResolverEnabled: true,
      turnRuntime: turnRuntime({ id, sequence, texts }),
      deps: {
        store: state.pgConversationalV2StateStore,
        now: () => turnNow,
        id: () => `${TURN_PREFIX}${id}-${safeTechnicalToken()}`,
        loadServices: async () => SERVICES,
        loadHistory: async () => [],
        isPaused: async () => false,
        executeTool: async (name, args) => {
          const result = name === 'getAvailableSlots'
            ? JSON.stringify({ success: true, slots: ['18:00'] })
            : name === 'getUpcomingAppointments'
              ? upcomingResult
              : JSON.stringify({ success: false, reason: 'unexpected_tool' });
          toolCalls.push({ name, args, result });
          return result;
        },
        onRejectedBoundaryCandidate: ({ stage, candidate, reasonCodes }) => {
          rejected.push({ stage, candidateHash: hash(candidate), reasonCodes });
        },
        runModelLoop: async () => {
          throw new Error('field-path fixture must not call primary provider');
        },
        regenerate: async () => {
          regenCalls.push(id);
          return {
            ok: true as const,
            result: {
              schemaVersion: 2 as const,
              reply: 'A gente estava marcando Manicure e pedicure para 24/08/2026 — qual horário você prefere?',
              replyPurpose: 'CLARIFICATION' as const,
              pendingTransitionCandidate: { kind: 'preserve' as const },
              resolutionCandidate: null,
              unknownServiceEvidence: null,
            },
            providerCalls: 1,
            providerReportedModel: 'fixture-regenerator',
            systemFingerprint: null,
          };
        },
      },
    });
    assert.equal(prepared.planReceipt.primaryProviderCalls, 0);
    assert.equal(prepared.planReceipt.primaryModelRounds, 0);
    if (sequence < 3) assert.equal(prepared.planReceipt.regenProviderCalls, 0);
    assert.ok(prepared.payload);
    const delivery = await deliverPreparedReceptionistTurnV2(prepared, {
      store: state.pgConversationalV2StateStore,
      now: () => turnNow,
      id: () => `${TURN_PREFIX}delivery-${id}-${safeTechnicalToken()}`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: sequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: `${TURN_PREFIX}provider-${id}` }),
    });
    assert.equal(delivery.delivery, 'sent');
    assert.equal(delivery.receipt.outboxState, 'accepted_by_provider');
    return prepared;
  };

  let cleanupFailures: string[] = [];
  let third: Awaited<ReturnType<typeof runTurn>> | null = null;
  let conflictReadCount = 0;
  let conflictWriteCount = 0;
  const { evaluateBoundaryV2 } = await import('../src/services/conversationalV2/boundary');
  const preBooking = beforeProbe
    ? null
    : await import('../src/services/conversationalV2/preBookingSummary');
  try {
    if (!onlyNoConflict) {
    const first = await runTurn(1, 'turn-one', [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ]);
    assert.equal(first.transition.kind, 'open');
    if (first.transition.kind === 'open') {
      assert.equal(first.transition.frame.kind, 'DATE');
      assert.equal(first.transition.frame.options.length, 2);
      assert.equal(first.transition.nextFlowState.fixedServiceId, 'svc-field-mani-pedi');
    }
    assert.equal(toolCalls.length, 0, 'first turn must not read calendar');
    reloadCheckInNewProcess(conversationKey, 'DATE', baseNow);

    const second = await runTurn(2, 'turn-two', ['Hoje']);
    assert.equal(second.transition.kind, 'open');
    if (second.transition.kind === 'open') {
      assert.equal(second.transition.frame.kind, 'TIME');
      assert.deepEqual(second.transition.frame.options.map((option) => option.entityId), ['18:00']);
    }
    assert.deepEqual(toolCalls.map((call) => call.name), ['getAvailableSlots']);
    reloadCheckInNewProcess(conversationKey, 'TIME', new Date(baseNow.getTime() + 45 * 60 * 1_000));

    toolCalls.length = 0;
    third = await runTurn(3, 'turn-three', ['Pode ser 18h']);
    assert.equal(
      third.payload,
      'Vi que você já tem outro agendamento de Esmaltação em gel em 24/08/2026 às 18:00. Quer manter os dois, remarcar, só cancelar o anterior ou decidir depois?'
    );
    assert.equal(third.planReceipt.route, 'fast_path');
    assert.equal(third.planReceipt.recoveryKind, 'none');
    assert.equal(third.planReceipt.regenProviderCalls, 0);
    assert.equal(third.planReceipt.boundaryAttempts.length, 1);
    assert.deepEqual(third.planReceipt.boundaryAttempts[0]?.reasonCodes, []);
    assert.deepEqual(toolCalls.map((call) => call.name), ['getUpcomingAppointments']);
    assert.equal(third.planReceipt.toolEffects.length, 1);
    assert.equal(third.planReceipt.toolEffects[0]?.tool, 'getUpcomingAppointments');
    assert.equal(third.planReceipt.toolEffects[0]?.class, 'read');
    assert.equal(third.planReceipt.toolEffects[0]?.writeCommitted, false);
    assert.equal(third.hasCommittedWrite, false);
    assert.equal(third.transition.kind, 'open');
    if (third.transition.kind === 'open') {
      assert.equal(third.transition.frame.kind, 'CONFIRMATION');
      assert.equal(third.transition.nextFlowState.bookingDraft?.time, '18:00');
      assert.equal(third.transition.nextFlowState.duplicatePreflightClearance, undefined);
    }
    assert.deepEqual(rejected, []);
    assert.deepEqual(regenCalls, []);
    const boundaryInput = {
      servicesResult: SERVICES,
      sourceInboundText: 'Pode ser 18h',
      flowState: third.transition.nextFlowState,
      pendingTransitionCandidate: third.transition.kind === 'open'
        ? {
            kind: 'open' as const,
            pendingKind: 'CONFIRMATION' as const,
            flowId: third.transition.frame.flowId,
            optionEntityIds: third.transition.frame.options.map((option) => option.entityId),
          }
        : { kind: 'preserve' as const },
      source: 'GENERATED' as const,
      route: 'model' as const,
      pendingAnaOpen: true,
      pendingSnapshot: third.frame.pending,
      temporalContext: { now: new Date(baseNow.getTime() + 90 * 60 * 1_000), timezone: CONFIG.timezone },
    };
    const staleRead = evaluateBoundaryV2({
      ...boundaryInput,
      rawCandidate: third.payload ?? '',
      toolTrace: [
        {
          userTurn: 1,
          name: 'getUpcomingAppointments',
          result: JSON.stringify({
            success: true,
            appointments: [{
              startTime: '2026-08-24T21:00:00.000Z',
              serviceName: 'Esmaltação em gel',
              professionalName: 'Profissional Dois',
            }],
          }),
        },
        {
          userTurn: 2,
          name: 'getUpcomingAppointments',
          result: JSON.stringify({ success: true, appointments: [] }),
        },
      ],
    });
    assert.ok(staleRead.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'));
    const invalidRead = evaluateBoundaryV2({
      ...boundaryInput,
      rawCandidate: third.payload ?? '',
      toolTrace: [{
        name: 'getUpcomingAppointments',
        result: JSON.stringify({ success: false, reason: 'executor_error' }),
      }],
    });
    assert.ok(invalidRead.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'));
    const adulterated = evaluateBoundaryV2({
      ...boundaryInput,
      rawCandidate: (third.payload ?? '').replace('Esmaltação em gel', 'Esmaltação em gel premium'),
      toolTrace: toolCalls.map((call) => ({ name: call.name, result: call.result })),
    });
    assert.ok(adulterated.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'));
    const relist = evaluateBoundaryV2({
      ...boundaryInput,
      rawCandidate: 'Temos Manicure, Pedicure e Manicure e pedicure. Qual serviço você prefere?',
      toolTrace: [],
      pendingTransitionCandidate: { kind: 'preserve' as const },
    });
    assert.ok(relist.reasonCodes.includes('SERVICE_RELIST_AFTER_FIXED'));
    const { coordinateRecoveryV2 } = await import('../src/services/conversationalV2/recoveryCoordinator');
    const airbag = await coordinateRecoveryV2({
      frame: third.frame,
      primaryResult: { ok: false, issues: [{ code: 'INVALID_VALUE', path: '$.reply' }] },
      boundaryContext: {
        servicesResult: SERVICES,
        sourceInboundText: 'Pode ser 18h',
        temporalContext: { now: new Date(baseNow.getTime() + 90 * 60 * 1_000), timezone: CONFIG.timezone },
        route: 'model',
        pendingAnaOpen: true,
        pendingSnapshot: third.frame.pending,
      },
      toolTrace: [{
        name: 'getUpcomingAppointments',
        result: JSON.stringify({ success: false, reason: 'executor_error' }),
      }],
      fallbackIntent: 'ANSWER_TO_PENDING',
      now: new Date(baseNow.getTime() + 90 * 60 * 1_000),
      regenerate: async () => ({
        ok: false as const,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
        providerCalls: 1 as const,
      }),
    });
    assert.equal(airbag.status, 'accepted');
    assert.equal(airbag.recoveryKind, 'direct_fallback');
    assert.ok(airbag.payload.trim().length > 0);
    conflictReadCount = toolCalls.length;
    conflictWriteCount = third.planReceipt.toolEffects.filter((effect) => effect.class === 'write').length;
    }
    activeConversationKey = `${CONFIG.phoneNumberId}:fixture-noconflict-${safeTechnicalToken()}`;
    conversationKeys.push(activeConversationKey);
    upcomingResult = JSON.stringify({ success: true, appointments: [] });
    toolCalls.length = 0;
    rejected.length = 0;
    regenCalls.length = 0;
    const noConflictFirst = await runTurn(1, 'turn-noconflict-one', [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ]);
    assert.equal(noConflictFirst.transition.kind, 'open');
    reloadCheckInNewProcess(activeConversationKey, 'DATE', baseNow);
    const noConflictSecond = await runTurn(2, 'turn-noconflict-two', ['Hoje']);
    assert.equal(noConflictSecond.transition.kind, 'open');
    reloadCheckInNewProcess(
      activeConversationKey,
      'TIME',
      new Date(baseNow.getTime() + 45 * 60 * 1_000)
    );
    toolCalls.length = 0;
    const noConflictThird = await runTurn(3, 'turn-noconflict-three', ['Pode ser 18h']);
    if (beforeProbe) {
      assert.equal(noConflictThird.planReceipt.route, 'regen');
      assert.equal(noConflictThird.planReceipt.primaryProviderCalls, 0);
      assert.equal(noConflictThird.planReceipt.regenProviderCalls, 1);
      assert.ok(
        noConflictThird.planReceipt.boundaryAttempts[0]?.reasonCodes.includes(
          'UNVERIFIED_APPOINTMENT_CONTEXT'
        )
      );
      assert.equal(noConflictThird.transition.kind, 'preserve');
      assert.equal(
        noConflictThird.payload,
        'A gente estava marcando Manicure e pedicure para 24/08/2026 — qual horário você prefere?'
      );
      console.log(JSON.stringify({
        status: 'EXPECTED_RED_BEFORE_IA24D',
        route: noConflictThird.planReceipt.route,
        primaryProviderCalls: noConflictThird.planReceipt.primaryProviderCalls,
        regenProviderCalls: noConflictThird.planReceipt.regenProviderCalls,
        boundaryReasonCodes: noConflictThird.planReceipt.boundaryAttempts[0]?.reasonCodes ?? [],
        pendingAfter: noConflictThird.transition.kind === 'open'
          ? noConflictThird.transition.frame.kind
          : null,
        bookingDraftTime: noConflictThird.transition.kind === 'open'
          ? noConflictThird.transition.nextFlowState.bookingDraft?.time ?? null
          : null,
        payload: noConflictThird.payload,
        writeCommitted: noConflictThird.hasCommittedWrite,
      }));
      return;
    }
    assert.equal(
      noConflictThird.payload,
      'Confirmando: Manicure e pedicure, em 24/08/2026, às 18h, com Vitin. Posso marcar?'
    );
    assert.equal(noConflictThird.planReceipt.route, 'fast_path');
    assert.equal(noConflictThird.planReceipt.recoveryKind, 'none');
    assert.equal(noConflictThird.planReceipt.regenProviderCalls, 0);
    assert.deepEqual(noConflictThird.planReceipt.boundaryAttempts[0]?.reasonCodes, []);
    assert.deepEqual(toolCalls.map((call) => call.name), ['getUpcomingAppointments']);
    assert.equal(noConflictThird.planReceipt.toolEffects.filter((effect) => effect.class === 'write').length, 0);
    assert.equal(noConflictThird.transition.kind, 'open');
    if (noConflictThird.transition.kind === 'open' && !beforeProbe && preBooking) {
      assert.equal(noConflictThird.transition.frame.kind, 'CONFIRMATION');
      assert.equal(noConflictThird.transition.nextFlowState.bookingDraft?.time, '18:00');
      assert.equal(noConflictThird.transition.nextFlowState.duplicatePreflightClearance?.kind, 'no_conflict');
      assert.equal(
        preBooking.materializePreBookingSummaryV2({
          bookingDraft: noConflictThird.transition.nextFlowState.bookingDraft!,
          services: SERVICES,
        }),
        noConflictThird.payload
      );
      const preBookingSummaryEvidence = preBooking.buildPreBookingSummaryEvidenceV2({
        flowState: noConflictThird.transition.nextFlowState,
        services: SERVICES,
      });
      assert.ok(preBookingSummaryEvidence);
      const finalBoundary = evaluateBoundaryV2({
        rawCandidate: noConflictThird.payload!,
        servicesResult: SERVICES,
        flowState: noConflictThird.transition.nextFlowState,
        pendingTransitionCandidate: {
          kind: 'open',
          pendingKind: 'CONFIRMATION',
          flowId: noConflictThird.transition.frame.flowId,
          optionEntityIds: noConflictThird.transition.frame.options.map((option) => option.entityId),
        },
        replyPurpose: 'WRITE_CONFIRMATION',
        source: 'CANONICAL',
        outboundEvidence: { preBookingSummary: preBookingSummaryEvidence },
        toolTrace: toolCalls.map((call) => ({ name: call.name, result: call.result })),
        sourceInboundText: 'Pode ser 18h',
        pendingAnaOpen: true,
        pendingSnapshot: noConflictThird.frame.pending,
      });
      assert.deepEqual(finalBoundary.reasonCodes, []);
      assert.equal(noConflictThird.hasCommittedWrite, false);
    }
    console.log(JSON.stringify({
      status: 'PASS',
      route: third?.planReceipt.route ?? noConflictThird.planReceipt.route,
      recoveryKind: third?.planReceipt.recoveryKind ?? noConflictThird.planReceipt.recoveryKind,
      source: onlyNoConflict ? 'CANONICAL_FAST_PATH_NO_CONFLICT' : 'CANONICAL_FAST_PATH',
      primaryCandidateHash: hash(third?.payload ?? noConflictThird.payload ?? ''),
      primaryModelRounds: third?.planReceipt.primaryModelRounds ?? noConflictThird.planReceipt.primaryModelRounds,
      primaryProviderCalls: third?.planReceipt.primaryProviderCalls ?? noConflictThird.planReceipt.primaryProviderCalls,
      regenProviderCalls: third?.planReceipt.regenProviderCalls ?? noConflictThird.planReceipt.regenProviderCalls,
      readOrigin: 'resolveTimeDuplicatePreflightV2',
      readCount: conflictReadCount,
      writeCount: conflictWriteCount,
      pendingAfter: third?.transition.kind === 'open' ? third.transition.frame.kind : null,
      bookingDraftTime: third?.transition.kind === 'open' ? third.transition.nextFlowState.bookingDraft?.time ?? null : null,
      staleReadLicense: false,
      airbagPreserved: !onlyNoConflict,
      serviceRelistProtected: !onlyNoConflict,
      noConflict: {
        route: noConflictThird.planReceipt.route,
        primaryCandidateHash: hash(noConflictThird.payload ?? ''),
        readOrigin: 'resolveTimeDuplicatePreflightV2',
        readCount: 1,
        writeCount: noConflictThird.planReceipt.toolEffects.filter((effect) => effect.class === 'write').length,
        pendingAfter: noConflictThird.transition.kind === 'open' ? noConflictThird.transition.frame.kind : null,
        bookingDraftTime: noConflictThird.transition.kind === 'open' ? noConflictThird.transition.nextFlowState.bookingDraft?.time ?? null : null,
        replyPurpose: noConflictThird.transition.kind === 'open' && noConflictThird.transition.frame.kind === 'CONFIRMATION'
          ? 'WRITE_CONFIRMATION'
          : null,
        writeCommitted: noConflictThird.hasCommittedWrite,
      },
    }));
  } finally {
    cleanupFailures = await cleanup(db);
    const after = await Promise.all(conversationKeys.map((key) => counts(db, key)));
    if (cleanupFailures.length > 0) fail(`cleanup failed: ${cleanupFailures.join(',')}`);
    if (after.some((countsForConversation) =>
      !countsForConversation || Object.values(countsForConversation).some((value) => value !== 0)
    )) fail('cleanup verification failed');
    console.log(JSON.stringify({
      status: 'CLEANUP_ZERO',
      conversationCount: conversationKeys.length,
    }));
    await contextManager.pool.end();
    await db.end();
  }
}

void main().catch((error: unknown) => {
  console.error(`smoke-ana-ia24-field-route-pg-real: FAIL (${technicalErrorKind(error)})`);
  process.exitCode = 1;
});
