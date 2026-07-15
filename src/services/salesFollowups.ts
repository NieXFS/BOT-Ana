import { pool } from './contextManager';
import type { TenantBotConfig } from '../configProvider';
import { getTenantConfig } from '../configProvider';
import { isConversationPaused } from './pauseService';
import { addMessage } from './contextManager';
import { sendFreeformMessage } from '../whatsappCloudService';
import { Sentry } from '../observability/sentry';

/**
 * Régua de FOLLOW-UP da Renata (Workstream B, §B5). Dentro da janela CTWA de 72h,
 * freeform é custo ZERO de template → 3 toques (+4h / +24h / +48h). Qualquer
 * inbound do lead ZERA a régua (a conversa seguiu). "não quero"/opt-out /
 * handoff / conversão encerram. Depois de 72h: PARAR.
 *
 * Tabela `sales_followups` no Postgres da Ana (padrão processedMessages, raw pg).
 * A lógica da régua é PURA (funções abaixo) pra smoke determinístico; o poller é
 * a casca impura (60s, no boot do webhookServer).
 */

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 72 * HOUR_MS;
/** Offsets do anchor (último inbound) até cada toque. Stage k dispara em anchor+OFFSETS[k]. */
export const FOLLOWUP_OFFSETS_MS = [4 * HOUR_MS, 24 * HOUR_MS, 48 * HOUR_MS];
export const MAX_TOUCHES = FOLLOWUP_OFFSETS_MS.length;

export interface FollowupRow {
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  customerName: string | null;
  anchorAtMs: number;
  windowExpiresAtMs: number;
  nextAtMs: number | null;
  touchCount: number;
  lastStage: number;
  optedOut: boolean;
}

// ── Ruler PURO (testável sem DB) ─────────────────────────────────────────────

/** Estado inicial de uma conversa nova (1º inbound). */
export function initialFollowupState(nowMs: number): {
  anchorAtMs: number;
  windowExpiresAtMs: number;
  nextAtMs: number;
  touchCount: number;
  lastStage: number;
} {
  return {
    anchorAtMs: nowMs,
    windowExpiresAtMs: nowMs + WINDOW_MS,
    nextAtMs: nowMs + FOLLOWUP_OFFSETS_MS[0],
    touchCount: 0,
    lastStage: 0,
  };
}

/**
 * Régua ZERA num novo inbound: anchor/next voltam pro estágio 0, touch_count=0.
 * A janela de 72h (do 1º inbound) é PRESERVADA — nunca mandamos depois dela.
 * opt-out é sticky (não reabre).
 */
export function rescheduleFollowupState(
  existing: Pick<FollowupRow, 'windowExpiresAtMs' | 'optedOut'>,
  nowMs: number
): { anchorAtMs: number; nextAtMs: number; touchCount: number; lastStage: number } | null {
  if (existing.optedOut) {
    return null; // não reabre
  }
  return {
    anchorAtMs: nowMs,
    nextAtMs: nowMs + FOLLOWUP_OFFSETS_MS[0],
    touchCount: 0,
    lastStage: 0,
  };
}

/** Um toque está DEVIDO agora? (dentro da janela, com toque pendente, não opt-out). */
export function isTouchDue(row: FollowupRow, nowMs: number): boolean {
  return (
    !row.optedOut &&
    row.touchCount < MAX_TOUCHES &&
    row.nextAtMs !== null &&
    row.nextAtMs <= nowMs &&
    row.windowExpiresAtMs > nowMs
  );
}

/** Estado após disparar o toque atual (avança o contador e agenda o próximo). */
export function advanceAfterTouch(row: FollowupRow): {
  touchCount: number;
  lastStage: number;
  nextAtMs: number | null;
} {
  const nextCount = row.touchCount + 1;
  const nextOffset = FOLLOWUP_OFFSETS_MS[nextCount];
  return {
    touchCount: nextCount,
    lastStage: nextCount,
    nextAtMs: nextOffset !== undefined ? row.anchorAtMs + nextOffset : null,
  };
}

/** Primeiro nome utilizável, ou vazio (nome ausente / "Cliente"). */
function firstName(name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'cliente') return '';
  return trimmed.split(/\s+/)[0];
}

