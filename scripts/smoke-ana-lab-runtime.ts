import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'development';
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.DATABASE_URL = [
  'postgresql:',
  '',
  '127.0.0.1:1',
  'lab_runtime_smoke',
].join('/');
process.env.ERP_API_TOKEN = 'smoke-invalid';
process.env.OPENAI_API_KEY = 'sk-smoke-invalid';
process.env.RECEPS_BOT_WEBHOOK_SECRET = '';
process.env.WA_PHONE_NUMBER_ID = 'PN-LAB-SMOKE';
process.env.HOST = '127.0.0.1';
process.env.ANA_RUNTIME_MODE = 'lab';
process.env.LAB_WRITE_POLICY = 'disabled';
process.env.ANA_LAB_ALLOWED_TENANT_SLUGS = 'studio-viti';
process.env.ANA_LAB_ALLOWED_PHONE_NUMBER_IDS = 'PN-LAB-SMOKE';
process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS = 'studio-viti';

function labEnv(
  databaseFingerprint: string,
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    ANA_RUNTIME_MODE: 'lab',
    LAB_WRITE_POLICY: 'disabled',
    HOST: '127.0.0.1',
    DATABASE_URL: process.env.DATABASE_URL,
    ANA_LAB_DATABASE_FINGERPRINT: databaseFingerprint,
    ANA_LAB_ALLOWED_TENANT_SLUGS: 'studio-viti',
    ANA_LAB_ALLOWED_PHONE_NUMBER_IDS: 'PN-LAB-SMOKE',
    ...overrides,
  };
}

function expectThrowMessage(work: () => unknown, fragment: string): void {
  assert.throws(work, (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, new RegExp(fragment, 'i'));
    return true;
  });
}

function request(
  port: number,
  options: { method: 'GET' | 'POST'; path: string; body?: unknown }
): Promise<{ status: number; body: string }> {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers:
          options.method === 'POST'
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }
            : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.once('error', reject);
    req.end(body);
  });
}

