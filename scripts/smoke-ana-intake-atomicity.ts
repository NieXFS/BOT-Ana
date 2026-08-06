import 'dotenv/config';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main(): Promise<void> {
  if (!process.env.ANA_DIRECT_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('ANA_DIRECT_DATABASE_URL e DATABASE_URL ausentes no .env local');
  }
  const order = await import('../src/services/conversationOrder');
  process.env.DATABASE_URL = order.resolveConversationOrderDatabaseUrl();
  process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
  const processed = await import('../src/services/processedMessages');
  const store = await import('../src/services/anaWave2Store');
  const privacy = await import('../src/services/privacyPurge');
  const { pool } = await import('../src/services/contextManager');

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phoneNumberId = `smoke-intake-${suffix}`;
  const customerPhone = '5511000000000';
  const messageId = `wamid-smoke-intake-${suffix}`;

  try {
    await processed.ensureProcessedMessagesTable();
    await store.ensureAnaWave2Tables();
    const input = {
      messageId,
      phoneNumberId,
      customerPhone,
      content: 'fixture sem PII',
      messageType: 'text' as const,
      contentStatus: 'final' as const,
      receivedAt: new Date(),
    };
    const first = await store.persistInboundAtomically(input);
    const replay = await store.persistInboundAtomically(input);
    check('primeiro intake grava e replay vira noop', first.fresh && !replay.fresh);

    const [processedCount, historyCount, outboxCount, sequence] = await Promise.all([
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM processed_messages WHERE message_id = $1',
        [messageId]
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ana_conversation_history WHERE message_id = $1',
        [messageId]
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM inbound_event_outbox WHERE message_id = $1',
        [messageId]
      ),
      pool.query<{ last_sequence: string; last_inbound_message_id: string }>(
        `SELECT last_sequence::text, last_inbound_message_id
         FROM ana_conversation_seq WHERE conversation_key = $1`,
        [first.conversationKey]
      ),
    ]);

    check(
      'processed/history/outbox têm exatamente uma linha',
      processedCount.rows[0]?.count === '1' &&
        historyCount.rows[0]?.count === '1' &&
        outboxCount.rows[0]?.count === '1'
    );
    check(
      'replay não incrementa sequência nem troca última inbound',
      sequence.rows[0]?.last_sequence === '1' &&
        sequence.rows[0]?.last_inbound_message_id === messageId
    );
  } finally {
    await privacy.purgeConversationData(phoneNumberId, customerPhone).catch(
      () => undefined
    );
    await Promise.all([pool.end(), order.closeConversationOrderPoolForSmoke()]);
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
