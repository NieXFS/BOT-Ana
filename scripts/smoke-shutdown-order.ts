import assert from 'node:assert/strict';

// O contextManager valida DATABASE_URL no load; nenhum pool conecta neste smoke.
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/shutdown';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';

import {
  startMaintenanceScheduler,
  stopAllMaintenanceSchedulers,
} from '../src/services/maintenanceScheduler';

async function main(): Promise<void> {
  const {
    __runShutdownSequenceForTest,
    HTTP_SHUTDOWN_GRACE_MS,
  } = await import('../src/webhookServer');
  const phases: string[] = [];
  const scheduled = startMaintenanceScheduler({
    worker: 'shutdown-order-smoke-worker',
    enabled: true,
    run: async () => ({ attempted: 0 }),
    idleIntervalMs: 60_000,
    busyIntervalMs: 1_000,
    errorBackoffMaxMs: 60_000,
    initialDelayMs: 60_000,
    jitterMs: 0,
  });
  assert.ok(scheduled?.getState().timerScheduled, 'smoke deve iniciar um timer real');

  await __runShutdownSequenceForTest({
    cancelSchedulers: () => {
      phases.push('cancel');
      stopAllMaintenanceSchedulers();
    },
    closeHttp: async () => {
      assert.deepEqual(phases, ['cancel'], 'schedulers são cancelados antes do HTTP');
      phases.push('http');
    },
    closePools: async () => {
      assert.deepEqual(phases, ['cancel', 'http'], 'pools fecham depois do HTTP');
      phases.push('pools');
    },
    log: () => undefined,
  });

  assert.deepEqual(phases, ['cancel', 'http', 'pools']);
  assert.equal(scheduled?.isActive(), false, 'cancelamento global para o worker registrado');
  assert.equal(scheduled?.getState().timerScheduled, false);
  assert.equal(
    HTTP_SHUTDOWN_GRACE_MS,
    25_000,
    'deadline HTTP deixa margem para o kill_timeout do PM2'
  );
  console.log('smoke:shutdown-order PASS (cancelamento → HTTP → pools; 25s + PM2 30s)');
}

main().catch((error) => {
  console.error('smoke:shutdown-order FAIL', error);
  process.exitCode = 1;
});
