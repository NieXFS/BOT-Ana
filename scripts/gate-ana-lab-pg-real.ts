import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Pool, PoolClient } from 'pg';
import type {
  FlowStateV2,
  TurnDeliveryReceiptV2,
  TurnPlanReceiptV2,
} from '../src/services/conversationalV2/contracts';
import type { MaterializedPendingTransitionV2 } from '../src/services/conversationalV2/stateStore';

const SYNTHETIC_PREFIX = 'labgate-';

// This executable is a local LAB gate, never a server boot. Keep remote
// observability and every global/background runtime path disabled before any
// product module is loaded.
process.env.NODE_ENV = 'development';
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.ANA_RUNTIME_MODE = 'lab';
process.env.LAB_WRITE_POLICY = 'disabled';
process.env.SENTRY_DSN = '';

const OPERATIONAL_TABLES = [
  'processed_messages',
  'ana_conversation_history',
  'ana_conversation_seq',
  'inbound_event_outbox',
  'sent_question_replies',
  'ana_v2_silent_escalation_holds',
  'ana_v2_pending_frames',
  'ana_v2_outbound_outbox',
  'ana_v2_turn_receipts',
  'ana_v2_successor_batches',
  'ana_v2_flow_state_invalidations',
  'ana_v2_provider_status_events',
  'sales_followups',
  'tts_cache',
  'tts_daily_usage',
  'renata_channel_prefs',
  'media_cache',
] as const;

type OperationalTable = (typeof OPERATIONAL_TABLES)[number];

interface BoundaryCounts {
  erpHttp: number;
  metaTransport: number;
  externalBusinessWrite: number;
  otherHttp: number;
}

interface LiveCounts {
  transportStarted: number;
  acceptedUncommitted: number;
  successorQueuedOrProcessing: number;
  silentHoldPendingOrConfirmed: number;
  providerStatusPending: number;
}

interface AuditSnapshot {
  tableRows: Record<OperationalTable, number>;
  live: LiveCounts;
  syntheticRows: Record<OperationalTable, number>;
}

interface FixtureIds {
  conversations: string[];
  deliveryAttemptIds: string[];
  turnIds: string[];
  planReceiptIds: string[];
  deliveryReceiptIds: string[];
  providerMessageIdHashes: string[];
  providerStatusReceiptIds: string[];
}

interface HttpBoundaryProbe {
  counts: BoundaryCounts;
  restore: () => void;
}

function safeErrorKind(error: unknown): string {
  const value = error instanceof Error ? error.name : typeof error;
  return value.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) || 'unknown';
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL ausente');
  if (
    process.env.RECEPS_IA_DIRECT_DATABASE_URL?.trim() ||
    process.env.ANA_DIRECT_DATABASE_URL?.trim()
  ) {
    throw new Error('Gate LAB aceita somente DATABASE_URL');
  }
  return value;
}

function requestDescriptor(input: unknown): {
  hostname: string;
  method: string;
} {
  let url: URL | null = null;
  let options: Record<string, unknown> = {};
  if (input instanceof URL) {
    url = input;
  } else if (typeof input === 'string') {
    try {
      url = new URL(input);
    } catch {
      url = null;
    }
  } else if (input && typeof input === 'object') {
    options = input as Record<string, unknown>;
  }
  const hostname = String(
    url?.hostname ?? options.hostname ?? options.host ?? ''
  ).toLowerCase();
  const method = String(options.method ?? 'GET').toUpperCase();
  return { hostname, method };
}

