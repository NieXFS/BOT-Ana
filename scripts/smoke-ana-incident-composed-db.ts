import 'dotenv/config';
import assert from 'node:assert/strict';

async function main(): Promise<void> {
  if (process.env.ANA_SMOKE_SKIP_DB === '1') {
    throw new Error('ANA_SMOKE_SKIP_DB=1 é proibido no gate do incidente.');
  }
  if (!process.env.RECEPS_IA_DIRECT_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('Banco isolado obrigatório para o smoke composto do incidente.');
  }

  const order = await import('../src/services/conversationOrder');
  process.env.DATABASE_URL = order.resolveConversationOrderDatabaseUrl();
  process.env.OPENAI_API_KEY ||= 'sk-smoke-invalid';
  process.env.ERP_API_TOKEN ||= 'smoke-erp-token';
  process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';

  const processed = await import('../src/services/processedMessages');
  const store = await import('../src/services/anaWave2Store');
  const context = await import('../src/services/contextManager');
  const human = await import('../src/services/humanConversationContext');
  const echo = await import('../src/echoHandler');
  const brain = await import('../src/services/brainService');
  const outbound = await import('../src/services/receptionistOutbound');
  const handler = await import('../src/messageHandler');
  const privacy = await import('../src/services/privacyPurge');

  await processed.ensureProcessedMessagesTable();
  await store.ensureAnaWave2Tables();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phoneNumberId = `PN-COMPOSED-${suffix}`;
  const customerPhone = '5511000000000';
  const identityPhone = '5511000000001';
  const conversationKey = context.buildConversationKey(
    phoneNumberId,
    customerPhone
  );
  const identityConversationKey = context.buildConversationKey(
    phoneNumberId,
    identityPhone
  );
  const config = {
    tenantSlug: `incident-composed-${suffix}`,
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Atenda com segurança.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'smoke-token',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  } as const;

  let inboundSequence = 0;
  const incomingDeps = {
    persistInbound: store.persistInboundAtomically,
    deliverInbound: async () => ({
      delivered: true,
      attempts: 1,
      terminal: false,
      fastRetryAllowed: false,
    }),
    updateInboundContent: store.updateInboundHistoryContent,
    markTranscriptionFailed: store.markInboundTranscriptionFailed,
    downloadAudio: async () => Buffer.from('audio-inbound-smoke'),
    transcribeAudio: async () => 'áudio inbound smoke',
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    isPaused: async () => false,
    resumeGate: async () => true,
    withConversationLock: (
      currentPhoneNumberId: string,
      currentCustomerPhone: string,
      work: () => Promise<void>
    ) =>
      order.withConversationLock(
        currentPhoneNumberId,
        currentCustomerPhone,
        async () => work()
      ),
  };

  async function ingestAndFlush(
    texts: string[],
    getReply: (...args: any[]) => Promise<any>,
    transport: string[],
    target: {
      config: typeof config | (typeof config & { greetingMessage: string });
      customerPhone: string;
      conversationKey: string;
    } = { config, customerPhone, conversationKey }
  ): Promise<void> {
    handler.__resetFlushStateForTest();
    for (const text of texts) {
      inboundSequence += 1;
      await handler.handleIncomingMessage(
        {
          from: target.customerPhone,
          id: `wamid.inbound.${suffix}.${inboundSequence}`,
          timestamp: String(Math.floor(Date.now() / 1000) + inboundSequence),
          type: 'text',
          text: { body: text },
        },
        { profile: { name: 'Cliente Smoke' }, wa_id: target.customerPhone },
        target.config as any,
        incomingDeps as any
      );
    }
    assert.equal(
      handler.__hasBufferForTest(target.conversationKey),
      true,
      'o handler real deve criar o buffer da conversa'
    );
    await handler.flushBuffer(target.conversationKey, {
      getReply: getReply as any,
      isPaused: async () => false,
      recordPausedInbound: async () => undefined,
      withConversationLock: incomingDeps.withConversationLock,
      sendReply: async (to, reply, tenantConfig) =>
        handler.sendConfiguredReply(to, reply, tenantConfig, {
          voiceEnabled: () => false,
          deliverVoice: async () => undefined,
          waitTyping: async () => undefined,
          isPausedBeforeTransport: async () => false,
          sendText: async (_to, text) => {
            transport.push(text);
          },
        }),
    });
  }

  try {
    // Histórico deliberadamente perigoso: o entrypoint real deve ignorá-lo ao
    // receber uma saudação e responder sem ERP/modelo/reuso operacional.
    await context.addMessage(
      conversationKey,
      'assistant',
      'Só pra confirmar: pé com Luzia amanhã às 09h30.'
    );
    const greetingTransport: string[] = [];
    await ingestAndFlush(
      ['Bia tarde', 'Tudo bem?'],
      brain.getReply,
      greetingTransport
    );
    assert.equal(
      greetingTransport.length,
      1,
      'duas mensagens no debounce devem gerar uma única resposta'
    );
    assert.match(greetingTransport[0]!, /^Boa tarde!/);
    assert.doesNotMatch(greetingTransport[0]!, /Luzia|09h30|p[eé]\b/i);

    const echoMessageId = `wamid.echo.${suffix}`;
    const echoPayload = {
      metadata: { phone_number_id: phoneNumberId },
      message_echoes: [
        {
          id: echoMessageId,
          to: `+${customerPhone}`,
          type: 'audio',
          audio: { id: `media-${suffix}` },
        },
      ],
    };
    const echoDeps = {
      pauseConversation: async () => undefined,
      markEchoProcessed: async () => {
        throw new Error('caminho legado não pode ser usado em produção');
      },
      unmarkEcho: async () => undefined,
      recordMessage: async () => {
        throw new Error('write separado não pode ser usado em produção');
      },
      persistEchoAtomically: store.persistHumanEchoAtomically,
      loadConfig: async () => config as any,
      shouldTranscribeHumanAudio: () => true,
      downloadAudio: async () => Buffer.from('audio-smoke'),
      transcribeAudio: async () => 'combinado para sexta às 13h',
      withConversationLock: (
        currentPhoneNumberId: string,
        currentCustomerPhone: string,
        work: () => Promise<void>
      ) =>
        order.withConversationLock(
          currentPhoneNumberId,
          currentCustomerPhone,
          async () => work()
        ),
    };
    await echo.handleSmbMessageEchoes(echoPayload, undefined, echoDeps);
    await echo.handleSmbMessageEchoes(echoPayload, undefined, echoDeps);

    const [processedCount, historyCount] = await Promise.all([
      context.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM processed_messages WHERE message_id = $1',
        [echoMessageId]
      ),
      context.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ana_conversation_history WHERE message_id = $1',
        [echoMessageId]
      ),
    ]);
    assert.equal(processedCount.rows[0]?.count, '1');
    assert.equal(historyCount.rows[0]?.count, '1');

    const rollbackMessageId = `wamid.echo.rollback.${suffix}`;
    await assert.rejects(
      store.persistHumanEchoAtomically({
        messageId: rollbackMessageId,
        phoneNumberId,
        conversationKey,
        content: null as unknown as string,
      })
    );
    const rolledBackProcessed = await context.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM processed_messages WHERE message_id = $1',
      [rollbackMessageId]
    );
    assert.equal(
      rolledBackProcessed.rows[0]?.count,
      '0',
      'falha da gravação do histórico deve desfazer também o dedup'
    );
    assert.equal(
      await store.persistHumanEchoAtomically({
        messageId: rollbackMessageId,
        phoneNumberId,
        conversationKey,
        content: '[atendente] retransmissão recuperada',
      }),
      true,
      'retransmissão após rollback precisa voltar a ser elegível'
    );

    const history = await context.getHistory(conversationKey);
    const modelHistory = human.toReceptionistModelHistory(history);
    const teamMessage = modelHistory.find(
      (message) => message.name === 'equipe_humana'
    );
    assert.ok(teamMessage);
    assert.match(teamMessage.content, /combinado para sexta/);
    assert.doesNotMatch(teamMessage.content, /\[atendente\]|enviou um [aá]udio/i);

    // Completion hostil copia byte a byte o contexto humano. O loop real a
    // entrega à fronteira final, que precisa resultar em zero transporte.
    const loop = await brain.runReceptionistModelLoop({
      config: config as any,
      messages: [{ role: 'system', content: 'smoke' }, ...modelHistory] as any,
      executeTool: async () => {
        throw new Error('nenhuma tool esperada');
      },
      retryOnFailure: false,
      completionFactory: async () =>
        ({
          id: `completion-${suffix}`,
          object: 'chat.completion',
          created: 0,
          model: 'smoke',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              logprobs: null,
              message: {
                role: 'assistant',
                content: teamMessage.content,
                refusal: null,
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }) as any,
    });
    assert.equal(loop.rawReply, teamMessage.content);
    const copied = outbound.validateReceptionistOutbound(
      outbound.buildReceptionistEnvelope({
        purpose: 'REACTIVE',
        blocks: [{ source: 'GENERATED', text: loop.rawReply! }],
        authoritativeCatalog: { services: [], professionals: [] },
        evidence: { sourceInboundText: 'Pode me ajudar?' },
      })
    );
    assert.equal(copied.originalAccepted, false);
    assert.ok(copied.reasonCodes.includes('INTERNAL_CONVERSATION_MARKER'));
    const copiedTransport: string[] = [];
    const copiedDelivery = await handler.sendConfiguredReply(
      customerPhone,
      copied,
      config as any,
      {
        voiceEnabled: () => false,
        deliverVoice: async () => undefined,
        waitTyping: async () => undefined,
        isPausedBeforeTransport: async () => false,
        sendText: async (_to, text) => {
          copiedTransport.push(text);
        },
      }
    );
    assert.equal(copiedDelivery, 'suppressed');
    assert.deepEqual(copiedTransport, []);

    // Agora atravessa o caminho real do incidente: intake DB → buffer → flush
    // → resposta hostil do provider → sendConfiguredReply → transporte.
    const fullMarkerTransport: string[] = [];
    await ingestAndFlush(
      ['Bom dia IA 🤖😂'],
      async () => teamMessage.content,
      fullMarkerTransport
    );
    assert.deepEqual(
      fullMarkerTransport,
      [],
      'wrapper/echo humano copiado pelo provider nunca chega ao WhatsApp'
    );

    const repeatedFallbackTransport: string[] = [];
    for (const inbound of ['Olá', 'Boa tarde', 'Oi', 'Tudo bem?', 'Olá de novo']) {
      await ingestAndFlush(
        [inbound],
        async () => outbound.RECEPTIONIST_SAFE_FALLBACK,
        repeatedFallbackTransport
      );
    }
    assert.deepEqual(
      repeatedFallbackTransport,
      [],
      'cinco turnos inseguros geram zero fallback técnico e zero loop'
    );

    // Contrato HTTP 409 do ERP: o reason customer_identity_ambiguous chega no
    // toolTrace no mesmo shape que calendarService devolve após o 409, e o
    // caminho composto (1º contato + saudação do tenant + prosa hostil) tem
    // de transportar SOMENTE a resposta canônica.
    const identity = await import('../src/services/customerIdentitySafety');
    const identityConfig = {
      ...config,
      greetingMessage:
        'Olá! Sou a Ana, sua assistente. Como posso te ajudar hoje?',
    } as const;
    const identityTrace = [
      {
        name: 'getUpcomingAppointments',
        result: JSON.stringify({
          success: false,
          reason: 'customer_identity_ambiguous',
          message: identity.CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
        }),
      },
    ];
    const identityTransport: string[] = [];
    await ingestAndFlush(
      ['Quero remarcar meu horário'],
      async () =>
        brain.validateComposedReceptionistReply({
          baseReply: identity.enforceCustomerIdentitySafeReply(
            identityTrace,
            'Parece que há dois cadastros. Qual deles é o seu?'
          )!,
          isFirstContact: true,
          config: identityConfig as any,
          services: { success: true, services: [], professionals: [] },
          purpose: 'REACTIVE',
          toolTrace: identityTrace,
          sourceInboundText: 'Quero remarcar meu horário',
          appendPostBooking: true,
        }),
      identityTransport,
      {
        config: identityConfig,
        customerPhone: identityPhone,
        conversationKey: identityConversationKey,
      }
    );
    assert.deepEqual(
      identityTransport,
      [identity.CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE],
      '409/customer_identity_ambiguous no 1º contato deve virar só a resposta canônica'
    );

    console.log(
      'smoke composto DB: handler→buffer→flush + echo→history→model→outbound→transport OK'
    );
  } finally {
    handler.__resetFlushStateForTest();
    try {
      await privacy.purgeConversationData(phoneNumberId, customerPhone);
      await privacy.purgeConversationData(phoneNumberId, identityPhone);
      const cleanupCounts = await Promise.all([
        context.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM ana_conversation_history WHERE "conversationKey" = ANY($1::text[])',
          [[conversationKey, identityConversationKey]]
        ),
        context.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM processed_messages WHERE conversation_key = ANY($1::text[])',
          [[conversationKey, identityConversationKey]]
        ),
        context.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM inbound_event_outbox WHERE conversation_key = ANY($1::text[])',
          [[conversationKey, identityConversationKey]]
        ),
      ]);
      assert.deepEqual(
        cleanupCounts.map((result) => result.rows[0]?.count),
        ['0', '0', '0'],
        'cleanup do smoke composto precisa ser verificável e completo'
      );
    } finally {
      await Promise.all([
        context.pool.end(),
        order.closeConversationOrderPoolForSmoke(),
      ]);
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
