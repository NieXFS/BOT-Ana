/**
 * Prova a garantia temporal do echo humano:
 * o cache local precisa ficar pausado ANTES de o POST ao Receps terminar.
 * Sem rede/DB reais — persistPause e relógio são injetados.
 *
 * Rodar: npx tsx scripts/smoke-echo-pause-race.ts
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean) {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main() {
  const {
    pauseConversationByEcho,
    isConversationPaused,
    __resetPauseCacheForTest,
  } = await import('../src/services/pauseService');

  // O serviço consulta Date.now() ao ler o cache; alinhar o relógio injetado ao
  // relógio real evita que uma data fixa antiga pareça uma pausa já expirada.
  const now = Date.now();
  let resolvePersist!: (value: string | null) => void;
  const persistGate = new Promise<string | null>((resolve) => {
    resolvePersist = resolve;
  });

  __resetPauseCacheForTest();
  const pendingPause = pauseConversationByEcho('PN-ECHO', '5511999990000', {
    now: () => now,
    persistPause: async () => persistGate,
  });

  check(
    'cache fica pausado enquanto o POST ainda está em voo',
    await isConversationPaused('PN-ECHO', '5511999990000')
  );

  resolvePersist(new Date(now + 2 * 60 * 60_000).toISOString());
  await pendingPause;
  check(
    'carimbo autoritativo futuro mantém a pausa',
    await isConversationPaused('PN-ECHO', '5511999990000')
  );

  __resetPauseCacheForTest();
  await pauseConversationByEcho('PN-FAIL', '5511888880000', {
    now: () => now,
    persistPause: async () => {
      throw new Error('Receps indisponível (simulado)');
    },
  });
  check(
    'falha do POST mantém a pausa local otimista',
    await isConversationPaused('PN-FAIL', '5511888880000')
  );

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    process.exit(1);
  }
  console.log('✅ smoke-echo-pause-race OK');
}

main().catch((error) => {
  console.error('❌ erro inesperado no smoke:', error);
  process.exit(1);
});