function installHttpBoundaryProbe(): HttpBoundaryProbe {
  const counts: BoundaryCounts = {
    erpHttp: 0,
    metaTransport: 0,
    externalBusinessWrite: 0,
    otherHttp: 0,
  };
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalFetch = globalThis.fetch;

  const erpHosts = new Set(['localhost', '127.0.0.1']);
  for (const raw of [
    process.env.ERP_BASE_URL,
    process.env.RECEPS_INTERNAL_API_URL,
  ]) {
    if (!raw?.trim()) continue;
    try {
      erpHosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      // An invalid configured URL cannot authorize network. The gate still
      // blocks and counts it as an unknown HTTP attempt if used.
    }
  }

  const observeAndBlock = (input: unknown): never => {
    const { hostname, method } = requestDescriptor(input);
    if (
      hostname === 'graph.facebook.com' ||
      hostname.endsWith('.graph.facebook.com')
    ) {
      counts.metaTransport += 1;
    } else if (erpHosts.has(hostname)) {
      counts.erpHttp += 1;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        counts.externalBusinessWrite += 1;
      }
    } else {
      counts.otherHttp += 1;
    }
    throw new Error('labgate external HTTP blocked');
  };

  (http as unknown as { request: typeof http.request }).request = ((
    ...args: unknown[]
  ) => observeAndBlock(args[0])) as typeof http.request;
  (http as unknown as { get: typeof http.get }).get = ((
    ...args: unknown[]
  ) => observeAndBlock(args[0])) as typeof http.get;
  (https as unknown as { request: typeof https.request }).request = ((
    ...args: unknown[]
  ) => observeAndBlock(args[0])) as typeof https.request;
  (https as unknown as { get: typeof https.get }).get = ((
    ...args: unknown[]
  ) => observeAndBlock(args[0])) as typeof https.get;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    try {
      observeAndBlock(input);
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof fetch;

  return {
    counts,
    restore: () => {
      (http as unknown as { request: typeof http.request }).request =
        originalHttpRequest;
      (http as unknown as { get: typeof http.get }).get = originalHttpGet;
      (https as unknown as { request: typeof https.request }).request =
        originalHttpsRequest;
      (https as unknown as { get: typeof https.get }).get = originalHttpsGet;
      globalThis.fetch = originalFetch;
    },
  };
}

function emptyFixtureIds(): FixtureIds {
  return {
    conversations: [],
    deliveryAttemptIds: [],
    turnIds: [],
    planReceiptIds: [],
    deliveryReceiptIds: [],
    providerMessageIdHashes: [],
    providerStatusReceiptIds: [],
  };
}

function fixtureIdFactory(ids: FixtureIds): (kind: string) => string {
  const runId = randomUUID().replace(/-/gu, '');
  return (kind: string) => `${SYNTHETIC_PREFIX}${runId}-${kind}`;
}

function makeConversation(
  id: (kind: string) => string,
  label: string,
  ids: FixtureIds
): string {
  const conversation = `${id(`${label}-phone`)}:${id(`${label}-customer`)}`;
  ids.conversations.push(conversation);
  return conversation;
}

function minimalFlow(flowId: string, now: Date): FlowStateV2 {
  return {
    flowId,
    lastOperationalAt: now.toISOString(),
    fixedByProofVersion: {},
  };
}

function makePlanReceipt(input: {
  turnId: string;
  planReceiptId: string;
  frameHash: string;
}): TurnPlanReceiptV2 {
  return {
    schemaVersion: 2,
    planReceiptId: input.planReceiptId,
    turnId: input.turnId,
    frameHash: input.frameHash,
    inputSequence: 1,
    route: 'model',
    provider: 'openai',
    requestedModel: 'gpt-4o-mini',
    response: { model: null, systemFingerprint: null },
    thinkingMode: 'disabled',
    strictTools: true,
    primaryModelRounds: 0,
    primaryProviderCalls: 0,
    regenProviderCalls: 0,
    pendingTransitionCandidate: { kind: 'preserve' },
    toolEffects: [],
    boundaryAttempts: [],
    recoveryKind: 'none',
    result: 'accepted_for_delivery',
  };
}

