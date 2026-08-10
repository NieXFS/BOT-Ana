/**
 * Smoke do listener de erro do pool compartilhado da Ana.
 * Não abre conexão real: `pg.Pool` é lazy e recebe uma DATABASE_URL dummy.
 */

process.env.DATABASE_URL = 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';

async function main(): Promise<void> {
  const { pool } = await import('../src/services/contextManager');
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];

  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    if (pool.listenerCount('error') < 1) {
      throw new Error('pool sem listener de error');
    }

    pool.emit('error', new Error('teste'));

    const expectedPrefix =
      '[pg-pool] client derrubado (compute do Neon suspendeu?):';
    if (!logged.some(([message]) => message === expectedPrefix)) {
      throw new Error('listener não registrou a mensagem esperada');
    }
  } finally {
    console.error = originalConsoleError;
    await pool.end();
  }

  console.log('✅ pg-pool: evento error tratado, processo vivo e mensagem registrada.');
}

main().catch((error) => {
  console.error('❌ smoke-pg-pool-error falhou:', error);
  process.exitCode = 1;
});
