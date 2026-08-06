process.env.ANA_DIRECT_DATABASE_URL =
  'postgresql://smoke:smoke@direct.example.invalid:5432/smoke';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@direct.example.invalid:5432/smoke';
process.env.ANA_SENTRY_DSN = '';

export {};

const SECRET = 'credential-that-must-never-appear';
const checks: Array<{ name: string; ok: boolean }> = [];
const observedOutput: string[] = [];

function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

function captureError(work: () => unknown): string {
  try {
    work();
    return '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observedOutput.push(message);
    return message;
  }
}

async function main(): Promise<void> {
  const order = await import('../src/services/conversationOrder');
  try {
    const direct = order.resolveConversationOrderDatabaseUrl({
      ANA_DIRECT_DATABASE_URL:
        'postgresql://user:pass@direct.example.invalid:5432/app',
    });
    check(
      'URL direta explícita é aceita',
      new URL(direct).hostname === 'direct.example.invalid'
    );

    const poolerError = captureError(() =>
      order.resolveConversationOrderDatabaseUrl({
        ANA_DIRECT_DATABASE_URL: `postgresql://user:${SECRET}@ep-demo-pooler.example.invalid:5432/app`,
      })
    );
    check(
      'URL direta explícita com pooler falha fechado',
      poolerError.includes('Endpoint pooled')
    );

    const derived = order.resolveConversationOrderDatabaseUrl({
      DATABASE_URL:
        'postgresql://user:pass@ep-demo-pooler.example.invalid:5432/app?sslmode=require',
    });
    check(
      'DATABASE_URL pooled deriva endpoint direto válido',
      new URL(derived).hostname === 'ep-demo.example.invalid' &&
        !order.databaseUrlHasPoolerHostname(derived)
    );

    const missingError = captureError(() =>
      order.resolveConversationOrderDatabaseUrl({})
    );
    check(
      'ausência de URLs falha fechado',
      missingError.includes('não configurada')
    );

    const invalidError = captureError(() =>
      order.resolveConversationOrderDatabaseUrl({
        ANA_DIRECT_DATABASE_URL: `not-a-url-${SECRET}`,
      })
    );
    check('URL inválida falha com erro sanitizado', invalidError.includes('URL de banco inválida'));
    check(
      'nenhum erro observado contém credencial',
      observedOutput.every((entry) => !entry.includes(SECRET))
    );
  } finally {
    await order.closeConversationOrderPoolForSmoke();
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : typeof error);
  process.exitCode = 1;
});
