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
    !process.env.RECEPS_IA_DIRECT_DATABASE_URL &&
    !process.env.DATABASE_URL &&
    !skipDatabase
  ) {
    throw new Error('RECEPS_IA_DIRECT_DATABASE_URL e DATABASE_URL ausentes no .env local');
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
  const humanHistory: Array<{
    messageId: string;
    content: string;
    createdAt: Date;
  }> = [];
  const emptyHuman = {
    humanHistoryPayload: null as string | null,
    humanHistoryAcceptedAt: null as Date | null,
    humanHistoryRecordedAt: null as Date | null,
    providerStatus: null as 'sent' | 'delivered' | 'read' | 'failed' | null,
    providerStatusAt: null as Date | null,
    providerFailureCode: null as string | null,
    callbackPending: false,
  };
  type ReplyRow = import('../src/services/questionReplyService').QuestionReplyRow;
  type HistoryLine = (typeof humanHistory)[number];
  const applyHumanHistory = (
    history: HistoryLine[],
    rowMap: Map<string, ReplyRow>,
    input: import('../src/services/questionReplyService').QuestionReplyHumanHistoryInput
  ): 'recorded' | 'already_recorded' => {
    const provisionalId = service.questionReplyProvisionalMessageId(
      input.idempotencyKey
    );
    const targetId = input.providerMessageId ?? provisionalId;
    const atTarget = history.filter((line) => line.messageId === targetId);
    const atProvisional = history.filter((line) => line.messageId === provisionalId);
    let outcome: 'recorded' | 'already_recorded' = 'already_recorded';
    if (input.providerMessageId) {
      if (atProvisional.length > 0 && atTarget.length === 0) {
        atProvisional[0]!.messageId = input.providerMessageId;
        atProvisional[0]!.createdAt = input.acceptedAt;
        atProvisional[0]!.content = service.questionReplyHumanHistoryContent(
          input.payload
        );
        outcome = 'recorded';
      } else if (atProvisional.length > 0 && atTarget.length > 0) {
        for (let i = history.length - 1; i >= 0; i -= 1) {
          if (history[i]?.messageId === provisionalId) history.splice(i, 1);
        }
      } else if (atTarget.length === 0) {
        history.push({
          messageId: input.providerMessageId,
          content: service.questionReplyHumanHistoryContent(input.payload),
          createdAt: input.acceptedAt,
        });
        outcome = 'recorded';
      }
    } else if (atProvisional.length === 0) {
      history.push({
        messageId: provisionalId,
        content: service.questionReplyHumanHistoryContent(input.payload),
        createdAt: input.acceptedAt,
      });
      outcome = 'recorded';
    }
    const row = rowMap.get(input.idempotencyKey);
    if (row) {
      row.humanHistoryPayload = row.humanHistoryPayload ?? input.payload;
      row.humanHistoryAcceptedAt = input.providerMessageId
        ? input.acceptedAt
        : row.humanHistoryAcceptedAt ?? input.acceptedAt;
      row.humanHistoryRecordedAt = row.humanHistoryRecordedAt ?? new Date(2_000);
    }
    return outcome;
  };
  const withdrawHumanHistoryFrom = (
    history: HistoryLine[],
    rowMap: Map<string, ReplyRow>,
    idempotencyKey: string
  ): void => {
    const provisionalId = service.questionReplyProvisionalMessageId(idempotencyKey);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.messageId === provisionalId) history.splice(i, 1);
    }
    const row = rowMap.get(idempotencyKey);
    if (row && row.providerMessageId == null) {
      row.humanHistoryPayload = null;
      row.humanHistoryAcceptedAt = null;
      row.humanHistoryRecordedAt = null;
    }
  };
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
        ...emptyHuman,
      };
      rows.set(input.idempotencyKey, row);
      return { inserted: true, row };
    },
    async update(key, status, providerMessageId, failureCode, snapshot) {
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
        humanHistoryPayload:
          current.humanHistoryPayload ?? snapshot?.payload ?? null,
        humanHistoryAcceptedAt:
          providerMessageId && snapshot?.acceptedAt
            ? snapshot.acceptedAt
            : current.humanHistoryAcceptedAt ?? snapshot?.acceptedAt ?? null,
      };
      rows.set(key, next);
      return next;
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };

  const projectHumanHistory = async (
    input: import('../src/services/questionReplyService').QuestionReplyHumanHistoryInput
  ): Promise<'recorded' | 'already_recorded'> =>
    applyHumanHistory(humanHistory, rows, input);

  let sends = 0;
  let humanObservedBeforeSend = false;
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
      humanObservedBeforeSend = humanHistory.length > 0;
      sends += 1;
      return { providerMessageId: `wamid-provider-${sends}` };
    },
    projectHumanHistory,
    withdrawHumanHistory: async ({ idempotencyKey }) => {
      withdrawHumanHistoryFrom(humanHistory, rows, idempotencyKey);
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
  const humanLinesFor = (messageId: string) =>
    humanHistory.filter((line) => line.messageId === messageId);
  check(
    'intenção HUMAN observável antes de sendReceipt',
    humanObservedBeforeSend === true
  );
  check(
    'aceite promove para wamid exatamente uma vez',
    first.kind === 'sent' &&
      humanLinesFor(first.providerMessageId).length === 1 &&
      humanLinesFor(service.questionReplyProvisionalMessageId(input.idempotencyKey))
        .length === 0 &&
      humanLinesFor(first.providerMessageId)[0]?.content ===
        `[atendente] ${input.text}` &&
      rows.get(input.idempotencyKey)?.humanHistoryRecordedAt != null
  );
  check(
    'resposta do painel aceita projeta exatamente uma linha HUMAN',
    first.kind === 'sent' &&
      humanLinesFor(first.providerMessageId).length === 1 &&
      humanLinesFor(first.providerMessageId)[0]?.content ===
        `[atendente] ${input.text}` &&
      rows.get(input.idempotencyKey)?.humanHistoryRecordedAt != null
  );
  check(
    'retry/idempotência não duplica a linha HUMAN',
    replay.kind === 'sent' &&
      first.kind === 'sent' &&
      humanLinesFor(first.providerMessageId).length === 1 &&
      sends === 1
  );
  check(
    'status/replay não duplicam',
    replay.kind === 'sent' &&
      first.kind === 'sent' &&
      humanHistory.filter((line) => line.content === `[atendente] ${input.text}`)
        .length === 1 &&
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
    ...emptyHuman,
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
    async update(key, status, providerMessageId, failureCode, snapshot) {
      if (status === 'sent' && failSentPersistenceOnce) {
        failSentPersistenceOnce = false;
        throw new Error('fixture sent persistence failure');
      }
      return fakeStore.update(
        key,
        status,
        providerMessageId,
        failureCode,
        snapshot
      );
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

  const failingHistory: typeof humanHistory = [];
  const repairRows = new Map<string, import('../src/services/questionReplyService').QuestionReplyRow>();
  const repairStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    async reserve(input) {
      const current = repairRows.get(input.idempotencyKey);
      if (current) return { inserted: false, row: current };
      const row = {
        ...input,
        status: 'in_flight' as const,
        providerMessageId: null,
        failureCode: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...emptyHuman,
      };
      repairRows.set(input.idempotencyKey, row);
      return { inserted: true, row };
    },
    async update(key, status, providerMessageId, failureCode, snapshot) {
      const current = repairRows.get(key);
      if (!current) throw new Error('missing repair row');
      const next = {
        ...current,
        status,
        providerMessageId: providerMessageId ?? current.providerMessageId,
        failureCode,
        updatedAt: new Date(1_000),
        humanHistoryPayload:
          current.humanHistoryPayload ?? snapshot?.payload ?? null,
        humanHistoryAcceptedAt:
          providerMessageId && snapshot?.acceptedAt
            ? snapshot.acceptedAt
            : current.humanHistoryAcceptedAt ?? snapshot?.acceptedAt ?? null,
      };
      repairRows.set(key, next);
      return next;
    },
    async get(key) {
      return repairRows.get(key) ?? null;
    },
  };
  const repairKey = 'question-smoke:history-fail';
  const repairInput = { ...input, idempotencyKey: repairKey };
  const repairSendsBefore = sends;
  let projectShouldFailPromote = true;
  const failedProject = await service.sendQuestionReply(repairInput, waConfig, {
    ...deps,
    store: repairStore,
    projectHumanHistory: async (projection) => {
      if (projection.providerMessageId && projectShouldFailPromote) {
        throw new Error('fixture history write failure');
      }
      return applyHumanHistory(failingHistory, repairRows, projection);
    },
    withdrawHumanHistory: async ({ idempotencyKey }) => {
      withdrawHumanHistoryFrom(failingHistory, repairRows, idempotencyKey);
    },
  });
  const failedRow = repairRows.get(repairKey);
  const repairProvisional = service.questionReplyProvisionalMessageId(repairKey);
  check(
    'falha de promote após aceite não reenvia e preserva HUMAN provisório',
    failedProject.kind === 'sent' &&
      sends === repairSendsBefore + 1 &&
      failedRow?.status === 'sent' &&
      failedRow.humanHistoryRecordedAt != null &&
      failedRow.humanHistoryPayload === repairInput.text &&
      failingHistory.length === 1 &&
      failingHistory[0]?.messageId === repairProvisional
  );
  projectShouldFailPromote = false;
  const repaired = await service.repairUnrecordedQuestionReplyHumanHistory({
    listUnrepaired: async () =>
      failedRow
        ? [
            {
              idempotencyKey: failedRow.idempotencyKey,
              conversationKey: failedRow.conversationKey,
              phoneNumberId: failedRow.phoneNumberId,
              providerMessageId: failedRow.providerMessageId,
              payload: failedRow.humanHistoryPayload!,
              acceptedAt: failedRow.humanHistoryAcceptedAt!,
            },
          ]
        : [],
    project: async (projection) => applyHumanHistory(failingHistory, repairRows, projection),
  });
  const replayAfterRepair = await service.sendQuestionReply(
    repairInput,
    waConfig,
    {
      ...deps,
      store: repairStore,
      projectHumanHistory: async (projection) =>
        applyHumanHistory(failingHistory, repairRows, projection),
      withdrawHumanHistory: async ({ idempotencyKey }) => {
        withdrawHumanHistoryFrom(failingHistory, repairRows, idempotencyKey);
      },
    }
  );
  check(
    'reparo posterior promove a linha HUMAN sem novo WhatsApp mesmo sem id anexado no marcador',
    repaired.recorded === 1 &&
      failingHistory.length === 1 &&
      failingHistory[0]?.messageId === failedRow?.providerMessageId &&
      failingHistory[0]?.content === `[atendente] ${repairInput.text}` &&
      repairRows.get(repairKey)?.humanHistoryRecordedAt != null &&
      replayAfterRepair.kind === 'sent' &&
      sends === repairSendsBefore + 1
  );

  const isolatedRows = new Map<string, ReplyRow>();
  const isolatedHistory: HistoryLine[] = [];
  const isolatedStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    async reserve(input) {
      const current = isolatedRows.get(input.idempotencyKey);
      if (current) return { inserted: false, row: current };
      const row = {
        ...input,
        status: 'in_flight' as const,
        providerMessageId: null,
        failureCode: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...emptyHuman,
      };
      isolatedRows.set(input.idempotencyKey, row);
      return { inserted: true, row };
    },
    async update(key, status, providerMessageId, failureCode, snapshot) {
      const current = isolatedRows.get(key);
      if (!current) throw new Error('missing isolated row');
      const next = {
        ...current,
        status,
        providerMessageId: providerMessageId ?? current.providerMessageId,
        failureCode,
        updatedAt: new Date(1_000),
        humanHistoryPayload:
          current.humanHistoryPayload ?? snapshot?.payload ?? null,
        humanHistoryAcceptedAt:
          providerMessageId && snapshot?.acceptedAt
            ? snapshot.acceptedAt
            : current.humanHistoryAcceptedAt ?? snapshot?.acceptedAt ?? null,
      };
      isolatedRows.set(key, next);
      return next;
    },
    async get(key) {
      return isolatedRows.get(key) ?? null;
    },
  };
  const isolatedBase = {
    ...deps,
    store: isolatedStore,
    projectHumanHistory: async (
      projection: import('../src/services/questionReplyService').QuestionReplyHumanHistoryInput
    ) => applyHumanHistory(isolatedHistory, isolatedRows, projection),
    withdrawHumanHistory: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      withdrawHumanHistoryFrom(isolatedHistory, isolatedRows, idempotencyKey);
    },
  };

  let intentionMeta = 0;
  const intentionFail = await service.sendQuestionReply(
    { ...input, idempotencyKey: 'question-smoke:intention-fail' },
    waConfig,
    {
      ...isolatedBase,
      projectHumanHistory: async () => {
        throw new Error('fixture intention persist failure');
      },
      sendReceipt: async () => {
        intentionMeta += 1;
        return { providerMessageId: 'wamid-should-not-send' };
      },
    }
  );
  check(
    'falha da intenção → Meta zero',
    intentionFail.kind === 'failed_pre_send' &&
      intentionFail.failureCode === 'HUMAN_INTENTION_FAILED' &&
      intentionMeta === 0 &&
      isolatedHistory.length === 0
  );

  let crashMeta = 0;
  const crashStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    ...isolatedStore,
    async update(key, status, providerMessageId, failureCode, snapshot) {
      if (crashMeta > 0) {
        throw new Error('simulated crash after receipt');
      }
      return isolatedStore.update(
        key,
        status,
        providerMessageId,
        failureCode,
        snapshot
      );
    },
  };
  const crashKey = 'question-smoke:crash-after-receipt';
  const crashResult = await service.sendQuestionReply(
    { ...input, idempotencyKey: crashKey },
    waConfig,
    {
      ...isolatedBase,
      store: crashStore,
      sendReceipt: async () => {
        crashMeta += 1;
        return { providerMessageId: 'wamid-crash-after-receipt' };
      },
      projectHumanHistory: async (projection) => {
        if (projection.providerMessageId) {
          throw new Error('simulated crash during promote');
        }
        return applyHumanHistory(isolatedHistory, isolatedRows, projection);
      },
    }
  );
  const crashProvisional = service.questionReplyProvisionalMessageId(crashKey);
  check(
    'crash simulado imediatamente após receipt preserva HUMAN',
    crashMeta === 1 &&
      crashResult.kind === 'pending' &&
      isolatedHistory.some((line) => line.messageId === crashProvisional) &&
      isolatedHistory.filter((line) =>
        line.content === `[atendente] ${input.text}`
      ).length === 1
  );

  const unattachedKey = 'question-smoke:repair-unattached';
  isolatedRows.set(unattachedKey, {
    idempotencyKey: unattachedKey,
    payloadHash: service.questionReplyPayloadHash({
      ...input,
      idempotencyKey: unattachedKey,
    }),
    sourceInboundMessageId,
    phoneNumberId,
    conversationKey: order.canonicalConversationKey(phoneNumberId, customerPhone),
    status: 'in_flight',
    providerMessageId: null,
    failureCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...emptyHuman,
    humanHistoryPayload: input.text,
    humanHistoryAcceptedAt: new Date(1_000),
  });
  const unattachedRepair = await service.repairUnrecordedQuestionReplyHumanHistory({
    listUnrepaired: async () => {
      const row = isolatedRows.get(unattachedKey);
      return row
        ? [
            {
              idempotencyKey: row.idempotencyKey,
              conversationKey: row.conversationKey,
              phoneNumberId: row.phoneNumberId,
              providerMessageId: row.providerMessageId,
              payload: row.humanHistoryPayload!,
              acceptedAt: row.humanHistoryAcceptedAt!,
            },
          ]
        : [];
    },
    project: async (projection) =>
      applyHumanHistory(isolatedHistory, isolatedRows, projection),
  });
  check(
    'reparo funciona sem provider ID anexado',
    unattachedRepair.attempted === 1 &&
      unattachedRepair.recorded === 1 &&
      isolatedHistory.some(
        (line) =>
          line.messageId === service.questionReplyProvisionalMessageId(unattachedKey)
      ) &&
      isolatedRows.get(unattachedKey)?.humanHistoryRecordedAt != null
  );

  const preSendKey = 'question-smoke:pre-send-reject';
  const preSendError = Object.assign(new Error('meta 400'), {
    deliveryClassification: 'pre_send' as const,
    code: 'META_HTTP_400',
  });
  let preSendAttempted = false;
  let humanDuringPreSend = false;
  const preSend = await service.sendQuestionReply(
    { ...input, idempotencyKey: preSendKey },
    waConfig,
    {
      ...isolatedBase,
      sendReceipt: async () => {
        preSendAttempted = true;
        humanDuringPreSend = isolatedHistory.some(
          (line) =>
            line.messageId === service.questionReplyProvisionalMessageId(preSendKey)
        );
        throw preSendError;
      },
    }
  );
  check(
    'rejeição pre-send remove o provisional',
    preSend.kind === 'failed_pre_send' &&
      preSendAttempted &&
      humanDuringPreSend &&
      !isolatedHistory.some(
        (line) =>
          line.messageId === service.questionReplyProvisionalMessageId(preSendKey)
      ) &&
      isolatedRows.get(preSendKey)?.humanHistoryRecordedAt == null &&
      isolatedRows.get(preSendKey)?.humanHistoryPayload == null
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
