import axios from 'axios';
import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
} from '../observability/safeRuntime';
import { ERP_API_TOKEN } from '../erpApiToken';
import { isPausedFromState, type PauseState } from './pauseDecision';
import {
  escalationCacheNeedsRefresh,
  getEscalationSnapshot,
  isEscalationKnownActive,
  parseStrictEscalationSnapshot,
  updateEscalationFromPauseState,
} from './escalationCache';
import { peekCachedTenantSlug } from '../configProvider';
import {
  observeTechnicalMaintenance,
  parseTechnicalMaintenanceSnapshot,
  shouldFailClosedForTechnicalMaintenance,
  __resetTechnicalMaintenanceCacheForTest,
} from './technicalMaintenanceCache';
import {
  canonicalConversationKey,
  canonicalCustomerPhone,
} from './conversationOrder';

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
  return canonicalConversationKey(phoneNumberId, customerPhone);
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
  const status = safeHttpStatus(error);
  Sentry.captureException(new Error('ana pause operation failed'), {
    tags: {
      service: 'ana-pause',
      operation,
      phoneNumberId,
      error_kind: runtimeErrorKind(error),
      http_status: status ?? 'n/a',
    },
  });
  console.error(
    `❌ [pause] falha em ${operation} | error=${runtimeErrorKind(error)} | status=${status ?? 'n/a'}`
  );
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
      escalation: data?.escalation,
      technicalMaintenance:
        parseTechnicalMaintenanceSnapshot(data?.technicalMaintenance) ??
        undefined,
    };
  } catch (error) {
    // FAIL-OPEN: erro/timeout/404 → null → tratado como NÃO pausado pelo caller.
    capture(error, phoneNumberId, 'fetch-pause-state');
    return null;
  }
}

export interface ConversationPauseDeps {
  now: () => number;
  fetchState: (
    phoneNumberId: string,
    customerPhone: string
  ) => Promise<PauseState | null>;
}

const defaultConversationPauseDeps: ConversationPauseDeps = {
  now: Date.now,
  fetchState: fetchPauseState,
};

/**
 * Echo: o humano respondeu PELO app do WhatsApp → pausa a conversa no Receps
 * (que aplica o echoPauseMinutes do tenant) e no cache local.
 *
 * Escreve no cache local IMEDIATAMENTE pra Ana respeitar a pausa já na próxima
 * mensagem (sem esperar o TTL do GET). Se o POST falhar, a pausa local OTIMISTA
 * continua ativa, mas o erro é propagado: o webhook responde 5xx e a Meta pode
 * retransmitir até a pausa ficar durável no Receps.
 */
export async function pauseConversationByEcho(
  phoneNumberId: string,
  customerPhone: string,
  deps: EchoPauseDeps = defaultEchoPauseDeps
): Promise<void> {
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  // O write-through precisa acontecer ANTES do primeiro await. A Meta pode entregar
  // a resposta seguinte da cliente enquanto o POST ao Receps ainda está em voo;
  // esperar a rede aqui abriria uma janela de até REQUEST_TIMEOUT_MS pra IA falar.
  const startedAt = deps.now();
  writeConversationPauseToCache(
    phoneNumberId,
    canonicalPhone,
    startedAt + ECHO_LOCAL_FALLBACK_MS,
    startedAt
  );

  try {
    const pausedUntilMs = toMs(await deps.persistPause(phoneNumberId, canonicalPhone));
    if (pausedUntilMs !== null) {
      writeConversationPauseToCache(
        phoneNumberId,
        canonicalPhone,
        pausedUntilMs,
        deps.now()
      );
    }
  } catch (error) {
    capture(error, phoneNumberId, 'pause-conversation');
    throw error;
  }
}

/**
 * "Esta conversa está pausada AGORA?" — combina pausa GERAL (salão) + pausa da
 * conversa. Usa cache curto por conversa + write-through do echo.
 *
 * FAIL-OPEN legado: erro/timeout/404 continua `false`, EXCETO se o cache já
 * conhecia escalation.active=true ou o modo técnico global já tinha sido
 * observado como ON para um tenant não isento. Esses motivos permanecem fechados.
 */
