/**
 * IA-21: autoridade fresca do ERP vence a pausa ordinária positiva vencida.
 *
 * Fixtures F1-F14, sem rede/DB/OpenAI/WhatsApp reais. O relógio, o estado do
 * ERP e os pontos de entrada do runtime são injetados para provar a ordem:
 * latch ECHO -> cache fresco -> GET após TTL -> snapshot autoritativo/fallback.
 */
process.env.NODE_ENV ||= 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN ||= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';
process.env.SENTRY_DSN = '';
process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS = 'pause-authority-v2';
delete process.env.ANA_RESUME_GATE_ENABLED;
delete process.env.ANA_RESUME_GATE_TENANT_SLUGS;
delete process.env.ANA_RESUME_GATE_EXCLUDED_TENANT_SLUGS;

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { PauseState } from '../src/services/pauseDecision';
import type { SilentEscalationHoldLookupV2 } from '../src/services/silentEscalationHold';

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

const PNID = 'PN-PAUSE-AUTHORITY';
const PHONE = '5511999000011';
const NOW = Date.UTC(2026, 7, 20, 15, 0, 0);
const TTL_MS = 25_000;

function iso(nowMs: number, deltaMs = 60 * 60_000): string {
  return new Date(nowMs + deltaMs).toISOString();
}

function pauseState(overrides: Partial<PauseState> = {}): PauseState {
  return {
    globalPausedUntil: null,
    conversationPausedUntil: null,
    schedulePausedUntil: null,
    escalation: { active: false, questionId: null, version: 1 },
    ...overrides,
  };
}

function stateWithoutEscalation(
  overrides: Partial<PauseState> = {}
): PauseState {
  const { escalation: _ignored, ...withoutEscalation } = pauseState(overrides);
  return withoutEscalation;
}

function configFor(
  tenantSlug: string,
  phoneNumberId: string,
  botRole: TenantBotConfig['botRole'] = 'receptionist'
): TenantBotConfig {
  return {
    tenantSlug,
    botName: botRole === 'sales' ? 'Renata' : 'Ana',
    botRole,
    systemPrompt: 'fixture',
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
    waAccessToken: 'fixture',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  };
}

function textMessage(from: string, id: string, body = 'Quero continuar'): {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
} {
  return {
    from,
    id,
    timestamp: String(Math.floor(NOW / 1000)),
    type: 'text',
    text: { body },
  };
}

function reset(
  pause: typeof import('../src/services/pauseService'),
  escalation: typeof import('../src/services/escalationCache')
): void {
  pause.__resetPauseCacheForTest();
  escalation.__resetEscalationCacheForTest();
}