/** Texto do toque `stageIndex` (0/1/2), do manual §7. */
export function followupStageText(stageIndex: number, name: string | null): string {
  const nome = firstName(name);
  switch (stageIndex) {
    case 0:
      return nome
        ? `Oi, ${nome}! Ficou alguma dúvida sobre a Receps? Se quiser, te mostro como a Ana atenderia uma cliente sua — é rapidinho.`
        : `Oi! Ficou alguma dúvida sobre a Receps? Se quiser, te mostro como a Ana atenderia uma cliente sua — é rapidinho.`;
    case 1:
      return `Lembrei de você: sabia que dá pra testar a Receps grátis, sem cartão? Você conecta seu WhatsApp e vê a Ana agendando de verdade antes de pagar qualquer coisa.`;
    case 2:
      return `Vou deixar você em paz depois dessa, prometo 😊 Se quiser, o Victor faz uma demonstração de 30min no horário que você escolher. Topa?`;
    default:
      return '';
  }
}

// ── Camada de DB (impura) ────────────────────────────────────────────────────

function conversationKey(phoneNumberId: string, customerPhone: string): string {
  return `${phoneNumberId}:${customerPhone}`;
}

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);

export async function ensureSalesFollowupsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_followups (
      conversation_key   text PRIMARY KEY,
      phone_number_id    text NOT NULL,
      customer_phone     text NOT NULL,
      customer_name      text,
      anchor_at          timestamptz NOT NULL,
      window_expires_at  timestamptz NOT NULL,
      next_at            timestamptz,
      touch_count        integer NOT NULL DEFAULT 0,
      last_stage         integer NOT NULL DEFAULT 0,
      opted_out          boolean NOT NULL DEFAULT false,
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Chamado a CADA inbound de venda: cria a régua (1º inbound) ou ZERA-a (inbounds
 * seguintes), preservando a janela de 72h. Não reabre se opt-out. Best-effort.
 */
export async function scheduleFollowup(
  phoneNumberId: string,
  customerPhone: string,
  customerName: string | null
): Promise<void> {
  const key = conversationKey(phoneNumberId, customerPhone);
  const now = new Date();
  const init = initialFollowupState(now.getTime());
  try {
    await pool.query(
      `INSERT INTO sales_followups
         (conversation_key, phone_number_id, customer_phone, customer_name,
          anchor_at, window_expires_at, next_at, touch_count, last_stage, opted_out, updated_at)
       VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0), to_timestamp($6/1000.0), to_timestamp($7/1000.0), 0, 0, false, now())
       ON CONFLICT (conversation_key) DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, sales_followups.customer_name),
         anchor_at = EXCLUDED.anchor_at,
         next_at = EXCLUDED.next_at,
         touch_count = 0,
         last_stage = 0,
         updated_at = now()
       WHERE sales_followups.opted_out = false`,
      [
        key,
        phoneNumberId,
        customerPhone,
        customerName,
        init.anchorAtMs,
        init.windowExpiresAtMs,
        init.nextAtMs,
      ]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'schedule', phoneNumberId },
    });
  }
}

/** Encerra a régua (opt-out / handoff / conversão). Best-effort. */
export async function markFollowupOptedOut(
  phoneNumberId: string,
  customerPhone: string
): Promise<void> {
  const key = conversationKey(phoneNumberId, customerPhone);
  try {
    await pool.query(
      `UPDATE sales_followups SET opted_out = true, next_at = NULL, updated_at = now()
       WHERE conversation_key = $1`,
      [key]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'opt-out', phoneNumberId },
    });
  }
}

