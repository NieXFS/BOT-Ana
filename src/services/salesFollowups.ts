import axios from 'axios';
import { pool } from './contextManager';
import type { TenantBotConfig } from '../configProvider';
import { getTenantConfig } from '../configProvider';
import { isConversationPaused } from './pauseService';
import { addMessage } from './contextManager';
import { sendFreeformMessage } from '../whatsappCloudService';
import { Sentry } from '../observability/sentry';
import { emitSalesEvent } from './salesEvents';
import { ERP_API_TOKEN } from '../erpApiToken';
import { isRenataVoiceEnabled } from '../voice/voiceConfig';
import { deliverSalesReply } from '../voice/voiceDelivery';
import { getAvailableSlots } from './calendarService';
import { resolveDemoServiceId } from './demoScheduling';

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
const REQUEST_TIMEOUT_MS = 10_000;
const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? process.env.ERP_BASE_URL ?? 'http://localhost:3000';
/** Offsets do anchor (último inbound) até cada toque. Stage k dispara em anchor+OFFSETS[k]. */
export const FOLLOWUP_OFFSETS_MS = [4 * HOUR_MS, 24 * HOUR_MS, 48 * HOUR_MS];
export const MAX_TOUCHES = FOLLOWUP_OFFSETS_MS.length;
/** Somente para migrar o marcador legado `last_stage = 100 + touch_count`. */
export const LEGACY_POST_LINK_STAGE_OFFSET = 100;
export type FollowupJourney = 'default' | 'post_link' | 'demo';

export type CurrentPrefilledSignupLinkResult =
  | { success: true; url: string }
  | { success: false; reason: 'not_found' | 'unavailable' };

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
  journey: FollowupJourney;
  lastTouchIdx: number | null;
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
 * Régua ZERA num novo inbound: anchor/next voltam pro toque 0, touch_count=0.
 * A janela de 72h (do 1º inbound), a jornada e o índice da última variação são
 * PRESERVADOS. Opt-out é sticky (não reabre).
 */
export function rescheduleFollowupState(
  existing: Pick<FollowupRow, 'windowExpiresAtMs' | 'optedOut'> &
    Partial<Pick<FollowupRow, 'journey' | 'lastTouchIdx' | 'lastStage'>>,
  nowMs: number
): {
  anchorAtMs: number;
  nextAtMs: number;
  touchCount: number;
  lastStage: number;
  journey: FollowupJourney;
  lastTouchIdx: number | null;
} | null {
  if (existing.optedOut) {
    return null; // não reabre
  }
  return {
    anchorAtMs: nowMs,
    nextAtMs: nowMs + FOLLOWUP_OFFSETS_MS[0],
    touchCount: 0,
    lastStage: 0,
    journey:
      existing.journey ??
      ((existing.lastStage ?? 0) >= LEGACY_POST_LINK_STAGE_OFFSET
        ? 'post_link'
        : 'default'),
    lastTouchIdx: existing.lastTouchIdx ?? null,
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
  lastTouchIdx: number | null;
};
export function advanceAfterTouch(
  row: FollowupRow,
  lastTouchIdx: number | null
): {
  touchCount: number;
  lastStage: number;
  nextAtMs: number | null;
  lastTouchIdx: number | null;
};
export function advanceAfterTouch(
  row: FollowupRow,
  lastTouchIdx: number | null = row.lastTouchIdx
): {
  touchCount: number;
  lastStage: number;
  nextAtMs: number | null;
  lastTouchIdx: number | null;
} {
  const nextCount = row.touchCount + 1;
  const nextOffset = FOLLOWUP_OFFSETS_MS[nextCount];
  return {
    touchCount: nextCount,
    lastStage: nextCount,
    nextAtMs: nextOffset !== undefined ? row.anchorAtMs + nextOffset : null,
    lastTouchIdx,
  };
}

const JOURNEY_PRIORITY: Record<FollowupJourney, number> = {
  default: 0,
  demo: 1,
  post_link: 2,
};

export function promoteFollowupJourney(
  current: FollowupJourney,
  requested: FollowupJourney
): FollowupJourney {
  return JOURNEY_PRIORITY[requested] > JOURNEY_PRIORITY[current]
    ? requested
    : current;
}

export function postLinkFollowupText(url: string): string {
  return `Vi que faltou só a senha pra ativar sua conta! 😊 O link é esse: ${url} — qualquer dúvida é só me chamar.`;
}

/** Primeiro nome utilizável, ou vazio (nome ausente / "Cliente"). */
function firstName(name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'cliente') return '';
  return trimmed.split(/\s+/)[0];
}

const NAME_TOKEN = '{{name}}';

