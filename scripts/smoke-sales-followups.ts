/**
 * Smoke DETERMINÍSTICO da régua de follow-up da Renata (Workstream B §B5). Testa
 * o RULER puro (agenda / zera no inbound / opt-out / limite 3 / janela 72h) e o
 * `runFollowupTick` com deps injetadas (pula pausada e não-sales, envia a devida).
 * Sem rede / DB real.
 *
 * Rodar: npx tsx scripts/smoke-sales-followups.ts
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { FollowupRow, FollowupTickDeps } from '../src/services/salesFollowups';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const HOUR = 3600_000;

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

function row(over: Partial<FollowupRow>): FollowupRow {
  const now = 1_000_000_000_000;
  return {
    conversationKey: 'PN:phone',
    phoneNumberId: 'PN',
    customerPhone: 'phone',
    customerName: 'Maria Silva',
    anchorAtMs: now,
    windowExpiresAtMs: now + 72 * HOUR,
    nextAtMs: now,
    touchCount: 0,
    lastStage: 0,
    optedOut: false,
    ...over,
  };
}

async function main() {
  const mod = await import('../src/services/salesFollowups');
  const {
    initialFollowupState,
    rescheduleFollowupState,
    isTouchDue,
    advanceAfterTouch,
    followupStageText,
    runFollowupTick,
    FOLLOWUP_OFFSETS_MS,
  } = mod;

  const now = 1_000_000_000_000;

  console.log('▶ estado inicial (agenda)');
  const init = initialFollowupState(now);
  check('anchor = now', init.anchorAtMs === now);
  check('janela = now + 72h', init.windowExpiresAtMs === now + 72 * HOUR);
  check('próximo toque = now + 4h', init.nextAtMs === now + FOLLOWUP_OFFSETS_MS[0]);
  check('touchCount 0', init.touchCount === 0);

  console.log('▶ inbound ZERA a régua (mantém janela; opt-out sticky)');
  const later = now + 10 * HOUR;
  const reset = rescheduleFollowupState({ windowExpiresAtMs: now + 72 * HOUR, optedOut: false }, later);
  check('reset volta pro estágio 0', reset !== null && reset.touchCount === 0);
  check('reset agenda +4h a partir do novo inbound', reset !== null && reset.nextAtMs === later + FOLLOWUP_OFFSETS_MS[0]);
  const resetOpted = rescheduleFollowupState({ windowExpiresAtMs: now + 72 * HOUR, optedOut: true }, later);
  check('opt-out NÃO reabre a régua', resetOpted === null);

  console.log('▶ isTouchDue');
  check('devido: nextAt<=now, na janela', isTouchDue(row({ nextAtMs: now - 1 }), now) === true);
  check('opt-out → não devido', isTouchDue(row({ nextAtMs: now - 1, optedOut: true }), now) === false);
  check('limite 3 → não devido', isTouchDue(row({ nextAtMs: now - 1, touchCount: 3 }), now) === false);
  check('fora da janela 72h → não devido', isTouchDue(row({ nextAtMs: now - 1, windowExpiresAtMs: now - 1 }), now) === false);
  check('nextAt no futuro → não devido', isTouchDue(row({ nextAtMs: now + HOUR }), now) === false);
  check('nextAt null → não devido', isTouchDue(row({ nextAtMs: null }), now) === false);

  console.log('▶ advanceAfterTouch (agenda o próximo / limite 3)');
  const a0 = advanceAfterTouch(row({ touchCount: 0 }));
  check('após toque 0 → count 1, next = anchor+24h', a0.touchCount === 1 && a0.nextAtMs === now + FOLLOWUP_OFFSETS_MS[1]);
  const a1 = advanceAfterTouch(row({ touchCount: 1 }));
  check('após toque 1 → count 2, next = anchor+48h', a1.touchCount === 2 && a1.nextAtMs === now + FOLLOWUP_OFFSETS_MS[2]);
  const a2 = advanceAfterTouch(row({ touchCount: 2 }));
  check('após toque 2 (último) → count 3, next null', a2.touchCount === 3 && a2.nextAtMs === null);

  console.log('▶ textos dos toques (manual §7)');
  check('toque 0 com nome → "Oi, Maria!"', followupStageText(0, 'Maria Silva').includes('Oi, Maria!'));
  check('toque 0 sem nome → "Oi!" (sem vírgula-nome)', followupStageText(0, null).startsWith('Oi!'));
  check('toque 0 nome "Cliente" tratado como sem nome', followupStageText(0, 'Cliente').startsWith('Oi!'));
  check('toque 1 → prova/trial grátis', followupStageText(1, null).includes('testar a Receps grátis'));
  check('toque 2 → demonstração com o Victor', followupStageText(2, null).includes('demonstração'));

  console.log('▶ runFollowupTick (pula pausada e não-sales; envia a devida)');
  const dueRow = row({ conversationKey: 'PN1:a', phoneNumberId: 'PN1', customerPhone: 'a', nextAtMs: now - 1, touchCount: 0 });
  const pausedRow = row({ conversationKey: 'PN1:b', phoneNumberId: 'PN1', customerPhone: 'b', nextAtMs: now - 1 });
  const nonSalesRow = row({ conversationKey: 'PN2:c', phoneNumberId: 'PN2', customerPhone: 'c', nextAtMs: now - 1 });

  const sent: Array<{ to: string; text: string }> = [];
  const persisted: string[] = [];
  const deps: FollowupTickDeps = {
    now: () => now,
    loadDue: async () => [dueRow, pausedRow, nonSalesRow],
    getConfig: async (pn) => (pn === 'PN1' ? salesConfig(pn) : { ...salesConfig(pn), botRole: 'receptionist' }),
    isPaused: async (_pn, phone) => phone === 'b',
    send: async (to, text) => {
      sent.push({ to, text });
    },
    record: async () => undefined,
    persist: async (key) => {
      persisted.push(key);
    },
  };

  const count = await runFollowupTick(deps);
  check('enviou exatamente 1 toque (só a devida)', count === 1 && sent.length === 1);
  check('enviou pra conversa devida (a)', sent[0]?.to === 'a');
  check('texto = toque 0 com nome', sent[0]?.text.includes('Oi, Maria!'));
  check('pausada (b) NÃO recebeu', !sent.some((s) => s.to === 'b'));
  check('não-sales (c) NÃO recebeu', !sent.some((s) => s.to === 'c'));
  check('persistiu avanço só da devida', persisted.length === 1 && persisted[0] === 'PN1:a');

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-sales-followups OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ erro no smoke:', err);
  process.exit(1);
});
