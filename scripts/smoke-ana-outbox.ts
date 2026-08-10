import { createHash } from 'crypto';

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
  const cache = await import('../src/services/escalationCache');
  type Row = import('../src/services/inboundOutbox').InboundOutboxRow;
  const rows = new Map<string, Row>();
  const ready: string[] = [];

  const store: import('../src/services/inboundOutbox').InboundOutboxStore = {
    async load(messageId) {
      return rows.get(messageId) ?? null;
    },
    async markDelivered(messageId) {
      const row = rows.get(messageId);
      if (row) row.deliveredAt = new Date(1_000);
    },
    async markFailure(messageId, attempts) {
      const row = rows.get(messageId);
      if (row) row.attempts = attempts;
    },
    async listReady() {
      return ready.splice(0);
    },
    async hasPending(conversationKey) {
      return [...rows.values()].some(
        (row) => row.conversationKey === conversationKey && !row.deliveredAt
      );
    },
  };

  const clinicalText = 'Minha unha está doendo muito, o que pode ser?';
  rows.set('wamid-fast', {
    messageId: 'wamid-fast',
    phoneNumberId: 'pnid-smoke',
    conversationKey: 'pnid-smoke:5511000000000',
    receivedAt: new Date(0),
    messageType: 'text',
    contentStatus: 'final',
    content: clinicalText,
    attempts: 0,
    deliveredAt: null,
  });
  let posts = 0;
  const posted: import('../src/services/inboundOutbox').InboundDeliveryPayload[] = [];
  const waits: number[] = [];
  const deps: import('../src/services/inboundOutbox').InboundOutboxDeps = {
    store,
    now: () => 1_000,
    wait: async (ms) => {
      waits.push(ms);
    },
    postInbound: async (payload) => {
      posts += 1;
      posted.push(payload);
      if (posts < 3) throw new Error('fixture network failure');
      return { escalation: { active: false, questionId: null, version: 2 } };
    },
  };
  const fast = await outbox.deliverInboundWithFastRetries('wamid-fast', deps);
  check('retry rápido entrega na 3ª tentativa', fast.delivered && posts === 3);
  check(
    'retry rápido usa 100ms/300ms, não o sweep de 10min',
    waits.join(',') === '100,300'
  );
  check(
    'W1 final contém texto real, E.164, hash e length exatos',
    posted[0]?.phoneNumberId === 'pnid-smoke' &&
      posted[0]?.customerPhone === '+5511000000000' &&
      posted[0]?.messageId === 'wamid-fast' &&
      posted[0]?.receivedAt === new Date(0).toISOString() &&
      posted[0]?.messageType === 'text' &&
      posted[0]?.contentStatus === 'final' &&
      posted[0]?.contentText === clinicalText &&
      posted[0]?.contentHash ===
        createHash('sha256').update(clinicalText, 'utf8').digest('hex') &&
      posted[0]?.contentLength === clinicalText.length
  );

  const internationalPayload = outbox.serializeInboundDeliveryPayload({
    messageId: 'wamid-international',
    phoneNumberId: 'pnid-smoke',
    conversationKey: 'pnid-smoke:6281234567890',
    receivedAt: new Date(0),
    messageType: 'text',
    contentStatus: 'final',
    content: 'Fixture internacional',
    contentOriginalLength: 'Fixture internacional'.length,
    attempts: 0,
    nextRetryAt: new Date(0),
    deliveredAt: null,
    terminalAt: null,
    failureCode: null,
  });
  check(
    'W1 preserva DDI internacional em E.164 explícito',
    internationalPayload.customerPhone === '+6281234567890'
  );
  check(
    'entrega marca delivered_at',
    rows.get('wamid-fast')?.deliveredAt instanceof Date
  );

  const transcription = 'Quero saber se vocês tratam micose de unha';
  rows.set('wamid-sweep', {
    messageId: 'wamid-sweep',
    phoneNumberId: 'pnid-smoke',
    conversationKey: 'pnid-smoke:5511000000001',
    receivedAt: new Date(0),
    messageType: 'audio',
    contentStatus: 'final',
    content: transcription,
    attempts: 3,
    deliveredAt: null,
  });
  ready.push('wamid-sweep');
  let sweepPayload: import('../src/services/inboundOutbox').InboundDeliveryPayload | null = null;
  const sweep = await outbox.sweepInboundOutbox(
    {
      ...deps,
      postInbound: async (payload) => {
        sweepPayload = payload;
        return {};
      },
    },
    10
  );
  check(
    'sweep recupera transcrição final do history/store',
    sweep.attempted === 1 &&
      sweep.delivered === 1 &&
      sweepPayload !== null &&
      (sweepPayload as import('../src/services/inboundOutbox').InboundDeliveryPayload).contentText === transcription
  );
  check(
    'intervalo exportado do sweep é exatamente 10min',
    outbox.OUTBOX_SWEEP_INTERVAL_MS === 10 * 60_000
  );

  const failedPayload = outbox.serializeInboundDeliveryPayload({
    messageId: 'wamid-failed-audio',
    phoneNumberId: 'pnid-smoke',
    conversationKey: 'pnid-smoke:5511000000002',
    receivedAt: new Date(0),
    messageType: 'audio',
    contentStatus: 'transcription_failed',
    content: '[áudio recebido]',
    attempts: 0,
    deliveredAt: null,
  });
  check(
    'falha de transcrição nunca publica placeholder',
    failedPayload.contentStatus === 'transcription_failed' &&
      failedPayload.contentText === null &&
      failedPayload.contentHash === null &&
      failedPayload.contentLength === null
  );

  rows.set('wamid-pending-audio', {
    messageId: 'wamid-pending-audio',
    phoneNumberId: 'pnid-smoke',
    conversationKey: 'pnid-smoke:5511000000003',
    receivedAt: new Date(0),
    messageType: 'audio',
    contentStatus: 'pending',
    content: '',
    attempts: 0,
    deliveredAt: null,
  });
  let pendingPosts = 0;
  const pending = await outbox.attemptInboundDeliveryOnce('wamid-pending-audio', {
    ...deps,
    postInbound: async () => {
      pendingPosts += 1;
      return {};
    },
  });
  check(
    'áudio pending não tenta POST nem incrementa tentativa',
    !pending.delivered && pending.attempts === 0 && pendingPosts === 0
  );

  cache.__resetEscalationCacheForTest();
  rows.set('wamid-pending', {
    messageId: 'wamid-pending',
    phoneNumberId: 'pnid-gate',
    conversationKey: 'pnid-gate:5511999999999',
    receivedAt: new Date(0),
    messageType: 'text',
    contentStatus: 'final',
    content: 'fixture',
    attempts: 1,
    deliveredAt: null,
  });
  check(
    'pendência sem escalada conhecida continua fail-open',
    !(await outbox.shouldSuspendForPendingInbound(
      'pnid-gate',
      '5511999999999',
      store
    ))
  );
  cache.updateEscalationCache('pnid-gate', '5511999999999', {
    active: true,
    questionId: 'question-smoke',
    version: 4,
  });
  check(
    'escalada ativa conhecida + pendência é fail-closed',
    await outbox.shouldSuspendForPendingInbound(
      'pnid-gate',
      '5511999999999',
      store
    )
  );
  rows.get('wamid-pending')!.deliveredAt = new Date();
  check(
    'escalada ativa sem pendência não aciona gate do outbox',
    !(await outbox.shouldSuspendForPendingInbound(
      'pnid-gate',
      '5511999999999',
      store
    ))
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
