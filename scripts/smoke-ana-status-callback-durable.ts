process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.RECEPS_IA_DIRECT_DATABASE_URL ??=
  'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main(): Promise<void> {
  const status = await import('../src/services/whatsappStatusHandler');
  const reply = await import('../src/services/questionReplyService');
  type StatusName = import('../src/services/whatsappStatusHandler').WhatsAppStatusEventName;
  type Obligation = import('../src/services/whatsappStatusHandler').StatusCallbackObligation;

  interface StatusRow {
    phoneNumberId: string;
    providerMessageId: string;
    status: StatusName | null;
    occurredAt: string | null;
    failureCode: string | null;
    version: number;
    pending: boolean;
    attempts: number;
  }
  const rows = new Map<string, StatusRow>();
  const seed = (providerMessageId: string): StatusRow => {
    const row: StatusRow = {
      phoneNumberId: 'pnid-status-durable',
      providerMessageId,
      status: null,
      occurredAt: null,
      failureCode: null,
      version: 0,
      pending: false,
      attempts: 0,
    };
    rows.set(providerMessageId, row);
    return row;
  };
  const obligation = (row: StatusRow): Obligation => ({
    phoneNumberId: row.phoneNumberId,
    providerMessageId: row.providerMessageId,
    statusEvent: row.status!,
    occurredAt: row.occurredAt!,
    failureCode: row.failureCode,
    version: row.version,
    attempts: row.attempts,
  });

  const store: import('../src/services/whatsappStatusHandler').WhatsAppStatusStore = {
    async apply(event) {
      const row = rows.get(event.providerMessageId);
      if (!row) return { kind: 'unknown' };
      if (status.canApplyWhatsAppStatus(row.status, event.statusEvent)) {
        row.status = event.statusEvent;
        row.occurredAt = event.occurredAt;
        row.failureCode = event.failureCode;
        row.version += 1;
        row.pending = true;
        row.attempts = 0;
        return { kind: 'applied', obligation: obligation(row) };
      }
      if (row.status === event.statusEvent && row.pending) {
        return { kind: 'reactivated', obligation: obligation(row) };
      }
      return { kind: 'noop' };
    },
    async markCallbackAck(providerMessageId, statusEvent, version) {
      const row = rows.get(providerMessageId);
      if (
        !row ||
        !row.pending ||
        row.status !== statusEvent ||
        row.version !== version
      ) {
        return false;
      }
      row.pending = false;
      return true;
    },
    async markCallbackFailure(
      providerMessageId,
      statusEvent,
      version,
      attempts
    ) {
      const row = rows.get(providerMessageId);
      if (
        !row ||
        !row.pending ||
        row.status !== statusEvent ||
        row.version !== version
      ) {
        return false;
      }
      row.attempts = Math.max(row.attempts, attempts);
      return true;
    },
    async listPendingCallbacks() {
      return [...rows.values()].filter((row) => row.pending).map(obligation);
    },
  };

  const value = (
    providerMessageId: string,
    statusEvent: StatusName,
    timestamp: number,
    failureCode?: number
  ) => ({
    statuses: [
      {
        id: providerMessageId,
        status: statusEvent,
        timestamp: String(timestamp),
        ...(failureCode === undefined ? {} : { errors: [{ code: failureCode }] }),
      },
    ],
  });

  seed('wamid-durable-main');
  let callbackCalls = 0;
  const failingDeps: import('../src/services/whatsappStatusHandler').WhatsAppStatusDeps = {
    store,
    wait: async () => undefined,
    now: () => 10_000,
    postCallback: async () => {
      callbackCalls += 1;
      throw new TypeError('fixture unavailable');
    },
  };
  await status.handleWhatsAppStatuses(
    value('wamid-durable-main', 'sent', 1_722_470_400),
    failingDeps
  );
  check(
    'falha 4× permanece callback_pending com attempts duráveis',
    callbackCalls === 4 &&
      rows.get('wamid-durable-main')?.pending === true &&
      rows.get('wamid-durable-main')?.attempts === 4
  );

  const duplicateApplied = await status.handleWhatsAppStatuses(
    value('wamid-durable-main', 'sent', 1_722_470_400),
    failingDeps
  );
  check(
    'duplicata do provider é noop factual, mas reativa callback pendente',
    duplicateApplied === 0 &&
      callbackCalls === 8 &&
      rows.get('wamid-durable-main')?.pending === true
  );

  const sweep = await status.sweepWhatsAppStatusCallbacks({
    store,
    wait: async () => undefined,
    now: () => 20_000,
    postCallback: async () => {
      callbackCalls += 1;
    },
  });
  check(
    'sweep posterior 2xx converge e grava ack da mesma versão',
    sweep.attempted === 1 &&
      sweep.acknowledged === 1 &&
      rows.get('wamid-durable-main')?.pending === false
  );

  const successDeps: import('../src/services/whatsappStatusHandler').WhatsAppStatusDeps = {
    store,
    wait: async () => undefined,
    postCallback: async () => undefined,
  };
  await status.handleWhatsAppStatuses(
    value('wamid-durable-main', 'delivered', 1_722_470_401),
    successDeps
  );
  await status.handleWhatsAppStatuses(
    value('wamid-durable-main', 'read', 1_722_470_402),
    successDeps
  );
  const deliveredAfterRead = await status.handleWhatsAppStatuses(
    value('wamid-durable-main', 'delivered', 1_722_470_401),
    successDeps
  );
  check(
    'delivered→read avança e evento entregue tardio não regride',
    rows.get('wamid-durable-main')?.status === 'read' && deliveredAfterRead === 0
  );

  seed('wamid-failed-from-sent');
  await status.handleWhatsAppStatuses(
    value('wamid-failed-from-sent', 'sent', 1_722_470_410),
    successDeps
  );
  await status.handleWhatsAppStatuses(
    value('wamid-failed-from-sent', 'failed', 1_722_470_411, 131_026),
    successDeps
  );
  seed('wamid-failed-after-delivered');
  await status.handleWhatsAppStatuses(
    value('wamid-failed-after-delivered', 'sent', 1_722_470_420),
    successDeps
  );
  await status.handleWhatsAppStatuses(
    value('wamid-failed-after-delivered', 'delivered', 1_722_470_421),
    successDeps
  );
  const lateFailure = await status.handleWhatsAppStatuses(
    value('wamid-failed-after-delivered', 'failed', 1_722_470_422, 131_026),
    successDeps
  );
  check(
    'failed segue matriz: SENT aceita; DELIVERED não regride',
    rows.get('wamid-failed-from-sent')?.status === 'failed' &&
      rows.get('wamid-failed-from-sent')?.failureCode === 'META_131026' &&
      rows.get('wamid-failed-after-delivered')?.status === 'delivered' &&
      lateFailure === 0
  );

  const casRow = seed('wamid-cas');
  const firstVersion = await store.apply({
    providerMessageId: casRow.providerMessageId,
    statusEvent: 'sent',
    occurredAt: new Date(1_000).toISOString(),
    failureCode: null,
  });
  await store.apply({
    providerMessageId: casRow.providerMessageId,
    statusEvent: 'delivered',
    occurredAt: new Date(2_000).toISOString(),
    failureCode: null,
  });
  const oldAck =
    firstVersion.kind === 'applied'
      ? await store.markCallbackAck(
          casRow.providerMessageId,
          firstVersion.obligation.statusEvent,
          firstVersion.obligation.version
        )
      : true;
  check(
    'ack antigo não limpa obrigação de status mais novo',
    !oldAck && casRow.status === 'delivered' && casRow.version === 2 && casRow.pending
  );

  const now = new Date();
  const statusShape = await reply.getQuestionReplyStatus('reply-shape', {
    async reserve() {
      throw new Error('unused');
    },
    async update() {
      throw new Error('unused');
    },
    async get() {
      return {
        idempotencyKey: 'reply-shape',
        payloadHash: 'hash',
        sourceInboundMessageId: 'source',
        phoneNumberId: 'pnid',
        conversationKey: 'pnid:customer',
        status: 'sent',
        providerMessageId: 'wamid-shape',
        createdAt: now,
        updatedAt: now,
        failureCode: null,
        providerStatus: 'delivered',
        providerStatusAt: now,
        providerFailureCode: null,
        callbackPending: true,
        humanHistoryPayload: null,
        humanHistoryAcceptedAt: null,
        humanHistoryRecordedAt: null,
      };
    },
  });
  check(
    'GET status expõe providerStatus/At/failureCode/callbackPending',
    statusShape?.providerStatus === 'delivered' &&
      statusShape.providerStatusAt === now.toISOString() &&
      statusShape.providerFailureCode === null &&
      statusShape.callbackPending === true
  );

  let whatsappSends = 0;
  let replyRow: import('../src/services/questionReplyService').QuestionReplyRow | null = null;
  const replyStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    async reserve(input) {
      if (replyRow) return { inserted: false, row: replyRow };
      replyRow = {
        ...input,
        status: 'in_flight',
        providerMessageId: null,
        createdAt: now,
        updatedAt: now,
        failureCode: null,
        providerStatus: null,
        providerStatusAt: null,
        providerFailureCode: null,
        callbackPending: false,
        humanHistoryPayload: null,
        humanHistoryAcceptedAt: null,
        humanHistoryRecordedAt: null,
      };
      return { inserted: true, row: replyRow };
    },
    async update(_key, nextStatus, providerMessageId, failureCode, snapshot) {
      replyRow = {
        ...replyRow!,
        status: nextStatus,
        providerMessageId: providerMessageId ?? replyRow!.providerMessageId,
        failureCode,
        updatedAt: now,
        humanHistoryPayload:
          replyRow!.humanHistoryPayload ?? snapshot?.payload ?? null,
        humanHistoryAcceptedAt:
          providerMessageId && snapshot?.acceptedAt
            ? snapshot.acceptedAt
            : replyRow!.humanHistoryAcceptedAt ?? snapshot?.acceptedAt ?? null,
      };
      return replyRow;
    },
    async get() {
      return replyRow;
    },
  };
  const replyInput = {
    phoneNumberId: 'pnid-status-durable',
    customerPhone: '5511000000000',
    idempotencyKey: 'reply-wa-once',
    text: 'resposta fixture',
    sourceInboundMessageId: 'source-wa-once',
  };
  const replyDeps = reply.createQuestionReplyDeps({
    store: replyStore,
    now: () => now.getTime(),
    withLock: async (_phone, _customer, work) => work({} as never),
    getLatestSource: async () => replyInput.sourceInboundMessageId,
    getLastInboundAtMs: async () => now.getTime(),
    sendReceipt: async () => {
      whatsappSends += 1;
      return { providerMessageId: 'wamid-whatsapp-once' };
    },
    projectHumanHistory: async (input) => {
      if (replyRow) {
        replyRow = {
          ...replyRow,
          humanHistoryPayload: replyRow.humanHistoryPayload ?? input.payload,
          humanHistoryAcceptedAt: input.providerMessageId
            ? input.acceptedAt
            : replyRow.humanHistoryAcceptedAt ?? input.acceptedAt,
          humanHistoryRecordedAt: replyRow.humanHistoryRecordedAt ?? now,
        };
      }
      return 'recorded';
    },
    withdrawHumanHistory: async () => undefined,
  });
  await reply.sendQuestionReply(
    replyInput,
    { phoneNumberId: replyInput.phoneNumberId, waAccessToken: 'x', waApiVersion: 'v21' },
    replyDeps
  );
  await reply.sendQuestionReply(
    replyInput,
    { phoneNumberId: replyInput.phoneNumberId, waAccessToken: 'x', waApiVersion: 'v21' },
    replyDeps
  );
  check('status/callback/replay mantêm envio WhatsApp ≤1×', whatsappSends === 1);

  seed('wamid-history-repair');
  let statusRepair = 0;
  await status.handleWhatsAppStatuses(
    value('wamid-history-repair', 'delivered', 1_722_470_501),
    {
      ...successDeps,
      repairHumanHistory: async (providerMessageId) => {
        if (providerMessageId === 'wamid-history-repair') statusRepair += 1;
      },
    }
  );
  check(
    'status sent/delivered/read reusa o sweeper para projetar histórico humano',
    statusRepair === 1
  );

  let sweepRepair = 0;
  const sweepResult = await status.sweepWhatsAppStatusCallbacks({
    store: {
      ...store,
      listPendingCallbacks: async () => [],
    },
    postCallback: async () => undefined,
    wait: async () => undefined,
    repairHumanHistory: async () => {
      sweepRepair += 1;
    },
  });
  check(
    'sweep existente repara histórico humano sem poller novo',
    sweepRepair === 1 && sweepResult.attempted === 0
  );

  status.__resetWhatsAppStatusCallbackSweepForTest();
  const schedulerFirst = status.startWhatsAppStatusCallbackSweep(successDeps, 60_000);
  const schedulerSecond = status.startWhatsAppStatusCallbackSweep(successDeps, 60_000);
  check('sweep de callback é singleton em globalThis', schedulerFirst && !schedulerSecond);
  status.__resetWhatsAppStatusCallbackSweepForTest();

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
