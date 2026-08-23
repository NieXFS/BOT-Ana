import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { handleSmbMessageEchoes } from '../src/echoHandler';
import {
  invalidateOpenPendingByHumanWithClient,
  withConversationalV2TransactionLock,
} from '../src/services/conversationalV2/stateStore';
import { sendQuestionReply } from '../src/services/questionReplyService';

type QueryResult = { rowCount: number; rows: unknown[] };

/** Two-session test double: advisory acquisition blocks while session A owns it. */
class TwoSessionLockDouble {
  sessionOwner: string | null = null;
  transactionOwner: string | null = null;
  advisoryAttempts = 0;
  atomicQueryCount = 0;
  failNextAtomicQuery = false;
  readonly pendingRows = new Map<string, { state: 'OPEN' | 'INVALIDATED'; version: number }>();
  readonly cutoffs = new Map<string, Date>();
  private waiters: Array<() => void> = [];

  async acquireSession(name: string): Promise<void> {
    if (this.sessionOwner) throw new Error(`session lock already owned by ${this.sessionOwner}`);
    this.sessionOwner = name;
  }

  releaseSession(name: string): void {
    assert.equal(this.sessionOwner, name);
    this.sessionOwner = null;
    this.releaseWaiter();
  }

  async acquireTransaction(name: string): Promise<void> {
    if (!this.sessionOwner && !this.transactionOwner) {
      this.transactionOwner = name;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.acquireTransaction(name);
  }

  releaseTransaction(name: string): void {
    assert.equal(this.transactionOwner, name);
    this.transactionOwner = null;
    this.releaseWaiter();
  }

  private releaseWaiter(): void {
    this.waiters.shift()?.();
  }
}

class FakeClient {
  readonly queries: string[] = [];
  constructor(
    readonly name: string,
    private readonly locks: TwoSessionLockDouble
  ) {}

  async query(sql: string, args: unknown[] = []): Promise<QueryResult> {
    this.queries.push(sql);
    if (sql.includes('WITH invalidated AS') && sql.includes('cutoff AS')) {
      this.locks.atomicQueryCount += 1;
      if (this.locks.failNextAtomicQuery) {
        this.locks.failNextAtomicQuery = false;
        throw new Error('atomic invalidation fixture failure');
      }
      const conversationKey = String(args[0]);
      const now = args[1] instanceof Date ? args[1] : new Date(String(args[1]));
      const pending = this.locks.pendingRows.get(conversationKey);
      let invalidatedCount = 0;
      if (pending?.state === 'OPEN') {
        pending.state = 'INVALIDATED';
        pending.version += 1;
        invalidatedCount = 1;
      }
      this.locks.cutoffs.set(conversationKey, now);
      return {
        rowCount: 1,
        rows: [{ invalidated_count: invalidatedCount, cutoff_written: true }],
      };
    }
    if (sql === 'SELECT pg_advisory_xact_lock($1::bigint)') {
      this.locks.advisoryAttempts += 1;
      await this.locks.acquireTransaction(this.name);
    } else if (sql === 'COMMIT') {
      if (this.locks.transactionOwner === this.name) {
        this.locks.releaseTransaction(this.name);
      }
    } else if (sql === 'ROLLBACK') {
      if (this.locks.transactionOwner === this.name) {
        this.locks.releaseTransaction(this.name);
      }
    }
    return { rowCount: 0, rows: [] };
  }

