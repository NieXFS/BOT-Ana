process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.ANA_ESCALATION_ENABLED = 'false';
process.env.RECEPS_IA_SENTRY_DSN = '';
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
  check(
    'parser estrito trata null/primitivo/array/{active:false} incompleto como inválido',
    cache.parseStrictEscalationSnapshot(null) === null &&
      cache.parseStrictEscalationSnapshot('inactive') === null &&
      cache.parseStrictEscalationSnapshot([]) === null &&
      cache.parseStrictEscalationSnapshot({ active: false }) === null &&
      cache.parseStrictEscalationSnapshot({
        active: false,
        questionId: null,
        version: 8,
      })?.active === false
  );
  const erpInactive = cache.parseStrictEscalationSnapshot({
    active: false,
    version: 0,
  });
  const erpActive = cache.parseStrictEscalationSnapshot({
    active: true,
    questionId: 'question-erp-live',
    version: 4,
  });
  check(
    'parser estrito aceita union real do ERP (inativo sem questionId; ativo com id)',
    erpInactive?.active === false &&
      erpInactive.questionId === null &&
      erpInactive.version === 0 &&
      erpActive?.active === true &&
      erpActive.questionId === 'question-erp-live' &&
      erpActive.version === 4
  );

  const decision = await import('../src/services/pauseDecision');
  const until = new Date(Date.now() + 60_000).toISOString();
  check(
    'pause-ack sem campos tipados falha fechado mesmo com escalation legado ativo',
    decision.decideEscalationAcknowledgementPause({
      expectedQuestionId: 'question-cache',
      local: { active: true, questionId: 'question-cache' },
      state: {
        globalPausedUntil: null,
        conversationPausedUntil: until,
        schedulePausedUntil: null,
        escalation: {
          active: true,
          questionId: 'question-cache',
          version: 7,
        },
      },
      nowMs: Date.now(),
    }) === true
  );
  check(
    'pause-ack tipado casa ESCALATION e bloqueia humanPause simultâneo',
    decision.decideEscalationAcknowledgementPause({
      expectedQuestionId: 'question-cache',
      local: { active: true, questionId: 'question-cache' },
      state: {
        globalPausedUntil: null,
        conversationPausedUntil: until,
        schedulePausedUntil: null,
        escalationPause: {
          active: true,
          questionId: 'question-cache',
          version: 7,
          until,
        },
        humanPause: { active: true, source: 'ECHO', until },
      },
      nowMs: Date.now(),
    }) === true &&
      decision.decideEscalationAcknowledgementPause({
        expectedQuestionId: 'question-cache',
        local: { active: true, questionId: 'question-cache' },
        state: {
          globalPausedUntil: null,
          conversationPausedUntil: until,
          schedulePausedUntil: null,
          escalationPause: {
            active: true,
            questionId: 'question-cache',
            version: 7,
            until,
          },
          humanPause: { active: false, source: null, until: null },
        },
        nowMs: Date.now(),
      }) === false
  );
  check(
    'pause-ack com latch local ECHO bloqueia mesmo com humanPause inativo',
    decision.decideEscalationAcknowledgementPause({
      expectedQuestionId: 'question-cache',
      local: { active: true, questionId: 'question-cache' },
      state: {
        globalPausedUntil: null,
        conversationPausedUntil: until,
        schedulePausedUntil: null,
        escalationPause: {
          active: true,
          questionId: 'question-cache',
          version: 7,
          until,
        },
        humanPause: { active: false, source: null, until: null },
      },
      nowMs: Date.now(),
      localEchoLatch: { source: 'ECHO', untilMs: Date.now() + 60_000 },
    }) === true
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
        messageId: 'wamid.HBgONjI4OTU0MjYyNTAzNjcVAgAS.fixture',
        messageIdHash: '36f35eb6f0a0b0eb',
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
    'scrub preserva apenas ids e hashes técnicos allowlisted',
    scrubbed.phoneNumberId === 'pnid-safe' &&
      scrubbed.messageId === '[REDACTED]' &&
      scrubbed.messageIdHash === '36f35eb6f0a0b0eb'
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