/** Índice 0 de cada estágio é a copy canônica do manual §7. */
export const FOLLOWUP_VARIANTS: string[][] = [
  [
    `Oi, ${NAME_TOKEN}! Ficou alguma dúvida sobre a Receps? Se quiser, te mostro como a Ana atenderia uma cliente sua — é rapidinho.`,
    `Oi, ${NAME_TOKEN}! Passando pra saber se ficou alguma dúvida sobre a Receps. Se quiser ver a Ana atendendo na prática, eu faço uma simulação aqui com você.`,
    `Oi, ${NAME_TOKEN}! Quer tirar alguma dúvida sobre a Receps? Posso te mostrar aqui mesmo como a Ana atenderia uma cliente sua.`,
  ],
  [
    'Lembrei de você: sabia que dá pra testar a Receps grátis, sem cartão? Você conecta seu WhatsApp e vê a Ana agendando de verdade antes de pagar qualquer coisa.',
    'Só pra você saber: dá pra testar a Receps grátis e sem cartão. Assim você vê a Ana agendando na prática antes de decidir.',
  ],
  [
    `Vou deixar você em paz depois dessa, prometo 😊 Se quiser ver a Ana funcionando na prática, é rapidinho: me manda um 'oi, queria marcar um horário' como se você fosse sua cliente, que eu te mostro ao vivo. Topa?`,
    `Esse é meu último toque, prometo 😊 Se quiser ver a Ana em ação, me manda um 'oi, queria marcar um horário' como se fosse sua cliente. Eu faço a simulação aqui pra você.`,
  ],
];

function interpolateName(template: string, name: string | null): string {
  const nome = firstName(name);
  return nome
    ? template.split(NAME_TOKEN).join(nome)
    : template.split(`, ${NAME_TOKEN}`).join('');
}

export function pickFollowupVariant(
  stageIndex: number,
  name: string | null,
  lastIdx: number | null
): { text: string; idx: number } {
  const variants = FOLLOWUP_VARIANTS[stageIndex] ?? [];
  if (variants.length === 0) return { text: '', idx: 0 };
  const idx =
    lastIdx === null || lastIdx < 0
      ? 0
      : (lastIdx + 1) % variants.length;
  return { text: interpolateName(variants[idx], name), idx };
}

/** Compatibilidade para consumidores que querem a variação canônica. */
export function followupStageText(stageIndex: number, name: string | null): string {
  return pickFollowupVariant(stageIndex, name, null).text;
}

/** Mesma copy canônica do novo +48h do manual §7. */
export const DEMO_SIMULATION_FALLBACK_TEXT = FOLLOWUP_VARIANTS[2][0];

export interface DemoAvailabilityResult {
  success: boolean;
  slots?: string[];
}

export interface DemoFollowupDeps {
  now: () => number;
  resolveServiceId: (config: TenantBotConfig) => Promise<string | null>;
  getSlots: (
    date: string,
    serviceId: string,
    config: TenantBotConfig
  ) => Promise<DemoAvailabilityResult>;
}

const defaultDemoFollowupDeps: DemoFollowupDeps = {
  now: () => Date.now(),
  resolveServiceId: resolveDemoServiceId,
  getSlots: getAvailableSlots,
};

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function formatDemoDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Retoma a negociação de demo com dois horários reais. Qualquer falha de
 * serviço/agenda degrada para a simulação in-chat, nunca para o toque genérico.
 */
export async function demoJourneyFollowupText(
  config: TenantBotConfig,
  overrides: Partial<DemoFollowupDeps> = {}
): Promise<string> {
  const deps = { ...defaultDemoFollowupDeps, ...overrides };
  try {
    const serviceId = await deps.resolveServiceId(config);
    if (!serviceId) return DEMO_SIMULATION_FALLBACK_TEXT;

    const today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: config.timezone,
    }).format(new Date(deps.now()));

    for (let offset = 0; offset <= 5; offset += 1) {
      const date = addCalendarDays(today, offset);
      const result = await deps.getSlots(date, serviceId, config);
      if (!result.success) return DEMO_SIMULATION_FALLBACK_TEXT;
      const slots = [...new Set((result.slots ?? []).filter(Boolean))];
      if (slots.length >= 2) {
        return `Vamos retomar sua demonstração com o Victor. Tenho ${formatDemoDate(date)} às ${slots[0]} ou às ${slots[1]}. Qual fica melhor?`;
      }
    }
  } catch {
    // Agenda é best-effort na régua: API fora/timeout nunca deixa o toque
    // genérico atropelar a conversa; oferecemos a simulação in-chat.
  }
  return DEMO_SIMULATION_FALLBACK_TEXT;
}

