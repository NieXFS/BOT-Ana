/**
 * Smoke DETERMINÍSTICO da "escuta enquanto pausada" (§8.2 / INV-10). Sem DB/rede
 * — deps injetadas. Prova:
 *   - pausada + inbound do cliente → grava role `user` com o texto (messageHandler);
 *   - recordInboundWhilePaused é à prova de falha (recorder lança → NÃO propaga);
 *   - echo do humano (texto) → grava role `assistant` com prefixo "[atendente] "
 *     + o corpo (echoHandler);
 *   - echo sem texto → marcador interno; áudio sem transcrição nunca vira fala;
 *   - echo retransmitido (mesmo message id) → NÃO grava 2x (dedup por id);
 *   - a PAUSA é disparada por cliente;
 *   - corrida echo×envio: echo vence ⇒ transporte suprimido; envio vence ⇒
 *     echo só começa depois do recibo; POST de pausa falho ⇒ latch ECHO bloqueia.
 *
 * Env dummy ANTES dos imports: contextManager exige DATABASE_URL no load (o Pool
 * do pg é lazy — não conecta — e nunca é usado, deps injetadas). NODE_ENV=dev pra
 * erpApiToken (transitivo via echoHandler→pauseService) não lançar.
 *
 * Rodar: npx tsx scripts/smoke-listen-while-paused.ts
 */
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { EchoDeps } from '../src/echoHandler';
import type { PausedRecordDeps } from '../src/messageHandler';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSerialLock() {
  const tails = new Map<string, Promise<void>>();
  return async (
    phoneNumberId: string,
    customerPhone: string,
    work: () => Promise<void>
  ) => {
    const key = `${phoneNumberId}:${customerPhone}`;
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(
      key,
      prev.then(
        () => done,
        () => done
      )
    );
    try {
      await prev;
      await work();
    } finally {
      release();
    }
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { recordInboundWhilePaused } = await import('../src/messageHandler');
  const { handleSmbMessageEchoes, parseEchoMessages, HUMAN_ECHO_PREFIX } =
    await import('../src/echoHandler');

  // === A) inbound do cliente enquanto pausada → grava role `user` ============
  const recorded: { key: string; role: string; content: string }[] = [];
  const recDeps: PausedRecordDeps = {
    recordMessage: async (key, role, content) => {
      recorded.push({ key, role, content });
    },
  };
  await recordInboundWhilePaused(
    'PN-SMOKE:5511CUST',
    'quero remarcar pra sexta',
    config,
    recDeps
  );
  expect('A) inbound gravado 1x', recorded.length === 1);
  expect('A) role = user', recorded[0]?.role === 'user');
  expect('A) conteúdo = texto do cliente', recorded[0]?.content === 'quero remarcar pra sexta');
  expect('A) conversationKey correto', recorded[0]?.key === 'PN-SMOKE:5511CUST');

  // === B) à prova de falha: recorder lança → não propaga ====================
  let threw = false;
  try {
    await recordInboundWhilePaused('PN:5511', 'oi', config, {
      recordMessage: async () => {
        throw new Error('DB down (simulado)');
      },
    });
  } catch {
    threw = true;
  }
  expect('B) erro do recorder NÃO propaga (à prova de falha)', threw === false);

  // === C) echo do humano (texto) → grava role assistant com prefixo =========
  const echoRecorded: { key: string; role: string; content: string }[] = [];
  const pausedFor: { pnid: string; phone: string }[] = [];
  const processedIds = new Set<string>(); // simula a tabela processed_messages
  let failRecordOnce = false;
  const echoDeps: EchoDeps = {
    pauseConversation: async (pnid, phone) => {
      pausedFor.push({ pnid, phone });
    },
    markEchoProcessed: async (id) => {
      if (processedIds.has(id)) return false; // retransmissão
      processedIds.add(id);
      return true;
    },
    unmarkEcho: async (id) => {
      processedIds.delete(id);
    },
    recordMessage: async (key, role, content) => {
      if (failRecordOnce) {
        failRecordOnce = false;
        throw new Error('DB blip (simulado)');
      }
      echoRecorded.push({ key, role, content });
    },
  };

  const textEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      {
        from: '5511BIZ',
        to: '5511CUST',
        id: 'wamid.echo1',
        type: 'text',
        text: { body: 'ok, te espero às 15h' },
      },
    ],
  };
  await handleSmbMessageEchoes(textEcho, undefined, echoDeps);
  expect('C) echo de texto gravado 1x', echoRecorded.length === 1);
  expect('C) role = assistant', echoRecorded[0]?.role === 'assistant');
  expect(
    'C) content começa com "[atendente] "',
    echoRecorded[0]?.content.startsWith(HUMAN_ECHO_PREFIX) === true
  );
  expect('C) content inclui o corpo do humano', echoRecorded[0]?.content.includes('ok, te espero às 15h') === true);
  expect('C) conversationKey = PNID:cliente', echoRecorded[0]?.key === 'PNID_1:5511CUST');
  expect('C) pausa disparada 1x', pausedFor.length === 1);

  // === D) echo retransmitido (mesmo id) → NÃO grava 2x ======================
  await handleSmbMessageEchoes(textEcho, undefined, echoDeps);
  expect('D) retransmissão NÃO grava de novo (total ainda 1)', echoRecorded.length === 1);

  // === E) echo não-texto → placeholder curto prefixado =====================
  echoRecorded.length = 0;
  const imgEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [{ to: '5511CUST2', id: 'wamid.echo2', type: 'image' }],
  };
  await handleSmbMessageEchoes(imgEcho, undefined, echoDeps);
  expect('E) echo de imagem gravado', echoRecorded.length === 1);
  expect(
    'E) placeholder prefixado',
    echoRecorded[0]?.content === `${HUMAN_ECHO_PREFIX}enviou uma imagem`
  );

  // === E2) áudio humano → media id, download e transcrição efêmera ==========
  echoRecorded.length = 0;
  const audioOrder: string[] = [];
  const audioEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      {
        to: '5511CUST4',
        id: 'wamid.echo-audio',
        type: 'audio',
        audio: { id: 'media-owner-1', voice: true },
      },
    ],
  };
  let insideAudioLock = false;
  let pauseInsideLock = false;
  let downloadInsideLock = false;
  let transcribeInsideLock = false;
  let dedupInsideLock = false;
  let recordInsideLock = false;
  await handleSmbMessageEchoes(audioEcho, undefined, {
    ...echoDeps,
    pauseConversation: async (pnid, phone) => {
      audioOrder.push('pause');
      pauseInsideLock = insideAudioLock;
      pausedFor.push({ pnid, phone });
    },
    loadConfig: async () => config,
    shouldTranscribeHumanAudio: () => true,
    downloadAudio: async (mediaId) => {
      audioOrder.push(`download:${mediaId}`);
      downloadInsideLock = insideAudioLock;
      return Buffer.from('audio-controlado');
    },
    transcribeAudio: async () => {
      audioOrder.push('transcribe');
      transcribeInsideLock = insideAudioLock;
      return 'pode deixar marcado para sexta às 13h';
    },
    markEchoProcessed: async (id) => {
      dedupInsideLock = insideAudioLock;
      if (processedIds.has(id)) return false;
      processedIds.add(id);
      return true;
    },
    recordMessage: async (key, role, content) => {
      recordInsideLock = insideAudioLock;
      echoRecorded.push({ key, role, content });
    },
    withConversationLock: async (_pnid, _phone, work) => {
      expect('E2) lock de áudio não é reentrante', insideAudioLock === false);
      insideAudioLock = true;
      try {
        await work();
      } finally {
        insideAudioLock = false;
      }
    },
  });
  expect('E2) pausa acontece antes do download', audioOrder[0] === 'pause');
  expect(
    'E2) media id do objeto audio é usado no download',
    audioOrder.includes('download:media-owner-1')
  );
  expect('E2) transcrição foi executada', audioOrder.includes('transcribe'));
  expect('E2) pausa acontece dentro da lock', pauseInsideLock === true);
  expect('E2) download acontece fora da lock', downloadInsideLock === false);
  expect('E2) transcrição acontece fora da lock', transcribeInsideLock === false);
  expect('E2) dedup acontece dentro da lock curta', dedupInsideLock === true);
  expect('E2) persistência acontece dentro da lock curta', recordInsideLock === true);
  expect(
    'E2) histórico guarda o transcript prefixado, não o media id',
    echoRecorded[0]?.content ===
      `${HUMAN_ECHO_PREFIX}pode deixar marcado para sexta às 13h`
  );

  echoRecorded.length = 0;
  const audioWithoutMedia = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      { to: '5511CUST5', id: 'wamid.echo-audio-no-media', type: 'audio' },
    ],
  };
  await handleSmbMessageEchoes(audioWithoutMedia, undefined, {
    ...echoDeps,
    loadConfig: async () => config,
    shouldTranscribeHumanAudio: () => true,
  });
  expect(
    'E2) áudio sem media id persiste estado explícito fail-closed',
    echoRecorded[0]?.content ===
      `${HUMAN_ECHO_PREFIX}[áudio do atendente sem transcrição]`
  );

  echoRecorded.length = 0;
  let disabledDownloadCalls = 0;
  await handleSmbMessageEchoes(
    {
      metadata: { phone_number_id: 'PNID_1' },
      message_echoes: [
        {
          to: '5511CUST6',
          id: 'wamid.echo-audio-disabled',
          type: 'audio',
          audio: { id: 'media-disabled' },
        },
      ],
    },
    undefined,
    {
      ...echoDeps,
      loadConfig: async () => config,
      shouldTranscribeHumanAudio: () => false,
      downloadAudio: async () => {
        disabledDownloadCalls += 1;
        return Buffer.from('nao-deveria-baixar');
      },
    }
  );
  expect('E2) gate desligado não baixa a mídia', disabledDownloadCalls === 0);
  expect(
    'E2) gate desligado não persiste o texto ambíguo "enviou um áudio"',
    echoRecorded[0]?.content ===
      `${HUMAN_ECHO_PREFIX}[áudio do atendente sem transcrição]`
  );

  // === R) corrida echo×envio (substitui "pausa fora da lock") ===============
  const pause = await import('../src/services/pauseService');
  const escalationCache = await import('../src/services/escalationCache');
  const raceNow = Date.now();
  const raceUntil = new Date(raceNow + 60 * 60_000).toISOString();
  const matchingAckState = {
    globalPausedUntil: null as string | null,
    conversationPausedUntil: raceUntil,
    schedulePausedUntil: null as string | null,
    escalationPause: {
      active: true as const,
      questionId: 'question-race-echo',
      version: 1,
      until: raceUntil,
    },
    humanPause: { active: false as const, source: null, until: null },
  };

  // R1) echo vence ⇒ transporte suprimido
  pause.__resetPauseCacheForTest();
  escalationCache.__resetEscalationCacheForTest();
  const echoWinPnid = 'PN-RACE-ECHO-WINS';
  const echoWinPhone = '5511999001111';
  escalationCache.updateEscalationCache(
    echoWinPnid,
    echoWinPhone,
    { active: true, questionId: 'question-race-echo', version: 1 },
    raceNow
  );
  const echoWinLock = createSerialLock();
  const echoHold = deferred();
  const pauseStarted = deferred();
  let echoWinPauseInsideLock = false;
  let echoWinInsideLock = false;
  let sendEnteredWhileEchoHeld = false;
  let echoWinTransported = false;
  const echoWinPayload = {
    metadata: { phone_number_id: echoWinPnid },
    message_echoes: [
      {
        to: echoWinPhone,
        id: 'wamid.race-echo-wins',
        type: 'text',
        text: { body: 'já te atendo' },
      },
    ],
  };
  const echoWinPromise = handleSmbMessageEchoes(echoWinPayload, undefined, {
    pauseConversation: async (pnid, phone) => {
      echoWinPauseInsideLock = echoWinInsideLock;
      await pause.pauseConversationByEcho(pnid, phone, {
        now: () => raceNow,
        persistPause: async () => raceUntil,
      });
      pauseStarted.resolve();
      await echoHold.promise;
    },
    markEchoProcessed: async () => true,
    unmarkEcho: async () => {},
    recordMessage: async () => {},
    withConversationLock: async (pnid, phone, work) => {
      await echoWinLock(pnid, phone, async () => {
        echoWinInsideLock = true;
        try {
          await work();
        } finally {
          echoWinInsideLock = false;
        }
      });
    },
  });
  await pauseStarted.promise;
  const sendWhileEchoHeld = echoWinLock(
    echoWinPnid,
    echoWinPhone,
    async () => {
      sendEnteredWhileEchoHeld = true;
      const blocked = await pause.isConversationPausedForEscalationAcknowledgement(
        echoWinPnid,
        echoWinPhone,
        'question-race-echo',
        {
          now: () => raceNow,
          fetchState: async () => matchingAckState,
        }
      );
      if (!blocked) echoWinTransported = true;
    }
  );
  await delay(30);
  expect(
    'R1) envio espera a lock enquanto o echo pausa',
    sendEnteredWhileEchoHeld === false
  );
  expect('R1) pausa do echo ocorre dentro da lock', echoWinPauseInsideLock === true);
  expect(
    'R1) latch local é ECHO',
    pause.peekLocalEchoLatch(echoWinPnid, echoWinPhone, raceNow)?.source ===
      'ECHO'
  );
  echoHold.resolve();
  await echoWinPromise;
  await sendWhileEchoHeld;
  expect(
    'R1) echo vence ⇒ transporte suprimido',
    sendEnteredWhileEchoHeld === true && echoWinTransported === false
  );

  // R2) envio vence ⇒ echo só começa depois do recibo
  const sendWinPnid = 'PN-RACE-SEND-WINS';
  const sendWinPhone = '5511999002222';
  const sendWinLock = createSerialLock();
  const sendHold = deferred();
  const sendRelease = deferred();
  let echoPauseStartedBeforeReceipt = false;
  let echoPauseStarted = false;
  let receiptDone = false;
  const sending = sendWinLock(sendWinPnid, sendWinPhone, async () => {
    sendHold.resolve();
    await sendRelease.promise;
    receiptDone = true;
  });
  await sendHold.promise;
  const echoAfterSend = handleSmbMessageEchoes(
    {
      metadata: { phone_number_id: sendWinPnid },
      message_echoes: [
        {
          to: sendWinPhone,
          id: 'wamid.race-send-wins',
          type: 'text',
          text: { body: 'já te atendo' },
        },
      ],
    },
    undefined,
    {
      pauseConversation: async () => {
        echoPauseStartedBeforeReceipt = receiptDone === false;
        echoPauseStarted = true;
      },
      markEchoProcessed: async () => true,
      unmarkEcho: async () => {},
      recordMessage: async () => {},
      withConversationLock: sendWinLock,
    }
  );
  await delay(30);
  expect(
    'R2) echo não começa enquanto o envio segura a lock',
    echoPauseStarted === false && receiptDone === false
  );
  sendRelease.resolve();
  await sending;
  await echoAfterSend;
  expect(
    'R2) envio vence ⇒ echo só começa depois do recibo',
    echoPauseStarted === true &&
      receiptDone === true &&
      echoPauseStartedBeforeReceipt === false
  );

  // R3) POST de pausa falha ⇒ latch ECHO ainda bloqueia o pause-ack
  pause.__resetPauseCacheForTest();
  escalationCache.__resetEscalationCacheForTest();
  const failPnid = 'PN-RACE-POST-FAIL';
  const failPhone = '5511999003333';
  escalationCache.updateEscalationCache(
    failPnid,
    failPhone,
    { active: true, questionId: 'question-race-echo', version: 1 },
    raceNow
  );
  let postFailPropagated = false;
  try {
    await pause.pauseConversationByEcho(failPnid, failPhone, {
      now: () => raceNow,
      persistPause: async () => {
        throw new Error('Receps indisponível (simulado)');
      },
    });
  } catch {
    postFailPropagated = true;
  }
  const failLatch = pause.peekLocalEchoLatch(failPnid, failPhone, raceNow);
  const ackBlockedAfterPostFail =
    await pause.isConversationPausedForEscalationAcknowledgement(
      failPnid,
      failPhone,
      'question-race-echo',
      {
        now: () => raceNow,
        fetchState: async () => matchingAckState,
      }
    );
  expect('R3) falha do POST é propagada', postFailPropagated === true);
  expect(
    'R3) latch local permanece tipado ECHO após POST falho',
    failLatch?.source === 'ECHO'
  );
  expect(
    'R3) POST de pausa falho ⇒ latch ainda bloqueia o pause-ack',
    ackBlockedAfterPostFail === true
  );

  // === G) gravação falha → marca desfeita → retransmissão recupera =========
  // (à prova de perda: o echo é o contexto do §8.2; um blip de DB na 1ª entrega
  // não pode sumir com ele — a retransmissão da Meta tem que re-gravar.)
  echoRecorded.length = 0;
  const recoverEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      { to: '5511CUST3', id: 'wamid.echo3', type: 'text', text: { body: 'pode confirmar?' } },
    ],
  };
  failRecordOnce = true;
  let firstDeliveryRejected = false;
  try {
    await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // record lança → unmark + 5xx
  } catch {
    firstDeliveryRejected = true;
  }
  expect(
    'G) falha durável propaga para o webhook solicitar retransmissão',
    firstDeliveryRejected
  );
  expect('G) gravação falhou na 1ª entrega (nada gravado ainda)', echoRecorded.length === 0);
  expect('G) id desmarcado (idempotência liberada p/ re-tentar)', processedIds.has('wamid.echo3') === false);
  await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // retransmissão → grava
  expect('G) retransmissão recupera o echo (gravado 1x)', echoRecorded.length === 1);
  expect('G) id remarcado após sucesso (não re-grava de novo)', processedIds.has('wamid.echo3') === true);
  await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // 3ª entrega = noop
  expect('G) entrega seguinte é noop (sem gravação dupla)', echoRecorded.length === 1);

  // === F) parseEchoMessages (puro) =========================================
  const parsed = parseEchoMessages(textEcho);
  expect('F) parse: 1 mensagem', parsed.length === 1);
  expect('F) parse: messageId extraído', parsed[0]?.messageId === 'wamid.echo1');
  expect(
    'F) parse: content prefixado com o corpo',
    parsed[0]?.content === `${HUMAN_ECHO_PREFIX}ok, te espero às 15h`
  );
  const parsedAudio = parseEchoMessages(audioEcho);
  expect('F) parse: tipo audio preservado', parsedAudio[0]?.messageType === 'audio');
  expect('F) parse: media id extraído', parsedAudio[0]?.mediaId === 'media-owner-1');
  expect(
    'F) parse: áudio cru já nasce como indisponível, nunca como frase enviável',
    parsedAudio[0]?.content ===
      `${HUMAN_ECHO_PREFIX}[áudio do atendente sem transcrição]`
  );

  const canonicalPhoneEcho = parseEchoMessages({
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      {
        to: '+55 (11) 99999-0000',
        id: 'wamid.echo-canonical',
        type: 'text',
        text: { body: 'ok' },
      },
    ],
  });
  expect(
    'F) parse: telefone do echo converge para a chave canônica do inbound',
    canonicalPhoneEcho[0]?.customerPhone === '5511999990000'
  );

  const noId = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [{ to: '5511X', type: 'text', text: { body: 'oi' } }],
  };
  expect('F) parse: echo sem id é omitido (sem dedup possível)', parseEchoMessages(noId).length === 0);
  expect('F) parse: null → []', parseEchoMessages(null).length === 0);
  expect(
    'F) parse: sem phoneNumberId nem fallback → []',
    parseEchoMessages({ message_echoes: [{ to: 'X', id: 'i', type: 'text' }] }).length === 0
  );
  expect(
    'F) parse: usa fallback phoneNumberId',
    parseEchoMessages(
      { message_echoes: [{ to: 'X', id: 'i', type: 'text', text: { body: 'a' } }] },
      'FB'
    )[0]?.phoneNumberId === 'FB'
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    console.error('❌ FALHOU:', failed.map((c) => c.name).join(' | '));
    process.exit(1);
  }
  console.log('✅ smoke-listen-while-paused OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ erro inesperado no smoke:', e);
  process.exit(1);
});
