/**
 * IA-17d: a fronteira final ignora o cache de 25s e relê /pause-state.
 *
 * Buraco: inbound GET → cache false; painel cria SENDING enquanto o brain
 * trabalha; Ana chega ao POST dentro do TTL e falaria por cima do humano.
 *
 * Sem rede/DB/WhatsApp reais — fetchState, lock, transporte e relógio injetados.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';
process.env.ERP_API_TOKEN ||= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';
process.env.SENTRY_DSN = '';

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { PauseState } from '../src/services/pauseDecision';
import type { ValidatedReceptionistOutbound } from '../src/services/receptionistOutbound';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

const PNID = 'PN-FRESH';
const PHONE = '5511999000001';
const NOW = Date.UTC(2026, 7, 19, 15, 0, 0);
const WITHIN_TTL_MS = 8_000;
const OVERLAY_UNTIL = new Date(NOW + 60 * 60_000).toISOString();

const idleState: PauseState = {
  globalPausedUntil: null,
  conversationPausedUntil: null,
  schedulePausedUntil: null,
  humanPause: { active: false, source: null, until: null },
  escalationPause: { active: false, questionId: null, version: 0, until: null },
};

function overlayState(): PauseState {
  return {
    ...idleState,
    conversationPausedUntil: OVERLAY_UNTIL,
    humanPause: { active: true, source: 'ECHO', until: OVERLAY_UNTIL },
  };
}

function echoState(): PauseState {
  return overlayState();
}

const config: TenantBotConfig = {
  tenantSlug: 'smoke-fresh-frontier',
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
  phoneNumberId: PNID,
  isActive: true,
};

const validated: ValidatedReceptionistOutbound = {
  kind: 'validated_receptionist_outbound',
  payload: 'Claro, posso te ajudar com o horário.',
  originalAccepted: true,
  reasonCodes: [],
  purpose: 'REACTIVE',
  sources: ['GENERATED'],
};

async function main(): Promise<void> {
  const pause = await import('../src/services/pauseService');
  const handler = await import('../src/messageHandler');
  const escalation = await import('../src/services/escalationCache');

  const primeIdleCache = async (): Promise<{ ordinaryFetches: number }> => {
    pause.__resetPauseCacheForTest();
    escalation.__resetEscalationCacheForTest();
    const counter = { ordinaryFetches: 0 };
    const paused = await pause.isConversationPaused(PNID, PHONE, {
      now: () => NOW,
      fetchState: async () => {
        counter.ordinaryFetches += 1;
        return idleState;
      },
    });
    assert.equal(paused, false);
    return counter;
  };

  // --- Cache ordinário permanece nas checagens anteriores -------------------
  const primed = await primeIdleCache();
  let forbiddenOrdinaryFetch = 0;
  const stillOpen = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + WITHIN_TTL_MS,
    fetchState: async () => {
      forbiddenOrdinaryFetch += 1;
      return overlayState();
    },
  });
  check(
    'cache primado false não relê /pause-state dentro de 25s',
    primed.ordinaryFetches === 1 && forbiddenOrdinaryFetch === 0 && stillOpen === false
  );

  // --- SENDING overlay: GET fresco + sendConfiguredReply outbound zero ------
  let sendingFetches = 0;
  const sendingDeps = {
    now: () => NOW + WITHIN_TTL_MS,
    fetchState: async () => {
      sendingFetches += 1;
      return overlayState();
    },
  };
  check(
    'overlay SENDING é visível só na leitura fresca',
    (await pause.isConversationPausedFresh(PNID, PHONE, sendingDeps)) === true
  );
  check('fronteira final consulta /pause-state de novo (SENDING)', sendingFetches === 1);

  sendingFetches = 0;
  let sends = 0;
  const sendingDelivery = await handler.sendConfiguredReply(
    PHONE,
    validated,
    config,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => {
        throw new Error('voz não entra na fronteira da recepcionista');
      },
      waitTyping: async () => undefined,
      sendText: async () => {
        sends += 1;
      },
      isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
        pause.isConversationPausedFresh(phoneNumberId, customerPhone, sendingDeps),
    }
  );
  check(
    'SENDING: nova consulta e outbound zero no sendConfiguredReply',
    sendingFetches === 1 && sends === 0 && sendingDelivery === 'suppressed'
  );

  // --- CONFIRMATION_PENDING: mesmo overlay, outro turno ---------------------
  await primeIdleCache();
  let pendingFetches = 0;
  const pendingDeps = {
    now: () => NOW + WITHIN_TTL_MS,
    fetchState: async () => {
      pendingFetches += 1;
      return overlayState();
    },
  };
  sends = 0;
  const pendingDelivery = await handler.sendConfiguredReply(
    PHONE,
    validated,
    config,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => undefined,
      waitTyping: async () => undefined,
      sendText: async () => {
        sends += 1;
      },
      isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
        pause.isConversationPausedFresh(phoneNumberId, customerPhone, pendingDeps),
    }
  );
  check(
    'CONFIRMATION_PENDING: GET fresco e outbound zero',
    pendingFetches === 1 && sends === 0 && pendingDelivery === 'suppressed'
  );

  // --- Checkpoint v2 sob lock ----------------------------------------------
  await primeIdleCache();
  handler.__resetFlushStateForTest();
  let v2Fetches = 0;
  let v2Transports = 0;
  let v2Deliveries = 0;
  const v2Key = handler.__seedFlushBufferForTest(config, PHONE, ['quero terça']);
  await handler.flushBuffer(v2Key, {
    getReply: async () =>
      ({
        kind: 'ana_conversational_v2_prepared',
        frame: { inputSequence: 1 },
        payload: validated.payload,
      }) as never,
    sendReply: async () => {
      v2Transports += 1;
      return 'sent';
    },
    isPaused: (phoneNumberId, customerPhone) =>
      pause.isConversationPaused(phoneNumberId, customerPhone, {
        now: () => NOW + WITHIN_TTL_MS,
        fetchState: async () => {
          throw new Error('checagem anterior não pode furar o cache');
        },
      }),
    isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
      pause.isConversationPausedFresh(phoneNumberId, customerPhone, {
        now: () => NOW + WITHIN_TTL_MS,
        fetchState: async () => {
          v2Fetches += 1;
          return overlayState();
        },
      }),
    recordPausedInbound: async () => undefined,
    withConversationLock: async (_pnid, _phone, work) => work(),
    deliverV2: async (_prepared, checkpoint) => {
      v2Deliveries += 1;
      const state = await checkpoint();
      if (state.paused) return { delivery: 'suppressed' as const, successor: null };
      v2Transports += 1;
      return { delivery: 'sent' as const, successor: null };
    },
  });
  check(
    'checkpoint v2: GET fresco sob lock e outbound zero',
    v2Fetches >= 1 && v2Transports === 0
  );
  check(
    'checkpoint v2: suppress na lock evita o POST (deliverV2 opcional)',
    v2Transports === 0 && v2Deliveries <= 1
  );

  // --- Caminho direto (áudio/fora de horário) --------------------------------
  await primeIdleCache();
  let directFetches = 0;
  let directSends = 0;
  const directDelivery = await handler.sendDirectReceptionistReplyIfUnpaused(
    PHONE,
    validated,
    config,
    {
      isPaused: (phoneNumberId, customerPhone) =>
        pause.isConversationPaused(phoneNumberId, customerPhone, {
          now: () => NOW + WITHIN_TTL_MS,
          fetchState: async () => idleState,
        }),
      isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
        pause.isConversationPausedFresh(phoneNumberId, customerPhone, {
          now: () => NOW + WITHIN_TTL_MS,
          fetchState: async () => {
            directFetches += 1;
            return overlayState();
          },
        }),
      sendReply: async () => {
        directSends += 1;
        return 'sent';
      },
      withConversationLock: async (_pnid, _phone, work) => work(),
    }
  );
  check(
    'caminho direto: overlay vence o cache e outbound zero',
    directFetches === 1 && directSends === 0 && directDelivery === 'suppressed'
  );

  // --- Transição para ECHO real (latch local + GET idle) --------------------
  await primeIdleCache();
  await pause.pauseConversationByEcho(PNID, PHONE, {
    now: () => NOW + WITHIN_TTL_MS,
    persistPause: async () => OVERLAY_UNTIL,
  });
  let echoFetches = 0;
  const echoFresh = await pause.isConversationPausedFresh(PNID, PHONE, {
    now: () => NOW + WITHIN_TTL_MS + 1,
    fetchState: async () => {
      echoFetches += 1;
      return idleState;
    },
  });
  check(
    'ECHO real: latch local continua soberano na leitura fresca',
    echoFresh === true && echoFetches === 1
  );

  await primeIdleCache();
  let echoWireFetches = 0;
  sends = 0;
  const echoWireDelivery = await handler.sendConfiguredReply(
    PHONE,
    validated,
    config,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => undefined,
      waitTyping: async () => undefined,
      sendText: async () => {
        sends += 1;
      },
      isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
        pause.isConversationPausedFresh(phoneNumberId, customerPhone, {
          now: () => NOW + WITHIN_TTL_MS,
          fetchState: async () => {
            echoWireFetches += 1;
            return echoState();
          },
        }),
    }
  );
  check(
    'ECHO real no fio: GET fresco pausa e outbound zero',
    echoWireFetches === 1 && sends === 0 && echoWireDelivery === 'suppressed'
  );

  // --- Falha do GET na fronteira: fail-closed -------------------------------
  await primeIdleCache();
  const ordinaryAfterPrime = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + WITHIN_TTL_MS,
    fetchState: async () => {
      throw new Error('ordinário não pode ir à rede com cache fresco');
    },
  });
  check('falha do GET: cache ordinário permanece false', ordinaryAfterPrime === false);

  let failFetches = 0;
  sends = 0;
  const failDelivery = await handler.sendConfiguredReply(
    PHONE,
    validated,
    config,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => undefined,
      waitTyping: async () => undefined,
      sendText: async () => {
        sends += 1;
      },
      isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
        pause.isConversationPausedFresh(phoneNumberId, customerPhone, {
          now: () => NOW + WITHIN_TTL_MS,
          fetchState: async () => {
            failFetches += 1;
            return null;
          },
        }),
    }
  );
  check(
    'falha do GET fresco suprime outbound (fail-closed)',
    failFetches === 1 && sends === 0 && failDelivery === 'suppressed'
  );

  const emptyFresh = await pause.isConversationPausedFresh(PNID, '5511999000099', {
    now: () => NOW,
    fetchState: async () => null,
  });
  const emptyOrdinary = await pause.isConversationPaused(PNID, '5511999000099', {
    now: () => NOW,
    fetchState: async () => null,
  });
  check(
    'GET nulo: fresco fecha, ordinário legado permanece aberto',
    emptyFresh === true && emptyOrdinary === false
  );

  // --- Fallback M24 na lock também usa a leitura fresca ---------------------
  await primeIdleCache();
  handler.__resetFlushStateForTest();
  let fallbackFetches = 0;
  let fallbackSends = 0;
  const fallbackKey = handler.__seedFlushBufferForTest(config, PHONE, ['oi']);
  await handler.flushBuffer(fallbackKey, {
    getReply: async () => {
      throw new Error('provider failed before transport');
    },
    sendReply: async () => 'sent',
    sendReplyPlain: async () => {
      fallbackSends += 1;
      return 'sent';
    },
    isPaused: async () => false,
    isPausedBeforeTransport: (phoneNumberId, customerPhone) =>
      pause.isConversationPausedFresh(phoneNumberId, customerPhone, {
        now: () => NOW + WITHIN_TTL_MS,
        fetchState: async () => {
          fallbackFetches += 1;
          return overlayState();
        },
      }),
    recordPausedInbound: async () => undefined,
    withConversationLock: async (_pnid, _phone, work) => work(),
  });
  check(
    'fallback M24: overlay fresco gera outbound zero',
    fallbackFetches >= 1 && fallbackSends === 0
  );

  // --- Renata não consulta a fronteira fresca --------------------------------
  let salesPauseChecks = 0;
  let salesSends = 0;
  await handler.sendConfiguredReply(
    PHONE,
    'Renata preserva copy byte a byte.',
    { botRole: 'sales' } as TenantBotConfig,
    {
      voiceEnabled: () => false,
      deliverVoice: async () => {
        throw new Error('voz off');
      },
      waitTyping: async () => {
        throw new Error('sales não simula digitação');
      },
      sendText: async () => {
        throw new Error('sales exige recibo');
      },
      sendSalesText: async () => {
        salesSends += 1;
      },
      isPausedBeforeTransport: async () => {
        salesPauseChecks += 1;
        return true;
      },
    }
  );
  check(
    'Renata não consulta isPausedBeforeTransport',
    salesPauseChecks === 0 && salesSends === 1
  );

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    process.exit(1);
  }
  console.log('✅ smoke-ana-pause-fresh-frontier OK');
}

main().catch((error) => {
  console.error('❌ erro inesperado no smoke:', error);
  process.exit(1);
});
