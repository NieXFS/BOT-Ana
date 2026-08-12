import assert from 'node:assert/strict';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke';

async function main() {
  const handler = await import('../src/messageHandler');

  const config = {
    tenantSlug: 'dispatch-smoke',
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
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN-DIRECT',
    isActive: true,
  } as any;

  const makeDeps = (overrides: Record<string, unknown> = {}) => ({
    persistInbound: async () => ({
      fresh: true,
      conversationKey: 'PN-DIRECT:5511999990000',
      sequence: 1,
    }),
    deliverInbound: async () => ({ delivered: true, attempts: 1 }),
    updateInboundContent: async () => undefined,
    markTranscriptionFailed: async () => undefined,
    downloadAudio: async () => Buffer.from('audio'),
    transcribeAudio: async () => 'texto do áudio',
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    isPaused: async () => false,
    resumeGate: async () => true,
    sendReply: async () => 'sent' as const,
    withConversationLock: async (
      _phoneNumberId: string,
      _customerPhone: string,
      work: () => Promise<void>
    ) => work(),
    ...overrides,
  });

  // Áudio ilegível durante takeover: finaliza o intake, mas não digita/envia.
  let paused = true;
  let sends = 0;
  let locks = 0;
  await handler.handleIncomingMessage(
    {
      from: '5511999990000',
      id: 'wamid-audio-missing',
      timestamp: '1786550400',
      type: 'audio',
      audio: undefined,
    },
    { profile: { name: 'Cliente' } },
    config,
    makeDeps({
      isPaused: async () => paused,
      sendReply: async () => {
        sends += 1;
        return 'sent' as const;
      },
      withConversationLock: async (
        _phoneNumberId: string,
        _customerPhone: string,
        work: () => Promise<void>
      ) => {
        locks += 1;
        await work();
      },
    }) as any
  );
  assert.equal(locks, 1);
  assert.equal(sends, 0, 'áudio ilegível pausado deve gerar zero transporte');

  // Takeover enquanto a transcrição está em voo: ao falhar, a pausa fresca vence.
  paused = false;
  sends = 0;
  let transcriptionStarted = false;
  let rejectTranscription!: (reason?: unknown) => void;
  const pendingTranscription = new Promise<string>((_resolve, reject) => {
    rejectTranscription = reject;
  });
  const inFlight = handler.handleIncomingMessage(
    {
      from: '5511999990001',
      id: 'wamid-audio-race',
      timestamp: '1786550401',
      type: 'audio',
      audio: { id: 'media-1', mime_type: 'audio/ogg' },
    },
    { profile: { name: 'Cliente' } },
    config,
    makeDeps({
      transcribeAudio: async () => {
        transcriptionStarted = true;
        return pendingTranscription;
      },
      isPaused: async () => paused,
      sendReply: async () => {
        sends += 1;
        return 'sent' as const;
      },
    }) as any
  );
  while (!transcriptionStarted) await Promise.resolve();
  paused = true;
  rejectTranscription(new Error('transcription failed'));
  await inFlight;
  assert.equal(sends, 0, 'takeover durante transcrição deve gerar zero transporte');

  // Fora de horário: echo vence a lock entre a checagem inicial e o dispatch.
  handler.__resetFlushStateForTest();
  sends = 0;
  let pauseChecks = 0;
  const outsideConfig = {
    ...config,
    phoneNumberId: 'PN-OUTSIDE',
    botIsAlwaysActive: false,
    botActiveStart: '23:59',
    botActiveEnd: '23:59',
  };
  await handler.handleIncomingMessage(
    {
      from: '5511999990002',
      id: 'wamid-outside-race',
      timestamp: '1786550402',
      type: 'text',
      text: { body: 'Boa noite, quero informações' },
    },
    { profile: { name: 'Cliente' } },
    outsideConfig,
    makeDeps({
      isPaused: async () => {
        pauseChecks += 1;
        return pauseChecks >= 2;
      },
      sendReply: async () => {
        sends += 1;
        return 'sent' as const;
      },
    }) as any
  );
  assert.equal(sends, 0, 'takeover antes do aviso fora de horário deve vencer');

  // A tentativa suprimida não pode consumir a janela de quatro horas: após a
  // retomada, o próximo inbound fora de horário ainda recebe o primeiro aviso.
  await handler.handleIncomingMessage(
    {
      from: '5511999990002',
      id: 'wamid-outside-after-resume',
      timestamp: '1786550403',
      type: 'text',
      text: { body: 'Agora pode responder' },
    },
    { profile: { name: 'Cliente' } },
    outsideConfig,
    makeDeps({
      isPaused: async () => false,
      sendReply: async () => {
        sends += 1;
        return 'sent' as const;
      },
    }) as any
  );
  assert.equal(
    sends,
    1,
    'aviso suprimido por takeover deve ficar elegível após a retomada'
  );

  // Erro pré-envio: M24 adquire exatamente uma lock (PG não é reentrante).
  handler.__resetFlushStateForTest();
  let activeLock = false;
  locks = 0;
  let fallbackSends = 0;
  const key = handler.__seedFlushBufferForTest(config, '5511999990003', ['oi']);
  await handler.flushBuffer(key, {
    getReply: async () => {
      throw new Error('provider failed before transport');
    },
    sendReply: async () => 'sent' as const,
    sendReplyPlain: async () => {
      fallbackSends += 1;
      return 'sent' as const;
    },
    isPaused: async () => false,
    recordPausedInbound: async () => undefined,
    withConversationLock: async (_pnid, _phone, work) => {
      assert.equal(activeLock, false, 'advisory lock não pode ser aninhada');
      activeLock = true;
      locks += 1;
      try {
        await work();
      } finally {
        activeLock = false;
      }
    },
  });
  assert.equal(locks, 1);
  assert.equal(fallbackSends, 1);

  // Resultado incerto do POST: zero M24 e zero segunda aquisição de lock.
  handler.__resetFlushStateForTest();
  activeLock = false;
  locks = 0;
  fallbackSends = 0;
  const ambiguous = Object.assign(new Error('timeout after POST'), {
    isAxiosError: true,
    code: 'ECONNABORTED',
    request: {},
  });
  const ambiguousKey = handler.__seedFlushBufferForTest(
    config,
    '5511999990004',
    ['oi']
  );
  await handler.flushBuffer(ambiguousKey, {
    getReply: async () => 'resposta válida',
    sendReply: async () => {
      throw ambiguous;
    },
    sendReplyPlain: async () => {
      fallbackSends += 1;
      return 'sent' as const;
    },
    isPaused: async () => false,
    recordPausedInbound: async () => undefined,
    withConversationLock: async (_pnid, _phone, work) => {
      assert.equal(activeLock, false, 'lock ambígua não pode ser aninhada');
      activeLock = true;
      locks += 1;
      try {
        await work();
      } finally {
        activeLock = false;
      }
    },
  });
  assert.equal(locks, 1);
  assert.equal(fallbackSends, 0, 'timeout ambíguo nunca autoriza outra mensagem');
  assert.equal(handler.__hasBufferForTest(ambiguousKey), false);

  console.log('smoke direct receptionist dispatch: OK');
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
