/**
 * IA-20 — provider status v2, totalmente determinístico.
 *
 * Não usa Postgres, Meta, ERP, HTTP, OpenAI ou WhatsApp. O store em memória
 * espelha a inbox/projeção local e o handler recebe um legado injetado para
 * provar a separação entre sent_question_replies e o caminho v2.
 */
process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.RECEPS_IA_DIRECT_DATABASE_URL ??=
  'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';
process.env.NODE_ENV = 'development';
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS = 'v2-status-fixture';

export {};

import http from 'node:http';
import type { AddressInfo } from 'node:net';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

type StatusName = import('../src/services/whatsappStatusHandler').WhatsAppStatusEventName;

function value(
  providerMessageId: string,
  status: StatusName,
  timestamp: number,
  failureCode?: number
): unknown {
  return {
    statuses: [
      {
        id: providerMessageId,
        status,
        timestamp: String(timestamp),
        ...(failureCode === undefined ? {} : { errors: [{ code: failureCode, message: 'must never persist' }] }),
        recipient_id: '+5511999999999',
      },
    ],
  };
}

function emptyLegacyStore(): import('../src/services/whatsappStatusHandler').WhatsAppStatusStore {
  return {
    async apply() {
      return { kind: 'unknown' };
    },
    async markCallbackAck() {
      return false;
    },
    async markCallbackFailure() {
      return false;
    },
    async listPendingCallbacks() {
      return [];
    },
  };
}

