/**
 * Smoke DETERMINÍSTICO do gatilho pós-cadastro da Renata (v1.1 §D4). Testa a
 * decisão PURA da janela de 24h e o `handleTrialStarted` com deps injetadas:
 * fora da janela → skip silencioso (nada de template pago), pausada → skip,
 * régua de venda encerrada SEMPRE que o lead converte, e conversa desconhecida
 * → no-op. Sem rede / DB real.
 *
 * Rodar: npx tsx scripts/smoke-sales-notify.ts
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { SalesNotifyDeps, SalesConversationRef } from '../src/services/salesNotify';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;

function salesConfig(overrides: Partial<TenantBotConfig> = {}): TenantBotConfig {
  return {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'prompt',
    greetingMessage: null,
    fallbackMessage: 'fallback',
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN_VENDAS',
    isActive: true,
    ...overrides,
  };
}

interface Recorded {
  sent: Array<{ to: string; text: string }>;
  ended: Array<{ phoneNumberId: string; customerPhone: string }>;
  recorded: string[];
}

function makeDeps(
  opts: {
    conversation?: SalesConversationRef | null;
    config?: TenantBotConfig | null;
    paused?: boolean;
    lastInboundAtMs?: number | null;
  } = {}
): { deps: SalesNotifyDeps; log: Recorded } {
  const log: Recorded = { sent: [], ended: [], recorded: [] };
  const deps: SalesNotifyDeps = {
    now: () => NOW,
    findConversation: async () =>
      opts.conversation === undefined
        ? { phoneNumberId: 'PN_VENDAS', customerPhone: '5516988870001' }
        : opts.conversation,
    getConfig: async () => (opts.config === undefined ? salesConfig() : opts.config),
    endFollowups: async (phoneNumberId, customerPhone) => {
      log.ended.push({ phoneNumberId, customerPhone });
    },
    isPaused: async () => opts.paused ?? false,
    lastInboundAt: async () =>
      opts.lastInboundAtMs === undefined ? NOW - HOUR : opts.lastInboundAtMs,
    send: async (to, text) => {
      log.sent.push({ to, text });
    },
    record: async (key) => {
      log.recorded.push(key);
    },
  };
  return { deps, log };
}

async function main() {
  const { shouldSendTrialNotice, handleTrialStarted, handleSalesNotify, SERVICE_WINDOW_MS, TRIAL_STARTED_MESSAGE } =
    await import('../src/services/salesNotify');

  console.log('\n=== 1. Decisão pura da janela de 24h ===');
  check('janela = 24h', SERVICE_WINDOW_MS === 24 * HOUR);
  check(
    'inbound há 1h → envia',
    shouldSendTrialNotice({ lastInboundAtMs: NOW - HOUR, nowMs: NOW, paused: false }).send
  );
  check(
    'inbound há 23h59 → envia (ainda na janela)',
    shouldSendTrialNotice({
      lastInboundAtMs: NOW - (24 * HOUR - 60_000),
      nowMs: NOW,
      paused: false,
    }).send
  );

  const exact = shouldSendTrialNotice({
    lastInboundAtMs: NOW - 24 * HOUR,
    nowMs: NOW,
    paused: false,
  });
  check('inbound há EXATAMENTE 24h → NÃO envia (borda fechada)', !exact.send);
  check(
    'motivo do skip na borda = outside-window',
    !exact.send && exact.reason === 'outside-window'
  );

  const stale = shouldSendTrialNotice({
    lastInboundAtMs: NOW - 48 * HOUR,
    nowMs: NOW,
    paused: false,
  });
  check('inbound há 48h → NÃO envia', !stale.send);
  check('motivo = outside-window (sem template pago)', !stale.send && stale.reason === 'outside-window');

  const noInbound = shouldSendTrialNotice({ lastInboundAtMs: null, nowMs: NOW, paused: false });
  check('sem inbound nenhum → NÃO envia', !noInbound.send);
  check('motivo = no-inbound', !noInbound.send && noInbound.reason === 'no-inbound');

  const paused = shouldSendTrialNotice({ lastInboundAtMs: NOW - HOUR, nowMs: NOW, paused: true });
  check('conversa pausada (handoff/echo) → NÃO envia', !paused.send);
  check('motivo = paused', !paused.send && paused.reason === 'paused');
  check(
    'pausa tem precedência sobre a janela (pausada E fora da janela → paused)',
    (() => {
      const d = shouldSendTrialNotice({
        lastInboundAtMs: NOW - 48 * HOUR,
        nowMs: NOW,
        paused: true,
      });
      return !d.send && d.reason === 'paused';
    })()
  );

  console.log('\n=== 2. Caminho feliz: mensagem enviada + régua encerrada ===');
  {
    const { deps, log } = makeDeps();
    const result = await handleTrialStarted('+5516988870001', deps);
    check('handled', result.handled === true && result.sent === true);
    check('mandou exatamente 1 mensagem', log.sent.length === 1);
    check('copy do manual', log.sent[0]?.text === TRIAL_STARTED_MESSAGE);
    check('menciona a configuração assistida de 30min', /30min/.test(log.sent[0]?.text ?? ''));
    check(
      'enviou pro telefone COMO a Ana o guarda (wa_id cru, não o canônico do Receps)',
      log.sent[0]?.to === '5516988870001'
    );
    check('régua de venda encerrada', log.ended.length === 1);
    check('gravou no histórico da conversa', log.recorded[0] === 'PN_VENDAS:5516988870001');
  }

  console.log('\n=== 3. Fora da janela de 24h → skip silencioso, régua AINDA encerra ===');
  {
    const { deps, log } = makeDeps({ lastInboundAtMs: NOW - 30 * HOUR });
    const result = await handleTrialStarted('+5516988870001', deps);
    check('handled, mas não enviou', result.handled === true && result.sent === false);
    check(
      'motivo = outside-window',
      result.handled === true && result.sent === false && result.reason === 'outside-window'
    );
    check('NENHUMA mensagem enviada (sem template pago)', log.sent.length === 0);
    check('régua encerrada mesmo assim (converteu)', log.ended.length === 1);
  }

  console.log('\n=== 4. Conversa pausada → skip, régua encerra ===');
  {
    const { deps, log } = makeDeps({ paused: true });
    const result = await handleTrialStarted('+5516988870001', deps);
    check('não enviou', result.handled === true && result.sent === false);
    check('Renata calada durante o handoff', log.sent.length === 0);
    check('régua encerrada', log.ended.length === 1);
  }

  console.log('\n=== 5. Conversa desconhecida (cadastro pelo site) → no-op ===');
  {
    const { deps, log } = makeDeps({ conversation: null });
    const result = await handleTrialStarted('+5511900000000', deps);
    check('não handled', result.handled === false);
    check('motivo = unknown-conversation', result.handled === false && result.reason === 'unknown-conversation');
    check('não enviou nada', log.sent.length === 0);
    check('não tentou encerrar régua inexistente', log.ended.length === 0);
  }

  console.log('\n=== 6. Tenant não-sales / inativo → régua encerra, nada é enviado ===');
  {
    const { deps, log } = makeDeps({ config: salesConfig({ botRole: 'receptionist' }) });
    const result = await handleTrialStarted('+5516988870001', deps);
    check('recepcionista NUNCA manda mensagem de venda', log.sent.length === 0);
    check('motivo = no-sales-config', result.handled === false && result.reason === 'no-sales-config');
    check('régua encerrada antes do gate de config', log.ended.length === 1);
  }
  {
    const { deps, log } = makeDeps({ config: salesConfig({ isActive: false }) });
    await handleTrialStarted('+5516988870001', deps);
    check('config inativa → não envia', log.sent.length === 0);
  }
  {
    const { deps, log } = makeDeps({ config: null });
    await handleTrialStarted('+5516988870001', deps);
    check('sem config → não envia', log.sent.length === 0);
  }

  console.log('\n=== 7. Roteamento por evento ===');
  {
    const { deps, log } = makeDeps();
    await handleSalesNotify('trial_started', '+5516988870001', deps);
    check('trial_started roteia pro handler', log.sent.length === 1);
  }
  {
    const { deps, log } = makeDeps();
    await handleSalesNotify('evento_inventado', '+5516988870001', deps);
    check('evento desconhecido é ignorado (não envia, não encerra régua)', log.sent.length === 0 && log.ended.length === 0);
  }
  {
    const { deps, log } = makeDeps();
    const boom: SalesNotifyDeps = {
      ...deps,
      send: async () => {
        throw new Error('WhatsApp fora do ar');
      },
    };
    await handleSalesNotify('trial_started', '+5516988870001', boom);
    check('falha no envio NÃO propaga (o Receps já respondeu ao usuário)', log.sent.length === 0);
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-sales-notify OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ erro no smoke:', err);
  process.exit(1);
});
