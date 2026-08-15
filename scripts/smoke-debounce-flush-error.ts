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
  const onboardingGate = await import(
    '../src/services/onboardingConfirmationGate'
  );

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
  const flushErrorLogs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    flushErrorLogs.push(args.map((value) => String(value)).join(' '));
  };
  try {
    await flushBuffer(key1, failingDeps);
  } finally {
    console.error = originalConsoleError;
  }

  expect('1) buffer limpo após falha', !__hasBufferForTest(key1));
  expect('1) fallback enviado exatamente 1x', sent.length === 1);
  expect('1) fallback é a mensagem de recuperação', sent[0]?.text === FALLBACK);
  expect('1) fallback foi pro cliente certo', sent[0]?.from === from);
  const flushErrorLog = flushErrorLogs.find((line) => line.includes('Erro no flush')) ?? '';
  expect(
    '1) log de flush inclui message',
    flushErrorLog.includes('OpenAI 500 (simulado)')
  );
  expect(
    '1) log de flush inclui stack',
    flushErrorLog.includes('detail=') && flushErrorLog.includes('Error:')
  );

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

  // --- Caso 4b: confirmação da escalada atravessa só a própria pausa --------
  __resetFlushStateForTest();
  let escalationAckChecks = 0;
  let escalationDeliveries = 0;
  let genericPauseChecks = 0;
  const escalationDeps: FlushDeps = {
    getReply: async () =>
      ({
        kind: 'ana_conversational_v2_prepared',
        frame: { inputSequence: 1 },
        payload: 'Vou avisar a equipe responsável pelo atendimento.',
        authoritativeEscalationQuestionId: 'question-authoritative-fixture',
      }) as any,
    sendReply: async () => {
      throw new Error('Confirmação v2 não pode usar o transporte v1.');
    },
    // Antes do brain ainda não existe a pausa. A ação autoritativa nasce no
    // getReply; qualquer recheck genérico posterior já a enxergaria como ativa.
    isPaused: async () => {
      genericPauseChecks += 1;
      return genericPauseChecks > 1;
    },
    isPausedForEscalationAck: async (_phoneNumberId, _customerPhone, questionId) => {
      escalationAckChecks += 1;
      return questionId !== 'question-authoritative-fixture';
    },
    recordPausedInbound: async () => {},
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
    deliverV2: async (_prepared, checkpoint) => {
      const state = await checkpoint();
      if (state.paused) throw new Error('Ack autoritativo foi suprimido indevidamente.');
      escalationDeliveries += 1;
      return { delivery: 'sent', successor: null };
    },
  };
  const escalationKey = __seedFlushBufferForTest(config, from, [
    'posso falar com a dona?',
  ]);
  await flushBuffer(escalationKey, escalationDeps);
  expect(
    '4b) pausa criada pela própria escalada usa o check escopado',
    escalationAckChecks >= 2
  );
  expect(
    '4b) confirmação autoritativa chega ao delivery v2 uma única vez',
    escalationDeliveries === 1
  );

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
  onboardingGate.rememberPendingOnboardingProposal(
    key7,
    'completeOnboarding',
    {}
  );
  await flushBuffer(key7, salesSendFailureDeps);

  expect(
    '7) falha de envio agenda recovery kind send',
    salesRecovery.__getSalesRecoveryStateForTest(key7)?.kind === 'send'
  );
  expect('7) falha de envio sales não dispara M24', sent.length === 0);
  expect(
    '7) proposta B3 não entregue é descartada',
    onboardingGate.getPendingOnboardingProposal(key7) === null
  );
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

  // --- Caso 10b: brain aborta por takeover → zero tool/write e zero M24 ------
  __resetFlushStateForTest();
  sent.length = 0;
  let fallbackCalls10b = 0;
  const { ConversationPausedBeforeDispatch } = await import(
    '../src/services/brainService'
  );
  const pausedDispatchDeps: FlushDeps = {
    getReply: async () => {
      throw new ConversationPausedBeforeDispatch();
    },
    sendReply: async (f, t) => {
      sent.push({ from: f, text: t });
    },
    sendReplyPlain: async (f, t) => {
      fallbackCalls10b += 1;
      sent.push({ from: f, text: t });
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  };
  const key10b = __seedFlushBufferForTest(config, from, ['quero remarcar']);
  await flushBuffer(key10b, pausedDispatchDeps);
  expect(
    '10b) aborto de takeover no brain não envia resposta',
    sent.length === 0
  );
  expect('10b) aborto de takeover não aciona fallback M24', fallbackCalls10b === 0);
  expect('10b) buffer é limpo após aborto de takeover', !__hasBufferForTest(key10b));

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

  // --- Caso 11b: timeout após POST de sales é ambíguo e nunca agenda retry ---
  __resetFlushStateForTest();
  salesRecovery.__resetSalesRecoveryForTest();
  configureRecoveryHarness();
  const ambiguousSalesError = Object.assign(new Error('timeout after POST'), {
    isAxiosError: true,
    code: 'ECONNABORTED',
    request: {},
  });
  const key11b = __seedFlushBufferForTest(salesConfig, from, ['quero conhecer']);
  await flushBuffer(key11b, {
    getReply: async () => 'Resposta da Renata possivelmente aceita',
    sendReply: async () => {
      throw ambiguousSalesError;
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
  });
  expect(
    '11b) transporte sales ambíguo não agenda recovery/retry',
    salesRecovery.__getSalesRecoveryStateForTest(key11b) === null
  );
  expect('11b) buffer sales é limpo', !__hasBufferForTest(key11b));
  salesRecovery.__resetSalesRecoveryForTest();

  // --- Caso 12: último check de pausa ocorre dentro da lock do transporte ----
  __resetFlushStateForTest();
  sent.length = 0;
  const dispatchOrder: string[] = [];
  let insideDispatchLock = false;
  const lockedDispatchDeps: FlushDeps = {
    getReply: async () => 'resposta que não pode passar pelo takeover',
    sendReply: async (f, t) => {
      dispatchOrder.push('send');
      sent.push({ from: f, text: t });
    },
    isPaused: async () => {
      dispatchOrder.push(insideDispatchLock ? 'pause:inside' : 'pause:outside');
      return insideDispatchLock;
    },
    recordPausedInbound: async () => {},
    withConversationLock: async (_pnid, _phone, work) => {
      dispatchOrder.push('lock:start');
      insideDispatchLock = true;
      try {
        await work();
      } finally {
        insideDispatchLock = false;
        dispatchOrder.push('lock:end');
      }
    },
  };
  const key12 = __seedFlushBufferForTest(config, from, ['oi']);
  await flushBuffer(key12, lockedDispatchDeps);
  expect('12) pausa é revalidada dentro da lock', dispatchOrder.includes('pause:inside'));
  expect('12) takeover dentro da lock impede transporte', !dispatchOrder.includes('send'));
  expect('12) buffer é limpo pelo takeover serializado', !__hasBufferForTest(key12));

  // --- Caso 12-resume: echo após RESUME_APPROVED e antes do send vence -------
  __resetFlushStateForTest();
  sent.length = 0;
  let resumeSendCalls = 0;
  const key12Resume = __seedFlushBufferForTest(
    config,
    from,
    ['Quero agendar Drenagem Linfática'],
    { disposition: 'RESUME_APPROVED', resumeDecision: 'RESUME_ANA' }
  );
  let pausedAfterBrain = false;
  await flushBuffer(key12Resume, {
    getReply: async (_phone, _text, _name, _cfg, turnControl) => {
      expect(
        '12-resume) getReply recebe RESUME_APPROVED',
        turnControl?.disposition === 'RESUME_APPROVED' &&
          turnControl?.resumeDecision === 'RESUME_ANA'
      );
      pausedAfterBrain = true;
      return 'resposta que não pode sair depois do echo';
    },
    sendReply: async () => {
      resumeSendCalls += 1;
    },
    isPaused: async () => pausedAfterBrain,
    recordPausedInbound: async () => {},
    withConversationLock: async (_pnid, _phone, work) => work(),
  });
  expect('12-resume) zero outbound após echo pós-resume', resumeSendCalls === 0);
  expect('12-resume) buffer limpo', !__hasBufferForTest(key12Resume));

  // --- Caso 13: rejeição fail-closed não vira fallback nem exceção ------------
  __resetFlushStateForTest();
  let fallbackCalls = 0;
  let boundaryCalls = 0;
  const suppressedBoundaryDeps: FlushDeps = {
    getReply: async () => ({
      kind: 'validated_receptionist_outbound' as const,
      payload: '',
      originalAccepted: false,
      reasonCodes: ['INTERNAL_CONVERSATION_MARKER'],
      purpose: 'REACTIVE' as const,
      sources: ['GENERATED'] as const,
    }),
    sendReply: async () => {
      boundaryCalls += 1;
      return 'suppressed';
    },
    sendReplyPlain: async () => {
      fallbackCalls += 1;
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
    withConversationLock: async (_pnid, _phone, work) => work(),
  };
  const key13 = __seedFlushBufferForTest(config, from, ['oi']);
  await flushBuffer(key13, suppressedBoundaryDeps);
  expect('13) fronteira é consultada uma vez', boundaryCalls === 1);
  expect('13) rejeição não aciona fallback M24', fallbackCalls === 0);
  expect('13) buffer rejeitado é limpo sem loop', !__hasBufferForTest(key13));

  // --- Caso 14: post_link só começa depois do envio aceito -----------------
  __resetFlushStateForTest();
  const deliveryOrder: string[] = [];
  const signupReply =
    'Prontinho! Te mandei o link.\n\nhttps://receps.com.br/cadastro?pf=TOKEN';
  const deliveredLinkDeps: FlushDeps = {
    getReply: async () => signupReply,
    sendReply: async () => {
      deliveryOrder.push('send');
    },
    isPaused: async () => false,
    recordPausedInbound: async () => {},
    markPostLink: async () => {
      deliveryOrder.push('post_link');
    },
  };
  const key14 = __seedFlushBufferForTest(salesConfig, from, ['Sim']);
  await flushBuffer(key14, deliveredLinkDeps);
  expect(
    '14) post_link ocorre somente depois do transporte aceitar a URL',
    deliveryOrder.join('|') === 'send|post_link'
  );
  expect('14) buffer é limpo após link entregue', !__hasBufferForTest(key14));

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