function makeDeliveryReceipt(input: {
  deliveryAttemptId: string;
  deliveryReceiptId: string;
  turnId: string;
  planReceiptId: string;
  providerMessageIdHash: string;
  transportStartedAt: Date;
  terminalAt: Date;
}): TurnDeliveryReceiptV2 {
  return {
    schemaVersion: 2,
    deliveryReceiptId: input.deliveryReceiptId,
    planReceiptId: input.planReceiptId,
    turnId: input.turnId,
    deliveryAttemptId: input.deliveryAttemptId,
    transportStartedAt: input.transportStartedAt.toISOString(),
    transportOutcome: 'accepted_by_provider',
    providerMessageIdHash: input.providerMessageIdHash,
    outboxState: 'accepted_by_provider',
    flowStateCommitOutcome: 'committed',
    conversationCommitOutcome: 'committed',
    pendingCommitOutcome: 'not_applicable',
    expectedPendingVersion: null,
    observedPendingVersion: null,
    terminalAt: input.terminalAt.toISOString(),
  };
}

async function createStartedOutbox(input: {
  store: import('../src/services/conversationalV2/stateStore').ConversationalV2StateStore;
  id: (kind: string) => string;
  ids: FixtureIds;
  label: string;
  conversationKey: string;
  startedAt: Date;
}): Promise<{
  deliveryAttemptId: string;
  deliveryReceiptId: string;
  turnId: string;
  planReceiptId: string;
  providerMessageIdHash: string;
  transition: MaterializedPendingTransitionV2;
}> {
  const deliveryAttemptId = input.id(`${input.label}-attempt`);
  const deliveryReceiptId = input.id(`${input.label}-delivery-receipt`);
  const turnId = input.id(`${input.label}-turn`);
  const planReceiptId = input.id(`${input.label}-plan`);
  const providerMessageIdHash = input.id(`${input.label}-provider-hash`);
  const flowId = input.id(`${input.label}-flow`);
  const transition: MaterializedPendingTransitionV2 = {
    kind: 'preserve',
    nextFlowState: minimalFlow(flowId, input.startedAt),
  };

  input.ids.deliveryAttemptIds.push(deliveryAttemptId);
  input.ids.deliveryReceiptIds.push(deliveryReceiptId);
  input.ids.turnIds.push(turnId);
  input.ids.planReceiptIds.push(planReceiptId);
  input.ids.providerMessageIdHashes.push(providerMessageIdHash);

  await input.store.savePlanReceipt(
    makePlanReceipt({
      turnId,
      planReceiptId,
      frameHash: input.id(`${input.label}-frame-hash`),
    })
  );
  await input.store.prepareOutbound({
    deliveryAttemptId,
    conversationKey: input.conversationKey,
    turnId,
    planReceiptId,
    payload: input.id(`${input.label}-payload`),
    transition,
    now: input.startedAt,
  });
  await input.store.markTransportStarted(deliveryAttemptId, input.startedAt);

  return {
    deliveryAttemptId,
    deliveryReceiptId,
    turnId,
    planReceiptId,
    providerMessageIdHash,
    transition,
  };
}

