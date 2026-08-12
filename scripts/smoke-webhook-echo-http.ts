import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'development';
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.RECEPS_BOT_WEBHOOK_SECRET =
  'incident-http-smoke-secret-at-least-32-chars';
process.env.OPENAI_API_KEY ||= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN ||= 'smoke-erp-token';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';

function signature(body: string): string {
  return (
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.RECEPS_BOT_WEBHOOK_SECRET!)
      .update(Buffer.from(body))
      .digest('hex')
  );
}

function postJson(
  port: number,
  body: string,
  signatureHeader = signature(body)
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/webhook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-bot-signature': signatureHeader,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function main(): Promise<void> {
  if (process.env.ANA_SMOKE_SKIP_DB === '1') {
    throw new Error('ANA_SMOKE_SKIP_DB=1 é proibido neste smoke.');
  }
  if (!process.env.RECEPS_IA_DIRECT_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('Banco descartável obrigatório para o smoke HTTP de echo.');
  }

  const order = await import('../src/services/conversationOrder');
  process.env.DATABASE_URL = order.resolveConversationOrderDatabaseUrl();
  const serverModule = await import('../src/webhookServer');
  const echo = await import('../src/echoHandler');
  const store = await import('../src/services/anaWave2Store');
  const context = await import('../src/services/contextManager');
  const privacy = await import('../src/services/privacyPurge');
  const processed = await import('../src/services/processedMessages');

  await processed.ensureProcessedMessagesTable();
  await store.ensureAnaWave2Tables();

  const server = await new Promise<http.Server>((resolve) => {
    const started = serverModule.app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const port = (server.address() as AddressInfo).port;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phoneNumberId = `PN-HTTP-ECHO-${suffix}`;
  const customerPhone = '5511999990088';
  const conversationKey = context.buildConversationKey(
    phoneNumberId,
    customerPhone
  );
  const messageId = `wamid.http.echo.${suffix}`;
  const payload = JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'smb_message_echoes',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              message_echoes: [
                {
                  id: messageId,
                  to: `+${customerPhone}`,
                  type: 'text',
                  text: { body: 'combinado para sexta' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  try {
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    serverModule.__setWebhookEchoHandlerForTest(async () => pending);
    let responseSettled = false;
    const pendingResponse = postJson(port, payload).then((response) => {
      responseSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      responseSettled,
      false,
      'endpoint não pode confirmar 200 enquanto o echo não está durável'
    );
    releasePending();
    assert.equal((await pendingResponse).status, 200);

    serverModule.__setWebhookEchoHandlerForTest(async () => {
      throw new Error('falha durável simulada');
    });
    assert.equal(
      (await postJson(port, payload)).status,
      500,
      'falha de persistência deve pedir retransmissão com 500'
    );

    let invalidSignatureCalls = 0;
    serverModule.__setWebhookEchoHandlerForTest(async () => {
      invalidSignatureCalls += 1;
    });
    assert.equal((await postJson(port, payload, 'sha256=invalid')).status, 401);
    assert.equal(invalidSignatureCalls, 0, 'assinatura inválida não alcança o echo');

    let durablePauseAttempts = 0;
    const echoDeps = {
      pauseConversation: async () => {
        durablePauseAttempts += 1;
        if (durablePauseAttempts === 1) {
          throw new Error('falha simulada ao persistir pausa no ERP');
        }
      },
      persistEchoAtomically: store.persistHumanEchoAtomically,
      markEchoProcessed: async () => {
        throw new Error('caminho legado proibido');
      },
      unmarkEcho: async () => undefined,
      recordMessage: async () => {
        throw new Error('write separado proibido');
      },
      withConversationLock: (
        currentPhoneNumberId: string,
        currentCustomerPhone: string,
        work: () => Promise<void>
      ) =>
        order.withConversationLock(
          currentPhoneNumberId,
          currentCustomerPhone,
          async () => work()
        ),
    };
    serverModule.__setWebhookEchoHandlerForTest((value, fallback) =>
      echo.handleSmbMessageEchoes(value, fallback, echoDeps)
    );
    assert.equal(
      (await postJson(port, payload)).status,
      500,
      'echo gravado sem pausa durável deve pedir retransmissão'
    );
    assert.equal((await postJson(port, payload)).status, 200);
    assert.equal((await postJson(port, payload)).status, 200);
    assert.equal(
      durablePauseAttempts,
      3,
      'cada retransmissão deve tentar tornar a pausa durável novamente'
    );

    const counts = await Promise.all([
      context.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM processed_messages WHERE message_id = $1',
        [messageId]
      ),
      context.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ana_conversation_history WHERE message_id = $1',
        [messageId]
      ),
    ]);
    assert.deepEqual(
      counts.map((result) => result.rows[0]?.count),
      ['1', '1'],
      'retransmissão HTTP deve permanecer idempotente no banco'
    );

    console.log(
      'smoke webhook echo HTTP: assinatura + await + pausa durável + 200/500 + retransmissão idempotente OK'
    );
  } finally {
    serverModule.__setWebhookEchoHandlerForTest();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    try {
      await privacy.purgeConversationData(phoneNumberId, customerPhone);
      const remaining = await context.pool.query<{ count: string }>(
        `SELECT (
          (SELECT COUNT(*) FROM processed_messages WHERE conversation_key = $1) +
          (SELECT COUNT(*) FROM ana_conversation_history WHERE "conversationKey" = $1)
        )::text AS count`,
        [conversationKey]
      );
      assert.equal(remaining.rows[0]?.count, '0');
    } finally {
      await Promise.all([
        context.pool.end(),
        order.closeConversationOrderPoolForSmoke(),
      ]);
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
