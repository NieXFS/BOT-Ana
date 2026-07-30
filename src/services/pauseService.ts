import axios from 'axios';
import { Sentry } from '../observability/sentry';
import { ERP_API_TOKEN } from '../erpApiToken';
import { isPausedFromState, type PauseState } from './pauseDecision';

// Base + auth no MESMO padrão do optOutService (Bearer ERP_API_TOKEN).
const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';

const REQUEST_TIMEOUT_MS = 10_000;

// Cache curto do GET por conversa: 1 GET cobre uma rajada de mensagens, mantendo
// o estado fresco o bastante pra refletir pausas feitas no painel em ~25s.
const PAUSE_STATE_TTL_MS = 25_000;

// Pausa local OTIMISTA quando o POST de echo falha: um humano JÁ respondeu pelo
// app, então a Ana fica calada localmente mesmo se o Receps estiver indisponível
// no instante (write local não depende da rede). Espelha o default de
// echoPauseMinutes do ERP (60 min).
const ECHO_LOCAL_FALLBACK_MS = 60 * 60_000;

interface PauseCacheEntry {
  globalUntilMs: number | null;
  conversationUntilMs: number | null;
  // Auto-pausa PROGRAMADA (intervalo "ex.: almoço") decidida no Receps. Carimbo do
  // fim do intervalo; futuro = pausado. A Ana só consome (não recalcula fuso/dia).
  scheduleUntilMs: number | null;
  expiresAt: number; // frescor do GET (não é o fim da pausa)
}

const pauseCache = new Map<string, PauseCacheEntry>();

export interface EchoPauseDeps {
  now: () => number;
  persistPause: (phoneNumberId: string, customerPhone: string) => Promise<string | null>;
}

