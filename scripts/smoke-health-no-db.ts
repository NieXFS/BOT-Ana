import assert from 'node:assert/strict';

// O contextManager exige DATABASE_URL no load, mas o Pool do pg é lazy.
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';

async function main(): Promise<void> {
  const { app } = await import('../src/webhookServer');
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200, 'liveness não depende do banco');
    assert.equal((await live.json()).status, 'ok');

    const legacy = await fetch(`${baseUrl}/health`);
    assert.equal(legacy.status, 200, 'alias histórico continua liveness');

    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(ready.status, 503, 'readiness distingue boot incompleto');
    assert.equal((await ready.json()).status, 'starting');

    console.log('smoke:health-no-db PASS (4 checks)');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error('smoke:health-no-db FAIL', error);
  process.exitCode = 1;
});
