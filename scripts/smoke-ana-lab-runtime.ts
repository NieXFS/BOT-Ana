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
process.env.ANA_LAB_ALLOWED_CUSTOMER_PHONES = '+55 (11) 99900-0101';
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
    ANA_LAB_ALLOWED_CUSTOMER_PHONES: '+55 (11) 99900-0101',
    ANA_CONVERSATIONAL_V2_TENANT_SLUGS: 'studio-viti',
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
          ANA_LAB_ALLOWED_CUSTOMER_PHONES: undefined,
        })
      ),
    'CUSTOMER_PHONES'
  );
  expectThrowMessage(
    () =>
      policy.resolveAnaRuntimeConfig(
        labEnv(expectedFingerprint, {
          ANA_LAB_ALLOWED_CUSTOMER_PHONES: '*',
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
  for (const directDatabaseName of [
    'RECEPS_IA_DIRECT_DATABASE_URL',
    'ANA_DIRECT_DATABASE_URL',
  ]) {
    expectThrowMessage(
      () =>
        policy.resolveAnaRuntimeConfig(
          labEnv(expectedFingerprint, {
            [directDatabaseName]:
              'postgresql://smoke:smoke@127.0.0.1:1/other',
          })
        ),
      'exclusivamente DATABASE_URL'
    );
  }

  const runtime = policy.resolveAnaRuntimeConfig(
    labEnv(expectedFingerprint)
  );
  assert.equal(runtime.mode, 'lab');
  assert.equal(runtime.writePolicy, 'disabled');
  assert.equal(runtime.globalBackgroundJobs, false);
  assert.equal(runtime.v2RecoveryJobs, true);
  assert.equal(runtime.allowedCustomerPhones.has('5511999000101'), true);
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
  const v2Delivery = await import('../src/services/conversationalV2/delivery');
  const v2StateStore = await import('../src/services/conversationalV2/stateStore');
  const successorProcessor = await import(
    '../src/services/conversationalV2/successorProcessor'
  );
  const silentHold = await import('../src/services/silentEscalationHold');
  const replyGuard = await import('../src/services/customerReplyGuard');
  const whatsapp = await import('../src/whatsappCloudService');
  const context = await import('../src/services/contextManager');
  const pause = await import('../src/services/pauseService');
  const resume = await import('../src/services/anaResumeGate');
  const inboundOutbox = await import('../src/services/inboundOutbox');
  const whatsappStatus = await import('../src/services/whatsappStatusHandler');
  const providerStatus = await import(
    '../src/services/conversationalV2/providerStatus'
  );
  const labSchema = await import('../src/services/labSchema');
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

  const schemaDeps = (
    query: (
      sql: string,
      params?: readonly unknown[]
    ) => Promise<{ rows: Record<string, unknown>[] }>
  ): labSchema.LabSchemaQuery => ({
    query: query as unknown as import('pg').Pool['query'],
  });
  let productionCatalogReads = 0;
  await labSchema.assertProductionStorageIsNotLab(
    schemaDeps(async (sql, params = []) => {
      productionCatalogReads += 1;
      assert.match(sql, /to_regclass/i);
      assert.deepEqual(params, [labSchema.ANA_LAB_SCHEMA_MARKER_TABLE]);
      return { rows: [{ relation: null }] };
    })
  );
  assert.equal(productionCatalogReads, 1);
  await assert.rejects(
    () =>
      labSchema.assertProductionStorageIsNotLab(
        schemaDeps(async () => ({
          rows: [{ relation: labSchema.ANA_LAB_SCHEMA_MARKER_TABLE }],
        }))
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === labSchema.PRODUCTION_STORAGE_IS_LAB_ERROR
  );

  const completeLabSchema = schemaDeps(async (sql, params = []) => {
    if (/to_regclass/i.test(sql)) {
      return { rows: [{ relation: String(params[0]) }] };
    }
    if (sql.includes(`FROM ${labSchema.ANA_LAB_SCHEMA_MARKER_TABLE}`)) {
      return {
        rows: [
          {
            schema_version: labSchema.ANA_LAB_SCHEMA_VERSION,
            database_fingerprint: expectedFingerprint,
          },
        ],
      };
    }
    throw new Error('unexpected LAB schema smoke query');
  });
  await labSchema.validateLabSchema(expectedFingerprint, completeLabSchema);
  await assert.rejects(
    () =>
      labSchema.validateLabSchema(
        expectedFingerprint,
        schemaDeps(async (sql, params = []) => {
          if (/to_regclass/i.test(sql)) {
            return {
              rows: [
                {
                  relation:
                    params[0] === labSchema.ANA_LAB_SCHEMA_MARKER_TABLE
                      ? null
                      : String(params[0]),
                },
              ],
            };
          }
          throw new Error('marker ausente não deve ler rows operacionais');
        })
      ),
    /Schema LAB ausente ou incompleto/
  );
  await assert.rejects(
    () =>
      labSchema.validateLabSchema(
        expectedFingerprint,
        schemaDeps(async (sql, params = []) => {
          if (/to_regclass/i.test(sql)) {
            return { rows: [{ relation: String(params[0]) }] };
          }
          return {
            rows: [
              {
                schema_version: labSchema.ANA_LAB_SCHEMA_VERSION,
                database_fingerprint: '0'.repeat(64),
              },
            ],
          };
        })
      ),
    /Identidade\/versão do schema LAB não confere/
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
      assertProductionStorageIsNotLab: push(
        'assertProductionStorageIsNotLab'
      ),
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
      startProviderStatusV2Recovery: push(
        'startProviderStatusV2RecoverySweep'
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
  assert.deepEqual(labBootEvents, [
    'validateLabSchema',
    'startConversationalV2Sweep',
    'startConversationalV2SuccessorSweep',
    'startProviderStatusV2RecoverySweep',
  ]);
  const labV2Disabled = policy.resolveAnaRuntimeConfig(
    labEnv(expectedFingerprint, {
      ANA_CONVERSATIONAL_V2_TENANT_SLUGS: undefined,
    })
  );
  assert.equal(labV2Disabled.mode, 'lab');
  assert.equal(labV2Disabled.v2RecoveryJobs, false);
  const labV2DisabledBootEvents: string[] = [];
  await serverModule.initializeRuntimeServices(
    labV2Disabled,
    makeOperations(labV2DisabledBootEvents),
    ''
  );
  assert.deepEqual(labV2DisabledBootEvents, ['validateLabSchema']);
  await serverModule.initializeRuntimeServices(
    productionDefault,
    makeOperations(productionBootEvents),
    'studio-viti'
  );
  assert.deepEqual(productionBootEvents, [
    'assertProductionStorageIsNotLab',
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
  const reverseFenceBootEvents: string[] = [];
  const reverseFenceOperations = makeOperations(reverseFenceBootEvents);
  reverseFenceOperations.assertProductionStorageIsNotLab = async () => {
    reverseFenceBootEvents.push('assertProductionStorageIsNotLab');
    throw new Error(labSchema.PRODUCTION_STORAGE_IS_LAB_ERROR);
  };
  await assert.rejects(
    () =>
      serverModule.initializeRuntimeServices(
        productionDefault,
        reverseFenceOperations,
        'studio-viti'
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === labSchema.PRODUCTION_STORAGE_IS_LAB_ERROR
  );
  assert.deepEqual(reverseFenceBootEvents, [
    'assertProductionStorageIsNotLab',
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

  // LAB: rejeição primária + rejeição da regeneração chega ao ramo de escalada
  // silenciosa, mas vira fallback visível local sem POST, hold ou cutoff humano.
  silentHold.__resetSilentEscalationHoldForTest();
  const labSilentStateStore = new v2StateStore.MemoryConversationalV2StateStore();
  const labSilentHoldStore = new silentHold.MemorySilentEscalationHoldStore();
  const labSilentPhone = '5511999000101';
  const labSilentConversationKey = context.buildConversationKey(
    baseConfig.phoneNumberId,
    labSilentPhone
  );
  let labSilentEscalationPostCalls = 0;
  let labSilentToolCalls = 0;
  let labSilentPrimaryCalls = 0;
  let labSilentRegenCalls = 0;
  let labSilentId = 0;
  const prepareRejectedLabTurn = async (
    inputSequence: number,
    inboundMessageId: string
  ) => {
    labSilentStateStore.setInputSequence(
      labSilentConversationKey,
      inputSequence
    );
    return v2Runtime.getReceptionistReplyV2({
      phone: labSilentPhone,
      userMessage: 'mensagem sintética incompreensível',
      userName: 'Cliente Fixture',
      config: baseConfig,
      turnRuntime: {
        turnId: `turn-lab-silent-${inputSequence}`,
        inputSequence,
        currentInboundIds: [inboundMessageId],
        currentInboundTextsById: {
          [inboundMessageId]: 'mensagem sintética incompreensível',
        },
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: inputSequence,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
      },
      deps: {
        store: labSilentStateStore,
        now: () => new Date('2026-08-27T12:00:00.000Z'),
        id: () => `lab-silent-id-${++labSilentId}`,
        loadServices: async () => ({
          success: true,
          services: [],
          professionals: [],
        }),
        loadHistory: async () => [],
        isPaused: async () => false,
        interpreterEnabled: false,
        runModelLoop: async () => {
          labSilentPrimaryCalls += 1;
          return {
            rawReply: '{',
            exhausted: false,
            provider: 'openai',
            model: 'gpt-4o-mini',
            providerReportedModels: ['gpt-4o-mini'],
            rounds: 1,
            messages: [],
            toolTrace: [],
            usage: [],
          };
        },
        regenerate: async () => {
          labSilentRegenCalls += 1;
          return {
            ok: false,
            reasonCode: 'REGEN_MODEL_RESULT_INVALID',
            providerCalls: 1,
          };
        },
        executeTool: async () => {
          labSilentToolCalls += 1;
          throw new Error('LAB silent escalation não executa tool');
        },
        escalateSilentDeps: {
          holdStore: labSilentHoldStore,
          post: async () => {
            labSilentEscalationPostCalls += 1;
            return { questionId: 'must-not-exist' };
          },
          wait: async () => undefined,
        },
      },
    });
  };

  const firstLabSilentPrepared = await prepareRejectedLabTurn(
    1,
    'wamid-lab-silent-1'
  );
  assert.notEqual(firstLabSilentPrepared.payload, null);
  assert.equal(firstLabSilentPrepared.planReceipt.recoveryKind, 'direct_fallback');
  assert.equal(labSilentEscalationPostCalls, 0);
  assert.equal(labSilentToolCalls, 0);
  assert.equal(
    await labSilentHoldStore.loadByMessageId('wamid-lab-silent-1'),
    null
  );
  assert.deepEqual(
    await labSilentHoldStore.listReady(
      10,
      new Date('2026-08-27T12:00:00.000Z')
    ),
    []
  );
  assert.equal(
    labSilentStateStore.flowStateInvalidations.has(labSilentConversationKey),
    false,
    'LAB não grava cutoff SILENT_ESCALATION'
  );
  let labVisibleTransportCalls = 0;
  const firstLabSilentDelivered = await v2Delivery.deliverPreparedReceptionistTurnV2(
    firstLabSilentPrepared,
    {
      store: labSilentStateStore,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      id: () => `lab-silent-delivery-${++labSilentId}`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        labVisibleTransportCalls += 1;
        return { providerMessageId: 'wamid-provider-lab-silent-1' };
      },
    }
  );
  assert.equal(firstLabSilentDelivered.delivery, 'sent');
  assert.equal(labVisibleTransportCalls, 1);
  assert.equal(
    (
      await silentHold.lookupSilentEscalationHold(
        baseConfig.phoneNumberId,
        labSilentPhone,
        labSilentHoldStore
      )
    ).kind,
    'inactive'
  );

  const secondLabSilentPrepared = await prepareRejectedLabTurn(
    2,
    'wamid-lab-silent-2'
  );
  assert.notEqual(
    secondLabSilentPrepared.payload,
    null,
    'próximo inbound não é suprimido por hold residual'
  );
  assert.equal(labSilentEscalationPostCalls, 0);
  assert.equal(labSilentPrimaryCalls, 2);
  assert.equal(labSilentRegenCalls, 2);
  assert.equal(labSilentToolCalls, 0);

  // Recovery local: crash entre início do transporte e recibo vira unknown,
  // deixa de bloquear inbound e nunca repete o transporte.
  const staleRecoveryStore = new v2StateStore.MemoryConversationalV2StateStore();
  await staleRecoveryStore.prepareOutbound({
    deliveryAttemptId: 'delivery-lab-stale',
    conversationKey: labSilentConversationKey,
    turnId: 'turn-lab-stale',
    planReceiptId: 'plan-lab-stale',
    payload: firstLabSilentPrepared.payload!,
    transition: firstLabSilentPrepared.transition,
    now: new Date('2026-08-27T11:55:00.000Z'),
  });
  await staleRecoveryStore.markTransportStarted(
    'delivery-lab-stale',
    new Date('2026-08-27T11:55:00.000Z')
  );
  const staleSweep = await staleRecoveryStore.sweep(
    new Date('2026-08-27T12:00:00.000Z')
  );
  assert.equal(staleSweep.unknownMarked, 1);
  assert.equal(
    staleRecoveryStore.outbox.get('delivery-lab-stale')?.state,
    'transport_unknown'
  );
  assert.equal(
    (await staleRecoveryStore.inspectInboundGuard(labSilentConversationKey)).kind,
    'clear'
  );
  assert.equal(staleRecoveryStore.transportPostCount, 1);

  // Recovery local: aceite conhecido com commit interrompido é concluído pelo
  // sweep no state store, sem um segundo POST/transporte.
  const acceptedRecoveryStore = new v2StateStore.MemoryConversationalV2StateStore();
  acceptedRecoveryStore.setInputSequence(labSilentConversationKey, 1);
  acceptedRecoveryStore.failNextAcceptedCommit = true;
  let acceptedRecoveryTransportCalls = 0;
  const acceptedUncommitted = await v2Delivery.deliverPreparedReceptionistTurnV2(
    firstLabSilentPrepared,
    {
      store: acceptedRecoveryStore,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      id: () => `lab-accepted-recovery-${++labSilentId}`,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        acceptedRecoveryTransportCalls += 1;
        return { providerMessageId: 'wamid-provider-accepted-recovery' };
      },
    }
  );
  assert.equal(acceptedUncommitted.receipt.outboxState, 'accepted_uncommitted');
  const acceptedRecoverySweep = await acceptedRecoveryStore.sweep(
    new Date('2026-08-27T12:00:01.000Z')
  );
  assert.equal(acceptedRecoverySweep.reconciled, 1);
  assert.equal(acceptedRecoveryTransportCalls, 1);
  assert.equal(
    [...acceptedRecoveryStore.outbox.values()][0]?.state,
    'accepted_by_provider'
  );

  // Successor retomado após restart: o write de negócio continua bloqueado e
  // o transporte só é alcançado para customer permitido.
  const successorStore = new v2StateStore.MemoryConversationalV2StateStore();
  const successorQueuedAt = new Date('2026-08-27T12:00:00.000Z');
  const successorReadyAt = new Date(
    successorQueuedAt.getTime() + v2StateStore.SUCCESSOR_REARM_DEBOUNCE_MS_V2
  );
  await successorStore.enqueueSuccessor({
    successorTurnId: 'successor-lab-allowed',
    sourceTurnId: 'source-lab-allowed',
    conversationKey: labSilentConversationKey,
    phoneNumberId: baseConfig.phoneNumberId,
    customerPhone: labSilentPhone,
    inputSequence: 2,
    inboundMessageIds: ['wamid-successor-lab-allowed'],
    requiresAuthoritativeRead: false,
    reprocessCount: 0,
    now: successorQueuedAt,
  });
  let successorBusinessPostCalls = 0;
  let successorOutboundTransportCalls = 0;
  const resumedSuccessors = await successorProcessor.sweepSuccessorBatchesV2(
    {
      store: successorStore,
      now: () => successorReadyAt,
      process: async (batch) => {
        const blockedCancellation = await calendar.cancelAppointment(
          'appointment-successor-smoke',
          batch.customerPhone,
          baseConfig,
          'cancelar',
          {
            getUpcomingAppointments: async () => ({
              success: true,
              appointments: [],
            }),
            postCancel: async () => {
              successorBusinessPostCalls += 1;
            },
          }
        );
        assert.equal(blockedCancellation.reason, 'lab_write_disabled');
        await whatsapp.sendAudioMessage(
          batch.customerPhone,
          'media-successor-smoke',
          baseConfig,
          async () => {
            successorOutboundTransportCalls += 1;
            return { data: {} };
          }
        );
      },
      fallback: async () => {
        throw new Error('successor LAB permitido não usa fallback');
      },
    },
    10
  );
  assert.equal(resumedSuccessors, 1);
  assert.equal(successorBusinessPostCalls, 0);
  assert.equal(successorOutboundTransportCalls, 1);
  assert.equal(
    successorStore.successors.get('successor-lab-allowed')?.status,
    'completed'
  );

  await successorStore.enqueueSuccessor({
    successorTurnId: 'successor-lab-blocked-customer',
    sourceTurnId: 'source-lab-blocked-customer',
    conversationKey: `${baseConfig.phoneNumberId}:5511999000199`,
    phoneNumberId: baseConfig.phoneNumberId,
    customerPhone: '5511999000199',
    inputSequence: 1,
    inboundMessageIds: ['wamid-successor-lab-blocked-customer'],
    requiresAuthoritativeRead: false,
    reprocessCount: 0,
    now: successorQueuedAt,
  });
  const blockedCustomerSuccessors =
    await successorProcessor.sweepSuccessorBatchesV2(
      {
        store: successorStore,
        now: () => successorReadyAt,
        process: async (batch) => {
          await whatsapp.sendAudioMessage(
            batch.customerPhone,
            'media-successor-smoke',
            baseConfig,
            async () => {
              successorOutboundTransportCalls += 1;
              return { data: {} };
            }
          );
        },
        fallback: async () => undefined,
      },
      10
    );
  assert.equal(blockedCustomerSuccessors, 1);
  assert.equal(successorOutboundTransportCalls, 1);
  assert.equal(
    successorStore.successors.get('successor-lab-blocked-customer')?.status,
    'queued'
  );

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

  let statusCallbackPostCalls = 0;
  let statusCallbackFailureMarks = 0;
  let statusCallbackDismissals = 0;
  let statusCallbackDismissReason: string | null = null;
  const statusCallbackApplied = await whatsappStatus.handleWhatsAppStatuses(
    {
      statuses: [
        {
          id: 'wamid-status-lab-smoke',
          status: 'sent',
          timestamp: '1787832000',
        },
      ],
    },
    {
      store: {
        apply: async (event) => ({
          kind: 'applied',
          obligation: {
            phoneNumberId: baseConfig.phoneNumberId,
            providerMessageId: event.providerMessageId,
            statusEvent: event.statusEvent,
            occurredAt: event.occurredAt,
            failureCode: event.failureCode,
            version: 1,
            attempts: 0,
          },
        }),
        markCallbackAck: async () => true,
        markCallbackFailure: async () => {
          statusCallbackFailureMarks += 1;
          return true;
        },
        markCallbackDismissed: async (
          _providerMessageId,
          _statusEvent,
          _version,
          reason
        ) => {
          statusCallbackDismissals += 1;
          statusCallbackDismissReason = reason;
          return true;
        },
        listPendingCallbacks: async () => [],
      },
      postCallback: async () => {
        statusCallbackPostCalls += 1;
      },
      wait: async () => undefined,
      now: () => Date.parse('2026-08-27T12:00:00.000Z'),
    },
    { awaitCallbacks: true, allowV2Fallback: false }
  );
  assert.equal(statusCallbackApplied, 1);
  assert.equal(statusCallbackPostCalls, 0);
  assert.equal(statusCallbackFailureMarks, 0);
  assert.equal(statusCallbackDismissals, 1);
  assert.equal(statusCallbackDismissReason, 'LAB_WRITE_DISABLED');

  const pendingProviderStatusStore =
    new providerStatus.MemoryProviderStatusStoreV2();
  let providerRecoveryCallbackPosts = 0;
  let providerRecoveryHistoryRepairs = 0;
  const pendingProviderApplied = await whatsappStatus.handleWhatsAppStatuses(
    {
      statuses: [
        {
          id: 'wamid-provider-before-outbox-smoke',
          status: 'delivered',
          timestamp: '1787832000',
        },
      ],
    },
    {
      store: {
        apply: async () => ({ kind: 'unknown' }),
        markCallbackAck: async () => true,
        markCallbackFailure: async () => true,
        markCallbackDismissed: async () => true,
        listPendingCallbacks: async () => [],
      },
      providerStatusStore: pendingProviderStatusStore,
      postCallback: async () => {
        providerRecoveryCallbackPosts += 1;
      },
      repairHumanHistory: async () => {
        providerRecoveryHistoryRepairs += 1;
      },
      wait: async () => undefined,
      now: () => Date.parse('2026-08-27T12:00:00.000Z'),
    },
    { awaitCallbacks: false, allowV2Fallback: true }
  );
  assert.equal(pendingProviderApplied, 0);
  assert.equal(pendingProviderStatusStore.getEvents()[0]?.state, 'pending');
  const pendingProviderMessageHash = providerStatus.hashProviderMessageIdV2(
    'wamid-provider-before-outbox-smoke'
  );
  pendingProviderStatusStore.registerOutbox({
    deliveryAttemptId: 'delivery-attempt-provider-recovery-smoke',
    turnId: 'turn-provider-recovery-smoke',
    deliveryReceiptId: 'delivery-receipt-provider-recovery-smoke',
    providerMessageIdHash: pendingProviderMessageHash,
    providerStatus: null,
    providerStatusAt: null,
    providerFailureCode: null,
    providerStatusVersion: 0,
    outboxState: 'accepted_by_provider',
  });
  const providerRecoveryResult =
    await providerStatus.sweepProviderStatusRecoveryV2(
      pendingProviderStatusStore,
      new Date('2026-08-27T12:00:02.000Z')
    );
  assert.equal(providerRecoveryResult.attempted, 1);
  assert.equal(providerRecoveryResult.applied, 1);
  assert.equal(providerRecoveryResult.unmatched, 0);
  assert.equal(pendingProviderStatusStore.getEvents()[0]?.state, 'applied');
  assert.equal(
    pendingProviderStatusStore.getOutbox(pendingProviderMessageHash)
      ?.providerStatus,
    'delivered'
  );
  assert.equal(providerRecoveryCallbackPosts, 0);
  assert.equal(providerRecoveryHistoryRepairs, 0);

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
    '5511999000101',
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
        '5511999000199',
        'media-smoke',
        baseConfig,
        async () => {
          outboundCalls += 1;
          return { data: {} };
        }
      ),
    /destinatário bloqueado pela cerca do LAB/i
  );
  assert.equal(
    outboundCalls,
    1,
    'outbound Viti para customer diferente não chama transporte'
  );
  const axiosModule = await import('axios');
  const originalAxiosPost = axiosModule.default.post;
  axiosModule.default.post = (async () => {
    outboundCalls += 1;
    return { data: { messages: [{ id: 'wamid-smoke' }] } };
  }) as typeof axiosModule.default.post;
  try {
    await assert.rejects(
      () =>
        whatsapp.sendFreeformMessage(
          '5511999000199',
          'mensagem smoke',
          baseConfig
        ),
      /destinatário bloqueado pela cerca do LAB/i
    );
    await assert.rejects(
      () =>
        whatsapp.sendFreeformMessageWithReceipt(
          '5511999000199',
          'mensagem smoke',
          baseConfig
        ),
      /destinatário bloqueado pela cerca do LAB/i
    );
  } finally {
    axiosModule.default.post = originalAxiosPost;
  }
  assert.equal(
    outboundCalls,
    1,
    'texto livre e texto com recibo também bloqueiam antes do transporte'
  );
  await assert.rejects(
    () =>
      whatsapp.sendVideoMessage(
        '5511999000199',
        'media-smoke',
        baseConfig,
        async () => {
          outboundCalls += 1;
          return { data: {} };
        }
      ),
    /destinatário bloqueado pela cerca do LAB/i
  );
  assert.equal(outboundCalls, 1, 'vídeo também bloqueia antes do transporte');
  await assert.rejects(
    () =>
      whatsapp.sendAudioMessage(
        '5511999000101',
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
  let configLoaderCalls = 0;
  serverModule.__setWebhookStatusConfigLoaderForTest(async () => {
    configLoaderCalls += 1;
    return configResponse;
  });
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
    from: '5511999000101',
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

    const unauthorizedCustomerPayload = payload('PN-LAB-SMOKE');
    unauthorizedCustomerPayload.entry[0]!.changes[0]!.value.messages[0]!.from =
      '5511999000199';
    const configReadsBeforeUnauthorizedCustomer = configLoaderCalls;
    assert.equal(
      (
        await request(port, {
          method: 'POST',
          path: '/webhook',
          body: unauthorizedCustomerPayload,
        })
      ).status,
      503
    );
    assert.equal(messageHandlerCalls, 1, 'customer diferente bloqueado antes do handler');
    assert.equal(
      configLoaderCalls,
      configReadsBeforeUnauthorizedCustomer,
      'customer diferente bloqueado antes da leitura de config'
    );

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

    const unauthorizedEcho = {
      entry: [
        {
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                metadata: { phone_number_id: 'PN-LAB-SMOKE' },
                message_echoes: [{ to: '5511999000199' }],
              },
            },
          ],
        },
      ],
    };
    const configReadsBeforeUnauthorizedEcho = configLoaderCalls;
    assert.equal(
      (
        await request(port, {
          method: 'POST',
          path: '/webhook',
          body: unauthorizedEcho,
        })
      ).status,
      503
    );
    assert.equal(echoHandlerCalls, 0, 'echo para customer diferente bloqueado');
    assert.equal(configLoaderCalls, configReadsBeforeUnauthorizedEcho);

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
    assert.equal(healthBody.globalBackgroundJobs, false);
    assert.equal(healthBody.v2RecoveryJobs, true);
    assert.deepEqual(healthBody.localRecoveryJobs, {
      conversationalV2State: true,
      conversationalV2Successor: true,
      providerStatusV2: true,
    });
    for (const forbidden of [
      process.env.DATABASE_URL!,
      expectedFingerprint,
      baseConfig.phoneNumberId,
      baseConfig.tenantSlug,
      baseConfig.waAccessToken,
      process.env.ANA_LAB_ALLOWED_CUSTOMER_PHONES!,
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
    const productionDifferentCustomer = payload();
    productionDifferentCustomer.entry[0]!.changes[0]!.value.messages[0]!.from =
      'customer-production-unfenced';
    assert.equal(
      (
        await request(port, {
          method: 'POST',
          path: '/webhook',
          body: productionDifferentCustomer,
        })
      ).status,
      200,
      'produção continua sem customer fence LAB'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messageHandlerCalls, productionBefore + 2);
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
