process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.ANA_ESCALATION_ENABLED = 'false';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main(): Promise<void> {
  const cache = await import('../src/services/escalationCache');
  const pause = await import('../src/services/pauseService');
  const escalation = await import('../src/services/questionEscalation');
  const statuses = await import('../src/services/whatsappStatusHandler');
  const { scrubEvent } = await import('../src/observability/scrub');

  cache.__resetEscalationCacheForTest();
  pause.__resetPauseCacheForTest();
  const absent = cache.parseEscalationSnapshot(undefined);
  check(
    'pause-state sem escalation é inactive',
    absent.active === false && absent.questionId === null && absent.version === 0
  );

  cache.updateEscalationCache(
    'pnid-cache',
    '5511000000000',
    { active: true, questionId: 'question-cache', version: 7 },
    0
  );
  const failClosed = await pause.isConversationPaused(
    'pnid-cache',
    '5511000000000',
    {
      now: () => 30_000,
      fetchState: async () => null,
    }
  );
  check('active conhecido + fetch falho permanece fail-closed', failClosed);

  const disabled = await escalation.maybeEscalateReceptionistQuestion({
    phoneNumberId: 'pnid-cache',
    customerPhone: '5511000000000',
    messageId: 'wamid-flag-off',
    text: 'quero falar com uma pessoa',
  });
  check(
    'ANA_ESCALATION_ENABLED=false deixa o gatilho completamente inerte',
    disabled === null && !escalation.isAnaEscalationEnabled()
  );

  let extensionCalls = 0;
  const statusCount = await statuses.handleWhatsAppStatuses(
    {
      statuses: [
        { id: 'wamid-provider-1', status: 'delivered', timestamp: '123' },
        { id: 'wamid-provider-2', status: 'read', timestamp: '124' },
      ],
    },
    {
      store: {
        apply: async (statusEvent) => ({
          kind: 'applied',
          obligation: {
            phoneNumberId: 'pnid-cache',
            providerMessageId: statusEvent.providerMessageId,
            statusEvent: statusEvent.statusEvent,
            occurredAt: statusEvent.occurredAt,
            failureCode: statusEvent.failureCode,
            version: 1,
            attempts: 0,
          },
        }),
        markCallbackAck: async () => true,
        markCallbackFailure: async () => true,
        listPendingCallbacks: async () => [],
      },
      postCallback: async () => {
        extensionCalls += 1;
      },
      wait: async () => undefined,
    }
  );
  check(
    'payload só-statuses chega ao handler/ponto de extensão',
    statusCount === 2 && extensionCalls === 2
  );

  const event = scrubEvent({
    contexts: {
      wave2: {
        customerPhone: '5511999999999',
        conversationKey: 'pnid:5511999999999',
        text: 'mensagem curta da cliente',
        phoneNumberId: 'pnid-safe',
        messageId: 'wamid-safe',
      },
    },
  } as never) as unknown as {
    contexts: {
      wave2: Record<string, unknown>;
    };
  };
  const scrubbed = event.contexts.wave2;
  check(
    'scrub remove telefone, conversationKey e texto nas superfícies novas',
    scrubbed.customerPhone === '[REDACTED]' &&
      scrubbed.conversationKey === '[REDACTED]' &&
      scrubbed.text === '[REDACTED:25 chars]'
  );
  check(
    'scrub preserva apenas ids técnicos allowlisted',
    scrubbed.phoneNumberId === 'pnid-safe' &&
      scrubbed.messageId === 'wamid-safe'
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