export async function isConversationPaused(
  phoneNumberId: string,
  customerPhone: string,
  deps: ConversationPauseDeps = defaultConversationPauseDeps
): Promise<boolean> {
  const now = deps.now();
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  const key = cacheKey(phoneNumberId, canonicalPhone);
  const cached = pauseCache.get(key);
  const escalationWasActive = isEscalationKnownActive(
    phoneNumberId,
    customerPhone
  );
  const escalationNeedsRefresh = escalationCacheNeedsRefresh(
    phoneNumberId,
    customerPhone,
    now
  );

  // Escalada ativa é motivo independente de pausa. Enquanto o snapshot ainda
  // está fresco, não há motivo para rede. Quando vence, reconsulta; se o Receps
  // cair, o snapshot ativo anterior continua fail-closed.
  if (escalationWasActive && !escalationNeedsRefresh) {
    return true;
  }

  // 1) Cache fresco (inclui o write-through imediato do echo) → decide sem rede.
  if (cached && cached.expiresAt > now && !escalationNeedsRefresh) {
    return entryIsPaused(cached, now);
  }

  // 2) Cache vencido mas ainda indicando pausa no futuro → respeita (não deixa o
  //    TTL do GET "despausar" antes da hora).
  if (cached && entryIsPaused(cached, now)) {
    return true;
  }

  // 3) Busca o estado fresco no Receps.
  const state = await deps.fetchState(phoneNumberId, canonicalPhone);
  if (!state) {
    return (
      escalationWasActive ||
      shouldFailClosedForTechnicalMaintenance({
        phoneNumberId,
        tenantSlug: peekCachedTenantSlug(phoneNumberId),
      })
    );
  }

  observeTechnicalMaintenance({
    phoneNumberId,
    snapshot: parseTechnicalMaintenanceSnapshot(state.technicalMaintenance),
    tenantSlug: peekCachedTenantSlug(phoneNumberId),
  });

  const escalation = updateEscalationFromPauseState(
    phoneNumberId,
    customerPhone,
    state.escalation,
    now
  );

  pauseCache.set(key, {
    globalUntilMs: toMs(state.globalPausedUntil),
    conversationUntilMs: toMs(state.conversationPausedUntil),
    scheduleUntilMs: toMs(state.schedulePausedUntil),
    expiresAt: now + PAUSE_STATE_TTL_MS,
  });
  return isPausedFromState({ ...state, escalation }, now);
}

/**
 * Exceção fechada de transporte: permite somente a confirmação da ação de
 * escalada que acabou de criar a própria pausa. Campo aditivo ausente
 * (`escalation === undefined`) preserva o snapshot local deste único ack.
 * Qualquer valor presente passa por validação estrita do snapshot: null,
 * primitivo, array ou objeto com active/questionId/version inválidos ou
 * incompletos falha fechado. `active:true` + mesmo questionId atualiza e
 * libera somente a própria escalada; ID ausente/divergente falha fechado;
 * `active:false` completo atualiza o cache e aplica a decisão ordinária das
 * demais pausas. Qualquer outra pausa ou fetch nulo continua fail-closed.
 */
export async function isConversationPausedForEscalationAcknowledgement(
  phoneNumberId: string,
  customerPhone: string,
  questionId: string,
  deps: ConversationPauseDeps = defaultConversationPauseDeps
): Promise<boolean> {
  const expectedQuestionId = questionId.trim();
  if (!expectedQuestionId) return true;
  const local = getEscalationSnapshot(phoneNumberId, customerPhone);
  if (!local?.active || local.questionId !== expectedQuestionId) return true;

  const now = deps.now();
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  const state = await deps.fetchState(phoneNumberId, canonicalPhone);
  if (!state) return true;

  observeTechnicalMaintenance({
    phoneNumberId,
    snapshot: parseTechnicalMaintenanceSnapshot(state.technicalMaintenance),
    tenantSlug: peekCachedTenantSlug(phoneNumberId),
  });
  if (
    shouldFailClosedForTechnicalMaintenance({
      phoneNumberId,
      tenantSlug: peekCachedTenantSlug(phoneNumberId),
    })
  ) {
    return true;
  }

  const rawEscalation: unknown = (state as { escalation?: unknown }).escalation;
  if (rawEscalation === undefined) {
    // Campo aditivo ausente no rollout: preserva o snapshot local deste único ack.
    return isPausedFromState(
      {
        ...state,
        escalation: { active: false, questionId: null, version: local.version },
      },
      now
    );
  }

  const snapshot = parseStrictEscalationSnapshot(rawEscalation);
  if (!snapshot) {
    return true;
  }

  updateEscalationFromPauseState(
    phoneNumberId,
    canonicalPhone,
    rawEscalation,
    now
  );
  if (snapshot.active) {
    if (snapshot.questionId !== expectedQuestionId) {
      return true;
    }
    return isPausedFromState(
      {
        ...state,
        escalation: {
          active: false,
          questionId: null,
          version: snapshot.version,
        },
      },
      now
    );
  }

  return isPausedFromState({ ...state, escalation: snapshot }, now);
}

/** Seam de teste: limpa o cache entre casos do smoke. */
export function __resetPauseCacheForTest(): void {
  pauseCache.clear();
  __resetTechnicalMaintenanceCacheForTest();
}