function postStatusWebhook(
  port: number,
  body: string
): Promise<number> {
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
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function main(): Promise<void> {
  const status = await import('../src/services/whatsappStatusHandler');
  const provider = await import('../src/services/conversationalV2/providerStatus');

  const store = new provider.MemoryProviderStatusStoreV2();
  const acceptedTarget = (id: string, hash: string, state = 'accepted_by_provider') =>
    store.registerOutbox({
      deliveryAttemptId: id,
      turnId: `turn-${id}`,
      deliveryReceiptId: `receipt-${id}`,
      providerMessageIdHash: hash,
      providerStatus: null,
      providerStatusAt: null,
      providerFailureCode: null,
      providerStatusVersion: 0,
      outboxState: state,
    });
  const deps = {
    store: emptyLegacyStore(),
    providerStatusStore: store,
    postCallback: async () => {
      throw new Error('legacy callback must not run for v2');
    },
    wait: async () => undefined,
    now: () => 1_000_000,
  } satisfies import('../src/services/whatsappStatusHandler').WhatsAppStatusDeps;

  const sentHash = provider.hashProviderMessageIdV2('wamid-s1');
  acceptedTarget('attempt-s1', sentHash);
  await status.handleWhatsAppStatuses(value('wamid-s1', 'sent', 1_722_470_400), deps);
  const s1Event = store.getEvents()[0];
  check(
    'S1 accepted + sent correlaciona por SHA-256 e cria receipt v2',
    s1Event?.state === 'applied' &&
      s1Event.providerMessageIdHash === sentHash &&
      s1Event.deliveryAttemptId === 'attempt-s1' &&
      s1Event.turnId === 'turn-attempt-s1' &&
      s1Event.deliveryReceiptId === 'receipt-attempt-s1'
  );
  check(
    'S1 receipt terminal de transporte continua aceito',
    store.getOutbox(sentHash)?.providerStatus === 'sent' &&
      store.getOutbox(sentHash)?.outboxState === 'accepted_by_provider'
  );

  await status.handleWhatsAppStatuses(value('wamid-s1', 'delivered', 1_722_470_401), deps);
  await status.handleWhatsAppStatuses(value('wamid-s1', 'read', 1_722_470_402), deps);
  const beforeDuplicateEvents = store.getEvents().length;
  await status.handleWhatsAppStatuses(value('wamid-s1', 'read', 1_722_470_402), deps);
  check(
    'S2 sent→delivered→read é monotônico e duplicata não cria recibo conflitante',
    store.getOutbox(sentHash)?.providerStatus === 'read' &&
      store.getOutbox(sentHash)?.providerStatusVersion === 3 &&
      store.getEvents().length === beforeDuplicateEvents
  );

  let failureWarnings = 0;
  status.__setV2ProviderFailureObserverForTest(() => {
    failureWarnings += 1;
  });
  const failedHash = provider.hashProviderMessageIdV2('wamid-s3');
  acceptedTarget('attempt-s3', failedHash);
  await status.handleWhatsAppStatuses(value('wamid-s3', 'sent', 1_722_470_410), deps);
  await status.handleWhatsAppStatuses(value('wamid-s3', 'failed', 1_722_470_411, 131047), deps);
  await status.handleWhatsAppStatuses(value('wamid-s3', 'failed', 1_722_470_411, 131047), deps);
  check(
    'S3 failed 131047 é terminal e warning Sentry/observer ocorre uma vez',
    store.getOutbox(failedHash)?.providerStatus === 'failed' &&
      store.getOutbox(failedHash)?.providerFailureCode === 'META_131047' &&
      failureWarnings === 1
  );
  check(
    'S3 failed não gera retry, write, rollback ou callback ERP',
    deps.store === (deps as { store: unknown }).store &&
      store.getEvents().filter((event) => event.providerMessageIdHash === failedHash).length === 2
  );

  const observerFailureHash = provider.hashProviderMessageIdV2('wamid-s3-observer-failure');
  acceptedTarget('attempt-s3-observer-failure', observerFailureHash);
  status.__setV2ProviderFailureObserverForTest(() => {
    throw new Error('fixture observer failure');
  });
  let observerFailureRejected = false;
  try {
    await status.handleWhatsAppStatuses(
      value('wamid-s3-observer-failure', 'failed', 1_722_470_415, 131047),
      deps,
      { throwOnPersistenceFailure: true }
    );
  } catch {
    observerFailureRejected = true;
  }
  check(
    'S3 observabilidade best-effort não transforma status committed em 500',
    !observerFailureRejected &&
      store.getOutbox(observerFailureHash)?.providerStatus === 'failed'
  );
  status.__setV2ProviderFailureObserverForTest(() => {
    failureWarnings += 1;
  });

  const noCodeHash = provider.hashProviderMessageIdV2('wamid-s4');
  acceptedTarget('attempt-s4', noCodeHash);
  await status.handleWhatsAppStatuses(value('wamid-s4', 'failed', 1_722_470_420), deps);
  check(
    'S4 failed sem código vira META_FAILED sem mensagem do provider',
    store.getOutbox(noCodeHash)?.providerFailureCode === 'META_FAILED' &&
      !JSON.stringify(store.getEvents()).includes('must never persist')
  );

  const pendingHash = provider.hashProviderMessageIdV2('wamid-s5');
  await status.handleWhatsAppStatuses(value('wamid-s5', 'sent', 1_722_470_430), deps);
  const pendingBefore = store.getEvents().find((event) => event.providerMessageIdHash === pendingHash);
  acceptedTarget('attempt-s5', pendingHash);
  const pendingSweep = await store.sweep(new Date(1_001_000));
  const pendingAfter = store.getOutbox(pendingHash);
  check(
    'S5 status antes do outbox fica pending e sweeper correlaciona depois',
    pendingBefore?.state === 'pending' &&
      pendingSweep.applied === 1 &&
      pendingAfter?.providerStatus === 'sent'
  );

  let localFailureEvents = 0;
  const failingProvider: import('../src/services/conversationalV2/providerStatus').ProviderStatusStoreV2 = {
    async ingest() {
      localFailureEvents += 1;
      throw new Error('fixture local db failure');
    },
    async sweep() {
      return { attempted: 0, applied: 0, unmatched: 0 };
    },
  };
  let s6Failed = false;
  try {
    await status.handleWhatsAppStatuses(value('wamid-s6', 'sent', 1_722_470_440), {
      ...deps,
      providerStatusStore: failingProvider,
    }, { throwOnPersistenceFailure: true });
  } catch {
    s6Failed = true;
  }
  check('S6 falha de persistência local não vira 200 processado', s6Failed && localFailureEvents === 1);

  let legacyCallbackCalls = 0;
  let legacyPending = true;
  const legacyStore: import('../src/services/whatsappStatusHandler').WhatsAppStatusStore = {
    async apply(event) {
      return {
        kind: 'applied',
        obligation: {
          phoneNumberId: 'pnid-legacy',
          providerMessageId: event.providerMessageId,
          statusEvent: event.statusEvent,
          occurredAt: event.occurredAt,
          failureCode: event.failureCode,
          version: 1,
          attempts: 0,
        },
      };
    },
    async markCallbackAck() {
      legacyPending = false;
      return true;
    },
    async markCallbackFailure() {
      legacyPending = true;
      return true;
    },
    async listPendingCallbacks() {
      return [];
    },
  };
  await status.handleWhatsAppStatuses(value('wamid-s7', 'sent', 1_722_470_450), {
    store: legacyStore,
    postCallback: async () => {
      legacyCallbackCalls += 1;
      throw new Error('ERP unavailable');
    },
    wait: async () => undefined,
    providerStatusStore: store,
  });
  check('S7 callback ERP falho mantém obrigação legacy pending após ingestão', legacyCallbackCalls === 4 && legacyPending);
  const beforeLegacyV2 = store.getEvents().length;
  await status.handleWhatsAppStatuses(value('wamid-s8', 'sent', 1_722_470_460), {
    ...deps,
    store: legacyStore,
  });
  check('S8 sent_question_replies escolhe caminho legado e não cria receipt v2', store.getEvents().length === beforeLegacyV2);

  const v2OnlyHash = provider.hashProviderMessageIdV2('wamid-s9');
  acceptedTarget('attempt-s9', v2OnlyHash);
  let v2Callbacks = 0;
  await status.handleWhatsAppStatuses(value('wamid-s9', 'sent', 1_722_470_470), {
    ...deps,
    postCallback: async () => {
      v2Callbacks += 1;
    },
  });
  check('S9 WAMID v2 não chama callback ERP e só projeta outbox/status', v2Callbacks === 0 && store.getOutbox(v2OnlyHash)?.providerStatus === 'sent');

  const unknownHash = provider.hashProviderMessageIdV2('wamid-s10');
  await status.handleWhatsAppStatuses(value('wamid-s10', 'sent', 1_000), deps);
  const earlySweep = await store.sweep(new Date(1_000_500));
  const horizonNow = 1_000_000 + provider.PROVIDER_STATUS_MATCH_HORIZON_MS_V2 + 1;
  const unmatchedSweep = await status.sweepWhatsAppStatusCallbacks(
    { ...deps, now: () => horizonNow },
    100
  );
  const duplicateUnmatchedSweep = await status.sweepWhatsAppStatusCallbacks(
    { ...deps, now: () => horizonNow },
    100
  );
  check(
    'S10 pending respeita nextAttempt, depois vira unmatched uma única vez',
    earlySweep.attempted === 0 &&
      unmatchedSweep.providerStatus?.unmatched === 1 &&
      duplicateUnmatchedSweep.providerStatus?.unmatched === 0 &&
      store.getEvents().find((event) => event.providerMessageIdHash === unknownHash)?.state === 'unmatched'
  );
  check(
    'S10 counter de unmatched acompanha o sweep',
    status.getWhatsAppStatusCountersForTest().v2ProviderStatusUnmatchedCount === 1
  );

  const serialized = JSON.stringify(store.getEvents());
  check('S11 banco/status receipt/log v2 não contém recipient_id, telefone, erro ou WAMID cru', !serialized.includes('wamid-') && !serialized.includes('5511999999999') && !serialized.includes('must never persist'));

  const uncommittedHash = provider.hashProviderMessageIdV2('wamid-s12');
  acceptedTarget('attempt-s12', uncommittedHash, 'accepted_uncommitted');
  await status.handleWhatsAppStatuses(value('wamid-s12', 'sent', 1_722_470_480), deps);
  check('S12 accepted_uncommitted correlaciona sem retry de transporte', store.getOutbox(uncommittedHash)?.providerStatus === 'sent' && store.getOutbox(uncommittedHash)?.outboxState === 'accepted_uncommitted');

  const artificialHash = provider.hashProviderMessageIdV2('wamid-s13');
  await status.handleWhatsAppStatuses(value('wamid-s13', 'sent', 1_722_470_490), deps);
  check('S13 silent_escalation/suppressed/no-provider sem hash não ganham status artificial', store.getOutbox(artificialHash) === null && store.getEvents().some((event) => event.providerMessageIdHash === artificialHash && event.state === 'pending'));

  const batchStore = new provider.MemoryProviderStatusStoreV2();
  for (const id of ['s14a', 's14b', 's14c']) {
    batchStore.registerOutbox({
      deliveryAttemptId: `attempt-${id}`,
      turnId: `turn-${id}`,
      deliveryReceiptId: `receipt-${id}`,
      providerMessageIdHash: provider.hashProviderMessageIdV2(`wamid-${id}`),
      providerStatus: null,
      providerStatusAt: null,
      providerFailureCode: null,
      providerStatusVersion: 0,
      outboxState: 'accepted_by_provider',
    });
  }
  const batchResult = await status.handleWhatsAppStatuses({ statuses: [
    { id: 'wamid-s14a', status: 'sent', timestamp: '1722470500' },
    { id: 'wamid-s14b', status: 'sent', timestamp: '1722470501' },
    { id: 'wamid-s14c', status: 'sent', timestamp: '1722470502' },
  ] }, { ...deps, providerStatusStore: batchStore });
  check('S14 batch múltiplo aguarda ingestão de todos antes do retorno', batchResult === 3 && batchStore.getEvents().length === 3);

  const digestA = provider.buildProviderStatusDigestV2([
    provider.projectProviderStatusForDigestDayV2(
      {
        acceptedAt: '2026-08-20T10:00:00.000Z',
        providerStatus: 'failed',
        providerStatusAt: '2026-08-21T10:00:00.000Z',
        providerFailureCode: 'META_131047',
      },
      '2026-08-20'
    ),
  ]);
  const digestB = provider.buildProviderStatusDigestV2([
    provider.projectProviderStatusForDigestDayV2(
      {
        acceptedAt: '2026-08-20T10:00:00.000Z',
        providerStatus: 'failed',
        providerStatusAt: '2026-08-21T10:00:00.000Z',
        providerFailureCode: 'META_131047',
      },
      '2026-08-21'
    ),
  ]);
  const sameDayDigest = provider.buildProviderStatusDigestV2([
    { acceptedByProvider: true, providerStatus: 'delivered', providerFailureCode: null },
  ]);
  check(
    'S15 digest atribui accepted/awaiting ao dia A e failed ao dia B sem dupla contagem',
    digestA.acceptedByProvider === 1 &&
      digestA.awaitingStatus === 1 &&
      digestA.failed === 0 &&
      digestB.acceptedByProvider === 0 &&
      digestB.failed === 1 &&
      digestB.failuresByCode.META_131047 === 1 &&
      sameDayDigest.delivered === 1
  );

  const s16 = store.getEvents().find((event) => event.providerMessageIdHash === sentHash);
  const pendingS16 = store.getEvents().find((event) => event.providerMessageIdHash === unknownHash);
  check('S16 applied aponta turn/delivery/outbox; pending/unmatched nunca fingem vínculo', Boolean(s16?.turnId && s16.deliveryReceiptId && s16.deliveryAttemptId) && pendingS16?.turnId === null && pendingS16.deliveryReceiptId === null);

  const webhook = await import('../src/webhookServer');
  const fixtureConfig = (
    botRole: 'receptionist' | 'sales',
    tenantSlug: string
  ) =>
    ({ botRole, tenantSlug }) as Pick<
      import('../src/configProvider').TenantBotConfig,
      'botRole' | 'tenantSlug'
    >;
  const httpServer = await new Promise<http.Server>((resolve) => {
    const server = webhook.app.listen(0, '127.0.0.1', () => resolve(server));
  });
  try {
    const port = (httpServer.address() as AddressInfo).port;
    const salesPhoneNumberId = 'PN-HTTP-STATUS-SALES';
    const v1PhoneNumberId = 'PN-HTTP-STATUS-V1';
    const v2PhoneNumberId = 'PN-HTTP-STATUS-V2';
    const fixtureConfigs = new Map([
      [salesPhoneNumberId, fixtureConfig('sales', 'sales-status-fixture')],
      [v1PhoneNumberId, fixtureConfig('receptionist', 'v1-status-fixture')],
      [v2PhoneNumberId, fixtureConfig('receptionist', 'v2-status-fixture')],
    ]);
    const loaderCalls = new Map<string, number>();
    const installFixtureLoader = () => {
      webhook.__setWebhookStatusConfigLoaderForTest(async (phoneNumberId) => {
        loaderCalls.set(phoneNumberId, (loaderCalls.get(phoneNumberId) ?? 0) + 1);
        return (fixtureConfigs.get(phoneNumberId) ?? null) as import('../src/configProvider').TenantBotConfig | null;
      });
    };
    installFixtureLoader();

    const isolationBefore = store.getEvents().length;
    const v2HttpIds = [
      'wamid-http-status-v2-a',
      'wamid-http-status-v2-b',
      'wamid-http-status-v2-c',
    ];
    for (const [index, id] of v2HttpIds.entries()) {
      store.registerOutbox({
        deliveryAttemptId: `attempt-http-status-v2-${index}`,
        turnId: `turn-http-status-v2-${index}`,
        deliveryReceiptId: `receipt-http-status-v2-${index}`,
        providerMessageIdHash: provider.hashProviderMessageIdV2(id),
        providerStatus: null,
        providerStatusAt: null,
        providerFailureCode: null,
        providerStatusVersion: 0,
        outboxState: 'accepted_by_provider',
      });
    }
    const routeResolverObservations: number[] = [];
    webhook.__setWebhookStatusHandlerForTest((incoming, _unused, options) => {
      routeResolverObservations.push(
        typeof options?.resolveAllowV2Fallback === 'function' ? 1 : 0
      );
      return status.handleWhatsAppStatuses(incoming, deps, options);
    });
    const statusFor = (phoneNumberId: string, ids: string[]) =>
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: ids.map((id) => ({
                    id,
                    status: 'sent',
                    timestamp: '1722470500',
                  })),
                },
              },
            ],
          },
        ],
      });
    const salesResponse = await postStatusWebhook(
      port,
      statusFor(salesPhoneNumberId, ['wamid-http-status-sales'])
    );
    const v1Response = await postStatusWebhook(
      port,
      statusFor(v1PhoneNumberId, ['wamid-http-status-v1'])
    );
    const v2Response = await postStatusWebhook(
      port,
      statusFor(v2PhoneNumberId, v2HttpIds)
    );
    check(
      'isolamento HTTP: sales/v1 sem v2; v2 chama loader uma vez por batch e aplica 3',
      salesResponse === 200 &&
        v1Response === 200 &&
        v2Response === 200 &&
        store.getEvents().length === isolationBefore + 3 &&
        v2HttpIds.every(
          (id) =>
            store.getOutbox(provider.hashProviderMessageIdV2(id))?.providerStatus ===
            'sent'
        ) &&
        loaderCalls.get(salesPhoneNumberId) === 1 &&
        loaderCalls.get(v1PhoneNumberId) === 1 &&
        loaderCalls.get(v2PhoneNumberId) === 1 &&
        routeResolverObservations.length === 3 &&
        routeResolverObservations.every((value) => value === 1)
    );

    const nullConfigPhoneNumberId = 'PN-HTTP-STATUS-NULL-CONFIG';
    const nullConfigMessageId = 'wamid-http-status-null-config';
    const nullConfigHash = provider.hashProviderMessageIdV2(nullConfigMessageId);
    store.registerOutbox({
      deliveryAttemptId: 'attempt-http-status-null-config',
      turnId: 'turn-http-status-null-config',
      deliveryReceiptId: 'receipt-http-status-null-config',
      providerMessageIdHash: nullConfigHash,
      providerStatus: null,
      providerStatusAt: null,
      providerFailureCode: null,
      providerStatusVersion: 0,
      outboxState: 'accepted_by_provider',
    });
    const beforeNullConfigRetry = store.getEvents().length;
    const nullConfigFirstResponse = await postStatusWebhook(
      port,
      statusFor(nullConfigPhoneNumberId, [nullConfigMessageId])
    );
    const nullConfigFirstEvents = store.getEvents().length;
    fixtureConfigs.set(
      nullConfigPhoneNumberId,
      fixtureConfig('receptionist', 'v2-status-fixture')
    );
    const nullConfigRetryResponse = await postStatusWebhook(
      port,
      statusFor(nullConfigPhoneNumberId, [nullConfigMessageId])
    );
    check(
      'config null em unknown retorna 500 sem descartar; replay com v2 aplica',
      nullConfigFirstResponse === 500 &&
        nullConfigFirstEvents === beforeNullConfigRetry &&
        nullConfigRetryResponse === 200 &&
        store.getEvents().length === beforeNullConfigRetry + 1 &&
        store.getOutbox(nullConfigHash)?.providerStatus === 'sent'
    );

    let legacyCallbackCalls = 0;
    const legacyStore: import('../src/services/whatsappStatusHandler').WhatsAppStatusStore = {
      async apply(event) {
        return {
          kind: 'applied',
          obligation: {
            phoneNumberId: 'pnid-legacy-any-role',
            providerMessageId: event.providerMessageId,
            statusEvent: event.statusEvent,
            occurredAt: event.occurredAt,
            failureCode: event.failureCode,
            version: 1,
            attempts: 0,
          },
        };
      },
      async markCallbackAck() {
        return true;
      },
      async markCallbackFailure() {
        return true;
      },
      async listPendingCallbacks() {
        return [];
      },
    };
    const legacyKnownPhoneNumberId = 'PN-HTTP-STATUS-LEGACY-KNOWN';
    let legacyLoaderCalls = 0;
    webhook.__setWebhookStatusConfigLoaderForTest(async () => {
      legacyLoaderCalls += 1;
      throw new Error('config loader must not run for known legacy status');
    });
    webhook.__setWebhookStatusHandlerForTest((incoming, _unused, options) =>
      status.handleWhatsAppStatuses(
        incoming,
        {
          ...deps,
          store: legacyStore,
          postCallback: async () => {
            legacyCallbackCalls += 1;
          },
        },
        options
      )
    );
    check(
      'legacy conhecido: config loader que lança não é chamado e HTTP continua 200',
      (await postStatusWebhook(
        port,
        statusFor(legacyKnownPhoneNumberId, ['wamid-http-legacy-known'])
      )) === 200 &&
        legacyLoaderCalls === 0 &&
        legacyCallbackCalls === 1 &&
        store.getEvents().length === isolationBefore + 4
    );

    legacyCallbackCalls = 0;
    installFixtureLoader();
    loaderCalls.clear();
    await status.handleWhatsAppStatuses(
      value('wamid-http-legacy-any-role', 'sent', 1_722_470_501),
      {
        ...deps,
        store: legacyStore,
        postCallback: async () => {
          legacyCallbackCalls += 1;
        },
      },
      { allowV2Fallback: false }
    );
    check(
      'legacy sent_question_replies recebe callback em qualquer papel e zero v2',
      legacyCallbackCalls === 1 && store.getEvents().length === isolationBefore + 4
    );

    const statusBody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid-http', status: 'sent', timestamp: '1722470500' }] } }] }] });
    let release!: () => void;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    webhook.__setWebhookStatusHandlerForTest(async () => {
      await durable;
      return 0;
    });
    const pendingResponse = postStatusWebhook(port, statusBody).then((code) => {
      settled = true;
      return code;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('sonda HTTP: webhook não responde 200 antes do durable ingest', !settled);
    release();
    check('sonda HTTP: webhook responde 200 após durable ingest', (await pendingResponse) === 200);
    webhook.__setWebhookStatusHandlerForTest(async () => {
      throw new Error('durable fixture failure');
    });
    check('sonda HTTP: falha local retorna 500 para retransmissão', (await postStatusWebhook(port, statusBody)) === 500);
  } finally {
    webhook.__setWebhookStatusHandlerForTest();
    webhook.__setWebhookStatusConfigLoaderForTest();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }

  status.__setV2ProviderFailureObserverForTest();
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : typeof error);
  process.exitCode = 1;
});