// ── Camada de DB (impura) ────────────────────────────────────────────────────

function conversationKey(phoneNumberId: string, customerPhone: string): string {
  return `${phoneNumberId}:${customerPhone}`;
}

const toMs = (d: Date | null): number | null => (d ? d.getTime() : null);

export type SalesFollowupsQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

const defaultFollowupsQuery: SalesFollowupsQuery = (text, params) =>
  pool.query(text, params);

export async function ensureSalesFollowupsTable(
  query: SalesFollowupsQuery = defaultFollowupsQuery
): Promise<void> {
  await query(`
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
      journey            text NOT NULL DEFAULT 'default',
      last_touch_idx     integer,
      opted_out          boolean NOT NULL DEFAULT false,
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    ALTER TABLE sales_followups
      ADD COLUMN IF NOT EXISTS journey text NOT NULL DEFAULT 'default',
      ADD COLUMN IF NOT EXISTS last_touch_idx integer
  `);
  await query(`
    UPDATE sales_followups
       SET journey = 'post_link'
     WHERE journey = 'default'
       AND last_stage >= ${LEGACY_POST_LINK_STAGE_OFFSET}
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
  let previousTouchCount = 0;

  try {
    const existing = await pool.query<{ touch_count: number }>(
      `SELECT touch_count FROM sales_followups WHERE conversation_key = $1`,
      [key]
    );
    previousTouchCount = existing.rows[0]?.touch_count ?? 0;
  } catch (err) {
    // A leitura de telemetria não pode impedir o upsert original da régua.
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'schedule-reopen-read', phoneNumberId },
    });
  }

  try {
    await pool.query(
      `INSERT INTO sales_followups
         (conversation_key, phone_number_id, customer_phone, customer_name,
          anchor_at, window_expires_at, next_at, touch_count, last_stage,
          journey, last_touch_idx, opted_out, updated_at)
       VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0), to_timestamp($6/1000.0), to_timestamp($7/1000.0), 0, 0, 'default', NULL, false, now())
       ON CONFLICT (conversation_key) DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, sales_followups.customer_name),
         anchor_at = EXCLUDED.anchor_at,
         next_at = EXCLUDED.next_at,
         touch_count = 0,
         last_stage = 0,
         -- journey e last_touch_idx são deliberadamente preservados: a resposta
         -- do lead reinicia o tempo/contador, mas não pode voltar ao texto que
         -- acabou de ouvir nem apagar uma negociação de demo/pós-link.
         journey = sales_followups.journey,
         last_touch_idx = sales_followups.last_touch_idx,
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
    if (previousTouchCount > 0) {
      void emitSalesEvent(phoneNumberId, customerPhone, 'reabriu', {
        afterTouches: previousTouchCount,
      }).catch(() => undefined);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'schedule', phoneNumberId },
    });
  }
}

/** Marca a jornada pós-link, que tem precedência máxima. */
export async function markFollowupPostLink(
  phoneNumberId: string,
  customerPhone: string
): Promise<void> {
  const key = conversationKey(phoneNumberId, customerPhone);
  try {
    await pool.query(
      `UPDATE sales_followups
          SET journey = 'post_link', updated_at = now()
        WHERE conversation_key = $1 AND opted_out = false`,
      [key]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'mark-post-link', phoneNumberId },
    });
  }
}

/**
 * Marca que uma negociação de demo está ativa. Não rebaixa quem já recebeu o
 * link: `post_link > demo > default`.
 */
export async function markFollowupDemoStage(
  phoneNumberId: string,
  customerPhone: string
): Promise<void> {
  const key = conversationKey(phoneNumberId, customerPhone);
  try {
    await pool.query(
      `UPDATE sales_followups
          SET journey = 'demo', updated_at = now()
        WHERE conversation_key = $1
          AND opted_out = false
          AND journey = 'default'`,
      [key]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-followups', operation: 'mark-demo', phoneNumberId },
    });
  }
}

/**
 * Recupera o prefill vigente sem criar/renovar token nem emitir evento. Nunca
 * loga URL/telefone e nunca lança; 404 é o fallback esperado para o texto comum.
 */