  release(): void {
    // The double deliberately releases the session/transaction through the
    // owning helper; this mirrors pg PoolClient lifetime without a database.
  }
}

function asPoolClient(client: FakeClient): PoolClient {
  return client as unknown as PoolClient;
}

async function withSession<T>(
  locks: TwoSessionLockDouble,
  name: string,
  work: (client: FakeClient) => Promise<T>
): Promise<T> {
  const client = new FakeClient(name, locks);
  await locks.acquireSession(name);
  try {
    return await work(client);
  } finally {
    locks.releaseSession(name);
  }
}

async function main(): Promise<void> {
  const locks = new TwoSessionLockDouble();
  const conversationKey = 'PN-IA23B:5511999990001';
  const now = new Date('2026-08-23T18:00:00.000Z');

  // Echo path: it owns session A and passes A's client into the lock-owned
  // invalidation. No nested advisory acquisition is permitted.
  let echoInvalidationClient: FakeClient | null = null;
  const echoValue = {
    metadata: { phone_number_id: 'PN-IA23B' },
    message_echoes: [
      {
        id: 'echo-ia23b-1',
        from: 'clinic',
        to: '5511999990001',
        type: 'text',
        text: { body: 'Atendimento humano' },
      },
    ],
  };
  await handleSmbMessageEchoes(echoValue, undefined, {
    pauseConversation: async () => undefined,
    markEchoProcessed: async () => true,
    unmarkEcho: async () => undefined,
    persistEchoAtomically: async () => true,
    recordMessage: async () => undefined,
    loadConfig: async () => ({ botRole: 'receptionist' } as any),
    withConversationLock: async (_phone, _customer, work) =>
      withSession(locks, 'A', async (client) => work(client)),
    invalidatePendingByHuman: async (_phone, _customer, client) => {
      assert.ok(client, 'echo invalidation received the lock-owned client A');
      echoInvalidationClient = client as FakeClient;
      await invalidateOpenPendingByHumanWithClient(client!, conversationKey, now);
    },
    releaseSilentHold: async () => undefined,
  });
  assert.ok(echoInvalidationClient);
  assert.equal(locks.advisoryAttempts, 0, 'echo under A never attempts lock B');
  assert.equal(
    echoInvalidationClient!.queries.filter((query) => query.includes('WITH invalidated AS')).length,
    1,
    'echo invalidation uses one CTE query'
  );
  assert.equal(echoInvalidationClient!.queries.some((query) => /BEGIN|COMMIT|pg_advisory/u.test(query)), false);

  // Questions panel path: sendQuestionReply already owns A; its invalidation
  // callback must use that exact client instead of opening state-store B.
  let panelInvalidationClient: FakeClient | null = null;
  let panelRow: any = null;
  const panelStore: any = {
    async reserve(input: any) {
      panelRow = {
        ...input,
        status: 'in_flight',
        providerMessageId: null,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
        humanHistoryPayload: null,
        humanHistoryAcceptedAt: null,
        humanHistoryRecordedAt: null,
        providerStatus: null,
        providerStatusAt: null,
        providerFailureCode: null,
        callbackPending: false,
      };
      return { inserted: true, row: panelRow };
    },
    async update(_key: string, status: string, providerMessageId: string | null, failureCode: string | null) {
      panelRow = { ...panelRow, status, providerMessageId, failureCode };
      return panelRow;
    },
    async get() { return panelRow; },
  };
  const panelResult = await sendQuestionReply(
    {
      phoneNumberId: 'PN-IA23B',
      customerPhone: '5511999990001',
      idempotencyKey: 'question-ia23b-1',
      text: 'A equipe confirmou o atendimento.',
      sourceInboundMessageId: 'inbound-ia23b-1',
      evidence: {
        teamReplyAuthorization: {
          authoredAt: now.toISOString(),
          authoredBy: 'fixture',
          questionId: 'question-ia23b',
          clinicalCapability: true,
        },
      },
    } as any,
    {} as any,
    {
      store: panelStore,
      now: () => now.getTime(),
      withLock: async (_phone, _customer, work) =>
        withSession(locks, 'A', async (client) => work(asPoolClient(client))),
      getLatestSource: async () => 'inbound-ia23b-1',
      getLastInboundAtMs: async () => now.getTime() - 1_000,
      projectHumanHistory: async () => 'recorded',
      withdrawHumanHistory: async () => undefined,
      sendReceipt: async () => ({ providerMessageId: 'provider-ia23b-1' }),
      invalidateConversationalFlowStateByHuman: async (_phone, _customer, _at, client) => {
        assert.ok(client, 'panel invalidation received the lock-owned client A');
        panelInvalidationClient = client as unknown as FakeClient;
        return invalidateOpenPendingByHumanWithClient(client!, conversationKey, now);
      },
    },
  );
  assert.equal(panelResult.kind, 'sent');
  assert.ok(panelInvalidationClient);
  assert.equal(locks.advisoryAttempts, 0, 'panel under A never attempts lock B');
  assert.equal(
    panelInvalidationClient!.queries.filter((query) => query.includes('WITH invalidated AS')).length,
    1,
    'panel invalidation uses one CTE query'
  );

  // IA-23c atomicity fixture: the double applies pending+cutoff only after
  // accepting the one CTE query, and injects failure before either mutation.
  const atomicKey = 'PN-IA23B:atomic';
  await withSession(locks, 'A', async (client) => {
    const zeroCount = await invalidateOpenPendingByHumanWithClient(
      asPoolClient(client),
      atomicKey,
      now
    );
    assert.equal(zeroCount, 0, 'zero OPEN rows still write cutoff');
  });
  assert.equal(locks.cutoffs.has(atomicKey), true);
  locks.pendingRows.set(atomicKey, { state: 'OPEN', version: 7 });
  await withSession(locks, 'A', async (client) => {
    const oneCount = await invalidateOpenPendingByHumanWithClient(
      asPoolClient(client),
      atomicKey,
      new Date(now.getTime() + 1_000)
    );
    assert.equal(oneCount, 1, 'OPEN row is invalidated by the same statement');
  });
  assert.deepEqual(locks.pendingRows.get(atomicKey), { state: 'INVALIDATED', version: 8 });
  assert.equal(locks.cutoffs.get(atomicKey)?.toISOString(), '2026-08-23T18:00:01.000Z');
  locks.pendingRows.set(atomicKey, { state: 'OPEN', version: 11 });
  const beforePending = { ...locks.pendingRows.get(atomicKey)! };
  const beforeCutoff = locks.cutoffs.get(atomicKey)?.toISOString();
  locks.failNextAtomicQuery = true;
  await assert.rejects(
    withSession(locks, 'A', async (client) =>
      invalidateOpenPendingByHumanWithClient(
        asPoolClient(client),
        atomicKey,
        new Date(now.getTime() + 2_000)
      )
    ),
    /atomic invalidation fixture failure/u
  );
  assert.deepEqual(locks.pendingRows.get(atomicKey), beforePending, 'failed statement leaves pending unchanged');
  assert.equal(locks.cutoffs.get(atomicKey)?.toISOString(), beforeCutoff, 'failed statement leaves cutoff unchanged');

  // Autonomous state-store work owns B exactly once. While A is held it must
  // wait; after A releases, B advances without a timeout/deadlock.
  await locks.acquireSession('A');
  let autonomousFinished = false;
  const autonomous = withConversationalV2TransactionLock(
    conversationKey,
    async (client) => {
      autonomousFinished = true;
      await invalidateOpenPendingByHumanWithClient(client, conversationKey, now);
      return 'committed';
    },
    { connect: async () => asPoolClient(new FakeClient('B', locks)) }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(autonomousFinished, false, 'B waits while session A owns the lock');
  assert.equal(locks.advisoryAttempts, 1, 'autonomous path attempts exactly one lock');
  locks.releaseSession('A');
  assert.equal(await autonomous, 'committed');
  assert.equal(autonomousFinished, true);

  console.log('smoke-ana-conversational-v2-ia23b: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