async function main(): Promise<void> {
  const pause = await import('../src/services/pauseService');
  const escalation = await import('../src/services/escalationCache');
  const messageHandler = await import('../src/messageHandler');
  const resumeGate = await import('../src/services/anaResumeGate');

  const activeV33 = pauseState({
    globalPausedUntil: iso(NOW),
    conversationPausedUntil: iso(NOW),
    schedulePausedUntil: iso(NOW),
    escalation: { active: true, questionId: 'fixture-question', version: 33 },
  });
  const inactiveV34 = pauseState({
    escalation: { active: false, questionId: null, version: 34 },
  });

  // F1 — after TTL, all ordinary sources are cleared and escalation v34 wins.
  reset(pause, escalation);
  let f1Fetches = 0;
  const f1First = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW,
    fetchState: async () => {
      f1Fetches += 1;
      return activeV33;
    },
  });
  const f1Second = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 1,
    fetchState: async () => {
      f1Fetches += 1;
      return inactiveV34;
    },
  });
  const f1Snapshot = escalation.getEscalationSnapshot(PNID, PHONE);
  let f1WithinTtlFetches = 0;
  const f1AfterFresh = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 100,
    fetchState: async () => {
      f1WithinTtlFetches += 1;
      return null;
    },
  });
  check(
    'F1: TTL vencido faz segundo GET e snapshot v34 inativo libera tudo',
    f1First === true &&
      f1Second === false &&
      f1Fetches === 2 &&
      f1Snapshot?.active === false &&
      f1Snapshot.version === 34 &&
      f1AfterFresh === false &&
      f1WithinTtlFetches === 0
  );

  // F2 — 24.999ms remains inside both ordinary and escalation TTLs.
  reset(pause, escalation);
  let f2Fetches = 0;
  const f2First = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW,
    fetchState: async () => {
      f2Fetches += 1;
      return pauseState({
        globalPausedUntil: iso(NOW),
        escalation: { active: false, questionId: null, version: 1 },
      });
    },
  });
  const f2Second = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS - 1,
    fetchState: async () => {
      f2Fetches += 1;
      return inactiveV34;
    },
  });
  check(
    'F2: 24.999ms não refaz GET e preserva a pausa',
    f2First === true && f2Second === true && f2Fetches === 1
  );

  // F3 — stale positive + null/throw-like null never writes an inactive cache.
  reset(pause, escalation);
  let f3Fetches = 0;
  await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW,
    fetchState: async () => {
      f3Fetches += 1;
      return pauseState({ conversationPausedUntil: iso(NOW) });
    },
  });
  const f3AfterError = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 1,
    fetchState: async () => {
      f3Fetches += 1;
      throw new Error('fixture ERP outage');
    },
  });
  const f3AfterSecondNull = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 2,
    fetchState: async () => {
      f3Fetches += 1;
      return null;
    },
  });
  check(
    'F3: GET com erro/nulo conserva evidência positiva, não grava inativo e tenta de novo',
    f3AfterError === true && f3AfterSecondNull === true && f3Fetches === 3
  );

  async function externalClearCase(
    name: string,
    field: 'globalPausedUntil' | 'schedulePausedUntil' | 'conversationPausedUntil',
    includeEscalationField = true
  ): Promise<void> {
    reset(pause, escalation);
    let fetches = 0;
    const old = pauseState({
      [field]: iso(NOW),
      escalation: { active: false, questionId: null, version: 7 },
    });
    const fresh = includeEscalationField
      ? inactiveV34
      : stateWithoutEscalation();
    const first = await pause.isConversationPaused(PNID, PHONE, {
      now: () => NOW,
      fetchState: async () => {
        fetches += 1;
        return old;
      },
    });
    const second = await pause.isConversationPaused(PNID, PHONE, {
      now: () => NOW + TTL_MS + 1,
      fetchState: async () => {
        fetches += 1;
        return fresh;
      },
    });
    check(name, first === true && second === false && fetches === 2);
  }

  // F4–F6 — each ordinary source is externally clearable after the TTL.
  await externalClearCase(
    'F4: globalPausedUntil antigo é removido por resposta fresca',
    'globalPausedUntil'
  );
  await externalClearCase(
    'F5: schedulePausedUntil antigo é removido por resposta fresca',
    'schedulePausedUntil'
  );
  await externalClearCase(
    'F6: conversationPausedUntil antigo é removido sem campo escalation',
    'conversationPausedUntil',
    false
  );

  // F7 — a versão inativa fresca substitui escalation v33; it is not sticky.
  reset(pause, escalation);
  let f7Fetches = 0;
  const f7First = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW,
    fetchState: async () => {
      f7Fetches += 1;
      return pauseState({
        escalation: { active: true, questionId: 'fixture-question', version: 33 },
      });
    },
  });
  const f7Second = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 1,
    fetchState: async () => {
      f7Fetches += 1;
      return inactiveV34;
    },
  });
  const f7Snapshot = escalation.getEscalationSnapshot(PNID, PHONE);
  check(
    'F7: force=true troca escalation v33 ativa por v34 inativa',
    f7First === true &&
      f7Second === false &&
      f7Fetches === 2 &&
      f7Snapshot?.active === false &&
      f7Snapshot.version === 34
  );

  // F8 — fresh authority may remain active; no temporary speech window opens.
  reset(pause, escalation);
  let f8Fetches = 0;
  const f8First = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW,
    fetchState: async () => {
      f8Fetches += 1;
      return activeV33;
    },
  });
  const f8Second = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 1,
    fetchState: async () => {
      f8Fetches += 1;
      return pauseState({
        conversationPausedUntil: iso(NOW + TTL_MS + 1),
        escalation: { active: true, questionId: 'fixture-question', version: 34 },
      });
    },
  });
  const f8Third = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + TTL_MS + 100,
    fetchState: async () => {
      f8Fetches += 1;
      return inactiveV34;
    },
  });
  check(
    'F8: resposta fresca ainda ativa continua bloqueando dentro do novo TTL',
    f8First === true && f8Second === true && f8Third === true && f8Fetches === 2
  );

  // F9 — ECHO is a local latch, not ordinary pause-state cache.
  reset(pause, escalation);
  let f9Fetches = 0;
  await pause.pauseConversationByEcho(PNID, PHONE, {
    now: () => NOW,
    persistPause: async () => iso(NOW),
  });
  const f9Latched = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + 1,
    fetchState: async () => {
      f9Fetches += 1;
      return inactiveV34;
    },
  });
  const f9FreshRead = await pause.isConversationPausedFresh(PNID, PHONE, {
    now: () => NOW + 1,
    fetchState: async () => {
      f9Fetches += 1;
      return inactiveV34;
    },
  });
  const f9LatchSurvivesGet = pause.peekLocalEchoLatch(PNID, PHONE, NOW + 1);
  pause.releaseLocalEchoPauseAfterAnaResume(PNID, PHONE);
  const f9AfterRelease = await pause.isConversationPaused(PNID, PHONE, {
    now: () => NOW + 2,
    fetchState: async () => {
      f9Fetches += 1;
      return inactiveV34;
    },
  });
  check(
    'F9: latch ECHO dá zero GET ordinário, sobrevive GET fresco e só release o remove',
    f9Latched === true &&
      f9FreshRead === true &&
      f9LatchSurvivesGet !== null &&
      f9AfterRelease === false &&
      f9Fetches === 2
  );

  // F10 — runtime v2: begin -> PROCEED, first inbound silent, next after TTL buffers.
  reset(pause, escalation);
  messageHandler.__resetFlushStateForTest();
  const v2Config = configFor('pause-authority-v2', PNID);
  const runtimeConversationKey = `${PNID}:${PHONE}`;
  let runtimeNow = NOW;
  let runtimeFetches = 0;
  let resumeBegins = 0;
  const runtimePause = async (phoneNumberId: string, customerPhone: string) =>
    pause.isConversationPaused(phoneNumberId, customerPhone, {
      now: () => runtimeNow,
      fetchState: async () => {
        runtimeFetches += 1;
        return runtimeNow <= NOW ? activeV33 : inactiveV34;
      },
    });
  const runtimeResume = async (input: {
    config: TenantBotConfig;
    customerPhone: string;
    customerName?: string | null;
    inboundText?: string | null;
  }) =>
    resumeGate.evaluateAnaResumeForInbound(input, {
      begin: async () => {
        resumeBegins += 1;
        return { action: 'PROCEED' as const };
      },
      loadHistory: async () => [],
      classify: async () => {
        throw new Error('PROCEED não deve classificar');
      },
      finalize: async () => {
        throw new Error('PROCEED não deve finalizar');
      },
    });
  const runtimeDeps = {
    persistInbound: async () => ({
      fresh: true,
      conversationKey: runtimeConversationKey,
      sequence: 1,
    }),
    deliverInbound: async () => ({
      delivered: true,
      attempts: 1,
      terminal: false,
      fastRetryAllowed: false,
    }),
    updateInboundContent: async () => undefined,
    markTranscriptionFailed: async () => undefined,
    downloadAudio: async () => Buffer.alloc(0),
    transcribeAudio: async () => '',
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    isPaused: runtimePause,
    lookupSilentHold: async () => ({ kind: 'inactive' as const }),
    evaluateResume: runtimeResume,
    sendReply: async () => {
      throw new Error('fixture não deve enviar durante o smoke');
    },
  };
  await messageHandler.handleIncomingMessage(
    textMessage(PHONE, 'fixture-runtime-before-ttl'),
    { profile: { name: 'Fixture' } },
    v2Config,
    runtimeDeps as never
  );
  const bufferedBeforeTtl = messageHandler.__hasBufferForTest(
    runtimeConversationKey
  );
  runtimeNow = NOW + TTL_MS + 1;
  await messageHandler.handleIncomingMessage(
    textMessage(PHONE, 'fixture-runtime-after-ttl'),
    { profile: { name: 'Fixture' } },
    v2Config,
    runtimeDeps as never
  );
  const bufferedAfterTtl = messageHandler.__hasBufferForTest(
    runtimeConversationKey
  );
  check(
    'F10: resume begin→PROCEED, antes do TTL silêncio; após GET fresco inbound chega ao buffer',
    bufferedBeforeTtl === false &&
      bufferedAfterTtl === true &&
      resumeBegins === 2 &&
      runtimeFetches === 2
  );
  messageHandler.__resetFlushStateForTest();

  // F11 — panel clear has no callback requirement; the next inbound revalidates.
  reset(pause, escalation);
  let f11Now = NOW;
  let f11Fetches = 0;
  const f11First = await pause.isConversationPaused(PNID, 'fixture-panel', {
    now: () => f11Now,
    fetchState: async () => {
      f11Fetches += 1;
      return pauseState({
        conversationPausedUntil: iso(NOW),
        escalation: { active: false, questionId: null, version: 11 },
      });
    },
  });
  f11Now = NOW + TTL_MS + 1;
  const f11Second = await pause.isConversationPaused(PNID, 'fixture-panel', {
    now: () => f11Now,
    fetchState: async () => {
      f11Fetches += 1;
      return stateWithoutEscalation();
    },
  });
  check(
    'F11: despausa modelada no painel é percebida no inbound seguinte sem restart/callback',
    f11First === true && f11Second === false && f11Fetches === 2
  );

  // F12 — Renata keeps legacy pause behavior and never enters resume gate.
  reset(pause, escalation);
  messageHandler.__resetFlushStateForTest();
  const salesConfig = configFor('receps-vendas', 'PN-SALES', 'sales');
  let f12FreshFetches = 0;
  const f12FreshFirst = await pause.isConversationPaused(
    salesConfig.phoneNumberId,
    PHONE,
    {
      now: () => NOW,
      fetchState: async () => {
        f12FreshFetches += 1;
        return pauseState({
          globalPausedUntil: iso(NOW),
          escalation: { active: false, questionId: null, version: 1 },
        });
      },
    }
  );
  const f12FreshSecond = await pause.isConversationPaused(
    salesConfig.phoneNumberId,
    PHONE,
    {
      now: () => NOW + 1,
      fetchState: async () => {
        f12FreshFetches += 1;
        return inactiveV34;
      },
    }
  );
  let f12ResumeCalls = 0;
  const salesDeps = {
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    isPaused: async (phoneNumberId: string, customerPhone: string) =>
      pause.isConversationPaused(phoneNumberId, customerPhone, {
        now: () => NOW + 1,
        fetchState: async () => inactiveV34,
      }),
    lookupSilentHold: async () => ({ kind: 'inactive' as const }),
    resumeGate: async () => {
      f12ResumeCalls += 1;
      return true;
    },
    sendReply: async () => 'sent',
  };
  await messageHandler.handleIncomingMessage(
    textMessage(PHONE, 'fixture-sales-paused'),
    undefined,
    salesConfig,
    salesDeps as never
  );
  const salesBlockedAtFresh = !messageHandler.__hasBufferForTest(
    `${salesConfig.phoneNumberId}:${PHONE}`
  );
  messageHandler.__resetFlushStateForTest();
  reset(pause, escalation);
  let f12OpenFetches = 0;
  const salesOpenPhone = 'fixture-sales-open';
  await messageHandler.handleIncomingMessage(
    textMessage(salesOpenPhone, 'fixture-sales-open'),
    undefined,
    salesConfig,
    {
      ...salesDeps,
      isPaused: async (phoneNumberId: string, customerPhone: string) =>
        pause.isConversationPaused(phoneNumberId, customerPhone, {
          now: () => NOW,
          fetchState: async () => {
            f12OpenFetches += 1;
            return null;
          },
        }),
    } as never
  );
  const salesFailOpenBuffer = messageHandler.__hasBufferForTest(
    `${salesConfig.phoneNumberId}:${salesOpenPhone}`
  );
  check(
    'F12: Renata bloqueia pausa fresca, falha sem evidência abre no legado e não chama resume gate',
    f12FreshFirst === true &&
      f12FreshSecond === true &&
      f12FreshFetches === 1 &&
      salesBlockedAtFresh &&
      salesFailOpenBuffer &&
      f12OpenFetches === 1 &&
      f12ResumeCalls === 0
  );
  messageHandler.__resetFlushStateForTest();

  // F13 — final frontier always GETs and a null response stays fail-closed.
  reset(pause, escalation);
  let f13Fetches = 0;
  const f13First = await pause.isConversationPausedFresh(PNID, 'fixture-frontier', {
    now: () => NOW,
    fetchState: async () => {
      f13Fetches += 1;
      return stateWithoutEscalation();
    },
  });
  const f13Second = await pause.isConversationPausedFresh(PNID, 'fixture-frontier', {
    now: () => NOW,
    fetchState: async () => {
      f13Fetches += 1;
      return stateWithoutEscalation();
    },
  });
  const f13Null = await pause.isConversationPausedFresh(PNID, 'fixture-frontier-null', {
    now: () => NOW,
    fetchState: async () => {
      f13Fetches += 1;
      return null;
    },
  });
  check(
    'F13: fronteira final sempre consulta e GET nulo suprime outbound',
    f13First === false && f13Second === false && f13Null === true && f13Fetches === 3
  );

  // F14 — IA-19D silent escalation hold remains independent of pause cache.
  messageHandler.__resetFlushStateForTest();
  const holdConfig = configFor('pause-authority-hold', 'PN-HOLD');
  const holdCases: Array<{
    label: string;
    lookup: SilentEscalationHoldLookupV2;
    from: string;
  }> = [
    { label: 'active', lookup: { kind: 'active', sourceMessageId: null }, from: 'fixture-hold-active' },
    { label: 'unknown', lookup: { kind: 'unknown', errorKind: 'fixture_outage' }, from: 'fixture-hold-unknown' },
  ];
  const holdResults: boolean[] = [];
  for (const holdCase of holdCases) {
    const key = `${holdConfig.phoneNumberId}:${holdCase.from}`;
    await messageHandler.handleIncomingMessage(
      textMessage(holdCase.from, `fixture-hold-${holdCase.label}`),
      undefined,
      holdConfig,
      {
        persistInbound: async () => ({
          fresh: true,
          conversationKey: key,
          sequence: 1,
        }),
        deliverInbound: async () => ({
          delivered: true,
          attempts: 1,
          terminal: false,
          fastRetryAllowed: false,
        }),
        updateInboundContent: async () => undefined,
        markTranscriptionFailed: async () => undefined,
        downloadAudio: async () => Buffer.alloc(0),
        transcribeAudio: async () => '',
        handleOptOut: async () => false,
        shouldSuspend: async () => false,
        isPaused: async () => false,
        lookupSilentHold: async () => holdCase.lookup,
        sendReply: async () => 'sent',
      } as never
    );
    holdResults.push(!messageHandler.__hasBufferForTest(key));
    messageHandler.__resetFlushStateForTest();
  }
  check(
    'F14: silent escalation active|unknown continua bloqueando sem depender do pause cache',
    holdResults.length === 2 && holdResults.every(Boolean)
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) process.exit(1);
  console.log('✅ smoke-ana-pause-authority OK');
}

main().catch((error) => {
  console.error('❌ erro inesperado no smoke de pause authority:', error);
  process.exit(1);
});
