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
  type EventName = import('../src/services/whatsappStatusHandler').WhatsAppStatusEventName;
  type Payload = import('../src/services/whatsappStatusHandler').QuestionReplyStatusCallbackPayload;

  const current = new Map<string, {
    status: EventName | null;
    occurredAt: string | null;
    failureCode: string | null;
    version: number;
    pending: boolean;
    attempts: number;
  }>([
    ['wamid-known', { status: null, occurredAt: null, failureCode: null, version: 0, pending: false, attempts: 0 }],
    ['wamid-failed', { status: null, occurredAt: null, failureCode: null, version: 0, pending: false, attempts: 0 }],
  ]);
  const store: import('../src/services/whatsappStatusHandler').WhatsAppStatusStore = {
    async apply(event) {
      if (!current.has(event.providerMessageId)) return { kind: 'unknown' };
      const row = current.get(event.providerMessageId)!;
      if (!status.canApplyWhatsAppStatus(row.status, event.statusEvent)) {
        if (row.status === event.statusEvent && row.pending) {
          return {
            kind: 'reactivated',
            obligation: {
              phoneNumberId: 'pnid-status-smoke',
              providerMessageId: event.providerMessageId,
              statusEvent: row.status,
              occurredAt: row.occurredAt!,
              failureCode: row.failureCode,
              version: row.version,
              attempts: row.attempts,
            },
          };
        }
        return { kind: 'noop' };
      }
      row.status = event.statusEvent;
      row.occurredAt = event.occurredAt;
      row.failureCode = event.failureCode;
      row.version += 1;
      row.pending = true;
      row.attempts = 0;
      return {
        kind: 'applied',
        obligation: {
          phoneNumberId: 'pnid-status-smoke',
          providerMessageId: event.providerMessageId,
          statusEvent: event.statusEvent,
          occurredAt: event.occurredAt,
          failureCode: event.failureCode,
          version: row.version,
          attempts: 0,
        },
      };
    },
    async markCallbackAck(providerMessageId, statusEvent, version) {
      const row = current.get(providerMessageId);
      if (!row || row.status !== statusEvent || row.version !== version || !row.pending) return false;
      row.pending = false;
      return true;
    },
    async markCallbackFailure(providerMessageId, statusEvent, version, attempts) {
      const row = current.get(providerMessageId);
      if (!row || row.status !== statusEvent || row.version !== version || !row.pending) return false;
      row.attempts = attempts;
      return true;
    },
    async listPendingCallbacks() {
      return [];
    },
  };

  const callbacks: Payload[] = [];
  const waits: number[] = [];
  let failSentCallback = 2;
  const deps: import('../src/services/whatsappStatusHandler').WhatsAppStatusDeps = {
    store,
    wait: async (ms) => {
      waits.push(ms);
    },
    postCallback: async (payload) => {
      if (payload.statusEvent === 'sent' && failSentCallback > 0) {
        failSentCallback -= 1;
        throw new Error('fixture callback failure');
      }
      callbacks.push(payload);
    },
  };

  const sentValue = {
    statuses: [
      {
        id: 'wamid-known',
        status: 'sent',
        timestamp: '1722470400',
        recipient_id: '5511999999999',
      },
    ],
  };
  const deliveredValue = {
    statuses: [
      {
        id: 'wamid-known',
        status: 'delivered',
        timestamp: '1722470460',
      },
    ],
  };

  check('status sent é aplicado', (await status.handleWhatsAppStatuses(sentValue, deps)) === 1);
  check(
    'callback usa tentativa imediata + backoff curto até sucesso',
    waits.join(',') === '50,150' && callbacks.length === 1
  );
  check(
    'W2 sent tem shape e timestamp exatos',
    JSON.stringify(callbacks[0]) ===
      JSON.stringify({
        phoneNumberId: 'pnid-status-smoke',
        providerMessageId: 'wamid-known',
        statusEvent: 'sent',
        occurredAt: new Date(1722470400 * 1000).toISOString(),
        failureCode: null,
      })
  );

  check(
    'delivered progride e gera um único callback',
    (await status.handleWhatsAppStatuses(deliveredValue, deps)) === 1 &&
      callbacks.length === 2 &&
      callbacks[1]?.statusEvent === 'delivered'
  );
  check(
    'duplicado e sent fora de ordem são no-op local e no callback',
    (await status.handleWhatsAppStatuses(deliveredValue, deps)) === 0 &&
      (await status.handleWhatsAppStatuses(sentValue, deps)) === 0 &&
      callbacks.length === 2 &&
      current.get('wamid-known')?.status === 'delivered'
  );

  const failedValue = {
    statuses: [
      {
        id: 'wamid-failed',
        status: 'failed',
        timestamp: '1722470500',
        errors: [{ code: 131047, message: 'fixture body must not be used' }],
      },
    ],
  };
  await status.handleWhatsAppStatuses(failedValue, deps);
  const failedCallback = callbacks[2];
  check(
    'failed é terminal e failureCode usa só código sanitizado',
    failedCallback?.failureCode === 'META_131047' &&
      (await status.handleWhatsAppStatuses(
        {
          statuses: [
            {
              id: 'wamid-failed',
              status: 'read',
              timestamp: '1722470600',
            },
          ],
        },
        deps
      )) === 0 &&
      current.get('wamid-failed')?.status === 'failed'
  );

  status.resetWhatsAppStatusCountersForTest();
  const beforeUnknownCallbacks = callbacks.length;
  await status.handleWhatsAppStatuses(
    {
      statuses: [
        {
          id: 'wamid-unknown',
          status: 'sent',
          timestamp: '1722470700',
        },
      ],
    },
    deps
  );
  check(
    'provider desconhecido é observável e não toca callback',
    status.getWhatsAppStatusCountersForTest().unknownProviderCount === 1 &&
      callbacks.length === beforeUnknownCallbacks
  );
  check(
    'política exportada contém exatamente três retries',
    status.STATUS_CALLBACK_RETRY_DELAYS_MS.length === 3
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
