import fs from 'fs';
import path from 'path';
import type { TenantBotConfig } from '../src/configProvider';

process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.RECEPS_IA_DIRECT_DATABASE_URL ??=
  'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.OPENAI_API_KEY ??= 'sk-smoke';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function listTypeScriptSources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptSources(relative);
    return entry.isFile() && relative.endsWith('.ts') ? [relative] : [];
  });
}

/**
 * A lista nasce do próprio src para que um novo arquivo do runtime não fique
 * fora do gate por esquecimento. Excluímos apenas módulos inequivocamente
 * sales/Renata-only; arquivos compartilhados (messageHandler, webhook e
 * observabilidade) continuam no sweep.
 */
const SOURCE_PATHS = listTypeScriptSources('src').filter((relative) => {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  if (normalized === 'src/utils/anthropicretry.ts') return false;
  return !/(?:^|\/)(?:sales|renata|voice|onboarding)(?:\/|-|\.|[a-z])/i.test(
    normalized
  );
});

function sourceSweep(): string[] {
  const findings: string[] = [];
  const forbidden = [
    /captureException\(\s*(?:err|error|sendErr|unmarkErr)\b/,
    /console\.(?:log|info|warn|error)\([\s\S]*?,\s*(?:err|error|sendErr|unmarkErr)\s*\)/,
    /\$\{\s*(?:customerPhone|conversationKey|bufferKey|from|name|consolidatedText)\s*\}/,
    /\$\{\s*(?:text|reply|content|transcription)\s*\}/,
    /(?:response\??\.data|JSON\.stringify\s*\(\s*(?:err|error))/,
    /response\??\.(?:body|data)/,
    /JSON\.stringify\s*\(\s*(?:payload|callbackPayload)/,
  ];
  // Este gate é deliberadamente mais estreito que o scrub: `message.id` é
  // autoridade no intake, mas nunca pode ser projetado em console, tags,
  // contexts ou receipts serializados. O scrub não torna uma tag crua aceitável
  // — a captura deve nascer higienizada.
  const rawMessageIdTelemetry = [
    /\$\{\s*(?:message\.id|messageId|input\.messageId|row\.messageId|event\.providerMessageId|obligation\.providerMessageId)\s*\}/,
    /(?:messageId|message_id)\s*:\s*(?:message\.id|messageId|input\.messageId|row\.messageId|event\.providerMessageId|obligation\.providerMessageId)\b/,
    /(?:setTag|setContext|setExtra|setExtras)\s*\(\s*['"](?:messageId|message_id)['"]\s*,\s*(?:message\.id|messageId|input\.messageId|row\.messageId|event\.providerMessageId|obligation\.providerMessageId)\b/,
  ];

  const extractCalls = (
    source: string,
    startPattern: RegExp
  ): Array<{ body: string; line: number }> => {
    const calls: Array<{ body: string; line: number }> = [];
    for (const match of source.matchAll(startPattern)) {
      const start = match.index ?? 0;
      const open = source.indexOf('(', start);
      let depth = 0;
      let quote: "'" | '"' | '`' | null = null;
      let escaped = false;
      let end = source.length;
      for (let cursor = open; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === quote) {
            quote = null;
          }
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') {
          depth -= 1;
          if (depth === 0) {
            end = cursor + 1;
            break;
          }
        }
      }
      calls.push({
        body: source.slice(start, end),
        line: source.slice(0, start).split('\n').length,
      });
    }
    return calls;
  };

  for (const relative of SOURCE_PATHS) {
    const source = fs.readFileSync(path.resolve(relative), 'utf8');
    const telemetryCalls = extractCalls(
      source,
      /(?:console\.(?:log|info|warn|error)|Sentry\.(?:captureException|captureMessage|withIsolationScope)|(?:scope|Sentry)\.(?:setTag|setContext|setExtra|setExtras))\s*\(/g
    );
    for (const call of telemetryCalls) {
      const statusSurfacePatterns = relative.endsWith(
        'services/whatsappStatusHandler.ts'
      )
        ? [
            /\$\{\s*(?:(?:event|payload|obligation)\.)?providerMessageId\s*\}/,
            /providerMessageId\s*:/,
            /\$\{\s*(?:(?:payload|obligation)\.)?phoneNumberId\s*\}/,
            /phoneNumberId\s*:/,
          ]
        : [];
      for (const pattern of [...forbidden, ...statusSurfacePatterns]) {
        if (pattern.test(call.body)) {
          findings.push(`${relative}:${call.line}`);
          break;
        }
      }
      for (const pattern of rawMessageIdTelemetry) {
        if (pattern.test(call.body)) {
          findings.push(`raw-message-id-telemetry:${relative}:${call.line}`);
          break;
        }
      }
    }
    // Receipts and other serialized envelopes are a separate surface. They
    // are not passed through the log-call checks above, but may still leak an
    // ID if a raw field is added to one.
    for (const call of extractCalls(source, /JSON\.stringify\s*\(/g)) {
      for (const pattern of rawMessageIdTelemetry) {
        if (pattern.test(call.body)) {
          findings.push(`raw-message-id-receipt:${relative}:${call.line}`);
          break;
        }
      }
    }
  }
  return [...new Set(findings)];
}

function countTechnicalMessageIdSinks(): number {
  const sources = {
    messageHandler: fs.readFileSync(
      path.resolve('src/messageHandler.ts'),
      'utf8'
    ),
    webhookServer: fs.readFileSync(
      path.resolve('src/webhookServer.ts'),
      'utf8'
    ),
  };
  const expectedSinks: Array<[keyof typeof sources, RegExp]> = [
    [
      'messageHandler',
      /operation:\s*'inbound_outbox_immediate'[\s\S]{0,180}messageIdHash:\s*technicalHash\(\s*message\.id\s*\)/,
    ],
    [
      'messageHandler',
      /Inbound repetida[\s\S]{0,180}messageIdHash=\$\{\s*technicalHash\(\s*message\.id\s*\)\s*\}/,
    ],
    [
      'messageHandler',
      /operation:\s*'audio_transcription'[\s\S]{0,180}messageIdHash:\s*technicalHash\(\s*message\.id\s*\)/,
    ],
    [
      'messageHandler',
      /operation:\s*'finalize_audio_failure'[\s\S]{0,180}messageIdHash:\s*technicalHash\(\s*message\.id\s*\)/,
    ],
    [
      'messageHandler',
      /\[escalation\] inbound pendente[\s\S]{0,180}messageIdHash=\$\{\s*technicalHash\(\s*message\.id\s*\)\s*\}/,
    ],
    [
      'webhookServer',
      /Mensagem já processada[\s\S]{0,180}messageIdHash=\$\{\s*technicalHash\(\s*message\.id\s*\)\s*\}/,
    ],
  ];
  return expectedSinks.filter(([file, pattern]) => pattern.test(sources[file])).length;
}

async function main(): Promise<void> {
  const findings = sourceSweep();
  const hashSinkCount = countTechnicalMessageIdSinks();
  check(
    'sweep de fonte não encontra PII/raw Error em telemetria',
    findings.length === 0,
    findings.join(', ') || undefined
  );
  check(
    'seis sinks de message id projetam somente hash técnico',
    hashSinkCount === 6,
    `encontrados=${hashSinkCount}`
  );

  const messageHandler = await import('../src/messageHandler');
  const pauseService = await import('../src/services/pauseService');
  const order = await import('../src/services/conversationOrder');
  const statusHandler = await import('../src/services/whatsappStatusHandler');
  const { technicalHash, runtimeErrorDetail } = await import('../src/observability/safeRuntime');

  const secretPhone = '5511987654321';
  const secretPhoneE164 = `+${secretPhone}`;
  const secretInbound = 'Minha unha está doendo muito e meu CPF é 123.456.789-00';
  const secretReply = 'Rascunho clínico secreto para a cliente';
  const secretName = 'Maria Segredo da Silva';
  const secretError = `request body ${secretPhone} ${secretInbound}`;
  const secretInboundMessageId = 'wamid-inbound-PII-CRU-NAO-LOGAR';
  const secretProviderMessageId = 'wamid-PII-CRU-NAO-LOGAR';
  const secretPhoneNumberId = 'PNID-PII-CRU-NAO-LOGAR';
  const captured: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args: unknown[]) => {
    captured.push(args.map((value) => String(value)).join(' '));
  };

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
    waAccessToken: 'fixture-token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN-PII-SMOKE',
    isActive: true,
  };

  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const persistedInboundIds = new Set<string>();
    await messageHandler.handleIncomingMessage(
      {
        from: secretPhone,
        id: secretInboundMessageId,
        timestamp: '1722470400',
        type: 'text',
        text: { body: secretInbound },
      },
      { profile: { name: secretName }, wa_id: secretPhone },
      config,
      {
        persistInbound: async (input) => {
          const fresh = !persistedInboundIds.has(input.messageId);
          if (fresh) persistedInboundIds.add(input.messageId);
          return {
            fresh,
            conversationKey: `${input.phoneNumberId}:${secretPhone}`,
            sequence: fresh ? 1 : null,
          };
        },
        deliverInbound: async () => ({
          delivered: true,
          attempts: 1,
          terminal: false,
          fastRetryAllowed: false,
        }),
        updateInboundContent: async () => undefined,
        markTranscriptionFailed: async () => undefined,
        downloadAudio: async () => Buffer.alloc(0),
        transcribeAudio: async () => 'transcrição secreta',
        handleOptOut: async () => false,
        shouldSuspend: async () => false,
        isPaused: async () => true,
      }
    );
    // A retransmissão precisa atravessar o mesmo sink de console que o replay
    // de cutover exercita. O ID permanece sintético e nunca deve ser emitido.
    await messageHandler.handleIncomingMessage(
      {
        from: secretPhone,
        id: secretInboundMessageId,
        timestamp: '1722470400',
        type: 'text',
        text: { body: `${secretInbound} retransmitida` },
      },
      { profile: { name: secretName }, wa_id: secretPhone },
      config,
      {
        persistInbound: async (input) => {
          const fresh = !persistedInboundIds.has(input.messageId);
          if (fresh) persistedInboundIds.add(input.messageId);
          return {
            fresh,
            conversationKey: `${input.phoneNumberId}:${secretPhone}`,
            sequence: fresh ? 1 : null,
          };
        },
        deliverInbound: async () => ({
          delivered: true,
          attempts: 1,
          terminal: false,
          fastRetryAllowed: false,
        }),
        updateInboundContent: async () => undefined,
        markTranscriptionFailed: async () => undefined,
        downloadAudio: async () => Buffer.alloc(0),
        transcribeAudio: async () => 'transcrição secreta',
        handleOptOut: async () => false,
        shouldSuspend: async () => false,
        isPaused: async () => true,
      }
    );

    const bufferKey = messageHandler.__seedFlushBufferForTest(
      config,
      secretPhone,
      [secretInbound]
    );
    await messageHandler.flushBuffer(bufferKey, {
      getReply: async () => secretReply,
      sendReply: async () => undefined,
      isPaused: async () => false,
      recordPausedInbound: async () => undefined,
    });

    try {
      await pauseService.pauseConversationByEcho(
        config.phoneNumberId,
        secretPhone,
        {
          now: () => 1_000,
          persistPause: async () => {
            throw new Error(secretError);
          },
        }
      );
    } catch {
      // Esperado: falha durável precisa subir para o webhook pedir replay. Este
      // smoke verifica apenas que o erro original/PII não aparece nos logs.
    }

    await statusHandler.handleWhatsAppStatuses(
      {
        statuses: [
          {
            id: secretProviderMessageId,
            status: 'sent',
            timestamp: '1722470400',
          },
        ],
      },
      {
        store: {
          async apply(event) {
            return {
              kind: 'applied',
              obligation: {
                phoneNumberId: secretPhoneNumberId,
                providerMessageId: event.providerMessageId,
                statusEvent: event.statusEvent,
                occurredAt: event.occurredAt,
                failureCode: event.failureCode,
                version: 1,
                attempts: 0,
              },
            };
          },
          async markCallbackAck() {
            return false;
          },
          async markCallbackFailure() {
            return true;
          },
          async listPendingCallbacks() {
            return [];
          },
        },
        postCallback: async () => {
          throw new Error(
            `response body callback payload ${secretProviderMessageId} ${secretPhoneNumberId}`
          );
        },
        wait: async () => undefined,
        now: () => 1_000,
      }
    );
  } finally {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    messageHandler.__resetFlushStateForTest();
    pauseService.__resetPauseCacheForTest();
    await order.closeConversationOrderPoolForSmoke();
  }

  const joined = captured.join('\n');
  const forbiddenOutput = [
    secretPhone,
    secretPhoneE164,
    secretInbound,
    secretReply,
    secretName,
    secretError,
    '123.456.789-00',
    'transcrição secreta',
    secretInboundMessageId,
    secretProviderMessageId,
    secretPhoneNumberId,
    'response body callback payload',
  ];
  check(
    'captura de console em intake/flush/pausa/envio não contém PII/conteúdo',
    forbiddenOutput.every((value) => !joined.includes(value))
  );
  check('captura preserva convHash técnico', joined.includes('convHash='));
  check('captura preserva apenas contagens de conteúdo', joined.includes('chars='));
  check(
    'replay capturado não emite ID cru e emite hash técnico',
    !joined.includes(secretInboundMessageId) &&
      joined.includes(`messageIdHash=${technicalHash(secretInboundMessageId)}`)
  );
  check(
    'status usa hashes técnicos consistentes para provider e phoneNumberId',
    joined.includes(`providerMessageHash=${technicalHash(secretProviderMessageId)}`) &&
      joined.includes(`phoneNumberHash=${technicalHash(secretPhoneNumberId)}`)
  );

  const detailed = runtimeErrorDetail(
    new Error(`flush failed ${secretPhoneE164}`)
  );
  check(
    'runtimeErrorDetail redige E.164 no stack',
    !detailed.includes(secretPhoneE164) && !detailed.includes(secretPhone)
  );
  check(
    'runtimeErrorDetail preserva name+message',
    detailed.includes('Error') && detailed.includes('flush failed')
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : typeof error);
  process.exitCode = 1;
});
