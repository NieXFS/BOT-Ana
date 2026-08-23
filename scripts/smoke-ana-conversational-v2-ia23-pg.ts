/*
 * IA-23 PG battery.
 *
 * This is deliberately opt-in and deliberately not part of the hermetic
 * smoke suite.  It uses the real PostgreSQL state store and the real direct
 * Neon endpoint.  No provider or WhatsApp transport is called.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { parse as parseDotenv } from 'dotenv';

const ENV_FILE = process.env.ANA_IA23_PG_ENV_FILE?.trim();
const OPT_IN = process.env.ANA_IA23_PG_DEV_TEST === '1';
const PROD_HOST_RE = /(?:^|[.-])ep-small-frog(?:[.-]|$)/i;
const DEV_HOST_RE = /^ep-restless-frost-[^.]+\.sa-east-1\.aws\.neon\.tech$/i;
const SYNTHETIC_CONVERSATION_PREFIX = 'ia23pg:';
const SYNTHETIC_TURN_PREFIX = 'ia23pg-turn:';
const SYNTHETIC_PLAN_PREFIX = 'ia23pg-plan:';

type StateStoreModule = typeof import('../src/services/conversationalV2/stateStore');
type OrderModule = typeof import('../src/services/conversationOrder');
type ContractsModule = typeof import('../src/services/conversationalV2/contracts');
type MaterializedTransition = import('../src/services/conversationalV2/stateStore')['MaterializedPendingTransitionV2'];

interface ScenarioResult {
  name: string;
  endpoint: string;
  status: 'PASS' | 'FAIL' | 'NÃO VERIFICÁVEL';
  observed: string;
  cleanup: string;
}

interface CleanupResult {
  failures: string[];
}

interface CountSnapshot {
  counts: Record<string, number> | null;
  verified: boolean;
  failures: string[];
}

function die(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sanitizedErrorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return name.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) || 'unknown';
}

function currentGitHead(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,40}$/iu.test(head) ? head : 'NOT_VERIFIED';
  } catch {
    return 'NOT_VERIFIED';
  }
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
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.|$)/i, '');
  return parsed.toString();
}

function nowAfter(base: Date, milliseconds: number): Date {
  return new Date(base.getTime() + milliseconds);
}

function syntheticConversation(): string {
  return `${SYNTHETIC_CONVERSATION_PREFIX}${randomUUID()}`;
}

function syntheticConversationParts(): {
  phoneNumberId: string;
  customerPhone: string;
  conversationKey: string;
} {
  // Keep this in the same shape as production's
  // `${phoneNumberId}:${canonicalCustomerPhone}` key.  The first component
  // deliberately has no colon: conversationAdvisoryKeyV2 parses that exact
  // boundary when it derives the shared advisory-lock key.
  const phoneNumberId = 'ia23pg';
  const customerPhone = `fixture-${randomUUID()}`;
  return {
    phoneNumberId,
    customerPhone,
    conversationKey: `${phoneNumberId}:${customerPhone}`,
  };
}

function syntheticTurn(): string {
  return `${SYNTHETIC_TURN_PREFIX}${randomUUID()}`;
}

function syntheticPlan(): string {
  return `${SYNTHETIC_PLAN_PREFIX}${randomUUID()}`;
}

function syntheticHash(): string {
  return `sha256:${randomUUID().replaceAll('-', '')}`;
}

function makeFlowState(flowId: string, withDeferred = true): Record<string, unknown> {
  return {
    flowId,
    ...(withDeferred
      ? {
          deferredAvailability: {
            schemaVersion: 1,
            capturedAt: '2026-08-23T12:00:00.000Z',
            capturedTurnId: `${SYNTHETIC_TURN_PREFIX}capture`,
            capturedInputSequence: 1,
            date: '2026-08-24',
            timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 1050 },
          },
        }
      : {}),
    fixedByProofVersion: {},
  };
}

function makeFrame(flowId: string, questionId: string, askedAt: Date, version = 1) {
  return {
    questionId,
    askedAt: askedAt.toISOString(),
    kind: 'SERVICE' as const,
    flowId,
    version,
    options: [],
  };
}

function makeReceipt(input: {
    deliveryAttemptId: string;
    turnId: string;
    planReceiptId: string;
    terminalAt: Date;
    outboxState?: 'accepted_by_provider' | 'accepted_uncommitted';
    transportOutcome?: 'accepted_by_provider' | 'accepted_uncommitted';
    pendingCommitOutcome?: 'opened' | 'not_applicable';
    flowStateCommitOutcome?: 'committed' | 'accepted_uncommitted';
    conversationCommitOutcome?: 'committed' | 'accepted_uncommitted';
  }) {
  return {
    schemaVersion: 2 as const,
    deliveryReceiptId: `${SYNTHETIC_TURN_PREFIX}delivery:${input.deliveryAttemptId}`,
    planReceiptId: input.planReceiptId,
    turnId: input.turnId,
    deliveryAttemptId: input.deliveryAttemptId,
    transportStartedAt: new Date(input.terminalAt.getTime() - 1000).toISOString(),
    transportOutcome: input.transportOutcome ?? ('accepted_by_provider' as const),
    providerMessageIdHash: syntheticHash(),
    outboxState: input.outboxState ?? ('accepted_by_provider' as const),
    flowStateCommitOutcome:
      input.flowStateCommitOutcome ?? ('committed' as const),
    conversationCommitOutcome:
      input.conversationCommitOutcome ?? ('committed' as const),
    pendingCommitOutcome: input.pendingCommitOutcome ?? ('opened' as const),
    expectedPendingVersion: null,
    observedPendingVersion: null,
    terminalAt: input.terminalAt.toISOString(),
  } satisfies ContractsModule['TurnDeliveryReceiptV2'];
}

function makePlanReceipt(
  turnId: string,
  planReceiptId: string
): ContractsModule['TurnPlanReceiptV2'] {
  return {
    schemaVersion: 2,
    planReceiptId,
    turnId,
    frameHash: syntheticHash(),
    inputSequence: 1,
    route: 'model',
    provider: 'deepseek',
    requestedModel: 'deepseek-v4-flash',
    response: { model: null, systemFingerprint: null },
    thinkingMode: 'disabled',
    strictTools: true,
    primaryModelRounds: 0,
    primaryProviderCalls: 0,
    regenProviderCalls: 0,
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'SERVICE',
      flowIdHash: syntheticHash(),
      optionCount: 0,
    },
    toolEffects: [],
    boundaryAttempts: [],
    recoveryKind: 'none',
    result: 'accepted_for_delivery',
  };
}

function advisoryKeyParts(key: string): [string, string] {
  const unsigned = BigInt.asUintN(64, BigInt(key));
  const high = ((unsigned >> 32n) & 0xffff_ffffn).toString();
  const low = (unsigned & 0xffff_ffffn).toString();
  return [high, low];
}

async function observeAdvisoryLock(
  db: Pool,
  key: string,
  granted: boolean
): Promise<boolean> {
  const [classId, objectId] = advisoryKeyParts(key);
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND granted = $3
         AND classid = $1::oid
         AND objid = $2::oid
     ) AS present`,
    [classId, objectId, granted]
  );
  return result.rows[0]?.present === true;
}

async function waitForAdvisoryWait(
  db: Pool,
  key: string,
  timeoutMs = 5_000
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ownerPresent = await observeAdvisoryLock(db, key, true);
    const waiterPresent = await observeAdvisoryLock(db, key, false);
    if (ownerPresent && waiterPresent) return true;
    // This is a database lock-observation barrier, not a fixed sleep.  The
    // loop advances only to let the PG clients progress to pg_locks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

async function insertPending(
  db: Pool,
  conversationKey: string,
  frame: ReturnType<typeof makeFrame>,
  flowState: Record<string, unknown>,
  updatedAt: Date
): Promise<void> {
  await db.query(
    `INSERT INTO ana_v2_pending_frames
       (conversation_key, flow_id, question_id, state, asked_at,
        pending_kind, options_json, version, flow_state_json, updated_at)
     VALUES ($1,$2,$3,'OPEN',$4,$5,$6::jsonb,$7,$8::jsonb,$9)`,
    [
      conversationKey,
      frame.flowId,
      frame.questionId,
      frame.askedAt,
      frame.kind,
      JSON.stringify(frame.options),
      frame.version,
      JSON.stringify(flowState),
      updatedAt,
    ]
  );
}

async function createPreparedStarted(
  store: StateStoreModule['pgConversationalV2StateStore'],
  state: StateStoreModule,
  contracts: ContractsModule,
  input: {
    conversationKey: string;
    flowId: string;
    questionId: string;
    createdAt: Date;
    transitionKind?: 'open';
  }
): Promise<{
  deliveryAttemptId: string;
  turnId: string;
  planReceiptId: string;
  receipt: ContractsModule['TurnDeliveryReceiptV2'];
  commitPayload: {
    assistantText: string;
    transition: MaterializedTransition;
    deliveryReceipt: ContractsModule['TurnDeliveryReceiptV2'];
  };
}> {
  const deliveryAttemptId = `${SYNTHETIC_TURN_PREFIX}attempt:${randomUUID()}`;
  const turnId = syntheticTurn();
  const planReceiptId = syntheticPlan();
  const frame = makeFrame(input.flowId, input.questionId, input.createdAt);
  const transition = {
    kind: input.transitionKind ?? ('open' as const),
    frame,
    expectedQuestionId: null,
    expectedVersion: null,
    nextFlowState: makeFlowState(input.flowId),
  };
  await store.savePlanReceipt(makePlanReceipt(turnId, planReceiptId));
  await store.prepareOutbound({
    deliveryAttemptId,
    conversationKey: input.conversationKey,
    turnId,
    planReceiptId,
    payload: 'fixture payload',
    transition,
    now: input.createdAt,
  });
  await store.markTransportStarted(deliveryAttemptId, input.createdAt);
  const receipt = makeReceipt({
    deliveryAttemptId,
    turnId,
    planReceiptId,
    terminalAt: nowAfter(input.createdAt, 1000),
  });
  return {
    deliveryAttemptId,
    turnId,
    planReceiptId,
    receipt,
    commitPayload: {
      assistantText: 'fixture payload',
      transition,
      deliveryReceipt: receipt,
    },
  };
}

async function cleanup(db: Pool): Promise<CleanupResult> {
  // No foreign-key assumptions are needed; delete dependent receipts first.
  // Every table is attempted even if another DELETE fails.  A missing
  // verification is never treated as an empty result.
  const statements: Array<[string, string, readonly unknown[]]> = [
    [
      'receipts',
      `DELETE FROM ana_v2_turn_receipts
       WHERE turn_id LIKE $1 OR receipt_id LIKE $2 OR receipt_id LIKE $3`,
      [`${SYNTHETIC_TURN_PREFIX}%`, `${SYNTHETIC_PLAN_PREFIX}%`, `${SYNTHETIC_TURN_PREFIX}%`],
    ],
    [
      'successors',
      `DELETE FROM ana_v2_successor_batches
       WHERE successor_turn_id LIKE $1 OR source_turn_id LIKE $2
          OR conversation_key LIKE $3`,
      [`${SYNTHETIC_TURN_PREFIX}%`, `${SYNTHETIC_TURN_PREFIX}%`, `${SYNTHETIC_CONVERSATION_PREFIX}%`],
    ],
    [
      'outbox',
      `DELETE FROM ana_v2_outbound_outbox
       WHERE delivery_attempt_id LIKE $1 OR conversation_key LIKE $2`,
      [`${SYNTHETIC_TURN_PREFIX}%`, `${SYNTHETIC_CONVERSATION_PREFIX}%`],
    ],
    [
      'pending',
      `DELETE FROM ana_v2_pending_frames
       WHERE conversation_key LIKE $1`,
      [`${SYNTHETIC_CONVERSATION_PREFIX}%`],
    ],
    [
      'invalidations',
      `DELETE FROM ana_v2_flow_state_invalidations
       WHERE conversation_key LIKE $1`,
      [`${SYNTHETIC_CONVERSATION_PREFIX}%`],
    ],
    [
      'history',
      `DELETE FROM ana_conversation_history
       WHERE "conversationKey" LIKE $1`,
      [`${SYNTHETIC_CONVERSATION_PREFIX}%`],
    ],
  ];
  const outcomes = await Promise.all(
    statements.map(async ([name, sql, params]) => {
      try {
        await db.query(sql, [...params]);
        return null;
      } catch (error) {
        return `${name}:${sanitizedErrorKind(error)}`;
      }
    })
  );
  return { failures: outcomes.filter((failure): failure is string => failure !== null) };
}

async function syntheticCounts(db: Pool): Promise<CountSnapshot> {
  const result: Record<string, number> = {};
  const queries: Record<string, string> = {
    pending: `SELECT count(*)::int AS count FROM ana_v2_pending_frames WHERE conversation_key LIKE $1`,
    outbox: `SELECT count(*)::int AS count FROM ana_v2_outbound_outbox WHERE conversation_key LIKE $1`,
    invalidations: `SELECT count(*)::int AS count FROM ana_v2_flow_state_invalidations WHERE conversation_key LIKE $1`,
    successors: `SELECT count(*)::int AS count FROM ana_v2_successor_batches WHERE conversation_key LIKE $1`,
    history: `SELECT count(*)::int AS count FROM ana_conversation_history WHERE "conversationKey" LIKE $1`,
    receipts: `SELECT count(*)::int AS count FROM ana_v2_turn_receipts WHERE turn_id LIKE $1`,
  };
  const outcomes = await Promise.all(
    Object.entries(queries).map(async ([name, sql]) => {
      const pattern = name === 'receipts' ? `${SYNTHETIC_TURN_PREFIX}%` : `${SYNTHETIC_CONVERSATION_PREFIX}%`;
      try {
        const queryResult = await db.query<{ count: number }>(sql, [pattern]);
        return { name, count: Number(queryResult.rows[0]?.count ?? 0), failure: null };
      } catch (error) {
        return { name, count: null, failure: `${name}:${sanitizedErrorKind(error)}` };
      }
    })
  );
  const failures = outcomes
    .filter((outcome): outcome is { name: string; count: null; failure: string } => outcome.failure !== null)
    .map((outcome) => outcome.failure);
  if (failures.length > 0) return { counts: null, verified: false, failures };
  for (const outcome of outcomes) result[outcome.name] = outcome.count as number;
  return { counts: result, verified: true, failures: [] };
}

async function runHumanTakeoverRace<T>(input: {
  db: Pool;
  store: StateStoreModule['pgConversationalV2StateStore'];
  state: StateStoreModule;
  order: OrderModule;
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  cutoffAt: Date;
  expectedInvalidatedCount: number;
  operation: () => Promise<T>;
}): Promise<{ result: T; events: string[] }> {
  const key = input.order.conversationAdvisoryLockKey(
    input.phoneNumberId,
    input.customerPhone
  );
  const events: string[] = [];
  let releaseA!: () => void;
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      releaseA();
    }
  };
  const aMayRelease = new Promise<void>((resolve) => { releaseA = resolve; });
  let resolveA!: () => void;
  let rejectA!: (reason?: unknown) => void;
  const aAcquiredPromise = new Promise<void>((resolve, reject) => {
    resolveA = resolve;
    rejectA = reject;
  });
  let aPromise: Promise<unknown> | null = null;
  let bPromise: Promise<T> | null = null;
  let bCompleted = false;
  try {
    aPromise = input.order.withConversationLock(
      input.phoneNumberId,
      input.customerPhone,
      async (client) => {
        try {
          events.push('A_LOCK_ACQUIRED');
          const count = await input.state.invalidateOpenPendingByHumanWithClient(
            client,
            input.conversationKey,
            input.cutoffAt
          );
          assert(
            count === input.expectedInvalidatedCount,
            'human owner não invalidou o número esperado de pending OPEN'
          );
          events.push('A_CUTOFF_WRITTEN');
          resolveA();
          await aMayRelease;
          events.push('A_RELEASED');
        } catch (error) {
          rejectA(error);
          throw error;
        }
      }
    );
    void aPromise.catch(rejectA);
    await aAcquiredPromise;
    assert(
      await observeAdvisoryLock(input.db, key, true),
      'PG não observou a session advisory lock A como concedida'
    );

    bPromise = (async () => {
      events.push('B_STARTED');
      const result = await input.operation();
      bCompleted = true;
      events.push('B_COMPLETED');
      return result;
    })();
    assert(
      await waitForAdvisoryWait(input.db, key),
      'PG não observou B aguardando a mesma advisory key de A'
    );
    assert(!bCompleted, 'B concluiu antes do unlock da autoridade humana A');
    releaseOnce();
    const [, result] = await Promise.all([aPromise, bPromise]);
    assert(
      events.indexOf('A_RELEASED') < events.indexOf('B_COMPLETED'),
      'B avançou antes de A liberar a advisory lock'
    );
    return { result, events };
  } catch (error) {
    // Never leave a real session lock held when a barrier/assertion fails.
    releaseOnce();
    const pending = [aPromise, bPromise].filter(
      (promise): promise is Promise<unknown> => promise !== null
    );
    await Promise.allSettled(pending);
    throw error;
  }
}

async function runFenceScenario(
  db: Pool,
  store: StateStoreModule['pgConversationalV2StateStore'],
  state: StateStoreModule,
  order: OrderModule,
  contracts: ContractsModule,
  directHost: string
): Promise<ScenarioResult> {
  const { conversationKey, phoneNumberId, customerPhone: phone } =
    syntheticConversationParts();
  const flowId = `ia23pg-flow:${randomUUID()}`;
  const questionId = `ia23pg-question:${randomUUID()}`;
  const initial = new Date();
  const frame = makeFrame(flowId, questionId, initial);
  await insertPending(db, conversationKey, frame, makeFlowState(flowId), initial);

  const key = order.conversationAdvisoryLockKey(phoneNumberId, phone);
  const events: string[] = [];
  let releaseA!: () => void;
  const aMayRelease = new Promise<void>((resolve) => { releaseA = resolve; });
  let aAcquired!: () => void;
  const aAcquiredPromise = new Promise<void>((resolve) => { aAcquired = resolve; });
  let bCompleted = false;
  let bStarted = false;

  const a = order.withConversationLock(
    phoneNumberId,
    phone,
    async (client) => {
      events.push('A_LOCK_ACQUIRED');
      aAcquired();
      const count = await state.invalidateOpenPendingByHumanWithClient(
        client,
        conversationKey,
        nowAfter(initial, 1000)
      );
      assert(count === 1, 'lock-owned CTE não invalidou pending OPEN');
      events.push('A_CTE_DONE');
      await aMayRelease;
      events.push('A_RELEASED');
      return key;
    }
  );
  await aAcquiredPromise;
  assert(
    await observeAdvisoryLock(db, key, true),
    'PG não observou a session advisory lock A como concedida'
  );

  const b = (async () => {
    bStarted = true;
    await store.recordFlowStateInvalidation({
      conversationKey,
      reason: 'EXPLICIT_CONVERSATION_RESET',
      now: nowAfter(initial, 2000),
    });
    bCompleted = true;
    events.push('B_COMPLETED');
  })();

  assert(bStarted, 'operação autônoma B não iniciou');
  assert(
    await waitForAdvisoryWait(db, key),
    'PG não observou B aguardando a mesma advisory key de A'
  );
  assert(!bCompleted, 'operação autônoma avançou antes do unlock A');
  releaseA();
  await Promise.all([a, b]);
  assert(events.indexOf('A_RELEASED') < events.indexOf('B_COMPLETED'), 'B avançou antes de A liberar');

  const afterLock = await store.loadLatestState(conversationKey, new Date());
  assert(afterLock.pending === null, 'pending invalidado reapareceu após fence');
  assert(afterLock.flowState === null, 'flow state anterior reapareceu após fence');

  // Recreate an OPEN row for the statement-level atomicity probe.  The query
  // below is the production CTE shape with only its cutoff CHECK value made
  // deliberately invalid.  PostgreSQL must roll back both data-modifying
  // CTE branches as one statement.
  const atomicConversation = syntheticConversation();
  const atomicFlow = `ia23pg-flow:${randomUUID()}`;
  const atomicQuestion = `ia23pg-question:${randomUUID()}`;
  const atomicNow = new Date();
  await insertPending(
    db,
    atomicConversation,
    makeFrame(atomicFlow, atomicQuestion, atomicNow),
    makeFlowState(atomicFlow),
    atomicNow
  );
  const atomicClient = await db.connect();
  let atomicFailed = false;
  try {
    await atomicClient.query(
      `WITH invalidated AS (
         UPDATE ana_v2_pending_frames
         SET state = 'INVALIDATED', version = version + 1, updated_at = $2
         WHERE conversation_key = $1 AND state = 'OPEN'
         RETURNING 1
       ), cutoff AS (
         INSERT INTO ana_v2_flow_state_invalidations
           (conversation_key, invalidated_at, reason)
         VALUES ($1, $2, 'IA23_INVALID_REASON')
         ON CONFLICT (conversation_key) DO UPDATE SET
           invalidated_at = GREATEST(
             ana_v2_flow_state_invalidations.invalidated_at,
             EXCLUDED.invalidated_at
           ),
           reason = CASE
             WHEN EXCLUDED.invalidated_at > ana_v2_flow_state_invalidations.invalidated_at
             THEN EXCLUDED.reason
             ELSE ana_v2_flow_state_invalidations.reason
           END
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM invalidated)::int AS invalidated_count,
              EXISTS (SELECT 1 FROM cutoff) AS cutoff_written`,
      [atomicConversation, atomicNow]
    );
  } catch {
    atomicFailed = true;
  } finally {
    atomicClient.release();
  }
  assert(atomicFailed, 'CTE de falha deliberada não falhou no PG real');
  const atomicState = await db.query<{ state: string }>(
    `SELECT state FROM ana_v2_pending_frames WHERE conversation_key = $1`,
    [atomicConversation]
  );
  const atomicCutoff = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ana_v2_flow_state_invalidations WHERE conversation_key = $1`,
    [atomicConversation]
  );
  assert(atomicState.rows[0]?.state === 'OPEN', 'UPDATE da CTE falha persistiu parcialmente');
  assert(Number(atomicCutoff.rows[0]?.count ?? 0) === 0, 'UPSERT do cutoff falha persistiu parcialmente');

  const zeroConversation = syntheticConversation();
  const zeroCount = await store.invalidateOpenPendingByHuman(zeroConversation, new Date());
  assert(zeroCount === 0, 'zero-pending não retornou invalidated_count=0');
  const zeroCutoff = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ana_v2_flow_state_invalidations WHERE conversation_key = $1`,
    [zeroConversation]
  );
  assert(Number(zeroCutoff.rows[0]?.count ?? 0) === 1, 'zero-pending não gravou cutoff');

  return {
    name: 'C1 fence PG + CTE atômica',
    endpoint: `direct DEV (${directHost})`,
    status: 'PASS',
    observed: 'session lock A, helper lock-owned, wrapper B aguardou; CTE falha sem mutação; zero-pending gravou cutoff',
    cleanup: 'rows sintéticas removidas no finally',
  };
}

async function runTakeoverScenario(
  db: Pool,
  store: StateStoreModule['pgConversationalV2StateStore'],
  state: StateStoreModule,
  order: OrderModule,
  contracts: ContractsModule,
  directHost: string
): Promise<ScenarioResult> {
  const base = new Date();
  const partsA = syntheticConversationParts();
  const conversationA = partsA.conversationKey;
  const flowA = `ia23pg-flow:${randomUUID()}`;
  const questionA = `ia23pg-question:${randomUUID()}`;
  await insertPending(db, conversationA, makeFrame(flowA, questionA, base), makeFlowState(flowA), base);
  const attemptA = await createPreparedStarted(store, state, contracts, {
    conversationKey: conversationA,
    flowId: flowA,
    questionId: questionA,
    createdAt: base,
  });
  const cutoffA = nowAfter(base, 2000);
  assert(
    Date.parse(attemptA.receipt.terminalAt) < cutoffA.getTime(),
    'ordem A precisa usar terminalAt factual anterior ao cutoff'
  );
  const raceA = await runHumanTakeoverRace({
    db,
    store,
    state,
    order,
    conversationKey: conversationA,
    phoneNumberId: partsA.phoneNumberId,
    customerPhone: partsA.customerPhone,
    cutoffAt: cutoffA,
    expectedInvalidatedCount: 1,
    operation: () => store.commitAccepted({
      deliveryAttemptId: attemptA.deliveryAttemptId,
      providerMessageIdHash: syntheticHash(),
      commitPayload: attemptA.commitPayload,
      now: nowAfter(cutoffA, 1000),
    }),
  });
  assert(
    raceA.result.flowStateCommitOutcome === 'skipped_human_cutoff',
    'ordem A concorrente não respeitou cutoff antes do commit'
  );
  const stateA = await store.loadLatestState(conversationA, nowAfter(cutoffA, 2000));
  assert(stateA.flowState === null && stateA.pending === null, 'ordem A ressuscitou estado anterior');

  const partsB = syntheticConversationParts();
  const conversationB = partsB.conversationKey;
  const flowB = `ia23pg-flow:${randomUUID()}`;
  const questionB = `ia23pg-question:${randomUUID()}`;
  await insertPending(db, conversationB, makeFrame(flowB, questionB, base), makeFlowState(flowB), base);
  const attemptB = await createPreparedStarted(store, state, contracts, {
    conversationKey: conversationB,
    flowId: flowB,
    questionId: questionB,
    createdAt: nowAfter(base, 10),
  });
  await store.markAcceptedUncommitted({
    deliveryAttemptId: attemptB.deliveryAttemptId,
    providerMessageIdHash: syntheticHash(),
    commitPayload: {
      ...attemptB.commitPayload,
      deliveryReceipt: {
        ...attemptB.receipt,
        outboxState: 'accepted_uncommitted',
        conversationCommitOutcome: 'accepted_uncommitted',
        flowStateCommitOutcome: 'accepted_uncommitted',
        pendingCommitOutcome: 'not_applicable',
      },
    },
    now: nowAfter(base, 20),
  });
  const cutoffB = nowAfter(base, 3000);
  const raceB = await runHumanTakeoverRace({
    db,
    store,
    state,
    order,
    conversationKey: conversationB,
    phoneNumberId: partsB.phoneNumberId,
    customerPhone: partsB.customerPhone,
    cutoffAt: cutoffB,
    expectedInvalidatedCount: 1,
    operation: () => store.reconcileAcceptedCommit(
      attemptB.deliveryAttemptId,
      nowAfter(cutoffB, 1000)
    ),
  });
  assert(
    raceB.result.flowStateCommitOutcome === 'skipped_human_cutoff',
    'ordem B concorrente não respeitou cutoff após acceptance'
  );
  const stateB = await store.loadLatestState(conversationB, nowAfter(cutoffB, 2000));
  assert(stateB.flowState === null && stateB.pending === null, 'ordem B ressuscitou estado anterior');

  // A strictly later accepted event must be able to start a fresh flow.
  const newFlow = `ia23pg-flow:${randomUUID()}`;
  const newQuestion = `ia23pg-question:${randomUUID()}`;
  const newAttempt = await createPreparedStarted(store, state, contracts, {
    conversationKey: conversationB,
    flowId: newFlow,
    questionId: newQuestion,
    createdAt: nowAfter(cutoffB, 100),
  });
  assert(
    Date.parse(newAttempt.receipt.terminalAt) > cutoffB.getTime(),
    'evento novo não tem terminalAt estritamente posterior ao cutoff'
  );
  const newReceipt = {
    ...newAttempt.commitPayload,
    deliveryReceipt: {
      ...newAttempt.commitPayload.deliveryReceipt,
      terminalAt: nowAfter(cutoffB, 2000).toISOString(),
    },
  };
  await store.commitAccepted({
    deliveryAttemptId: newAttempt.deliveryAttemptId,
    providerMessageIdHash: syntheticHash(),
    commitPayload: newReceipt,
    now: nowAfter(cutoffB, 3000),
  });
  const newState = await store.loadLatestState(conversationB, nowAfter(cutoffB, 4000));
  assert(newState.flowState?.flowId === newFlow, 'fluxo posterior ao takeover não nasceu');
  assert(newState.pending?.snapshot.questionId === newQuestion, 'pending novo posterior ao takeover não carregou');

  return {
    name: 'C2 takeover concorrente e fluxo novo',
    endpoint: `direct DEV (${directHost})`,
    status: 'PASS',
    observed: 'duas corridas PG reais (takeover→commit e takeover→reconcile) mostraram owner+waiter em pg_locks; ambas aguardaram unlock e fecharam skipped_human_cutoff; terminalAt posterior iniciou flow novo; provider-send-after-cutoff não foi simulado e permanece impedido pela delivery boundary/pausa',
    cleanup: 'rows sintéticas removidas no finally',
  };
}

async function runAcceptedUncommittedScenario(
  db: Pool,
  store: StateStoreModule['pgConversationalV2StateStore'],
  state: StateStoreModule,
  contracts: ContractsModule,
  directHost: string
): Promise<ScenarioResult> {
  const base = new Date();
  const conversation = syntheticConversation();
  const flowId = `ia23pg-flow:${randomUUID()}`;
  const questionId = `ia23pg-question:${randomUUID()}`;
  await insertPending(db, conversation, makeFrame(flowId, questionId, base), makeFlowState(flowId), base);
  const attempt = await createPreparedStarted(store, state, contracts, {
    conversationKey: conversation,
    flowId,
    questionId,
    createdAt: base,
  });
  const providerHash = syntheticHash();
  const acceptedReceipt = {
    ...attempt.receipt,
    outboxState: 'accepted_uncommitted' as const,
    conversationCommitOutcome: 'accepted_uncommitted' as const,
    flowStateCommitOutcome: 'accepted_uncommitted' as const,
    pendingCommitOutcome: 'not_applicable' as const,
  };
  await store.markAcceptedUncommitted({
    deliveryAttemptId: attempt.deliveryAttemptId,
    providerMessageIdHash: providerHash,
    commitPayload: {
      ...attempt.commitPayload,
      deliveryReceipt: acceptedReceipt,
    },
    now: nowAfter(base, 1000),
  });
  const before = await db.query<{
    state: string;
    provider_message_id_hash: string | null;
    transport_started_at: Date | string | null;
  }>(
    `SELECT state, provider_message_id_hash, transport_started_at
       FROM ana_v2_outbound_outbox WHERE delivery_attempt_id = $1`,
    [attempt.deliveryAttemptId]
  );
  assert(before.rows[0]?.state === 'accepted_uncommitted', 'accepted_uncommitted não persistiu no PG');
  const takeoverAt = nowAfter(base, 2000);
  await store.invalidateOpenPendingByHuman(conversation, takeoverAt);
  const firstReconcile = await store.reconcileAcceptedCommit(
    attempt.deliveryAttemptId,
    nowAfter(takeoverAt, 1000)
  );
  assert(firstReconcile.flowStateCommitOutcome === 'skipped_human_cutoff', 'reconcile ressuscitou flow antigo');
  const secondReconcile = await store.reconcileAcceptedCommit(
    attempt.deliveryAttemptId,
    nowAfter(takeoverAt, 2000)
  );
  assert(secondReconcile.flowStateCommitOutcome === 'skipped_human_cutoff', 'reconcile idempotente mudou outcome');
  const after = await db.query<{
    state: string;
    provider_message_id_hash: string | null;
    transport_started_at: Date | string | null;
    count: number;
  }>(
    `SELECT outbox.state, outbox.provider_message_id_hash,
            outbox.transport_started_at,
            (SELECT count(*)::int FROM ana_v2_outbound_outbox other
             WHERE other.conversation_key = outbox.conversation_key) AS count
       FROM ana_v2_outbound_outbox outbox
      WHERE outbox.delivery_attempt_id = $1`,
    [attempt.deliveryAttemptId]
  );
  assert(after.rows[0]?.state === 'accepted_by_provider', 'reconcile não fechou estado aceito');
  assert(after.rows[0]?.provider_message_id_hash === before.rows[0]?.provider_message_id_hash, 'reconcile alterou provider identity');
  assert(String(after.rows[0]?.transport_started_at) === String(before.rows[0]?.transport_started_at), 'reconcile alterou transport start');
  assert(Number(after.rows[0]?.count) === 1, 'reconcile criou segunda tentativa/outbox');
  const loaded = await store.loadLatestState(conversation, nowAfter(takeoverAt, 3000));
  assert(loaded.flowState === null && loaded.pending === null, 'estado antigo reapareceu após reconcile');

  return {
    name: 'C3 accepted_uncommitted → takeover → reconcile',
    endpoint: `direct DEV (${directHost})`,
    status: 'PASS',
    observed: 'acceptance local pendente foi cortada pelo cutoff; reconcile repetido estável, hash/transport intactos, uma tentativa',
    cleanup: 'rows sintéticas removidas no finally',
  };
}

async function main(): Promise<void> {
  if (!OPT_IN) die('IA-23 PG battery requires ANA_IA23_PG_DEV_TEST=1');
  if (!ENV_FILE) die('IA-23 PG battery requires ANA_IA23_PG_ENV_FILE pointing to the authorized DEV env file');

  const envText = readFileSync(ENV_FILE, 'utf8');
  const parsedEnv = parseDotenv(envText) as Record<string, string | undefined>;
  const configuredUrl = parsedEnv.DATABASE_URL?.trim();
  if (!configuredUrl) die('authorized env has no DATABASE_URL');
  const configuredHost = hostOf(configuredUrl);
  if (!DEV_HOST_RE.test(configuredHost) || PROD_HOST_RE.test(configuredHost)) {
    die('database host is not the authorized DEV Neon branch');
  }
  const directUrl = directUrlFromPooler(configuredUrl);
  const directHost = hostOf(directUrl);
  console.error(`IA23_ENDPOINT_CHECK configured=${configuredHost} direct=${directHost}`);
  if (directHost.includes('-pooler') || !DEV_HOST_RE.test(directHost) || PROD_HOST_RE.test(directHost)) {
    die('derived direct endpoint failed DEV/direct host validation');
  }

  const initialNodeEnv = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
  const isProd = initialNodeEnv === 'production';
  const isDev = initialNodeEnv === '' || initialNodeEnv === 'development' || initialNodeEnv === 'test';
  if (!isDev || isProd) die('IA-23 PG battery requires a non-production NODE_ENV');
  process.env.NODE_ENV = 'development';

  // The URL exists only in process memory.  All actual runtime PG pools are
  // therefore direct for this battery, including the state store and order
  // lock pool.  Do not print or persist these values.
  process.env.DATABASE_URL = directUrl;
  process.env.RECEPS_IA_DIRECT_DATABASE_URL = directUrl;
  process.env.ANA_DIRECT_DATABASE_URL = '';
  process.env.NODE_ENV ??= 'test';

  const db = new Pool({
    connectionString: directUrl,
    max: 8,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: 'receps-ia-ia23-pg-battery',
  });
  db.on('error', () => { /* test process owns cleanup; no sensitive output */ });
  const results: ScenarioResult[] = [];
  let state: StateStoreModule;
  let order: OrderModule | null = null;
  let contracts: ContractsModule;
  let runtimePool: Pool | null = null;
  let beforeCounts: CountSnapshot = {
    counts: null,
    verified: false,
    failures: ['not_attempted'],
  };
  try {
    try {
      beforeCounts = await syntheticCounts(db);
    } catch (error) {
      beforeCounts = {
        counts: null,
        verified: false,
        failures: [`before-count:${sanitizedErrorKind(error)}`],
      };
    }
    const identity = await db.query<{ current_database: string; current_user: string }>(
      'SELECT current_database(), current_user'
    );
    assert(identity.rows.length === 1, 'PG identity query returned no row');
    state = await import('../src/services/conversationalV2/stateStore');
    const orderModule = await import('../src/services/conversationOrder');
    order = orderModule;
    contracts = await import('../src/services/conversationalV2/contracts');
    const isProdBeforeWrite = process.env.NODE_ENV === 'production';
    const isDevBeforeWrite = process.env.NODE_ENV === 'development';
    assert(isDevBeforeWrite && !isProdBeforeWrite, 'DEV write gate failed before PG setup');
    await state.ensureConversationalV2Tables();
    // The context manager pool is the real runtime pool configured above.
    runtimePool = (await import('../src/services/contextManager')).pool;

    results.push(await runFenceScenario(db, state.pgConversationalV2StateStore, state, orderModule, contracts, directHost));
    results.push(await runTakeoverScenario(db, state.pgConversationalV2StateStore, state, orderModule, contracts, directHost));
    results.push(await runAcceptedUncommittedScenario(db, state.pgConversationalV2StateStore, state, contracts, directHost));
  } finally {
    // Cleanup must happen even if an assertion or a PG error aborts a scenario.
    // Every DELETE and every count is attempted, but an error is never
    // converted into an empty manifest or a PASS.
    let cleanupError: string | null = null;
    let cleanupResult: CleanupResult;
    try {
      cleanupResult = await cleanup(db);
    } catch (error) {
      cleanupError = sanitizedErrorKind(error);
      cleanupResult = { failures: [`cleanup:${cleanupError}`] };
    }
    let afterCounts: CountSnapshot;
    let afterCountError: string | null = null;
    try {
      afterCounts = await syntheticCounts(db);
    } catch (error) {
      afterCountError = sanitizedErrorKind(error);
      afterCounts = {
        counts: null,
        verified: false,
        failures: [`after-count:${afterCountError}`],
      };
    }
    const beforeManifest = beforeCounts.verified && beforeCounts.counts
      ? JSON.stringify(beforeCounts.counts)
      : 'NOT_VERIFIED';
    const afterManifest = afterCounts.verified && afterCounts.counts
      ? JSON.stringify(afterCounts.counts)
      : 'NOT_VERIFIED';
    const nonZeroAfterCount = afterCounts.verified && afterCounts.counts
      ? Object.values(afterCounts.counts).some((count) => count !== 0)
      : false;
    const verificationFailed = !beforeCounts.verified || !afterCounts.verified;
    const cleanupFailed =
      cleanupResult.failures.length > 0 || verificationFailed || nonZeroAfterCount;
    const cleanupStatus = cleanupResult.failures.length > 0
      ? 'FAIL — delete errors; row verification is not sufficient'
      : !afterCounts.verified
        ? 'FAIL — after cleanup row verification NOT_VERIFIED'
        : verificationFailed
          ? 'FAIL — before cleanup manifest NOT_VERIFIED'
          : nonZeroAfterCount
            ? 'FAIL — verified synthetic residue detected'
            : 'PASS — zero synthetic rows verified';
    const localValidationSummary = process.env.ANA_IA23_PG_VALIDATIONS?.trim();
    const reportPath = '/private/tmp/claude-501/-Users-niexfs-dev-Receps-ERP/6b92ee4e-5418-4be9-a93c-c518e7e452f6/scratchpad/exec-ia23-pg-battery.md';
    const lines = [
      '# Exec IA-23 — Bateria PG real',
      '',
      `status: ${results.length === 3 && results.every((result) => result.status === 'PASS') && !cleanupFailed ? 'PASS' : 'FAIL'}`,
      `baseline: HEAD ${currentGitHead()}; worktree preservada; divergência registrada: não havia .env na worktree nem DATABASE_URL no /Users/niexfs/dev/Receps-IA/.env; fonte autorizada pelo primário foi /Users/niexfs/dev/Receps ERP/.env carregada apenas em memória`,
      `host_configured_sanitized: ${hostOf(configuredUrl)} (DEV/pooler)`,
      `host_direct_sanitized: ${directHost} (DEV/direct; pooler removido em memória)`,
      'database_identity: consulta PG direta bem-sucedida; nenhuma credencial/ID/PII reportado',
      '',
      '## Cenários',
      ...results.flatMap((result) => [
        `- ${result.name}: ${result.status}`,
        `  endpoint: ${result.endpoint}`,
        `  observado: ${result.observed}`,
        `  cleanup: ${result.cleanup}`,
      ]),
      ...(results.length < 3 ? ['- Cenários não executados após falha anterior: NÃO VERIFICÁVEL; bateria FAIL.'] : []),
      '',
      `manifest_before_prefix_counts: ${beforeManifest}`,
      `manifest_before_prefix_verification: ${beforeCounts.verified ? 'VERIFIED' : 'NOT_VERIFIED'}`,
      ...(beforeCounts.failures.length > 0
        ? [`manifest_before_prefix_failures: ${JSON.stringify(beforeCounts.failures)}`]
        : []),
      `manifest_after_prefix_counts: ${afterManifest}`,
      `manifest_after_prefix_verification: ${afterCounts.verified ? 'VERIFIED' : 'NOT_VERIFIED'}`,
      ...(afterCounts.failures.length > 0
        ? [`manifest_after_prefix_failures: ${JSON.stringify(afterCounts.failures)}`]
        : []),
      `cleanup: ${cleanupStatus}`,
      `cleanup_delete_failures: ${cleanupResult.failures.length > 0 ? JSON.stringify(cleanupResult.failures) : 'none'}`,
      `cleanup_error: ${cleanupError ?? 'none'}`,
      `after_count_error: ${afterCountError ?? 'none'}`,
      '',
      '## Validações PG da bateria',
      '- endpoint direto usado para state store, order/session locks e Pool de observação; endpoint pooler não foi usado para os testes',
      '- C1: session advisory lock real + CTE UPDATE/UPSERT real + rollback de erro CHECK real + zero-pending real',
      '- C2: commit/cutoff/load PG real nas duas ordens + novo evento posterior ao cutoff',
      '- C3: accepted_uncommitted/reconcile PG real, idempotência e uma tentativa persistida',
      ...(localValidationSummary
        ? [
            '',
            '## Validações locais e exits',
            ...localValidationSummary
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => `- ${line}`),
          ]
        : []),
      '',
      '## Riscos/limites',
      '- Não houve provider/WhatsApp/HTTP real; a prova é exclusivamente do estado PG e do código de persistência/reconciliação.',
      '- A escrita foi limitada a fixtures sintéticas com prefixo ia23pg e removida no finally.',
    ];
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(reportPath.slice(0, reportPath.lastIndexOf('/')), { recursive: true });
      writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
    } catch {
      // Keep the process result authoritative even if the scratchpad path is unavailable.
    }
    if (cleanupFailed) process.exitCode = 1;
    if (runtimePool) await runtimePool.end().catch(() => undefined);
    if (order) await order.closeConversationOrderPoolForSmoke().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
  if (results.length !== 3 || results.some((result) => result.status !== 'PASS')) {
    process.exitCode = 1;
  }
  console.log(JSON.stringify({
    status: process.exitCode === 1 ? 'FAIL' : 'PASS',
    endpoint: 'direct DEV',
    scenarios: results.map(({ name, status }) => ({ name, status })),
    cleanup: 'reported in scratchpad',
  }));
}

main().catch((error) => {
  console.error(`IA-23 PG battery failed | error_kind=${sanitizedErrorKind(error)}`);
  process.exitCode = 1;
});
