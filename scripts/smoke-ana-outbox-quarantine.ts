process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ANA_DIRECT_DATABASE_URL ??=
  'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main(): Promise<void> {
  const outbox = await import('../src/services/inboundOutbox');
  type Row = import('../src/services/inboundOutbox').InboundOutboxRow;
  const rows = new Map<string, Row>();
  const posted = new Map<string, number>();

  const addRow = (messageId: string): Row => {
    const row: Row = {
      messageId,
      phoneNumberId: 'pnid-quarantine-smoke',
      conversationKey: 'pnid-quarantine-smoke:5511000000000',
      receivedAt: new Date(0),
      messageType: 'text',
      contentStatus: 'final',
      content: 'fixture contratual',
      contentOriginalLength: 'fixture contratual'.length,
      attempts: 0,
      nextRetryAt: new Date(0),
      deliveredAt: null,
      terminalAt: null,
      failureCode: null,
    };
    rows.set(messageId, row);
    return row;
  };

  const store: import('../src/services/inboundOutbox').InboundOutboxStore = {
    async load(messageId) {
      return rows.get(messageId) ?? null;
    },
    async markDelivered(messageId) {
      const row = rows.get(messageId);
      if (row) row.deliveredAt = new Date();
    },
    async markFailure(messageId, attempts, nextRetryAt, failureCode) {
      const row = rows.get(messageId);
      if (row) {
        row.attempts = attempts;
        row.nextRetryAt = nextRetryAt;
        row.failureCode = failureCode;
      }
    },
    async markTerminal(messageId, attempts, failureCode) {
      const row = rows.get(messageId);
      if (row) {
        row.attempts = attempts;
        row.terminalAt = new Date();
        row.failureCode = failureCode;
      }
    },
    async reprocessQuarantined(messageId) {
      const row = rows.get(messageId);
      if (!row || !row.terminalAt || row.deliveredAt) return false;
      row.terminalAt = null;
      row.failureCode = null;
      row.attempts = 0;
      row.nextRetryAt = new Date(0);
      return true;
    },
    async listReady() {
      return [...rows.values()]
        .filter((row) => !row.deliveredAt && !row.terminalAt)
        .map((row) => row.messageId);
    },
    async hasPending(conversationKey) {
      return [...rows.values()].some(
        (row) => row.conversationKey === conversationKey && !row.deliveredAt
      );
    },
  };

  const runStatus = async (status: number) => {
    const messageId = `wamid-http-${status}`;
    addRow(messageId);
    const result = await outbox.attemptInboundDeliveryOnce(messageId, {
      store,
      wait: async () => undefined,
      now: () => 1_000,
      postInbound: async () => {
        posted.set(messageId, (posted.get(messageId) ?? 0) + 1);
        throw { response: { status } };
      },
    });
    return { messageId, result, row: rows.get(messageId)! };
  };

  for (const status of [400, 422]) {
    const terminal = await runStatus(status);
    const replay = await outbox.attemptInboundDeliveryOnce(terminal.messageId, {
      store,
      wait: async () => undefined,
      now: () => 2_000,
      postInbound: async () => {
        posted.set(terminal.messageId, (posted.get(terminal.messageId) ?? 0) + 1);
        return {};
      },
    });
    check(
      `${status} entra em quarentena terminal e não repete automaticamente`,
      terminal.result.terminal &&
        terminal.row.terminalAt instanceof Date &&
        terminal.row.failureCode === `W1_CONTRACT_HTTP_${status}` &&
        !replay.delivered &&
        replay.terminal &&
        posted.get(terminal.messageId) === 1
    );
  }

  for (const status of [401, 403, 404, 409, 429, 500, 503]) {
    const recoverable = await runStatus(status);
    check(
      `${status} permanece recuperável com backoff/failureCode`,
      !recoverable.result.terminal &&
        recoverable.row.terminalAt === null &&
        recoverable.row.failureCode === `W1_HTTP_${status}` &&
        recoverable.row.nextRetryAt.getTime() > 1_000
    );
  }

  const networkId = 'wamid-network';
  addRow(networkId);
  const network = await outbox.attemptInboundDeliveryOnce(networkId, {
    store,
    wait: async () => undefined,
    now: () => 5_000,
    postInbound: async () => {
      throw new TypeError('fixture network unavailable');
    },
  });
  check(
    'timeout/rede permanece recuperável e sanitizada',
    !network.terminal &&
      rows.get(networkId)?.terminalAt === null &&
      rows.get(networkId)?.failureCode === 'W1_TYPEERROR'
  );

  const quarantinedId = 'wamid-http-400';
  const rearmed = await outbox.reprocessQuarantinedInbound(quarantinedId, store);
  const recovered = await outbox.attemptInboundDeliveryOnce(quarantinedId, {
    store,
    wait: async () => undefined,
    now: () => 10_000,
    postInbound: async () => ({}),
  });
  check(
    'reprocessamento explícito rearma e só então permite entrega',
    rearmed && recovered.delivered && rows.get(quarantinedId)?.deliveredAt instanceof Date
  );

  const ready = await store.listReady(100);
  check(
    'quarentena restante fica excluída do sweep comum',
    !ready.includes('wamid-http-422')
  );

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
