/**
 * Smoke DETERMINÍSTICO do recovery do flush (M24). Força um erro no flush do
 * debounce e verifica que o cliente NÃO fica mais em silêncio:
 *   - buffer é limpo (não re-dispara um flush condenado);
 *   - o cliente recebe UMA mensagem de fallback pedindo pra repetir;
 *   - re-flush imediato na mesma conversa é noop (janela de recovery);
 *   - conversa DIFERENTE não é suprimida (janela é por conversa);
 *   - sucesso continua respondendo normalmente.
 *
 * Sem WhatsApp/OpenAI reais — deps injetadas. A captura no Sentry roda na MESMA
 * cláusula catch, imediatamente antes do fallback: se o fallback foi enviado, o
 * catch (e o captureException) executou. O namespace ESM do @sentry/node é
 * frozen (não dá pra espionar — mesma limitação documentada do next-auth).
 *
 * Rodar: npx ts-node scripts/smoke-debounce-flush-error.ts
 */

// Env dummy ANTES de carregar o módulo: contextManager exige DATABASE_URL no
// load; brainService/transcriber instanciam OpenAI lazy. O Pool do pg é lazy
// (não conecta na construção) e nunca é usado aqui (deps injetadas).
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

import type { TenantBotConfig } from '../src/configProvider';
import type { FlushDeps } from '../src/messageHandler';

const FALLBACK = 'Tive um probleminha aqui. Pode repetir sua última mensagem?';

const config: TenantBotConfig = {
  tenantSlug: 'smoke-tenant',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: '',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '08:00',
  botActiveEnd: '20:00',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'tok',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-SMOKE',
  isActive: true,
};

const checks: { name: string; ok: boolean }[] = [];
function expect(name: string, cond: boolean) {
  checks.push({ name, ok: cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main() {
  const {
    flushBuffer,
    __seedFlushBufferForTest,
    __hasBufferForTest,
    __resetFlushStateForTest,
  } = await import('../src/messageHandler');
  const salesRecovery = await import('../src/services/salesRecovery');

  const sent: { from: string; text: string }[] = [];
  const failingDeps: FlushDeps = {
    getReply: async () => {
      throw new Error('OpenAI 500 (simulado)');
    },
    sendReply: async (from, text) => {
      sent.push({ from, text });
    },
  };

  const from = '5511999990000';
  const from2 = '5511888880000';

  // --- Caso 1: flush falha → buffer limpo + fallback enviado 1x --------------
  __resetFlushStateForTest();
  const key1 = __seedFlushBufferForTest(config, from, ['oi', 'quero marcar']);
  await flushBuffer(key1, failingDeps);

  expect('1) buffer limpo após falha', !__hasBufferForTest(key1));
  expect('1) fallback enviado exatamente 1x', sent.length === 1);
  expect('1) fallback é a mensagem de recuperação', sent[0]?.text === FALLBACK);
  expect('1) fallback foi pro cliente certo', sent[0]?.from === from);

  // --- Caso 2: re-flush imediato na MESMA conversa → fallback suprimido ------
  const key2 = __seedFlushBufferForTest(config, from, ['de novo']);
  await flushBuffer(key2, failingDeps);

  expect('2) buffer limpo no re-flush', !__hasBufferForTest(key2));
  expect('2) fallback NÃO reenviado na janela (total ainda 1x)', sent.length === 1);

  // --- Caso 3: conversa DIFERENTE não é suprimida ---------------------------
  const key3 = __seedFlushBufferForTest(config, from2, ['oi']);
  await flushBuffer(key3, failingDeps);

  expect('3) outra conversa recebe o fallback', sent.length === 2);
  expect('3) fallback foi pro segundo cliente', sent[1]?.from === from2);

  // --- Caso 4: sucesso responde normalmente e limpa o buffer ----------------
  __resetFlushStateForTest();
  sent.length = 0;
  const okDeps: FlushDeps = {
    getReply: async () => 'Claro! Temos horário às 15h.',
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
  };
  const key4 = __seedFlushBufferForTest(config, from, ['oi']);
  await flushBuffer(key4, okDeps);

  expect('4) sucesso responde ao cliente', sent.length === 1 && Boolean(sent[0]?.text.includes('15h')));
  expect('4) buffer limpo após sucesso', !__hasBufferForTest(key4));

  // --- Caso 5: sales não usa M24; agenda recovery silencioso ----------------
  const salesConfig: TenantBotConfig = {
    ...config,
    botName: 'Renata',
    botRole: 'sales',
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
  };
  const fakeTimers: Array<{ cancelled: boolean }> = [];
  salesRecovery.__setSalesRecoveryDepsForTest({
    scheduler: {
      setTimeout: () => {
        const timer = { cancelled: false };
        fakeTimers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { cancelled: boolean }).cancelled = true;
      },
    },
    emitEvent: async () => undefined,
  });
  sent.length = 0;
  const genericSalesBrainFailureDeps: FlushDeps = {
    getReply: async () => {
      throw new Error('falha genérica fora de SalesBrainFailure');
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
  };
  const key5 = __seedFlushBufferForTest(salesConfig, from, ['quero conhecer']);
  await flushBuffer(key5, genericSalesBrainFailureDeps);
  expect('5) erro genérico de sales não envia fallback M24', sent.length === 0);
  expect(
    '5) erro genérico de sales agenda recovery de brain',
    salesRecovery.__getSalesRecoveryStateForTest(key5)?.kind === 'brain'
  );
  expect('5) buffer sales é limpo após falha', !__hasBufferForTest(key5));
  salesRecovery.__resetSalesRecoveryForTest();

  // --- Caso 6: falha de envio guarda replyText, sem fallback ----------------
  const salesSendFailureDeps: FlushDeps = {
    getReply: async () => 'Resposta natural já persistida',
    sendReply: async () => {
      throw new Error('WhatsApp indisponível');
    },
  };
  salesRecovery.__setSalesRecoveryDepsForTest({
    scheduler: {
      setTimeout: () => ({ cancelled: false }),
      clearTimeout: () => undefined,
    },
    emitEvent: async () => undefined,
  });
  const key6 = __seedFlushBufferForTest(salesConfig, from, ['oi']);
  await flushBuffer(key6, salesSendFailureDeps);
  expect(
    '6) falha de envio agenda recovery kind send',
    salesRecovery.__getSalesRecoveryStateForTest(key6)?.kind === 'send'
  );
  expect('6) buffer é limpo sem M24', !__hasBufferForTest(key6));
  salesRecovery.__resetSalesRecoveryForTest();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    console.error('❌ FALHOU:', failed.map((c) => c.name).join(' | '));
    process.exit(1);
  }
  console.log('✅ smoke-debounce-flush-error OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ erro inesperado no smoke:', err);
  process.exit(1);
});