async function main(): Promise<void> {
  const policy = await import('../src/runtimePolicy');
  const expectedFingerprint = policy.databaseFingerprint(
    process.env.DATABASE_URL!
  );
  process.env.ANA_LAB_DATABASE_FINGERPRINT = expectedFingerprint;

  const productionDefault = policy.resolveAnaRuntimeConfig({});
  const productionExplicit = policy.resolveAnaRuntimeConfig({
    ANA_RUNTIME_MODE: 'production',
  });
  assert.deepEqual(
    productionDefault,
    productionExplicit,
    'ANA_RUNTIME_MODE ausente e production precisam resolver a mesma política'
  );
  assert.equal(productionDefault.mode, 'production');
  assert.equal(productionDefault.backgroundJobs, true);
  assert.equal(
    policy.labBlockedWriteEffect('bookAppointment', {}),
    null,
    'produção default não arma write policy LAB'
  );
  assert.equal(
    policy.labBlockedWriteEffect('bookAppointment', {
      ANA_RUNTIME_MODE: 'production',
      LAB_WRITE_POLICY: 'disabled',
    }),
    null,
    'flags LAB não armam write policy em production'
  );

  expectThrowMessage(
    () => policy.resolveAnaRuntimeConfig({ ANA_RUNTIME_MODE: 'unexpected' }),
    'ANA_RUNTIME_MODE'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, {
          ANA_LAB_ALLOWED_TENANT_SLUGS: undefined,
        })
      ),
    'TENANT_SLUGS'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, {
          ANA_LAB_ALLOWED_TENANT_SLUGS: '*',
        })
      ),
    'wildcard'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, {
          ANA_LAB_ALLOWED_PHONE_NUMBER_IDS: undefined,
        })
      ),
    'PHONE_NUMBER_IDS'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, {
          ANA_LAB_ALLOWED_PHONE_NUMBER_IDS: '*',
        })
      ),
    'wildcard'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv('0'.repeat(64))
      ),
    'fingerprint'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, { LAB_WRITE_POLICY: 'enabled' })
      ),
    'LAB_WRITE_POLICY'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, { HOST: '0.0.0.0' })
      ),
    '127.0.0.1'
  );

  const runtime = policy.resolveAnaRuntimeConfig(
    labEnv(expectedFingerprint)
  );
  assert.equal(runtime.mode, 'lab');
  assert.equal(runtime.writePolicy, 'disabled');
  assert.equal(runtime.backgroundJobs, false);
  const defaultLabWritePolicy = policy.resolveAnaRuntimeConfig(
    labEnv(expectedFingerprint, { LAB_WRITE_POLICY: undefined })
  );
  assert.equal(defaultLabWritePolicy.mode, 'lab');
  assert.equal(defaultLabWritePolicy.writePolicy, 'disabled');

  const serverModule = await import('../src/webhookServer');
  const calendar = await import('../src/services/calendarService');
  const cancellationV2 = await import(
    '../src/services/cancelAppointmentV2Authorized'
  );
  const escalation = await import('../src/services/questionEscalation');
  const v2Runtime = await import('../src/services/conversationalV2/runtime');
  const replyGuard = await import('../src/services/customerReplyGuard');
  const whatsapp = await import('../src/whatsappCloudService');
  const context = await import('../src/services/contextManager');
  const pause = await import('../src/services/pauseService');
  const resume = await import('../src/services/anaResumeGate');
  const inboundOutbox = await import('../src/services/inboundOutbox');
  const sentryConfig = await import('../src/observability/sentryConfig');
  assert.equal(
    sentryConfig.RECEPS_IA_SENTRY_SCOPE.tags.runtime_mode,
    'lab'
  );

  const baseConfig = {
    tenantSlug: 'studio-viti',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'smoke',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0,
    aiMaxTokens: 32,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: '',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN-LAB-SMOKE',
    isActive: true,
  } satisfies import('../src/configProvider').TenantBotConfig;

  assert.equal(runtime.mode, 'lab');
  serverModule.authorizeLabWebhookValue(
    { metadata: { phone_number_id: 'PN-LAB-SMOKE' } },
    baseConfig,
    runtime
  );
  assert.throws(
    () =>
      serverModule.authorizeLabWebhookValue(
        { metadata: { phone_number_id: 'PN-OTHER' } },
        baseConfig,
        runtime
      ),
    (error: unknown) =>
      error instanceof serverModule.LabWebhookRejectedError &&
      error.reason === 'phone_number_not_allowed'
  );
  assert.throws(
    () =>
      serverModule.authorizeLabWebhookValue(
        { metadata: { phone_number_id: 'PN-LAB-SMOKE' } },
        { ...baseConfig, tenantSlug: 'other-tenant' },
        runtime
      ),
    (error: unknown) =>
      error instanceof serverModule.LabWebhookRejectedError &&
      error.reason === 'tenant_slug_not_allowed'
  );
  assert.throws(
    () =>
      serverModule.authorizeLabWebhookValue(
        { metadata: { phone_number_id: 'PN-LAB-SMOKE' } },
        { ...baseConfig, botRole: 'sales' },
        runtime
      ),
    (error: unknown) =>
      error instanceof serverModule.LabWebhookRejectedError &&
      error.reason === 'tenant_role_not_allowed'
  );
  assert.throws(
    () =>
      serverModule.authorizeLabWebhookValue(
        { metadata: { phone_number_id: 'PN-LAB-SMOKE' } },
        { ...baseConfig, phoneNumberId: 'PN-CONFIG-MISMATCH' },
        runtime
      ),
    (error: unknown) =>
      error instanceof serverModule.LabWebhookRejectedError &&
      error.reason === 'tenant_phone_mismatch'
  );
  assert.throws(
    () =>
      serverModule.authorizeLabWebhookValue(
        { metadata: { phone_number_id: 'PN-LAB-SMOKE' } },
        { ...baseConfig, isActive: false },
        runtime
      ),
    (error: unknown) =>
      error instanceof serverModule.LabWebhookRejectedError &&
      error.reason === 'tenant_inactive'
  );

  // Use operations inline so completion order is observed deterministically.
  const labBootEvents: string[] = [];
  const productionBootEvents: string[] = [];
  const makeOperations = (
    events: string[]
  ): serverModule.RuntimeBootOperations => {
    const push = (name: string) => async () => {
      events.push(name);
    };
    return {
      validateLabSchema: async () => events.push('validateLabSchema'),
      ensureProcessedMessages: push('ensureProcessedMessages'),
      ensureAnaWave2: push('ensureAnaWave2'),
      ensureSilentEscalationHold: push('ensureSilentEscalationHold'),
      startSilentEscalationHold: push('startSilentEscalationHoldSweep'),
      ensureConversationalV2: push('ensureConversationalV2'),
      startConversationalV2: push('startConversationalV2Sweep'),
      startConversationalV2Successor: push(
        'startConversationalV2SuccessorSweep'
      ),
      runRetentionOnce: push('runAnaRetention'),
      startRetentionScheduler: push('startAnaRetentionScheduler'),
      startInboundOutbox: push('startInboundOutboxSweep'),
      startWhatsAppStatusCallback: push(
        'startWhatsAppStatusCallbackSweep'
      ),
      ensureSalesFollowups: push('ensureSalesFollowups'),
      startSalesFollowup: push('startFollowupPoller'),
      initializeVoiceStorageAndProbe: push('initializeVoiceStorageAndProbe'),
    };
  };
  await serverModule.initializeRuntimeServices(
    runtime,
    makeOperations(labBootEvents),
    'studio-viti'
  );
  assert.deepEqual(labBootEvents, ['validateLabSchema']);
  await serverModule.initializeRuntimeServices(
    productionDefault,
    makeOperations(productionBootEvents),
    'studio-viti'
  );
  assert.deepEqual(productionBootEvents, [
    'ensureProcessedMessages',
    'ensureAnaWave2',
    'ensureSilentEscalationHold',
    'startSilentEscalationHoldSweep',
    'ensureConversationalV2',
    'startConversationalV2Sweep',
    'startConversationalV2SuccessorSweep',
    'runAnaRetention',
    'startAnaRetentionScheduler',
    'startInboundOutboxSweep',
    'startWhatsAppStatusCallbackSweep',
    'ensureSalesFollowups',
    'startFollowupPoller',
    'initializeVoiceStorageAndProbe',
  ]);
  const explicitProductionBootEvents: string[] = [];
  await serverModule.initializeRuntimeServices(
    productionExplicit,
    makeOperations(explicitProductionBootEvents),
    'studio-viti'
  );
  assert.deepEqual(
    explicitProductionBootEvents,
    productionBootEvents,
    'boot production explícito e default precisam executar a mesma sequência'
  );

  calendar.__seedServicesCacheForTest('studio-viti', {
    success: true,
    services: [
      {
        id: 'service-smoke-id',
        name: 'Serviço Smoke',
        durationMinutes: 30,
        price: null,
        priceFormatted: null,
        professionalIds: [],
      },
    ],
    professionals: [],
  });
  const servicesRead = await calendar.getServices(baseConfig);
  assert.equal(servicesRead.success, true, 'getServices continua permitido no LAB');
  const availabilityRead = await calendar.getAvailableSlots(
    '2000-01-01',
    'service-smoke-id',
    baseConfig
  );
  assert.equal(
    'reason' in availabilityRead &&
      availabilityRead.reason === 'lab_write_disabled',
    false,
    'getAvailableSlots não pode cair na write policy do LAB'
  );

  const booking = await calendar.bookAppointment(
    '2030-01-01',
    '10:00',
    'service-smoke-id',
    'customer-smoke',
    'Cliente',
    baseConfig
  );
  assert.deepEqual(
    {
      class: booking.class,
      outcome: booking.outcome,
      writeCommitted: booking.writeCommitted,
      reason: booking.reason,
    },
    {
      class: 'write',
      outcome: 'blocked',
      writeCommitted: false,
      reason: 'lab_write_disabled',
    }
  );

  let cancelReadCalls = 0;
  let cancelPostCalls = 0;
  const cancellation = await calendar.cancelAppointment(
    'appointment-smoke',
    'customer-smoke',
    baseConfig,
    'cancelar',
    {
      getUpcomingAppointments: async () => {
        cancelReadCalls += 1;
        return { success: true, appointments: [] };
      },
      postCancel: async () => {
        cancelPostCalls += 1;
      },
    }
  );
  assert.equal(cancellation.reason, 'lab_write_disabled');
  assert.equal(cancelReadCalls, 0);
  assert.equal(cancelPostCalls, 0);

  let cancelV2ReadCalls = 0;
  let cancelV2PostCalls = 0;
  const cancellationV2Result = await cancellationV2.cancelAppointmentV2Authorized({
    phone: 'customer-smoke',
    config: baseConfig,
    pending: null,
    flow: undefined,
    token: 'cancel-target:smoke' as never,
    deps: {
      getUpcomingAppointments: async () => {
        cancelV2ReadCalls += 1;
        return { success: true, appointments: [] };
      },
      postCancel: async () => {
        cancelV2PostCalls += 1;
      },
    },
  });
  assert.equal(cancellationV2Result.reason, 'lab_write_disabled');
  assert.equal(cancellationV2Result.posted, false);
  assert.equal(cancelV2ReadCalls, 0);
  assert.equal(cancelV2PostCalls, 0);

  let escalationPostCalls = 0;
  const escalationResult = await escalation.escalateQuestion(
    {
      phoneNumberId: 'PN-LAB-SMOKE',
      customerPhone: 'customer-smoke',
      reasonCode: 'HUMAN_REQUEST',
      messageId: 'message-smoke',
    },
    {
      post: async () => {
        escalationPostCalls += 1;
        return { questionId: 'should-not-exist' };
      },
    }
  );
  assert.equal(escalationResult.kind, 'blocked');
  assert.equal(escalationPostCalls, 0);

  let pausePostCalls = 0;
  await pause.pauseConversationByEcho(
    'PN-LAB-SMOKE',
    'customer-pause-smoke',
    {
      now: () => Date.now(),
      persistPause: async () => {
        pausePostCalls += 1;
        return null;
      },
    }
  );
  assert.equal(pausePostCalls, 0, 'echo LAB não faz POST de pausa no ERP');
  assert.notEqual(
    pause.peekLocalEchoLatch('PN-LAB-SMOKE', 'customer-pause-smoke'),
    null,
    'echo LAB mantém latch local'
  );
  pause.releaseLocalEchoPauseAfterAnaResume(
    'PN-LAB-SMOKE',
    'customer-pause-smoke'
  );

  let resumeBeginCalls = 0;
  const resumeWithoutHuman = await resume.evaluateAnaResumeForInbound(
    {
      config: baseConfig,
      customerPhone: 'customer-resume-smoke',
      inboundText: 'quero saber os horários',
    },
    {
      begin: async () => {
        resumeBeginCalls += 1;
        return { action: 'PROCEED' };
      },
      loadHistory: async () => [],
    }
  );
  assert.equal(resumeWithoutHuman.allowed, true);
  assert.equal(resumeBeginCalls, 0, 'resume LAB não faz POST begin no ERP');
  const humanHistory = [
    {
      role: 'assistant' as const,
      content: '[atendente] atendimento humano smoke',
      createdAt: '2026-08-27T12:00:00.000Z',
    },
  ];
  const resumeAfterHuman = await resume.evaluateAnaResumeForInbound(
    {
      config: baseConfig,
      customerPhone: 'customer-resume-smoke',
      inboundText: 'quero saber os horários',
    },
    { loadHistory: async () => humanHistory }
  );
  assert.equal(resumeAfterHuman.allowed, false, 'echo humano mantém LAB silencioso');
  const explicitResume = await resume.evaluateAnaResumeForInbound(
    {
      config: baseConfig,
      customerPhone: 'customer-resume-smoke',
      inboundText: 'quero falar com a Ana',
    },
    { loadHistory: async () => humanHistory }
  );
  assert.equal(explicitResume.allowed, true);
  assert.equal(resumeBeginCalls, 0, 'resume explícito LAB também não faz POST ERP');

  let inboundPostCalls = 0;
  let inboundTerminalMarks = 0;
  const inboundRow: inboundOutbox.InboundOutboxRow = {
    messageId: 'message-inbound-smoke',
    phoneNumberId: 'PN-LAB-SMOKE',
    conversationKey: 'PN-LAB-SMOKE:customer-smoke',
    receivedAt: new Date('2026-08-27T12:00:00.000Z'),
    messageType: 'text',
    contentStatus: 'final',
    content: 'mensagem smoke',
    contentOriginalLength: 14,
    attempts: 0,
    nextRetryAt: new Date('2026-08-27T12:00:00.000Z'),
    deliveredAt: null,
    terminalAt: null,
    failureCode: null,
  };
  const inboundStore: inboundOutbox.InboundOutboxStore = {
    load: async () => inboundRow,
    markDelivered: async () => undefined,
    markFailure: async () => undefined,
    markTerminal: async () => {
      inboundTerminalMarks += 1;
    },
    reprocessQuarantined: async () => false,
    listReady: async () => [],
    hasPending: async () => false,
  };
  const inboundDelivery = await inboundOutbox.attemptInboundDeliveryOnce(
    inboundRow.messageId,
    {
      store: inboundStore,
      postInbound: async () => {
        inboundPostCalls += 1;
        return {};
      },
      wait: async () => undefined,
      now: Date.now,
    }
  );
  assert.equal(inboundDelivery.reason, 'lab_write_disabled');
  assert.equal(inboundPostCalls, 0);
  assert.equal(inboundTerminalMarks, 1);

  const blockedResult = JSON.stringify(booking);
  const effect = v2Runtime.toolEffects({
    rawReply: null,
    exhausted: false,
    provider: 'openai',
    model: 'smoke',
    providerReportedModels: [],
    rounds: 1,
    messages: [],
    usage: [],
    toolTrace: [
      {
        round: 1,
        name: 'bookAppointment',
        args: {},
        argumentsValidJson: true,
        result: blockedResult,
      },
    ],
  });
  assert.deepEqual(effect[0], {
    invocationId: 'tool-r1-i0',
    tool: 'bookAppointment',
    class: 'write',
    outcome: 'blocked',
    writeCommitted: false,
    reason: 'lab_write_disabled',
  });
  assert.equal(
    replyGuard.buildSafeWriteConfirmation([
      { name: 'bookAppointment', result: blockedResult },
    ]),
    null,
    'write bloqueado não pode gerar confirmação de agendamento'
  );

  let outboundCalls = 0;
  await whatsapp.sendAudioMessage(
    'customer-smoke',
    'media-smoke',
    baseConfig,
    async () => {
      outboundCalls += 1;
      return { data: {} };
    }
  );
  assert.equal(outboundCalls, 1, 'outbound do phone LAB continua permitido');
  await assert.rejects(
    () =>
      whatsapp.sendAudioMessage(
        'customer-smoke',
        'media-smoke',
        { ...baseConfig, phoneNumberId: 'PN-OTHER' },
        async () => {
          outboundCalls += 1;
          return { data: {} };
        }
      ),
    /cerca do LAB/i
  );
  assert.equal(outboundCalls, 1, 'outbound fora da allowlist não chama transporte');

  let configResponse: import('../src/configProvider').TenantBotConfig | null =
    baseConfig;
  let messageHandlerCalls = 0;
  let echoHandlerCalls = 0;
  let statusHandlerCalls = 0;
  serverModule.__setWebhookStatusConfigLoaderForTest(async () => configResponse);
  serverModule.__setWebhookMessageHandlerForTest(async () => {
    messageHandlerCalls += 1;
  });
  serverModule.__setWebhookEchoHandlerForTest(async () => {
    echoHandlerCalls += 1;
  });
  serverModule.__setWebhookStatusHandlerForTest(async () => {
    statusHandlerCalls += 1;
    return 0;
  });

  const server = await new Promise<http.Server>((resolve) => {
    const started = serverModule.app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const port = (server.address() as AddressInfo).port;
  const message = {
    from: 'customer-smoke',
    id: 'message-smoke',
    timestamp: '1',
    type: 'text',
    text: { body: 'mensagem smoke' },
  };
  const payload = (phoneNumberId?: string) => ({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              ...(phoneNumberId
                ? { metadata: { phone_number_id: phoneNumberId } }
                : {}),
              messages: [message],
            },
          },
        ],
      },
    ],
  });

  try {
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload('PN-LAB-SMOKE') })).status,
      200
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messageHandlerCalls, 1, 'inbound Viti autorizado');

    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload('PN-OTHER') })).status,
      503
    );
    assert.equal(messageHandlerCalls, 1, 'outro phone bloqueado antes do handler');

    configResponse = { ...baseConfig, tenantSlug: 'other-tenant' };
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload('PN-LAB-SMOKE') })).status,
      503
    );
    assert.equal(messageHandlerCalls, 1, 'outro tenant bloqueado antes do handler');

    configResponse = { ...baseConfig, botRole: 'sales' };
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload('PN-LAB-SMOKE') })).status,
      503
    );
    assert.equal(messageHandlerCalls, 1, 'sales bloqueada antes do handler');

    configResponse = baseConfig;
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload() })).status,
      503,
      'LAB sem metadata não usa WA_PHONE_NUMBER_ID'
    );
    assert.equal(messageHandlerCalls, 1);

    const echoWithoutMetadata = {
      entry: [
        {
          changes: [
            {
              field: 'smb_message_echoes',
              value: { message_echoes: [{ to: 'customer-smoke' }] },
            },
          ],
        },
      ],
    };
    assert.equal(
      (
        await request(port, {
          method: 'POST',
          path: '/webhook',
          body: echoWithoutMetadata,
        })
      ).status,
      503
    );
    assert.equal(echoHandlerCalls, 0, 'echo incompleto bloqueado antes do handler');

    const statusWithoutMetadata = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  { id: 'status-smoke', status: 'sent', timestamp: '1' },
                ],
              },
            },
          ],
        },
      ],
    };
    assert.equal(
      (
        await request(port, {
          method: 'POST',
          path: '/webhook',
          body: statusWithoutMetadata,
        })
      ).status,
      503
    );
    assert.equal(statusHandlerCalls, 0, 'status incompleto bloqueado antes do handler');

    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    const healthBody = JSON.parse(health.body) as Record<string, unknown>;
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.runtimeMode, 'lab');
    assert.equal(healthBody.writePolicy, 'disabled');
    assert.equal(healthBody.backgroundJobs, false);
    for (const forbidden of [
      process.env.DATABASE_URL!,
      expectedFingerprint,
      baseConfig.phoneNumberId,
      baseConfig.tenantSlug,
      baseConfig.waAccessToken,
    ].filter(Boolean)) {
      assert.equal(health.body.includes(forbidden), false);
    }
    const adminBlocked = await request(port, {
      method: 'POST',
      path: '/admin/reset-conversation',
      body: {},
    });
    assert.equal(adminBlocked.status, 423);
    assert.equal(
      (JSON.parse(adminBlocked.body) as { reason?: unknown }).reason,
      'lab_write_disabled'
    );

    process.env.ANA_RUNTIME_MODE = 'production';
    configResponse = baseConfig;
    const productionBefore = messageHandlerCalls;
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload() })).status,
      200,
      'produção preserva fallback legado sem metadata'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messageHandlerCalls, productionBefore + 1);
    delete process.env.ANA_RUNTIME_MODE;
    const productionDefaultBefore = messageHandlerCalls;
    assert.equal(
      (await request(port, { method: 'POST', path: '/webhook', body: payload() })).status,
      200,
      'produção default preserva fallback legado sem metadata'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messageHandlerCalls, productionDefaultBefore + 1);
    const productionHealth = await request(port, {
      method: 'GET',
      path: '/health',
    });
    const productionHealthBody = JSON.parse(productionHealth.body) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(productionHealthBody).sort(), ['status', 'ts']);
  } finally {
    process.env.ANA_RUNTIME_MODE = 'lab';
    serverModule.__setWebhookStatusConfigLoaderForTest();
    serverModule.__setWebhookMessageHandlerForTest();
    serverModule.__setWebhookEchoHandlerForTest();
    serverModule.__setWebhookStatusHandlerForTest();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await context.pool.end();
  }

  console.log('smoke-ana-lab-runtime: ok');
}

void main().catch((error) => {
  console.error(
    `smoke-ana-lab-runtime: failed | error_kind=${
      error instanceof Error ? error.name : typeof error
    }`
  );
  process.exitCode = 1;
});
