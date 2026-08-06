import 'dotenv/config';
import type { PoolClient } from 'pg';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main(): Promise<void> {
  const skipDatabase = process.env.ANA_SMOKE_SKIP_DB === '1';
  if (
    !process.env.ANA_DIRECT_DATABASE_URL &&
    !process.env.DATABASE_URL &&
    !skipDatabase
  ) {
    throw new Error('ANA_DIRECT_DATABASE_URL e DATABASE_URL ausentes no .env local');
  }
  process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
  const order = await import('../src/services/conversationOrder');
  process.env.DATABASE_URL = order.resolveConversationOrderDatabaseUrl();
  process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
  const service = await import('../src/services/questionReplyService');
  const schema = await import('../src/services/anaWave2Store');
  const processed = await import('../src/services/processedMessages');
  const { pool } = await import('../src/services/contextManager');

  const rows = new Map<string, import('../src/services/questionReplyService').QuestionReplyRow>();
  const providerIds = new Set<string>();
  const fakeStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    async reserve(input) {
      const current = rows.get(input.idempotencyKey);
      if (current) return { inserted: false, row: current };
      const now = new Date(0);
      const row = {
        ...input,
        status: 'in_flight' as const,
        providerMessageId: null,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(input.idempotencyKey, row);
      return { inserted: true, row };
    },
    async update(key, status, providerMessageId, failureCode) {
      const current = rows.get(key);
      if (!current) throw new Error('missing fixture row');
      if (providerMessageId) {
        if (providerIds.has(providerMessageId)) {
          const error = new Error('fixture provider unique');
          (error as Error & { code: string }).code = '23505';
          throw error;
        }
        providerIds.add(providerMessageId);
      }
      const next = {
        ...current,
        status,
        providerMessageId: providerMessageId ?? current.providerMessageId,
        failureCode,
        updatedAt: new Date(1_000),
      };
      rows.set(key, next);
      return next;
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };

  let sends = 0;
  const phoneNumberId = 'pnid-reply-smoke';
  const customerPhone = '5511000000000';
  const sourceInboundMessageId = 'wamid-source-smoke';
  const deps: import('../src/services/questionReplyService').QuestionReplyDeps = {
    store: fakeStore,
    now: () => 1_000,
    withLock: async (_phone, _customer, work) => work({} as PoolClient),
    getLatestSource: async () => sourceInboundMessageId,
    getLastInboundAtMs: async () => 500,
    sendReceipt: async () => {
      sends += 1;
      return { providerMessageId: `wamid-provider-${sends}` };
    },
  };
  const waConfig = {
    phoneNumberId,
    waAccessToken: 'fixture-token',
    waApiVersion: 'v21.0',
  };
  const input = {
    phoneNumberId,
    customerPhone,
    idempotencyKey: 'question-smoke:1',
    text: 'Resposta da equipe: fixture',
    sourceInboundMessageId,
  };
  const first = await service.sendQuestionReply(input, waConfig, deps);
  const replay = await service.sendQuestionReply(input, waConfig, deps);
  check(
    'mesma chave+hash devolve a mesma conclusão sem novo transporte',
    first.kind === 'sent' &&
      replay.kind === 'sent' &&
      first.providerMessageId === replay.providerMessageId &&
      sends === 1
  );

  const conflict = await service.sendQuestionReply(
    { ...input, text: 'Resposta da equipe: payload diferente' },
    waConfig,
    deps
  );
  check('mesma chave com hash diferente retorna conflito', conflict.kind === 'conflict');

  const pendingKey = 'question-smoke:2';
  rows.set(pendingKey, {
    idempotencyKey: pendingKey,
    payloadHash: service.questionReplyPayloadHash({
      ...input,
      idempotencyKey: pendingKey,
    }),
    sourceInboundMessageId,
    phoneNumberId,
    conversationKey: order.canonicalConversationKey(phoneNumberId, customerPhone),
    status: 'confirmation_pending',
    providerMessageId: null,
    failureCode: 'TRANSPORT_OUTCOME_UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const pending = await service.sendQuestionReply(
    { ...input, idempotencyKey: pendingKey },
    waConfig,
    deps
  );
  check(
    'confirmation_pending devolve pendente e nunca chama Meta de novo',
    pending.kind === 'pending' &&
      pending.status === 'confirmation_pending' &&
      pending.providerMessageId === null &&
      sends === 1
  );

  let failSentPersistenceOnce = true;
  const evidenceStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    ...fakeStore,
    async update(key, status, providerMessageId, failureCode) {
      if (status === 'sent' && failSentPersistenceOnce) {
        failSentPersistenceOnce = false;
        throw new Error('fixture sent persistence failure');
      }
      return fakeStore.update(key, status, providerMessageId, failureCode);
    },
  };
  const evidenceKey = 'question-smoke:3';
  const evidence = await service.sendQuestionReply(
    { ...input, idempotencyKey: evidenceKey },
    waConfig,
    { ...deps, store: evidenceStore }
  );
  const evidenceStatus = await service.getQuestionReplyStatus(
    evidenceKey,
    evidenceStore
  );
  check(
    'aceite Meta + falha do sent persiste providerMessageId em confirmation_pending',
    evidence.kind === 'pending' &&
      evidence.status === 'confirmation_pending' &&
      evidence.providerMessageId === 'wamid-provider-2' &&
      evidenceStatus?.status === 'confirmation_pending' &&
      evidenceStatus.providerMessageId === 'wamid-provider-2' &&
      sends === 2
  );

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key1 = `provider-unique-a-${suffix}`;
  const key2 = `provider-unique-b-${suffix}`;
  const providerMessageId = `wamid-provider-unique-${suffix}`;
  if (!skipDatabase) {
    try {
      await processed.ensureProcessedMessagesTable();
      await schema.ensureAnaWave2Tables();
      await pool.query(
        `INSERT INTO sent_question_replies (
           idempotency_key, payload_hash, source_inbound_message_id,
           phone_number_id, conversation_key, status, provider_message_id
         ) VALUES ($1, $2, $3, $4, $5, 'sent', $6)`,
        [key1, 'a'.repeat(64), 'source-a', phoneNumberId, 'conv-a', providerMessageId]
      );
      let uniqueRejected = false;
      try {
        await pool.query(
          `INSERT INTO sent_question_replies (
             idempotency_key, payload_hash, source_inbound_message_id,
             phone_number_id, conversation_key, status, provider_message_id
           ) VALUES ($1, $2, $3, $4, $5, 'sent', $6)`,
          [key2, 'b'.repeat(64), 'source-b', phoneNumberId, 'conv-b', providerMessageId]
        );
      } catch (error) {
        uniqueRejected = (error as { code?: unknown }).code === '23505';
      }
      check('providerMessageId é UNIQUE no Postgres', uniqueRejected);
    } finally {
      await pool.query(
        'DELETE FROM sent_question_replies WHERE idempotency_key = ANY($1)',
        [[key1, key2]]
      ).catch(() => undefined);
    }
  } else {
    console.log('[SKIP] providerMessageId UNIQUE exige Postgres');
  }
  await Promise.all([pool.end(), order.closeConversationOrderPoolForSmoke()]);

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
