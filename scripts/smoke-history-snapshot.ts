import assert from 'node:assert/strict';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';

async function main() {
  const context = await import('../src/services/contextManager');
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const rows = [
    { id: 10, role: 'assistant', content: 'contexto anterior', message_id: null },
    { id: 20, role: 'user', content: 'mensagem do flush atual', message_id: 'm-current' },
    { id: 30, role: 'user', content: 'mensagem que chegou durante o brain', message_id: 'm-pending' },
  ];
  const deps: import('../src/services/contextManager').HistoryReadDeps = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      if (sql.includes('max("id")')) {
        const ids = params[1] as string[];
        const matching = rows.filter((row) => row.message_id && ids.includes(row.message_id));
        const max = matching.reduce((value, row) => Math.max(value, row.id), 0);
        return {
          rows: [
            {
              max_id: max ? String(max) : null,
              found_ids: matching.map((row) => row.message_id),
            } as T,
          ],
        };
      }
      const upperBound = params[2] == null ? Number.POSITIVE_INFINITY : Number(params[2]);
      return {
        rows: rows
          .filter((row) => row.id <= upperBound)
          .map(({ role, content, message_id }) => ({ role, content, message_id }) as T),
      };
    },
  };

  const history = await context.withPersistedInboundContext(
    ['m-current'],
    () => context.getHistory('PN:5511999990000', deps)
  );
  assert.deepEqual(history, [
    { role: 'assistant', content: 'contexto anterior' },
    { role: 'user', content: 'mensagem do flush atual' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.params[2], '20');
  assert.match(calls[1]?.sql ?? '', /"id" <= \$3::bigint/);

  calls.length = 0;
  const unbounded = await context.getHistory('PN:5511999990000', deps);
  assert.equal(
    unbounded.at(-1)?.content,
    'mensagem do flush atual mensagem que chegou durante o brain'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params[2], null);

  await assert.rejects(
    () =>
      context.withPersistedInboundContext(['m-missing'], () =>
        context.getHistory('PN:5511999990000', deps)
      ),
    /snapshot do histórico/
  );

  await assert.rejects(
    () =>
      context.withPersistedInboundContext(['m-missing', 'm-current'], () =>
        context.getHistory('PN:5511999990000', deps)
      ),
    /incompleto.*snapshot do histórico/
  );

  assert.equal(
    context.buildConversationKey(' PN ', '+55 (11) 99999-0000'),
    'PN:5511999990000'
  );
  console.log('smoke history snapshot: OK');
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
