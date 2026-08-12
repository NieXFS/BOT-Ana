process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.ANA_RESUME_GATE_ENABLED = 'true';

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';

const config: TenantBotConfig = {
  tenantSlug: 'tenant-seguro',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-RESUME',
  isActive: true,
};

const history = [
  {
    role: 'assistant' as const,
    content: '[atendente] pode deixar marcado para sexta às 13h',
    createdAt: '2026-08-11T11:37:00.000Z',
  },
  {
    role: 'user' as const,
    content: 'Foi agendado p as 13 horas c ela. Meu telefone é (11) 99999-8888.',
    createdAt: '2026-08-11T12:08:00.000Z',
  },
];

async function main() {
  const classifier = await import('../src/services/anaResumeClassifier');
  const gate = await import('../src/services/anaResumeGate');
  const messageHandler = await import('../src/messageHandler');

  const timeline = classifier.buildAnaResumeTimeline({
    history,
    config,
    customerName: 'Carla',
  });
  assert.equal(timeline[0]?.speaker, 'HUMAN');
  assert.equal(timeline[1]?.speaker, 'CUSTOMER');
  assert.equal(timeline[1]?.text.includes('99999'), false);
  assert.equal(classifier.hashAnaResumeTimeline(timeline).length, 64);
  assert.equal(
    classifier.hasExplicitAnaResumeAuthorization([
      timeline[0]!,
      { speaker: 'CUSTOMER', gap: 'MINUTES', text: 'Ana, pode continuar e ver os horários?' },
    ]),
    true
  );
  assert.equal(
    classifier.hasExplicitAnaResumeAuthorization([
      { speaker: 'HUMAN', gap: 'FIRST', text: 'A Ana pode continuar o agendamento' },
      { speaker: 'CUSTOMER', gap: 'MINUTES', text: 'Quero horários de terça' },
    ]),
    true
  );
  assert.equal(
    classifier.hasExplicitAnaResumeAuthorization([
      { speaker: 'HUMAN', gap: 'FIRST', text: 'A Ana não pode continuar ainda' },
      { speaker: 'CUSTOMER', gap: 'MINUTES', text: 'Quero horários de terça' },
    ]),
    false
  );

  assert.deepEqual(
    classifier.parseAnaResumeClassifierOutput(
      '{"decision":"KEEP_HUMAN","reasonCode":"HUMAN_HANDLED_REQUEST"}'
    ),
    { decision: 'KEEP_HUMAN', reasonCode: 'HUMAN_HANDLED_REQUEST' }
  );
  assert.equal(
    classifier.parseAnaResumeClassifierOutput(
      '{"decision":"RESUME_ANA","reasonCode":"HUMAN_HANDLED_REQUEST"}'
    ),
    null
  );
  assert.equal(
    classifier.parseAnaResumeClassifierOutput(
      '{"decision":"KEEP_HUMAN","reasonCode":"HUMAN_HANDLED_REQUEST","reply":"oi"}'
    ),
    null
  );
  assert.equal(classifier.parseAnaResumeClassifierOutput('```json {} ```'), null);

  let clock = 1_000;
  let providerCalls = 0;
  const keep = await classifier.classifyAnaResume(
    { history, config },
    {
      now: () => clock++,
      complete: async () => {
        providerCalls += 1;
        return '{"decision":"KEEP_HUMAN","reasonCode":"HUMAN_HANDLED_REQUEST"}';
      },
    }
  );
  assert.equal(keep.decision, 'KEEP_HUMAN');
  assert.equal(keep.reasonCode, 'HUMAN_HANDLED_REQUEST');
  assert.equal(providerCalls, 1);

  const invalid = await classifier.classifyAnaResume(
    { history, config },
    { now: () => 1_000, complete: async () => 'não sei' }
  );
  assert.equal(invalid.decision, 'UNCERTAIN');
  assert.equal(invalid.reasonCode, 'INVALID_MODEL_OUTPUT');

  const providerFailure = await classifier.classifyAnaResume(
    { history, config },
    {
      now: () => 1_000,
      complete: async () => {
        throw new Error('simulado');
      },
    }
  );
  assert.equal(providerFailure.reasonCode, 'PROVIDER_FAILURE');

  providerCalls = 0;
  const unavailable = await classifier.classifyAnaResume(
    {
      history: [
        {
          role: 'assistant',
          content: '[atendente] [áudio do atendente sem transcrição]',
          createdAt: '2026-08-11T11:37:00.000Z',
        },
        history[1]!,
      ],
      config,
    },
    {
      now: () => 1_000,
      complete: async () => {
        providerCalls += 1;
        return '{}';
      },
    }
  );
  assert.equal(unavailable.reasonCode, 'TRANSCRIPTION_UNAVAILABLE');
  assert.equal(providerCalls, 0);

  assert.equal(gate.isAnaResumeGateEnabled(config), true);
  assert.equal(
    gate.isAnaResumeGateEnabled(config, {
      NODE_ENV: 'production',
      ANA_RESUME_GATE_ENABLED: 'true',
      ANA_RESUME_GATE_TENANT_SLUGS: '',
    }),
    false
  );
  assert.equal(
    gate.isAnaResumeGateEnabled(config, {
      NODE_ENV: 'production',
      ANA_RESUME_GATE_ENABLED: 'true',
      ANA_RESUME_GATE_TENANT_SLUGS: 'tenant-seguro',
    }),
    true
  );
  assert.equal(
    gate.isAnaResumeGateEnabled(config, {
      NODE_ENV: 'production',
      ANA_RESUME_GATE_ENABLED: 'true',
      ANA_RESUME_GATE_TENANT_SLUGS: '*',
      ANA_RESUME_GATE_EXCLUDED_TENANT_SLUGS: '',
    }),
    true
  );
  assert.equal(
    gate.isAnaResumeGateEnabled(config, {
      NODE_ENV: 'production',
      ANA_RESUME_GATE_ENABLED: 'true',
      ANA_RESUME_GATE_TENANT_SLUGS: '*',
      ANA_RESUME_GATE_EXCLUDED_TENANT_SLUGS: 'outro, tenant-seguro',
    }),
    false
  );

  const noModelDeps = {
    begin: async () => ({ action: 'PROCEED' as const }),
    loadHistory: async () => {
      throw new Error('não deveria ler');
    },
    classify: async () => {
      throw new Error('não deveria classificar');
    },
    finalize: async () => {
      throw new Error('não deveria finalizar');
    },
  };
  assert.equal(
    await gate.shouldAnaResumeForInbound(
      { config, customerPhone: '5511999999999' },
      noModelDeps
    ),
    true
  );

  assert.equal(
    await gate.shouldAnaResumeForInbound(
      { config, customerPhone: '5511999999999' },
      {
        ...noModelDeps,
        begin: async () => ({
          action: 'KEEP_SILENT' as const,
          reason: 'PAUSE_ACTIVE' as const,
        }),
      }
    ),
    false
  );

  let finalizedDecision = '';
  const evaluated = await gate.shouldAnaResumeForInbound(
    { config, customerPhone: '5511999999999' },
    {
      begin: async () => ({
        action: 'EVALUATE',
        expectedVersion: 7,
        leaseUntil: '2026-08-11T15:01:00.000Z',
      }),
      loadHistory: async () => history,
      classify: async () => ({
        decision: 'RESUME_ANA',
        reasonCode: 'NEW_INDEPENDENT_REQUEST',
        model: 'deepseek-v4-flash',
        latencyMs: 42,
        contextHash: 'a'.repeat(64),
      }),
      finalize: async ({ expectedVersion, classification }) => {
        assert.equal(expectedVersion, 7);
        finalizedDecision = classification.decision;
        return {
          applied: true,
          action: 'PROCEED',
          version: 8,
          pausedUntil: null,
        };
      },
    }
  );
  assert.equal(evaluated, true);
  assert.equal(finalizedDecision, 'RESUME_ANA');

  const stale = await gate.shouldAnaResumeForInbound(
    { config, customerPhone: '5511999999999' },
    {
      begin: async () => ({
        action: 'EVALUATE',
        expectedVersion: 7,
        leaseUntil: '2026-08-11T15:01:00.000Z',
      }),
      loadHistory: async () => history,
      classify: async () => keep,
      finalize: async () => ({
        applied: false,
        action: 'KEEP_SILENT',
        version: 8,
        pausedUntil: null,
      }),
    }
  );
  assert.equal(stale, false);

  const unexpectedClassifierFailure = await gate.shouldAnaResumeForInbound(
    { config, customerPhone: '5511999999999' },
    {
      begin: async () => ({
        action: 'EVALUATE',
        expectedVersion: 12,
        leaseUntil: '2026-08-11T15:01:00.000Z',
      }),
      loadHistory: async () => history,
      classify: async () => {
        throw new Error('falha inesperada simulada');
      },
      finalize: async () => {
        throw new Error('não deve finalizar uma classificação inexistente');
      },
    }
  );
  assert.equal(unexpectedClassifierFailure, false);

  let integrationGateCalls = 0;
  await messageHandler.handleIncomingMessage(
    {
      from: '5511999999999',
      id: 'wamid.resume-integration',
      timestamp: '1786453200',
      type: 'text',
      text: { body: 'oi' },
    },
    { profile: { name: 'Cliente' } },
    config,
    {
      persistInbound: async () => ({
        fresh: true,
        conversationKey: 'PN-RESUME:5511999999999',
        sequence: 1,
      }),
      deliverInbound: async () => ({
        delivered: true,
        attempts: 1,
        terminal: false,
        fastRetryAllowed: false,
      }),
      updateInboundContent: async () => {},
      markTranscriptionFailed: async () => {},
      downloadAudio: async () => Buffer.alloc(0),
      transcribeAudio: async () => '',
      handleOptOut: async () => false,
      shouldSuspend: async () => false,
      isPaused: async () => false,
      resumeGate: async () => {
        integrationGateCalls += 1;
        return false;
      },
    }
  );
  assert.equal(integrationGateCalls, 1);
  assert.equal(
    messageHandler.__hasBufferForTest('PN-RESUME:5511999999999'),
    false,
    'gate KEEP impede o buffer/brain real'
  );
  messageHandler.__resetFlushStateForTest();

  console.log('✅ smoke-ana-resume-gate: todos os checks passaram');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
