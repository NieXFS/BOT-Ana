/**
 * Smoke DETERMINÍSTICO do recovery do flush (M24). Força um erro no flush do
 * debounce e verifica que o cliente NÃO fica mais em silêncio:
 *   - buffer é limpo (não re-dispara um flush condenado);
 *   - o cliente recebe UMA mensagem de fallback pedindo pra repetir;
 *   - re-flush imediato na mesma conversa é noop (janela de recovery);
 *   - conversa DIFERENTE não é suprimida (janela é por conversa);
 *   - sucesso continua respondendo normalmente.
 *   - sales separa falha de brain da falha de envio e agenda recovery sem M24;
 *   - pausa antes/depois do brain suprime resposta, fallback e recovery.
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
  const salesRecovery = await import('../src/services/salesRecovery');
  const { SalesBrainFailure } = await import('../src/services/salesBrain');

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

  const salesConfig: TenantBotConfig = {
    ...config,
    botName: 'Renata',
    botRole: 'sales',
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
  };
  type RecoveryTimer = {
    callback: () => void | Promise<void>;
    cancelled: boolean;
  };
  const recoveryTimers: RecoveryTimer[] = [];
  const recoveryEvents: string[] = [];
  const recoveredReplyTexts: string[] = [];
  const configureRecoveryHarness = () => {
    recoveryTimers.length = 0;
    recoveryEvents.length = 0;
    recoveredReplyTexts.length = 0;
    salesRecovery.__setSalesRecoveryDepsForTest({
      scheduler: {
        setTimeout: (callback) => {
          const timer: RecoveryTimer = { callback, cancelled: false };
          recoveryTimers.push(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          (timer as RecoveryTimer).cancelled = true;
        },
      },
      emitEvent: async (_phoneNumberId, _phone, event) => {
        recoveryEvents.push(event);
      },
      sendReply: async (_phone, replyText) => {
        recoveredReplyTexts.push(replyText);
      },
    });
  };

  // --- Caso 5: SalesBrainFailure agenda recovery silencioso, sem M24 --------
  __resetFlushStateForTest();
  salesRecovery.__resetSalesRecoveryForTest();
  configureRecoveryHarness();
  sent.length = 0;
  const salesBrainFailureDeps: FlushDeps = {
    getReply: async () => {
      throw new SalesBrainFailure(new Error('Anthropic 529 simulado'));
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  };
  const key5 = __seedFlushBufferForTest(salesConfig, from, ['quero conhecer']);
  await flushBuffer(key5, salesBrainFailureDeps);

  expect('5) SalesBrainFailure de sales não envia fallback M24', sent.length === 0);
  expect(
    '5) SalesBrainFailure agenda recovery de brain',
    salesRecovery.__getSalesRecoveryStateForTest(key5)?.kind === 'brain'
  );
  expect(
    '5) falha real de brain emite falha_resposta',
    recoveryEvents.join('|') === 'falha_resposta'
  );
  expect('5) buffer sales é limpo após SalesBrainFailure', !__hasBufferForTest(key5));

  // --- Caso 6: erro genérico de brain também agenda recovery ----------------
  salesRecovery.__resetSalesRecoveryForTest();
  configureRecoveryHarness();
  sent.length = 0;
  const genericSalesBrainFailureDeps: FlushDeps = {
    getReply: async () => {
      throw new Error('falha genérica fora de SalesBrainFailure');
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  };
  const key6 = __seedFlushBufferForTest(salesConfig, from, ['quero conhecer']);
  await flushBuffer(key6, genericSalesBrainFailureDeps);

  expect('6) erro genérico de sales não envia fallback M24', sent.length === 0);
  expect(
    '6) erro genérico de sales agenda recovery de brain',
    salesRecovery.__getSalesRecoveryStateForTest(key6)?.kind === 'brain'
  );
  expect(
    '6) erro genérico de brain emite falha_resposta',
    recoveryEvents.join('|') === 'falha_resposta'
  );
  expect('6) buffer sales é limpo após erro genérico', !__hasBufferForTest(key6));

  // --- Caso 7: falha de envio guarda replyText, sem fallback ----------------
  salesRecovery.__resetSalesRecoveryForTest();
  configureRecoveryHarness();
  sent.length = 0;
  const salesSendFailureDeps: FlushDeps = {
    getReply: async () => 'Resposta natural já persistida',
    sendReply: async () => {
      throw new Error('WhatsApp indisponível');
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  };
  const key7 = __seedFlushBufferForTest(salesConfig, from, ['oi']);
  await flushBuffer(key7, salesSendFailureDeps);

  expect(
    '7) falha de envio agenda recovery kind send',
    salesRecovery.__getSalesRecoveryStateForTest(key7)?.kind === 'send'
  );
  expect('7) falha de envio sales não dispara M24', sent.length === 0);
  expect('7) buffer sales é limpo após falha de envio', !__hasBufferForTest(key7));
  await recoveryTimers[0]?.callback();
  expect(
    '7) recovery de envio preserva o replyText original',
    recoveredReplyTexts.join('|') === 'Resposta natural já persistida'
  );

  // --- Caso 8: echo antes do flush → brain nem roda --------------------------
  __resetFlushStateForTest();
  salesRecovery.__resetSalesRecoveryForTest();
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
  const key8 = __seedFlushBufferForTest(config, from, ['pode manter', '15:30']);
  await flushBuffer(key8, pausedBeforeDeps);

  expect('8) pausa pré-flush não chama o brain', brainCalls === 0);
  expect('8) pausa pré-flush não envia resposta', sent.length === 0);
  expect(
    '8) textos não processados são preservados no histórico',
    pausedTexts.join('|') === 'pode manter|15:30'
  );
  expect('8) buffer pausado é limpo', !__hasBufferForTest(key8));

  // --- Caso 9: echo chega com o brain em voo → resposta é descartada --------
  __resetFlushStateForTest();
  sent.length = 0;
  brainCalls = 0;
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
  const key9 = __seedFlushBufferForTest(config, from, ['pode manter 15:30']);
  await flushBuffer(key9, pausedDuringDeps);

  expect('9) brain chegou a gerar a resposta', brainCalls === 1);
  expect('9) pausa pós-brain bloqueia a entrega', sent.length === 0);
  expect('9) buffer é limpo após suprimir resposta', !__hasBufferForTest(key9));

  // --- Caso 10: erro + pausa não manda nem fallback --------------------------
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
  const key10 = __seedFlushBufferForTest(config, from, ['ok']);
  await flushBuffer(key10, failedWhilePausedDeps);

  expect('10) pausa após erro bloqueia fallback M24', sent.length === 0);
  expect('10) buffer é limpo sem rearmar', !__hasBufferForTest(key10));

  // --- Caso 11: em sales, pausa vence recovery e falha_resposta --------------
  __resetFlushStateForTest();
  salesRecovery.__resetSalesRecoveryForTest();
  configureRecoveryHarness();
  sent.length = 0;
  pauseChecks = 0;
  const salesFailedDuringTakeoverDeps: FlushDeps = {
    getReply: async () => {
      throw new SalesBrainFailure(new Error('Anthropic caiu durante takeover'));
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
  const key11 = __seedFlushBufferForTest(salesConfig, from, ['vou falar com o atendente']);
  await flushBuffer(key11, salesFailedDuringTakeoverDeps);

  expect('11) takeover sales não envia mensagem ao lead', sent.length === 0);
  expect(
    '11) takeover sales não agenda recovery',
    salesRecovery.__getSalesRecoveryStateForTest(key11) === null
  );
  expect('11) takeover sales não emite falha_resposta', recoveryEvents.length === 0);
  expect('11) buffer sales pausado é limpo', !__hasBufferForTest(key11));
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