export async function getCurrentPrefilledSignupLink(
  customerPhone: string,
  phoneNumberId: string
): Promise<CurrentPrefilledSignupLinkResult> {
  try {
    const { data } = await axios.get<{ url?: string }>(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/signup-prefill`,
      {
        params: { customerPhone },
        headers: { Authorization: `Bearer ${ERP_API_TOKEN}` },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    if (data?.url) return { success: true, url: data.url };
    Sentry.captureException(
      new Error('sales-followups get-current-prefilled-signup failed (response without url)'),
      {
        tags: {
          service: 'sales-followups',
          operation: 'get-current-prefilled-signup',
          phoneNumberId,
        },
      }
    );
    console.error(
      '❌ [sales-followups] falha em get-current-prefilled-signup: response without url'
    );
    return { success: false, reason: 'unavailable' };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 404) return { success: false, reason: 'not_found' };

    const detail = status
      ? `HTTP ${status}`
      : axios.isAxiosError(error)
        ? error.code ?? 'axios_error'
        : error instanceof Error
          ? error.name
          : 'unknown_error';
    Sentry.captureException(
      new Error(`sales-followups get-current-prefilled-signup failed (${detail})`),
      {
        tags: {
          service: 'sales-followups',
          operation: 'get-current-prefilled-signup',
          phoneNumberId,
        },
      }
    );
    console.error(`❌ [sales-followups] falha em get-current-prefilled-signup: ${detail}`);
    return { success: false, reason: 'unavailable' };
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
            anchor_at, window_expires_at, next_at, touch_count, last_stage,
            journey, last_touch_idx, opted_out
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
    journey:
      r.journey === 'post_link' || r.journey === 'demo'
        ? r.journey
        : 'default',
    lastTouchIdx:
      typeof r.last_touch_idx === 'number' ? r.last_touch_idx : null,
    optedOut: r.opted_out,
  }));
}

export interface FollowupAdvance {
  touchCount: number;
  lastStage: number;
  nextAtMs: number | null;
  lastTouchIdx: number | null;
}

async function persistAdvance(
  conversationKey: string,
  advance: FollowupAdvance
): Promise<void> {
  await pool.query(
    `UPDATE sales_followups
        SET touch_count = $2, last_stage = $3,
            next_at = CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4/1000.0) END,
            last_touch_idx = $5,
            updated_at = now()
      WHERE conversation_key = $1`,
    [
      conversationKey,
      advance.touchCount,
      advance.lastStage,
      advance.nextAtMs,
      advance.lastTouchIdx,
    ]
  );
}

export interface FollowupTickDeps {
  now: () => number;
  loadDue: (nowMs: number) => Promise<FollowupRow[]>;
  getConfig: (phoneNumberId: string) => Promise<TenantBotConfig | null>;
  isPaused: (phoneNumberId: string, customerPhone: string) => Promise<boolean>;
  getPrefilledLink: (
    customerPhone: string,
    phoneNumberId: string
  ) => Promise<CurrentPrefilledSignupLinkResult>;
  getDemoText: (config: TenantBotConfig) => Promise<string>;
  send: (to: string, text: string, config: TenantBotConfig) => Promise<void>;
  record: (conversationKey: string, role: 'assistant', content: string) => Promise<void>;
  emitEvent: typeof emitSalesEvent;
  persist: (
    conversationKey: string,
    advance: FollowupAdvance
  ) => Promise<void>;
}

const defaultTickDeps: FollowupTickDeps = {
  now: () => Date.now(),
  loadDue: loadDueRows,
  getConfig: getTenantConfig,
  isPaused: isConversationPaused,
  getPrefilledLink: getCurrentPrefilledSignupLink,
  getDemoText: demoJourneyFollowupText,
  send: (to, text, config) =>
    isRenataVoiceEnabled(config)
      ? deliverSalesReply(to, text, config)
      : sendFreeformMessage(to, text, config),
  record: (key, role, content) => addMessage(key, role, content),
  emitEvent: emitSalesEvent,
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

      const variant = pickFollowupVariant(
        row.touchCount,
        row.customerName,
        row.lastTouchIdx
      );
      let text = variant.text;
      let nextVariantIdx: number | null = variant.idx;

      if (row.journey === 'post_link') {
        const currentLink = await deps.getPrefilledLink(
          row.customerPhone,
          row.phoneNumberId
        );
        if (currentLink.success) {
          text = postLinkFollowupText(currentLink.url);
          nextVariantIdx = row.lastTouchIdx;
        }
      } else if (row.journey === 'demo') {
        text = await deps.getDemoText(config);
        nextVariantIdx = row.lastTouchIdx;
      }
      await deps.send(row.customerPhone, text, config);
      void deps
        .emitEvent(row.phoneNumberId, row.customerPhone, 'followup_enviado', {
          stage: row.touchCount,
        })
        .catch(() => undefined);
      await deps
        .record(row.conversationKey, 'assistant', text)
        .catch(() => undefined);

      await deps.persist(
        row.conversationKey,
        advanceAfterTouch(row, nextVariantIdx)
      );
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