function cacheKey(phoneNumberId: string, customerPhone: string): string {
  // Mesma forma do conversationKey/bufferKey do resto da Ana.
  return `${phoneNumberId}:${customerPhone}`;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function entryIsPaused(entry: PauseCacheEntry, nowMs: number): boolean {
  return (
    (entry.globalUntilMs !== null && entry.globalUntilMs > nowMs) ||
    (entry.conversationUntilMs !== null && entry.conversationUntilMs > nowMs) ||
    (entry.scheduleUntilMs !== null && entry.scheduleUntilMs > nowMs)
  );
}

async function persistPauseInReceps(
  phoneNumberId: string,
  customerPhone: string
): Promise<string | null> {
  const { data } = await axios.post<{ pausedUntil: string }>(
    `${RECEPS_INTERNAL_API_URL}/api/v1/bot/pause-conversation`,
    { phoneNumberId, customerPhone, source: 'echo' },
    {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );
  return data?.pausedUntil ?? null;
}

const defaultEchoPauseDeps: EchoPauseDeps = {
  now: Date.now,
  persistPause: persistPauseInReceps,
};

function writeConversationPauseToCache(
  phoneNumberId: string,
  customerPhone: string,
  conversationUntilMs: number,
  nowMs: number
): void {
  const key = cacheKey(phoneNumberId, customerPhone);
  const existing = pauseCache.get(key);
  pauseCache.set(key, {
    globalUntilMs: existing?.globalUntilMs ?? null,
    conversationUntilMs,
    scheduleUntilMs: existing?.scheduleUntilMs ?? null,
    expiresAt: nowMs + PAUSE_STATE_TTL_MS,
  });
}

// NUNCA logar PII: só phoneNumberId (id do salão, allowlistado no scrub). O número
// e o nome do cliente NÃO entram em tags/log.
function capture(error: unknown, phoneNumberId: string, operation: string): void {
  Sentry.captureException(error, {
    tags: { service: 'ana-pause', operation, phoneNumberId },
  });
  const message = axios.isAxiosError(error)
    ? error.response?.status
      ? `HTTP ${error.response.status}`
      : error.message
    : String(error);
  console.error(`❌ [pause] falha em ${operation}: ${message}`);
}

async function fetchPauseState(
  phoneNumberId: string,
  customerPhone: string
): Promise<PauseState | null> {
  try {
    const url = new URL('/api/v1/bot/pause-state', RECEPS_INTERNAL_API_URL);
    url.searchParams.set('phoneNumberId', phoneNumberId);
    url.searchParams.set('customerPhone', customerPhone);

    const { data } = await axios.get<PauseState>(url.toString(), {
      headers: { Authorization: `Bearer ${ERP_API_TOKEN}` },
      timeout: REQUEST_TIMEOUT_MS,
    });

    return {
      globalPausedUntil: data?.globalPausedUntil ?? null,
      conversationPausedUntil: data?.conversationPausedUntil ?? null,
      schedulePausedUntil: data?.schedulePausedUntil ?? null,
    };
  } catch (error) {
    // FAIL-OPEN: erro/timeout/404 → null → tratado como NÃO pausado pelo caller.
    capture(error, phoneNumberId, 'fetch-pause-state');
    return null;
  }
}

/**
 * Echo: o humano respondeu PELO app do WhatsApp → pausa a conversa no Receps
 * (que aplica o echoPauseMinutes do tenant) e no cache local.
 *
 * NUNCA lança. Escreve no cache local IMEDIATAMENTE pra Ana respeitar a pausa já
 * na próxima mensagem (sem esperar o TTL do GET). Se o POST falhar, ainda aplica
 * uma pausa local OTIMISTA pra não falar por cima do humano.
 */
export async function pauseConversationByEcho(
  phoneNumberId: string,
  customerPhone: string,
  deps: EchoPauseDeps = defaultEchoPauseDeps
): Promise<void> {
  // O write-through precisa acontecer ANTES do primeiro await. A Meta pode entregar
  // a resposta seguinte da cliente enquanto o POST ao Receps ainda está em voo;
  // esperar a rede aqui abriria uma janela de até REQUEST_TIMEOUT_MS pra IA falar.
  const startedAt = deps.now();
  writeConversationPauseToCache(
    phoneNumberId,
    customerPhone,
    startedAt + ECHO_LOCAL_FALLBACK_MS,
    startedAt
  );

  try {
    const pausedUntilMs = toMs(await deps.persistPause(phoneNumberId, customerPhone));
    if (pausedUntilMs !== null) {
      writeConversationPauseToCache(
        phoneNumberId,
        customerPhone,
        pausedUntilMs,
        deps.now()
      );
    }
  } catch (error) {
    capture(error, phoneNumberId, 'pause-conversation');
  }
}

/**
 * "Esta conversa está pausada AGORA?" — combina pausa GERAL (salão) + pausa da
 * conversa. Usa cache curto por conversa + write-through do echo.
 *
 * FAIL-OPEN: qualquer erro/timeout/404 no GET → `false` (Ana responde normal).
 */
export async function isConversationPaused(
  phoneNumberId: string,
  customerPhone: string
): Promise<boolean> {
  const now = Date.now();
  const key = cacheKey(phoneNumberId, customerPhone);
  const cached = pauseCache.get(key);

  // 1) Cache fresco (inclui o write-through imediato do echo) → decide sem rede.
  if (cached && cached.expiresAt > now) {
    return entryIsPaused(cached, now);
  }

  // 2) Cache vencido mas ainda indicando pausa no futuro → respeita (não deixa o
  //    TTL do GET "despausar" antes da hora).
  if (cached && entryIsPaused(cached, now)) {
    return true;
  }

  // 3) Busca o estado fresco no Receps.
  const state = await fetchPauseState(phoneNumberId, customerPhone);
  if (!state) {
    return false; // fail-open
  }

  pauseCache.set(key, {
    globalUntilMs: toMs(state.globalPausedUntil),
    conversationUntilMs: toMs(state.conversationPausedUntil),
    scheduleUntilMs: toMs(state.schedulePausedUntil),
    expiresAt: now + PAUSE_STATE_TTL_MS,
  });
  return isPausedFromState(state, now);
}

/** Seam de teste: limpa o cache entre casos do smoke. */
export function __resetPauseCacheForTest(): void {
  pauseCache.clear();
}