async function countAudit(pool: Pool): Promise<AuditSnapshot> {
  const rowSql = OPERATIONAL_TABLES.map(
    (table) =>
      `SELECT '${table}'::text AS table_name, count(*)::int AS count FROM ${table}`
  ).join('\nUNION ALL\n');
  const rowResult = await pool.query<{ table_name: OperationalTable; count: number }>(
    rowSql
  );
  const tableRows = Object.fromEntries(
    OPERATIONAL_TABLES.map((table) => [table, 0])
  ) as Record<OperationalTable, number>;
  for (const row of rowResult.rows) tableRows[row.table_name] = Number(row.count);

  const syntheticSql = OPERATIONAL_TABLES.map(
    (table) =>
      `SELECT '${table}'::text AS table_name, count(*)::int AS count
         FROM ${table} AS row_value
        WHERE to_jsonb(row_value)::text LIKE $1`
  ).join('\nUNION ALL\n');
  const syntheticResult = await pool.query<{
    table_name: OperationalTable;
    count: number;
  }>(syntheticSql, [`%${SYNTHETIC_PREFIX}%`]);
  const syntheticRows = Object.fromEntries(
    OPERATIONAL_TABLES.map((table) => [table, 0])
  ) as Record<OperationalTable, number>;
  for (const row of syntheticResult.rows) {
    syntheticRows[row.table_name] = Number(row.count);
  }

  const liveResult = await pool.query<{
    transport_started: number;
    accepted_uncommitted: number;
    successor_queued_or_processing: number;
    silent_hold_pending_or_confirmed: number;
    provider_status_pending: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM ana_v2_outbound_outbox
        WHERE state = 'transport_started') AS transport_started,
      (SELECT count(*)::int FROM ana_v2_outbound_outbox
        WHERE state = 'accepted_uncommitted') AS accepted_uncommitted,
      (SELECT count(*)::int FROM ana_v2_successor_batches
        WHERE status IN ('queued', 'processing')) AS successor_queued_or_processing,
      (SELECT count(*)::int FROM ana_v2_silent_escalation_holds
        WHERE status IN ('pending', 'confirmed')) AS silent_hold_pending_or_confirmed,
      (SELECT count(*)::int FROM ana_v2_provider_status_events
        WHERE state = 'pending') AS provider_status_pending
  `);
  const liveRow = liveResult.rows[0]!;
  return {
    tableRows,
    syntheticRows,
    live: {
      transportStarted: Number(liveRow.transport_started),
      acceptedUncommitted: Number(liveRow.accepted_uncommitted),
      successorQueuedOrProcessing: Number(
        liveRow.successor_queued_or_processing
      ),
      silentHoldPendingOrConfirmed: Number(
        liveRow.silent_hold_pending_or_confirmed
      ),
      providerStatusPending: Number(liveRow.provider_status_pending),
    },
  };
}

function sumCounts(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function assertZeroLive(audit: AuditSnapshot, label: string): void {
  assert.equal(
    sumCounts(audit.live as unknown as Record<string, number>),
    0,
    `${label}: estado vivo residual`
  );
}

async function cleanupStaleSyntheticPrefix(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const tables = [
    'ana_v2_provider_status_events',
    'ana_v2_turn_receipts',
    'ana_v2_successor_batches',
    'ana_v2_pending_frames',
    'ana_v2_flow_state_invalidations',
    'ana_v2_silent_escalation_holds',
    'ana_conversation_history',
    'ana_conversation_seq',
    'ana_v2_outbound_outbox',
  ] as const;
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      await client.query(
        `DELETE FROM ${table} AS row_value
          WHERE to_jsonb(row_value)::text LIKE $1`,
        [`%${SYNTHETIC_PREFIX}%`]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original cleanup failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupKnownFixtures(
  pool: Pool,
  ids: FixtureIds
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM ana_v2_provider_status_events
        WHERE status_receipt_id = ANY($1::text[])
           OR provider_message_id_hash = ANY($2::text[])
           OR delivery_attempt_id = ANY($3::text[])
           OR turn_id = ANY($4::text[])
           OR delivery_receipt_id = ANY($5::text[])`,
      [
        ids.providerStatusReceiptIds,
        ids.providerMessageIdHashes,
        ids.deliveryAttemptIds,
        ids.turnIds,
        ids.deliveryReceiptIds,
      ]
    );
    await client.query(
      `DELETE FROM ana_v2_turn_receipts
        WHERE receipt_id = ANY($1::text[]) OR turn_id = ANY($2::text[])`,
      [[...ids.planReceiptIds, ...ids.deliveryReceiptIds], ids.turnIds]
    );
    await client.query(
      `DELETE FROM ana_v2_successor_batches
        WHERE conversation_key = ANY($1::text[])
           OR successor_turn_id = ANY($2::text[])
           OR source_turn_id = ANY($2::text[])`,
      [ids.conversations, ids.turnIds]
    );
    await client.query(
      `DELETE FROM ana_v2_pending_frames
        WHERE conversation_key = ANY($1::text[])`,
      [ids.conversations]
    );
    await client.query(
      `DELETE FROM ana_v2_flow_state_invalidations
        WHERE conversation_key = ANY($1::text[])`,
      [ids.conversations]
    );
    await client.query(
      `DELETE FROM ana_v2_silent_escalation_holds
        WHERE conversation_key = ANY($1::text[])`,
      [ids.conversations]
    );
    await client.query(
      `DELETE FROM ana_conversation_history
        WHERE "conversationKey" = ANY($1::text[])`,
      [ids.conversations]
    );
    await client.query(
      `DELETE FROM ana_conversation_seq
        WHERE conversation_key = ANY($1::text[])`,
      [ids.conversations]
    );
    await client.query(
      `DELETE FROM ana_v2_outbound_outbox
        WHERE delivery_attempt_id = ANY($1::text[])
           OR conversation_key = ANY($2::text[])`,
      [ids.deliveryAttemptIds, ids.conversations]
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original cleanup failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function queryOutbox(
  pool: Pool,
  deliveryAttemptId: string
): Promise<{
  state: string;
  providerMessageIdHash: string | null;
  providerStatus: string | null;
  providerStatusVersion: number;
  transportStartedAt: string | null;
  conversationCommitOutcome: string | null;
  flowStateCommitOutcome: string | null;
}> {
  const result = await pool.query<{
    state: string;
    provider_message_id_hash: string | null;
    provider_status: string | null;
    provider_status_version: number | string;
    transport_started_at: Date | string | null;
    conversation_commit_outcome: string | null;
    flow_state_commit_outcome: string | null;
  }>(
    `SELECT state, provider_message_id_hash, provider_status,
            provider_status_version, transport_started_at,
            commit_payload_json->'deliveryReceipt'->>'conversationCommitOutcome'
              AS conversation_commit_outcome,
            commit_payload_json->'deliveryReceipt'->>'flowStateCommitOutcome'
              AS flow_state_commit_outcome
       FROM ana_v2_outbound_outbox
      WHERE delivery_attempt_id = $1`,
    [deliveryAttemptId]
  );
  const row = result.rows[0];
  assert(row, 'outbox sintético ausente');
  return {
    state: row.state,
    providerMessageIdHash: row.provider_message_id_hash,
    providerStatus: row.provider_status,
    providerStatusVersion: Number(row.provider_status_version),
    transportStartedAt: row.transport_started_at
      ? new Date(row.transport_started_at).toISOString()
      : null,
    conversationCommitOutcome: row.conversation_commit_outcome,
    flowStateCommitOutcome: row.flow_state_commit_outcome,
  };
}

async function insertPendingProviderStatus(input: {
  client: PoolClient;
  statusReceiptId: string;
  providerMessageIdHash: string;
  occurredAt: Date;
  observedAt: Date;
  nextAttemptAt: Date;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO ana_v2_provider_status_events (
       status_receipt_id, provider_message_id_hash, status_event,
       occurred_at, failure_code, delivery_attempt_id, turn_id,
       delivery_receipt_id, state, attempts, next_attempt_at,
       observed_at, updated_at
     ) VALUES ($1,$2,'delivered',$3,NULL,NULL,NULL,NULL,'pending',0,$4,$5,$5)`,
    [
      input.statusReceiptId,
      input.providerMessageIdHash,
      input.occurredAt,
      input.nextAttemptAt,
      input.observedAt,
    ]
  );
}

async function run(): Promise<void> {
  let stage = 'environment';
  const databaseUrl = requireDatabaseUrl();
  const ids = emptyFixtureIds();
  const id = fixtureIdFactory(ids);
  const probe = installHttpBoundaryProbe();
  let pool: Pool | null = null;
  let before: AuditSnapshot | null = null;
  let after: AuditSnapshot | null = null;
  let primaryError: unknown = null;
  let primaryFailureStage: string | null = null;
  let cleanupError: unknown = null;

  try {
    stage = 'module_load';
    const [context, labSchema, policy, stateModule, providerStatusModule] =
      await Promise.all([
        import('../src/services/contextManager'),
        import('../src/services/labSchema'),
        import('../src/runtimePolicy'),
        import('../src/services/conversationalV2/stateStore'),
        import('../src/services/conversationalV2/providerStatus'),
      ]);
    pool = context.pool;

    stage = 'lab_identity';
    const fingerprint = policy.databaseFingerprint(databaseUrl);
    await labSchema.validateLabSchema(fingerprint, pool);
    const blockedWrite = policy.labBlockedWriteEffect(
      `${SYNTHETIC_PREFIX}business-write-probe`,
      process.env
    );
    assert(blockedWrite, 'política LAB de write não armada');
    assert.equal(blockedWrite.writeCommitted, false);
    assert.throws(
      () => policy.assertExternalWriteAllowed(process.env),
      policy.LabWriteDisabledError
    );

    stage = 'startup_cleanup';
    await cleanupStaleSyntheticPrefix(pool);

    stage = 'preflight_audit';
    before = await countAudit(pool);
    assertZeroLive(before, 'preflight');
    assert.equal(
      sumCounts(before.syntheticRows),
      0,
      'preflight: row labgate residual'
    );

    const recoveryNow = new Date();
    const staleStartedAt = new Date(recoveryNow.getTime() - 5 * 60_000);
    const acceptedStartedAt = new Date(recoveryNow.getTime() - 30_000);

    stage = 'seed_transport_started';
    const staleConversation = makeConversation(id, 'stale', ids);
    const stale = await createStartedOutbox({
      store: stateModule.pgConversationalV2StateStore,
      id,
      ids,
      label: 'stale',
      conversationKey: staleConversation,
      startedAt: staleStartedAt,
    });

    stage = 'seed_accepted_uncommitted';
    const acceptedConversation = makeConversation(id, 'accepted', ids);
    const accepted = await createStartedOutbox({
      store: stateModule.pgConversationalV2StateStore,
      id,
      ids,
      label: 'accepted',
      conversationKey: acceptedConversation,
      startedAt: acceptedStartedAt,
    });
    const acceptedReceipt = makeDeliveryReceipt({
      ...accepted,
      transportStartedAt: acceptedStartedAt,
      terminalAt: new Date(acceptedStartedAt.getTime() + 1_000),
    });
    await stateModule.pgConversationalV2StateStore.markAcceptedUncommitted({
      deliveryAttemptId: accepted.deliveryAttemptId,
      providerMessageIdHash: accepted.providerMessageIdHash,
      commitPayload: {
        assistantText: id('accepted-assistant-text'),
        transition: accepted.transition,
        deliveryReceipt: acceptedReceipt,
      },
      now: new Date(acceptedStartedAt.getTime() + 2_000),
    });
    const acceptedBefore = await queryOutbox(pool, accepted.deliveryAttemptId);
    assert.equal(acceptedBefore.state, 'accepted_uncommitted');

    stage = 'state_recovery_sweep';
    const stateSweep = await stateModule.pgConversationalV2StateStore.sweep(
      recoveryNow
    );
    assert.deepEqual(stateSweep, {
      unknownMarked: 1,
      reconciled: 1,
      successorsReady: 0,
    });
    const staleAfter = await queryOutbox(pool, stale.deliveryAttemptId);
    assert.equal(staleAfter.state, 'transport_unknown');
    const staleGuard = await stateModule.pgConversationalV2StateStore.inspectInboundGuard(
      staleConversation,
      recoveryNow
    );
    assert.equal(staleGuard.kind, 'clear');

    const acceptedAfter = await queryOutbox(pool, accepted.deliveryAttemptId);
    assert.equal(acceptedAfter.state, 'accepted_by_provider');
    assert.equal(acceptedAfter.conversationCommitOutcome, 'committed');
    assert.equal(acceptedAfter.flowStateCommitOutcome, 'committed');
    assert.equal(
      acceptedAfter.providerMessageIdHash,
      acceptedBefore.providerMessageIdHash
    );
    assert.equal(
      acceptedAfter.transportStartedAt,
      acceptedBefore.transportStartedAt
    );
    const acceptedOutboxCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ana_v2_outbound_outbox
        WHERE conversation_key = $1`,
      [acceptedConversation]
    );
    assert.equal(Number(acceptedOutboxCount.rows[0]?.count), 1);
    const idempotentStateSweep =
      await stateModule.pgConversationalV2StateStore.sweep(
        new Date(recoveryNow.getTime() + 1_000)
      );
    assert.deepEqual(idempotentStateSweep, {
      unknownMarked: 0,
      reconciled: 0,
      successorsReady: 0,
    });

    stage = 'seed_provider_status_pending';
    const providerConversation = makeConversation(id, 'provider', ids);
    const providerStatusReceiptId = id('provider-status-receipt');
    ids.providerStatusReceiptIds.push(providerStatusReceiptId);
    const providerOccurredAt = new Date(recoveryNow.getTime() + 2_000);
    const providerSweepAt = new Date(recoveryNow.getTime() + 5_000);
    const providerStatusClient = await pool.connect();
    try {
      await insertPendingProviderStatus({
        client: providerStatusClient,
        statusReceiptId: providerStatusReceiptId,
        providerMessageIdHash: id('provider-provider-hash'),
        occurredAt: providerOccurredAt,
        observedAt: new Date(recoveryNow.getTime() + 1_000),
        nextAttemptAt: new Date(recoveryNow.getTime() + 3_000),
      });
    } finally {
      providerStatusClient.release();
    }
    const pendingHashResult = await pool.query<{
      provider_message_id_hash: string;
      state: string;
    }>(
      `SELECT provider_message_id_hash, state
         FROM ana_v2_provider_status_events
        WHERE status_receipt_id = $1`,
      [providerStatusReceiptId]
    );
    const pendingHash = pendingHashResult.rows[0]?.provider_message_id_hash;
    assert(pendingHash?.startsWith(SYNTHETIC_PREFIX));
    assert.equal(pendingHashResult.rows[0]?.state, 'pending');
    ids.providerMessageIdHashes.push(pendingHash);

    stage = 'seed_provider_outbox_target';
    const providerTarget = await createStartedOutbox({
      store: stateModule.pgConversationalV2StateStore,
      id,
      ids,
      label: 'provider-target',
      conversationKey: providerConversation,
      startedAt: new Date(recoveryNow.getTime() + 3_500),
    });
    // The status fixture must correlate with this target. Replace only the
    // controllable synthetic hash before the target becomes accepted.
    await pool.query(
      `UPDATE ana_v2_outbound_outbox
          SET provider_message_id_hash = $2
        WHERE delivery_attempt_id = $1`,
      [providerTarget.deliveryAttemptId, pendingHash]
    );
    const providerReceipt = makeDeliveryReceipt({
      ...providerTarget,
      providerMessageIdHash: pendingHash,
      transportStartedAt: new Date(recoveryNow.getTime() + 3_500),
      terminalAt: new Date(recoveryNow.getTime() + 4_000),
    });
    await stateModule.pgConversationalV2StateStore.commitAccepted({
      deliveryAttemptId: providerTarget.deliveryAttemptId,
      providerMessageIdHash: pendingHash,
      commitPayload: {
        assistantText: id('provider-assistant-text'),
        transition: providerTarget.transition,
        deliveryReceipt: providerReceipt,
      },
      now: new Date(recoveryNow.getTime() + 4_500),
    });

    stage = 'provider_status_recovery_sweep';
    const providerSweep =
      await providerStatusModule.sweepProviderStatusRecoveryV2(
        providerStatusModule.pgProviderStatusStoreV2,
        providerSweepAt
      );
    assert.equal(providerSweep.attempted, 1);
    assert.equal(providerSweep.applied, 1);
    assert.equal(providerSweep.unmatched, 0);
    const providerEventAfter = await pool.query<{ state: string }>(
      `SELECT state FROM ana_v2_provider_status_events
        WHERE status_receipt_id = $1`,
      [providerStatusReceiptId]
    );
    assert.equal(providerEventAfter.rows[0]?.state, 'applied');
    const providerOutboxAfter = await queryOutbox(
      pool,
      providerTarget.deliveryAttemptId
    );
    assert.equal(providerOutboxAfter.state, 'accepted_by_provider');
    assert.equal(providerOutboxAfter.providerStatus, 'delivered');
    assert.equal(providerOutboxAfter.providerStatusVersion, 1);
    const idempotentProviderSweep =
      await providerStatusModule.sweepProviderStatusRecoveryV2(
        providerStatusModule.pgProviderStatusStoreV2,
        new Date(providerSweepAt.getTime() + 1_000)
      );
    assert.deepEqual(
      {
        attempted: idempotentProviderSweep.attempted,
        applied: idempotentProviderSweep.applied,
        unmatched: idempotentProviderSweep.unmatched,
      },
      { attempted: 0, applied: 0, unmatched: 0 }
    );

    stage = 'boundary_assertions';
    assert.deepEqual(probe.counts, {
      erpHttp: 0,
      metaTransport: 0,
      externalBusinessWrite: 0,
      otherHttp: 0,
    });
  } catch (error) {
    primaryError = error;
    primaryFailureStage = stage;
  } finally {
    if (pool) {
      try {
        stage = 'final_cleanup';
        await cleanupKnownFixtures(pool, ids);
        after = await countAudit(pool);
        assertZeroLive(after, 'final');
        assert.equal(
          sumCounts(after.syntheticRows),
          0,
          'final: row labgate residual'
        );
        if (before) {
          assert.deepEqual(
            after.tableRows,
            before.tableRows,
            'contagens operacionais não voltaram ao baseline'
          );
        }
      } catch (error) {
        cleanupError = error;
      }
      try {
        await pool.end();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    probe.restore();
  }

  if (primaryError || cleanupError || !before || !after) {
    const failure = cleanupError ?? primaryError;
    const failureStage = cleanupError
      ? 'final_cleanup'
      : primaryFailureStage ?? stage;
    console.error(
      `gate-ana-lab-pg-real: FAIL | stage=${failureStage} | error_kind=${safeErrorKind(failure)}`
    );
    if (before) {
      console.error(`counts.before=${JSON.stringify(before.tableRows)}`);
    }
    if (after) {
      console.error(`counts.after=${JSON.stringify(after.tableRows)}`);
      console.error(`residue.live=${JSON.stringify(after.live)}`);
      console.error(
        `residue.synthetic_total=${sumCounts(after.syntheticRows)}`
      );
    }
    console.error(`external.boundaries=${JSON.stringify(probe.counts)}`);
    process.exitCode = 1;
    return;
  }

  console.log('gate-ana-lab-pg-real: PASS');
  console.log('proof.transport_started=transport_unknown');
  console.log(
    'proof.accepted_uncommitted=reconciled_no_repost_no_retransport'
  );
  console.log('proof.provider_status_pending=applied');
  console.log(`external.boundaries=${JSON.stringify(probe.counts)}`);
  console.log(`counts.before=${JSON.stringify(before.tableRows)}`);
  console.log(`counts.after=${JSON.stringify(after.tableRows)}`);
  console.log(`residue.live=${JSON.stringify(after.live)}`);
  console.log(`residue.synthetic_total=${sumCounts(after.syntheticRows)}`);
}

void run();
