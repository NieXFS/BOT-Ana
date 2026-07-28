/**
 * Smoke DETERMINÍSTICO do recovery do flush (M24). Força um erro no flush do
 * debounce e verifica que o cliente NÃO fica mais em silêncio:
 *   - buffer é limpo (não re-dispara um flush condenado);
 *   - o cliente recebe UMA mensagem de fallback pedindo pra repetir;
 *   - re-flush imediato na mesma conversa é noop (janela de recovery);
 *   - conversa DIFERENTE não é suprimida (janela é por conversa);
 *   - sucesso continua respondendo normalmente.
 *   - pausa antes do flush impede até chamar o brain;
 *   - pausa enquanto o brain está em voo impede a entrega da resposta.
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

  const sent: { from: string; text: string }[] = [];
  const failingDeps: FlushDeps = {
    getReply: async () => {
      throw new Error('OpenAI 500 (simulado)');
    },
    sendReply: async (from, text) => {
      sent.push({ from, text });
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
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
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  };
  const key4 = __seedFlushBufferForTest(config, from, ['oi']);
  await flushBuffer(key4, okDeps);

  expect('4) sucesso responde ao cliente', sent.length === 1 && Boolean(sent[0]?.text.includes('15h')));
  expect('4) buffer limpo após sucesso', !__hasBufferForTest(key4));

  // --- Caso 5: echo antes do flush → brain nem roda --------------------------
  __resetFlushStateForTest();
  sent.length = 0;
  let brainCalls = 0;
  const pausedTexts: string[] = [];
  const pausedBeforeDeps: FlushDeps = {
    getReply: async () => {
      brainCalls += 1;
      return 'não deveria ser gerada';
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    isPaused: async () => true,
    recordPausedInbound: async (_key, text) => {
      pausedTexts.push(text);
    },
  };
  const key5 = __seedFlushBufferForTest(config, from, ['pode manter', '15:30']);
  await flushBuffer(key5, pausedBeforeDeps);

  expect('5) pausa pré-flush não chama o brain', brainCalls === 0);
  expect('5) pausa pré-flush não envia resposta', sent.length === 0);
  expect('5) textos do buffer são preservados no histórico', pausedTexts.join('|') === 'pode manter|15:30');
  expect('5) buffer pausado é limpo', !__hasBufferForTest(key5));

  // --- Caso 6: echo chega com o brain em voo → resposta é descartada --------
  __resetFlushStateForTest();
  sent.length = 0;
  let pauseChecks = 0;
  const pausedDuringDeps: FlushDeps = {
    getReply: async () => {
      brainCalls += 1;
      return 'resposta gerada antes do echo';
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    isPaused: async () => {
      pauseChecks += 1;
      return pauseChecks >= 2;
    },
    recordPausedInbound: async () => {},
  };
  const key6 = __seedFlushBufferForTest(config, from, ['pode manter 15:30']);
  await flushBuffer(key6, pausedDuringDeps);

  expect('6) brain chegou a gerar a resposta', brainCalls === 1);
  expect('6) pausa pós-brain bloqueia a entrega', sent.length === 0);
  expect('6) buffer é limpo após suprimir resposta', !__hasBufferForTest(key6));

  // --- Caso 7: erro + pausa não manda nem fallback ---------------------------
  __resetFlushStateForTest();
  sent.length = 0;
  pauseChecks = 0;
  const failedWhilePausedDeps: FlushDeps = {
    getReply: async () => {
      throw new Error('provider caiu durante takeover');
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    isPaused: async () => {
      pauseChecks += 1;
      return pauseChecks >= 2;
    },
    recordPausedInbound: async () => {},
  };
  const key7 = __seedFlushBufferForTest(config, from, ['ok']);
  await flushBuffer(key7, failedWhilePausedDeps);

  expect('7) pausa após erro bloqueia fallback', sent.length === 0);
  expect('7) buffer é limpo sem rearmar', !__hasBufferForTest(key7));

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