async function loadDueRows(nowMs: number): Promise<FollowupRow[]> {
  const { rows } = await pool.query(
    `SELECT conversation_key, phone_number_id, customer_phone, customer_name,
            anchor_at, window_expires_at, next_at, touch_count, last_stage, opted_out
       FROM sales_followups
      WHERE opted_out = false
        AND touch_count < $1
        AND next_at IS NOT NULL
        AND next_at <= to_timestamp($2/1000.0)
        AND window_expires_at > to_timestamp($2/1000.0)
      ORDER BY next_at ASC
      LIMIT 50`,
    [MAX_TOUCHES, nowMs]
  );
  return rows.map((r) => ({
    conversationKey: r.conversation_key,
    phoneNumberId: r.phone_number_id,
    customerPhone: r.customer_phone,
    customerName: r.customer_name,
    anchorAtMs: new Date(r.anchor_at).getTime(),
    windowExpiresAtMs: new Date(r.window_expires_at).getTime(),
    nextAtMs: toMs(r.next_at),
    touchCount: r.touch_count,
    lastStage: r.last_stage,
    optedOut: r.opted_out,
  }));
}

async function persistAdvance(
  conversationKey: string,
  advance: { touchCount: number; lastStage: number; nextAtMs: number | null }
): Promise<void> {
  await pool.query(
    `UPDATE sales_followups
        SET touch_count = $2, last_stage = $3,
            next_at = CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4/1000.0) END,
            updated_at = now()
      WHERE conversation_key = $1`,
    [conversationKey, advance.touchCount, advance.lastStage, advance.nextAtMs]
  );
}

export interface FollowupTickDeps {
  now: () => number;
  loadDue: (nowMs: number) => Promise<FollowupRow[]>;
  getConfig: (phoneNumberId: string) => Promise<TenantBotConfig | null>;
  isPaused: (phoneNumberId: string, customerPhone: string) => Promise<boolean>;
  send: (to: string, text: string, config: TenantBotConfig) => Promise<void>;
  record: (conversationKey: string, role: 'assistant', content: string) => Promise<void>;
  persist: (
    conversationKey: string,
    advance: { touchCount: number; lastStage: number; nextAtMs: number | null }
  ) => Promise<void>;
}

const defaultTickDeps: FollowupTickDeps = {
  now: () => Date.now(),
  loadDue: loadDueRows,
  getConfig: getTenantConfig,
  isPaused: isConversationPaused,
  send: (to, text, config) => sendFreeformMessage(to, text, config),
  record: (key, role, content) => addMessage(key, role, content),
  persist: persistAdvance,
};

/**
 * Um "tick" da régua: dispara os toques devidos. Pula conversa pausada
 * (handoff/echo), tenant sem config ativa, ou brain != sales (defesa). Cada envio
 * é isolado — falha de um não derruba os outros. Retorna quantos toques enviou.
 */
export async function runFollowupTick(
  deps: FollowupTickDeps = defaultTickDeps
): Promise<number> {
  const nowMs = deps.now();
  let sent = 0;

  const due = await deps.loadDue(nowMs);
  for (const row of due) {
    try {
      const config = await deps.getConfig(row.phoneNumberId);
      if (!config || !config.isActive || config.botRole !== 'sales') {
        continue; // sem config ativa de vendas → não envia (tenta no próximo tick)
      }

      if (await deps.isPaused(row.phoneNumberId, row.customerPhone)) {
        continue; // handoff/echo em andamento — Renata cala
      }

      const text = followupStageText(row.touchCount, row.customerName);
      await deps.send(row.customerPhone, text, config);
      await deps
        .record(row.conversationKey, 'assistant', text)
        .catch(() => undefined);

      await deps.persist(row.conversationKey, advanceAfterTouch(row));
      sent += 1;
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          service: 'sales-followups',
          operation: 'tick-send',
          phoneNumberId: row.phoneNumberId,
        },
      });
    }
  }

  return sent;
}

let pollerHandle: NodeJS.Timeout | null = null;

/** Liga o poller de 60s (no boot). Idempotente. */
export function startFollowupPoller(intervalMs = 60_000): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(() => {
    runFollowupTick().catch((err) => {
      Sentry.captureException(err, {
        tags: { service: 'sales-followups', operation: 'poller' },
      });
      console.error('❌ Erro no poller de follow-up:', err);
    });
  }, intervalMs);
  // Não segura o processo vivo só por causa do poller.
  if (typeof pollerHandle.unref === 'function') pollerHandle.unref();
}

/** Seam de teste. */
export function __stopFollowupPollerForTest(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}
