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
  } = mod;

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
