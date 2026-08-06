process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ANA_DIRECT_DATABASE_URL ??=
  'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function buildClient(calls: QueryCall[], fail = false) {
  return {
    released: false,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (fail && sql.includes('UPDATE inbound_event_outbox')) {
        throw new Error('PII-SECRETA-5511999999999');
      }
      const counts: Array<[RegExp, number]> = [
        [/UPDATE inbound_event_outbox/, 1],
        [/DELETE FROM ana_conversation_history/, 2],
        [/DELETE FROM inbound_event_outbox/, 1],
        [/DELETE FROM sent_question_replies/, 3],
        [/DELETE FROM processed_messages/, 4],
        [/DELETE FROM ana_conversation_seq/, 5],
      ];
      return {
        rowCount: counts.find(([pattern]) => pattern.test(sql))?.[1] ?? null,
        rows: [],
      };
    },
    release() {
      this.released = true;
    },
  };
}

async function main(): Promise<void> {
  const retention = await import('../src/services/anaRetention');
  retention.__resetAnaRetentionRuntimeForTest();

  const calls: QueryCall[] = [];
  const client = buildClient(calls);
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const result = await retention.runAnaRetention({
    connect: async () => client as never,
    now: () => now,
  });
  const sql = calls.map((entry) => entry.sql).join('\n');
  const historySql = calls.find((entry) =>
    entry.sql.includes('DELETE FROM ana_conversation_history')
  )?.sql ?? '';
  const processedSql = calls.find((entry) =>
    entry.sql.includes('DELETE FROM processed_messages')
  )?.sql ?? '';
  const seqSql = calls.find((entry) =>
    entry.sql.includes('DELETE FROM ana_conversation_seq')
  )?.sql ?? '';

  check(
    '<30 mensagens todas >90d são apagáveis sem depender de LIMIT/count',
    historySql.includes('h."createdAt" < $1') && !historySql.includes('LIMIT 30')
  );
  check(
    'history recente é preservada pelo cutoff estrito',
    historySql.includes('< $1') && !historySql.includes('<= now()')
  );
  check(
    'mistura antiga/recente é decidida por linha',
    historySql.includes('h."createdAt" < $1')
  );
  check(
    'pending >90d terminaliza antes do purge e não deixa history ligado ao outbox',
    calls.findIndex((entry) => entry.sql.includes('UPDATE inbound_event_outbox')) <
      calls.findIndex((entry) => entry.sql.includes('DELETE FROM ana_conversation_history')) &&
      historySql.includes('expired.message_id = h.message_id') &&
      sql.includes("failure_code = 'RETENTION_EXPIRED'")
  );
  check(
    'processed antigo é removido em cada execução, sem depender de restart',
    processedSql.includes('p.processed_at < $1') &&
      processedSql.includes('h."createdAt" < $1') &&
      processedSql.includes('o.received_at < $1')
  );
  check(
    'replies antigas entram no mesmo cutoff/transação',
    sql.includes('DELETE FROM sent_question_replies') &&
      result.sentQuestionReplies === 3
  );
  check(
    'seq órfã é removida',
    seqSql.includes('DELETE FROM ana_conversation_seq')
  );
  check(
    'seq referenciada por history/outbox/reply é preservada',
    (seqSql.match(/NOT EXISTS/g) ?? []).length === 3 &&
      seqSql.includes('sent_question_replies')
  );
  check(
    'cutoff é calculado uma vez e reutilizado em todas as queries temporais',
    result.cutoff ===
      new Date(now - retention.ANA_RETENTION_WINDOW_MS).toISOString() &&
      calls
        .filter((entry) => entry.params?.length)
        .every((entry) => entry.params?.[0] instanceof Date)
  );
  check(
    'operação é bulk fixa, sem query por item',
    calls.length === 8 &&
      calls[0]?.sql === 'BEGIN' &&
      calls.at(-1)?.sql === 'COMMIT'
  );

  const schedulerFirst = retention.startAnaRetentionScheduler(
    { connect: async () => buildClient([]) as never, now: () => now },
    60_000
  );
  const schedulerSecond = retention.startAnaRetentionScheduler(
    { connect: async () => buildClient([]) as never, now: () => now },
    60_000
  );
  check(
    'scheduler globalThis não duplica timer',
    schedulerFirst && !schedulerSecond
  );
  retention.__resetAnaRetentionRuntimeForTest();

  let connects = 0;
  const concurrentCalls: QueryCall[] = [];
  const concurrentClient = buildClient(concurrentCalls);
  const deps = {
    connect: async () => {
      connects += 1;
      return concurrentClient as never;
    },
    now: () => now,
  };
  const first = retention.runAnaRetention(deps);
  const second = retention.runAnaRetention(deps);
  check('concorrência coalesce na mesma operação', first === second);
  await Promise.all([first, second]);
  check('concorrência usa uma conexão/transação', connects === 1);

  retention.__resetAnaRetentionRuntimeForTest();
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  try {
    await retention
      .runAnaRetention({
        connect: async () => buildClient([], true) as never,
        now: () => now,
      })
      .catch(() => undefined);
  } finally {
    console.error = originalError;
  }
  const state = retention.getAnaRetentionState();
  check(
    'estado/alerta de erro expõem só classe sanitizada, zero PII',
    state.lastError === 'Error' &&
      !JSON.stringify(state).includes('5511999999999') &&
      !captured.join('\n').includes('5511999999999')
  );

  retention.__resetAnaRetentionRuntimeForTest();
  await import('../src/services/conversationOrder').then((order) =>
    order.closeConversationOrderPoolForSmoke()
  );
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : typeof error);
  process.exitCode = 1;
});
