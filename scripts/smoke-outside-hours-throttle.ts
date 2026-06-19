/**
 * FIX 2 (aviso de fora-de-horário sem throttle) — smoke DETERMINÍSTICO.
 *
 * Prova que shouldSendOutsideHoursNotice():
 *  - retorna true na 1ª chamada pra um bufferKey;
 *  - retorna false nas chamadas seguintes DENTRO da janela (mesma conversa);
 *  - retorna true pra um bufferKey diferente (não silencia outras conversas);
 *  - volta a retornar true depois que a janela expira.
 *
 * Rodar: npx tsx scripts/smoke-outside-hours-throttle.ts
 */
// Env dummy ANTES de carregar o módulo: messageHandler importa brainService →
// contextManager, que exige DATABASE_URL no load. Pool do pg é lazy (não conecta).
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

const checks: { name: string; ok: boolean }[] = [];
function record(name: string, ok: boolean) {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main() {
  const { shouldSendOutsideHoursNotice, __resetFlushStateForTest } =
    await import('../src/messageHandler');

  __resetFlushStateForTest();

  const KEY_A = 'phone-1:5511999999999';
  const KEY_B = 'phone-1:5511888888888';
  const T0 = 1_000_000_000_000; // base de tempo fixa (determinística)
  const WINDOW_MS = 4 * 60 * 60 * 1000;

  record(
    '1ª chamada (KEY_A) → true',
    shouldSendOutsideHoursNotice(KEY_A, T0) === true
  );
  record(
    '2ª chamada (KEY_A) 1min depois → false (throttle)',
    shouldSendOutsideHoursNotice(KEY_A, T0 + 60_000) === false
  );
  record(
    '3ª chamada (KEY_A) 2h depois → false (ainda na janela de 4h)',
    shouldSendOutsideHoursNotice(KEY_A, T0 + 2 * 60 * 60 * 1000) === false
  );
  record(
    'KEY_B (outra conversa) → true (não foi silenciada por KEY_A)',
    shouldSendOutsideHoursNotice(KEY_B, T0 + 60_000) === true
  );
  record(
    'KEY_A após a janela (4h + 1ms) → true de novo',
    shouldSendOutsideHoursNotice(KEY_A, T0 + WINDOW_MS + 1) === true
  );

  __resetFlushStateForTest();
  record(
    'após __resetFlushStateForTest → KEY_A volta a true',
    shouldSendOutsideHoursNotice(KEY_A, T0) === true
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${failed.length === 0 ? '✅ TODOS OS CHECKS PASSARAM' : `❌ ${failed.length} CHECK(S) FALHARAM`} (${checks.length} no total)`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
