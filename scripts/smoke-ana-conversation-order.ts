import 'dotenv/config';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  if (!process.env.ANA_DIRECT_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('ANA_DIRECT_DATABASE_URL e DATABASE_URL ausentes no .env local');
  }
  const order = await import('../src/services/conversationOrder');
  process.env.DATABASE_URL = order.resolveConversationOrderDatabaseUrl();
  process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
  const schema = await import('../src/services/anaWave2Store');
  const { pool } = await import('../src/services/contextManager');
  await import('../src/services/processedMessages').then((module) =>
    module.ensureProcessedMessagesTable()
  );
  await schema.ensureAnaWave2Tables();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phoneNumberId = `smoke-order-${suffix}`;
  const customerPhone = '5511000000000';
  const conversationKey = order.canonicalConversationKey(
    phoneNumberId,
    customerPhone
  );
  const oldSource = `wamid-old-${suffix}`;
  const newSource = `wamid-new-${suffix}`;

  const seed = async (source: string) => {
    await pool.query(
      `INSERT INTO ana_conversation_seq (
         conversation_key, last_sequence, last_inbound_message_id,
         last_inbound_at, updated_at
       ) VALUES ($1, 1, $2, now(), now())
       ON CONFLICT (conversation_key) DO UPDATE SET
         last_sequence = 1,
         last_inbound_message_id = EXCLUDED.last_inbound_message_id,
         last_inbound_at = now(),
         updated_at = now()`,
      [conversationKey, source]
    );
  };

  try {
    // Corrida A: a inbound segura a lock, atualiza source e só então libera.
    await seed(oldSource);
    const inboundUpdated = deferred();
    const releaseInbound = deferred();
    let sendFinished = false;
    const inboundWorker = order.withConversationLock(
      phoneNumberId,
      customerPhone,
      async (client) => {
        await client.query(
          `UPDATE ana_conversation_seq SET
             last_sequence = last_sequence + 1,
             last_inbound_message_id = $2,
             last_inbound_at = now(), updated_at = now()
           WHERE conversation_key = $1`,
          [conversationKey, newSource]
        );
        inboundUpdated.resolve();
        await releaseInbound.promise;
      }
    );
    await inboundUpdated.promise;
    const sendWorker = order.withConversationLock(
      phoneNumberId,
      customerPhone,
      async (client) => {
        const result = await client.query<{ source: string }>(
          `SELECT last_inbound_message_id AS source
           FROM ana_conversation_seq WHERE conversation_key = $1`,
          [conversationKey]
        );
        sendFinished = true;
        return result.rows[0]?.source;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(
      'dois workers usam conexões concorrentes e o envio aguarda a lock',
      order.getConversationOrderPoolStatsForSmoke().totalCount >= 2 &&
        !sendFinished
    );
    releaseInbound.resolve();
    const [, observedAfterInbound] = await Promise.all([inboundWorker, sendWorker]);
    check(
      'inbound vence => envio observa source nova e fica stale_source',
      observedAfterInbound === newSource && observedAfterInbound !== oldSource
    );

    // Corrida B: envio segura a mesma lock até obter o recibo; inbound é depois.
    await seed(oldSource);
    const sendAcquired = deferred();
    const releaseSend = deferred();
    let inboundFinished = false;
    const sending = order.withConversationLock(
      phoneNumberId,
      customerPhone,
      async (client) => {
        const before = await client.query<{ source: string }>(
          `SELECT last_inbound_message_id AS source
           FROM ana_conversation_seq WHERE conversation_key = $1`,
          [conversationKey]
        );
        sendAcquired.resolve();
        await releaseSend.promise;
        return before.rows[0]?.source === oldSource ? 'sent' : 'stale_source';
      }
    );
    await sendAcquired.promise;
    const laterInbound = order.withConversationLock(
      phoneNumberId,
      customerPhone,
      async (client) => {
        await client.query(
          `UPDATE ana_conversation_seq SET
             last_sequence = last_sequence + 1,
             last_inbound_message_id = $2,
             last_inbound_at = now(), updated_at = now()
           WHERE conversation_key = $1`,
          [conversationKey, newSource]
        );
        inboundFinished = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('inbound posterior aguarda o envio em voo', !inboundFinished);
    releaseSend.resolve();
    const [sendOutcome] = await Promise.all([sending, laterInbound]);
    const latest = await schema.getLastInboundMessageId(conversationKey);
    check(
      'envio vence => recibo sent; inbound posterior inicia o fluxo seguinte',
      sendOutcome === 'sent' && latest === newSource
    );

    // finally: uma exceção não pode deixar a sessão travada.
    let threw = false;
    try {
      await order.withConversationLock(phoneNumberId, customerPhone, async () => {
        throw new Error('fixture');
      });
    } catch {
      threw = true;
    }
    const reacquired = await Promise.race([
      order
        .withConversationLock(phoneNumberId, customerPhone, async () => true)
        .then(Boolean),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    check('advisory lock é solta no finally', threw && reacquired);
  } finally {
    await pool.query(
      'DELETE FROM ana_conversation_seq WHERE conversation_key = $1',
      [conversationKey]
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
