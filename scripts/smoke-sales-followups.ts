/**
 * Smoke determinístico da régua da Renata: ruler, journeys, backfill e tick.
 * Sem rede/DB real.
 */
process.env.DATABASE_URL ||=
  'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type {
  FollowupRow,
  FollowupTickDeps,
} from '../src/services/salesFollowups';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 23, 12);

function salesConfig(phoneNumberId: string): TenantBotConfig {
  return {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'x',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.5,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'tok',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  };
}

function row(over: Partial<FollowupRow> = {}): FollowupRow {
  return {
    conversationKey: 'PN1:phone',
    phoneNumberId: 'PN1',
    customerPhone: 'phone',
    customerName: 'Maria Silva',
    anchorAtMs: NOW,
    windowExpiresAtMs: NOW + 72 * HOUR,
    nextAtMs: NOW,
    touchCount: 0,
    lastStage: 0,
    journey: 'default',
    lastTouchIdx: null,
    optedOut: false,
    ...over,
  };
}

async function main(): Promise<void> {
  const mod = await import('../src/services/salesFollowups');
  const {
    initialFollowupState,
    rescheduleFollowupState,
    isTouchDue,
    advanceAfterTouch,
    followupStageText,
    pickFollowupVariant,
    postLinkFollowupText,
    promoteFollowupJourney,
    demoJourneyFollowupText,
    DEMO_SIMULATION_FALLBACK_TEXT,
    ensureSalesFollowupsTable,
    runFollowupTick,
    FOLLOWUP_OFFSETS_MS,
    DEFAULT_FOLLOWUP_POLL_MS,
    MIN_FOLLOWUP_POLL_MS,
    MAX_FOLLOWUP_BACKOFF_MS,
    resolveFollowupPollIntervalMs,
    resolveFollowupPollOffsetMin,
    msUntilAlignedTick,
    DEFAULT_FOLLOWUP_POLL_OFFSET_MIN,
    createFollowupPollerState,
    runFollowupPollerCycle,
    startFollowupPoller,
    __stopFollowupPollerForTest,
  } = mod;

  console.log('▶ configuração do poller');
  const originalPollEnv = process.env.SALES_FOLLOWUP_POLL_MS;
  const originalConsoleWarn = console.warn;
  const pollWarnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    pollWarnings.push(args.map(String).join(' '));
  };
  try {
    delete process.env.SALES_FOLLOWUP_POLL_MS;
    check(
      'sem argumento e sem env usa 30min',
      startFollowupPoller() === DEFAULT_FOLLOWUP_POLL_MS
    );
    __stopFollowupPollerForTest();

    process.env.SALES_FOLLOWUP_POLL_MS = '3600000';
    check(
      'env válido sobrescreve o default',
      startFollowupPoller() === 3_600_000
    );
    __stopFollowupPollerForTest();

    process.env.SALES_FOLLOWUP_POLL_MS = '60000';
    const warningCountBeforeClamp = pollWarnings.length;
    check(
      'env abaixo do piso é elevado a 10min e avisa',
      startFollowupPoller() === MIN_FOLLOWUP_POLL_MS &&
        pollWarnings.length === warningCountBeforeClamp + 1 &&
        pollWarnings.at(-1)?.includes(String(MIN_FOLLOWUP_POLL_MS)) === true
    );
    __stopFollowupPollerForTest();

    const breadcrumbReasons: string[] = [];
    check(
      'clamp também deixa breadcrumb warning no Sentry',
      resolveFollowupPollIntervalMs(undefined, {
        warn: () => undefined,
        addBreadcrumb: (breadcrumb) => {
          breadcrumbReasons.push(String(breadcrumb.data.reason));
        },
      }) === MIN_FOLLOWUP_POLL_MS &&
        breadcrumbReasons.join(',') === 'below_minimum'
    );

    for (const invalid of ['abc', '0', '-1']) {
      process.env.SALES_FOLLOWUP_POLL_MS = invalid;
      const warningsBeforeInvalid = pollWarnings.length;
      check(
        `env inválido (${invalid}) cai no default e avisa`,
        startFollowupPoller() === DEFAULT_FOLLOWUP_POLL_MS &&
          pollWarnings.length === warningsBeforeInvalid + 1
      );
      __stopFollowupPollerForTest();
    }

    process.env.SALES_FOLLOWUP_POLL_MS = '60000';
    const warningsBeforeExplicit = pollWarnings.length;
    check(
      'startFollowupPoller(50) honra o seam sem clamp',
      startFollowupPoller(50) === 50 &&
        pollWarnings.length === warningsBeforeExplicit
    );
    __stopFollowupPollerForTest();

    delete process.env.SALES_FOLLOWUP_POLL_MS;
    check(
      'startFollowupPoller é idempotente (2ª chamada devolve o mesmo intervalo)',
      startFollowupPoller() === DEFAULT_FOLLOWUP_POLL_MS &&
        startFollowupPoller() === DEFAULT_FOLLOWUP_POLL_MS
    );
    __stopFollowupPollerForTest();

    console.log('▶ alinhamento de fase com o cron fiscal');
    const HALF_HOUR_MS = 30 * 60_000;
    check(
      '12:00Z com offset :07 espera 7min',
      msUntilAlignedTick(HALF_HOUR_MS, 7, Date.UTC(2026, 6, 30, 12, 0, 0)) === 7 * 60_000
    );
    check(
      '12:10Z com offset :07 espera 27min (cai em :37)',
      msUntilAlignedTick(HALF_HOUR_MS, 7, Date.UTC(2026, 6, 30, 12, 10, 0)) === 27 * 60_000
    );
    check(
      'now exatamente no alvo devolve o clamp de 1s',
      msUntilAlignedTick(HALF_HOUR_MS, 7, Date.UTC(2026, 6, 30, 12, 7, 0)) === 1_000
    );
    check(
      'intervalo que não divide a hora cai no fallback (intervalMs)',
      msUntilAlignedTick(25 * 60_000, 7, Date.UTC(2026, 6, 30, 12, 0, 0)) === 25 * 60_000
    );

    const originalOffsetEnv = process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN;
    delete process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN;
    check(
      'offset sem env usa o default :07',
      resolveFollowupPollOffsetMin() === DEFAULT_FOLLOWUP_POLL_OFFSET_MIN
    );
    process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN = '37';
    check('offset por env sobrescreve', resolveFollowupPollOffsetMin() === 37);
    for (const invalidOffset of ['60', '-1', '2.5', 'abc']) {
      process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN = invalidOffset;
      const warningsBeforeOffset = pollWarnings.length;
      check(
        `offset inválido (${invalidOffset}) cai no default e avisa`,
        resolveFollowupPollOffsetMin() === DEFAULT_FOLLOWUP_POLL_OFFSET_MIN &&
          pollWarnings.length === warningsBeforeOffset + 1
      );
    }
    check('offset explícito é seam e não é validado', resolveFollowupPollOffsetMin(61) === 61);
    if (originalOffsetEnv === undefined) {
      delete process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN;
    } else {
      process.env.SALES_FOLLOWUP_POLL_OFFSET_MIN = originalOffsetEnv;
    }
  } finally {
    console.warn = originalConsoleWarn;
    if (originalPollEnv === undefined) {
      delete process.env.SALES_FOLLOWUP_POLL_MS;
    } else {
      process.env.SALES_FOLLOWUP_POLL_MS = originalPollEnv;
    }
    __stopFollowupPollerForTest();
  }

  console.log('▶ backoff, dedup e recuperação do poller');
  const backoffState = createFollowupPollerState();
  let backoffNow = 0;
  let failingTickCalls = 0;
  const backoffs: number[] = [];
  const failingCycleDeps = {
    state: backoffState,
    intervalMs: 50,
    now: () => backoffNow,
    tick: async () => {
      failingTickCalls += 1;
      throw new Error('db unavailable');
    },
    captureException: () => undefined,
    captureMessage: () => undefined,
    logError: () => undefined,
  };

  const firstFailureAt = backoffNow;
  check(
    'primeira falha agenda backoff a partir do intervalo efetivo',
    (await runFollowupPollerCycle(failingCycleDeps)) === 'failed'
  );
  backoffs.push(backoffState.skipUntilMs - firstFailureAt);
  backoffNow = backoffState.skipUntilMs - 1;
  check(
    'gate retorna sem chamar tick dentro do backoff',
    (await runFollowupPollerCycle(failingCycleDeps)) === 'skipped' &&
      failingTickCalls === 1
  );

  for (let failure = 2; failure <= 25; failure += 1) {
    backoffNow = backoffState.skipUntilMs;
    const failureAt = backoffNow;
    await runFollowupPollerCycle(failingCycleDeps);
    backoffs.push(backoffState.skipUntilMs - failureAt);
  }
  check(
    'backoff cresce exponencialmente e satura em 2h',
    backoffs[0] === 50 &&
      backoffs[1] === 100 &&
      backoffs[2] === 200 &&
      backoffs.at(-1) === MAX_FOLLOWUP_BACKOFF_MS &&
      Math.max(...backoffs) === MAX_FOLLOWUP_BACKOFF_MS
  );

  const outageState = createFollowupPollerState();
  let outageNow = 0;
  let outageCaptures = 0;
  let outageTickCalls = 0;
  for (
    let simulatedAt = 0;
    simulatedAt < 24 * HOUR;
    simulatedAt += DEFAULT_FOLLOWUP_POLL_MS
  ) {
    outageNow = simulatedAt;
    await runFollowupPollerCycle({
      state: outageState,
      intervalMs: DEFAULT_FOLLOWUP_POLL_MS,
      now: () => outageNow,
      tick: async () => {
        outageTickCalls += 1;
        throw new Error('db unavailable');
      },
      captureException: () => {
        outageCaptures += 1;
      },
      captureMessage: () => undefined,
      logError: () => undefined,
    });
  }
  check(
    'queda simulada de 24h gera 13 capturas (≤15), com ciclos sem query',
    outageCaptures === 13 &&
      outageCaptures <= 15 &&
      outageTickCalls < 48
  );

  const recoveryState = createFollowupPollerState();
  let recoveryNow = NOW;
  let recoveryShouldFail = true;
  const recoveryMessages: Array<{
    message: string;
    level: string | undefined;
    failures: number | undefined;
    unavailableForMs: number | undefined;
  }> = [];
  const recoveryDeps = {
    state: recoveryState,
    intervalMs: DEFAULT_FOLLOWUP_POLL_MS,
    now: () => recoveryNow,
    tick: async () => {
      if (recoveryShouldFail) throw new Error('db unavailable');
    },
    captureException: () => undefined,
    captureMessage: (
      message: string,
      context: {
        level?: 'info';
        extra: Record<string, number>;
      }
    ) => {
      recoveryMessages.push({
        message,
        level: context.level,
        failures: context.extra.consecutiveFailures,
        unavailableForMs: context.extra.unavailableForMs,
      });
    },
    logError: () => undefined,
  };
  await runFollowupPollerCycle(recoveryDeps);
  recoveryNow = recoveryState.skipUntilMs;
  recoveryShouldFail = false;
  check(
    'sucesso após falha emite recuperação info e zera o estado',
    (await runFollowupPollerCycle(recoveryDeps)) === 'succeeded' &&
      recoveryMessages.length === 1 &&
      recoveryMessages[0].level === 'info' &&
      recoveryMessages[0].failures === 1 &&
      recoveryMessages[0].unavailableForMs === DEFAULT_FOLLOWUP_POLL_MS &&
      recoveryState.consecutiveFailures === 0 &&
      recoveryState.skipUntilMs === 0
  );
  await runFollowupPollerCycle(recoveryDeps);
  check(
    'recuperação é sinalizada uma única vez',
    recoveryMessages.length === 1 &&
      recoveryMessages[0].message.includes('1 falha')
  );

  console.log('▶ ruler + reset');
  const init = initialFollowupState(NOW);
  check(
    'estado inicial: +4h, janela 72h, stage 0',
    init.anchorAtMs === NOW &&
      init.windowExpiresAtMs === NOW + 72 * HOUR &&
      init.nextAtMs === NOW + FOLLOWUP_OFFSETS_MS[0] &&
      init.touchCount === 0 &&
      init.lastStage === 0
  );
  const reset = rescheduleFollowupState(
    {
      windowExpiresAtMs: NOW + 72 * HOUR,
      optedOut: false,
      journey: 'demo',
      lastTouchIdx: 2,
    },
    NOW + HOUR
  );
  check(
    'reset preserva journey e last_touch_idx',
    reset?.touchCount === 0 &&
      reset.lastStage === 0 &&
      reset.journey === 'demo' &&
      reset.lastTouchIdx === 2
  );
  check(
    'opt-out não reabre',
    rescheduleFollowupState(
      { windowExpiresAtMs: NOW, optedOut: true },
      NOW
    ) === null
  );

  check(
    'isTouchDue respeita tempo/janela/opt-out',
    isTouchDue(row({ nextAtMs: NOW - 1 }), NOW) &&
      !isTouchDue(row({ nextAtMs: NOW + 1 }), NOW) &&
      !isTouchDue(row({ optedOut: true }), NOW) &&
      !isTouchDue(row({ windowExpiresAtMs: NOW - 1 }), NOW)
  );
  const advanced = advanceAfterTouch(row(), 1);
  check(
    'advance faz bookkeeping e persiste índice usado',
    advanced.touchCount === 1 &&
      advanced.lastStage === 1 &&
      advanced.nextAtMs === NOW + FOLLOWUP_OFFSETS_MS[1] &&
      advanced.lastTouchIdx === 1
  );

  console.log('▶ variações e correção B2');
  const first = pickFollowupVariant(0, 'Maria Silva', null);
  const afterFirst = advanceAfterTouch(row(), first.idx);
  const afterInbound = rescheduleFollowupState(
    {
      windowExpiresAtMs: NOW + 72 * HOUR,
      optedOut: false,
      journey: 'default',
      lastTouchIdx: afterFirst.lastTouchIdx,
    },
    NOW + HOUR
  );
  const second = pickFollowupVariant(
    0,
    'Maria Silva',
    afterInbound?.lastTouchIdx ?? null
  );
  check(
    'toque → inbound reset → próximo toque usa texto diferente',
    first.idx !== second.idx && first.text !== second.text
  );
  check(
    'variação canônica mantém primeiro nome',
    followupStageText(0, 'Maria Silva').startsWith('Oi, Maria!')
  );
  check(
    'sem nome/Cliente não deixa placeholder',
    followupStageText(0, null).startsWith('Oi!') &&
      followupStageText(0, 'Cliente').startsWith('Oi!')
  );
  const lastCanonical = followupStageText(2, null);
  check(
    '+48h convida simulação in-chat e não promete demo com Victor',
    lastCanonical.includes("oi, queria marcar um horário") &&
      !/Victor|30min/i.test(lastCanonical)
  );

  console.log('▶ journey + backfill');
  check(
    'precedência post_link > demo > default',
    promoteFollowupJourney('default', 'demo') === 'demo' &&
      promoteFollowupJourney('demo', 'post_link') === 'post_link' &&
      promoteFollowupJourney('post_link', 'demo') === 'post_link'
  );
  const legacy = { journey: 'default', lastStage: 102 };
  const ensureSql: string[] = [];
  await ensureSalesFollowupsTable(async (sql) => {
    ensureSql.push(sql);
    if (
      /SET journey = 'post_link'/.test(sql) &&
      legacy.journey === 'default' &&
      legacy.lastStage >= 100
    ) {
      legacy.journey = 'post_link';
    }
    return { rows: [] };
  });
  check(
    'ensure adiciona journey + last_touch_idx',
    ensureSql.some(
      (sql) =>
        /ADD COLUMN IF NOT EXISTS journey/.test(sql) &&
        /ADD COLUMN IF NOT EXISTS last_touch_idx/.test(sql)
    )
  );
  check(
    'backfill idempotente promove legado last_stage >= 100',
    legacy.journey === 'post_link' &&
      ensureSql.some(
        (sql) =>
          /WHERE journey = 'default'/.test(sql) &&
          /last_stage >= 100/.test(sql)
      )
  );

  console.log('▶ jornada demo: slots reais ou simulação');
  const datesRead: string[] = [];
  const withSlots = await demoJourneyFollowupText(salesConfig('PN3'), {
    now: () => NOW,
    resolveServiceId: async () => 'service-demo',
    getSlots: async (date) => {
      datesRead.push(date);
      return date === '2026-07-25'
        ? { success: true, slots: ['10:30', '15:00', '16:00'] }
        : { success: true, slots: [] };
    },
  });
  check(
    'demo busca dias até achar e oferece os dois primeiros horários',
    datesRead.join(',') === '2026-07-23,2026-07-24,2026-07-25' &&
      withSlots.includes('25/07/2026') &&
      withSlots.includes('10:30') &&
      withSlots.includes('15:00')
  );
  check(
    'demo nunca pergunta data em aberto',
    !/que dia você prefere/i.test(withSlots)
  );
  const withoutSlots = await demoJourneyFollowupText(salesConfig('PN4'), {
    now: () => NOW,
    resolveServiceId: async () => 'service-demo',
    getSlots: async () => ({ success: true, slots: [] }),
  });
  check(
    'demo sem slots cai na simulação e nunca no genérico',
    withoutSlots === DEMO_SIMULATION_FALLBACK_TEXT &&
      !withoutSlots.includes('Ficou alguma dúvida')
  );
  const apiDown = await demoJourneyFollowupText(salesConfig('PN4'), {
    resolveServiceId: async () => 'service-demo',
    getSlots: async () => {
      throw new Error('mock timeout');
    },
  });
  check(
    'API fora também cai na simulação',
    apiDown === DEMO_SIMULATION_FALLBACK_TEXT
  );

  console.log('▶ runFollowupTick stage-aware');
  const dueRows = [
    row({
      conversationKey: 'PN1:a',
      customerPhone: 'a',
      nextAtMs: NOW - 1,
    }),
    row({
      conversationKey: 'PN1:b',
      customerPhone: 'b',
      nextAtMs: NOW - 1,
    }),
    row({
      conversationKey: 'PN2:c',
      phoneNumberId: 'PN2',
      customerPhone: 'c',
      nextAtMs: NOW - 1,
    }),
    row({
      conversationKey: 'PN1:d',
      customerPhone: 'd',
      nextAtMs: NOW - 1,
      journey: 'post_link',
    }),
    row({
      conversationKey: 'PN1:e',
      customerPhone: 'e',
      nextAtMs: NOW - 1,
      journey: 'post_link',
    }),
    row({
      conversationKey: 'PN3:f',
      phoneNumberId: 'PN3',
      customerPhone: 'f',
      nextAtMs: NOW - 1,
      journey: 'demo',
    }),
    row({
      conversationKey: 'PN4:g',
      phoneNumberId: 'PN4',
      customerPhone: 'g',
      nextAtMs: NOW - 1,
      journey: 'demo',
    }),
  ];
  const sent: Array<{ to: string; text: string }> = [];
  const persisted = new Map<string, { lastTouchIdx: number | null }>();
  const prefillLookups: string[] = [];
  const deps: FollowupTickDeps = {
    now: () => NOW,
    loadDue: async () => dueRows,
    getConfig: async (phoneNumberId) =>
      phoneNumberId === 'PN2'
        ? { ...salesConfig(phoneNumberId), botRole: 'receptionist' }
        : salesConfig(phoneNumberId),
    isPaused: async (_phoneNumberId, customerPhone) => customerPhone === 'b',
    getPrefilledLink: async (customerPhone) => {
      prefillLookups.push(customerPhone);
      return customerPhone === 'd'
        ? {
            success: true,
            url: 'https://receps.com.br/cadastro?pf=TOKEN_VIGENTE',
          }
        : { success: false, reason: 'not_found' };
    },
    getDemoText: async (config) =>
      config.phoneNumberId === 'PN3'
        ? 'Tenho 25/07/2026 às 10:30 ou às 15:00. Qual fica melhor?'
        : DEMO_SIMULATION_FALLBACK_TEXT,
    send: async (to, text) => {
      sent.push({ to, text });
    },
    record: async () => undefined,
    emitEvent: async () => undefined,
    persist: async (key, advance) => {
      persisted.set(key, { lastTouchIdx: advance.lastTouchIdx });
    },
  };
  const count = await runFollowupTick(deps);
  check(
    'envia só 5 elegíveis; pausada e receptionist ficam fora',
    count === 5 &&
      !sent.some((item) => item.to === 'b' || item.to === 'c')
  );
  check(
    'post_link vigente permanece intacto',
    sent.find((item) => item.to === 'd')?.text ===
      postLinkFollowupText(
        'https://receps.com.br/cadastro?pf=TOKEN_VIGENTE'
      )
  );
  check(
    'post_link sem prefill mantém fallback genérico',
    sent.find((item) => item.to === 'e')?.text.includes(
      'Ficou alguma dúvida'
    ) === true &&
      prefillLookups.join(',') === 'd,e'
  );
  check(
    'journey demo com slots retoma os dois horários',
    sent.find((item) => item.to === 'f')?.text.includes('10:30') === true &&
      sent.find((item) => item.to === 'f')?.text.includes('15:00') === true
  );
  check(
    'journey demo sem slots usa simulação, nunca genérico',
    sent.find((item) => item.to === 'g')?.text ===
      DEMO_SIMULATION_FALLBACK_TEXT
  );
  check(
    'índice só avança quando o texto veio do pool',
    persisted.get('PN1:a')?.lastTouchIdx === 0 &&
      persisted.get('PN1:e')?.lastTouchIdx === 0 &&
      persisted.get('PN1:d')?.lastTouchIdx === null &&
      persisted.get('PN3:f')?.lastTouchIdx === null
  );

  if (failures) process.exit(1);
  console.log('\n✅ smoke-sales-followups OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
