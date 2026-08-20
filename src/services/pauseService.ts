import axios from 'axios';
import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
} from '../observability/safeRuntime';
import { ERP_API_TOKEN } from '../erpApiToken';
import {
  decideEscalationAcknowledgementPause,
  isActiveLocalEchoLatch,
  isPausedFromState,
  parseStrictEscalationPause,
  type LocalEchoLatch,
  type PauseState,
} from './pauseDecision';
import {
  escalationCacheNeedsRefresh,
  getEscalationSnapshot,
  isEscalationKnownActive,
  updateEscalationCache,
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

/** Latch local tipado ECHO: o GET do ERP não o apaga; só o untilMs o encerra. */
const echoLatchByConversation = new Map<string, LocalEchoLatch>();

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

function writeEchoLatch(
  phoneNumberId: string,
  customerPhone: string,
  untilMs: number
): void {
  echoLatchByConversation.set(cacheKey(phoneNumberId, customerPhone), {
    source: 'ECHO',
    untilMs,
  });
}

/** Latch local ECHO ainda ativo nesta conversa, se houver. */
export function peekLocalEchoLatch(
  phoneNumberId: string,
  customerPhone: string,
  nowMs: number = Date.now()
): LocalEchoLatch | null {
  const latch = echoLatchByConversation.get(
    cacheKey(phoneNumberId, canonicalCustomerPhone(customerPhone))
  );
  return isActiveLocalEchoLatch(latch, nowMs) && latch
    ? { source: 'ECHO', untilMs: latch.untilMs }
    : null;
}

/**
 * Após finalize(RESUME_ANA/PROCEED): apaga só o latch ECHO local e invalida o
 * cache ordinário da conversa (força o próximo GET). Não toca manutenção
 * técnica, escalação, pausa global nem agenda — esses motivos continuam
 * soberanos na checagem seguinte.
 */
export function releaseLocalEchoPauseAfterAnaResume(
  phoneNumberId: string,
  customerPhone: string
): void {
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  const key = cacheKey(phoneNumberId, canonicalPhone);
  echoLatchByConversation.delete(key);
  const existing = pauseCache.get(key);
  if (!existing) return;
  pauseCache.set(key, {
    globalUntilMs: existing.globalUntilMs,
    conversationUntilMs: null,
    scheduleUntilMs: existing.scheduleUntilMs,
    expiresAt: 0,
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
      escalationPause: data?.escalationPause,
      humanPause: data?.humanPause,
      technicalMaintenance:
        parseTechnicalMaintenanceSnapshot(data?.technicalMaintenance) ??
        undefined,
    };
  } catch (error) {
    // FAIL-OPEN legado quando não há evidência positiva anterior: erro/timeout/
    // 404 vira null; o caller preserva pausas positivas já observadas.
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
  const localUntilMs = startedAt + ECHO_LOCAL_FALLBACK_MS;
  writeConversationPauseToCache(
    phoneNumberId,
    canonicalPhone,
    localUntilMs,
    startedAt
  );
  writeEchoLatch(phoneNumberId, canonicalPhone, localUntilMs);

  try {
    const pausedUntilMs = toMs(await deps.persistPause(phoneNumberId, canonicalPhone));
    if (pausedUntilMs !== null) {
      writeConversationPauseToCache(
        phoneNumberId,
        canonicalPhone,
        pausedUntilMs,
        deps.now()
      );
      writeEchoLatch(phoneNumberId, canonicalPhone, pausedUntilMs);
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
 * FAIL-OPEN legado: erro/timeout/404 continua `false` quando não há evidência
 * positiva anterior. Uma pausa ordinária ainda futura no cache vencido, uma
 * escalation.active conhecida ou o modo técnico global já observado como ON
 * permanecem fechados até uma resposta autoritativa válida.
 */
export async function isConversationPaused(
  phoneNumberId: string,
  customerPhone: string,
  deps: ConversationPauseDeps = defaultConversationPauseDeps
): Promise<boolean> {
  const now = deps.now();
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  const key = cacheKey(phoneNumberId, canonicalPhone);
  if (isActiveLocalEchoLatch(echoLatchByConversation.get(key), now)) {
    return true;
  }
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

  // 1) Cache fresco (inclui o write-through imediato do echo) e escalada fresca
  //    → decide sem rede. A escalada ativa é uma autoridade independente da
  //    pausa ordinária, mas um cache ordinário vencido ainda obriga releitura.
  if (cached && cached.expiresAt > now && !escalationNeedsRefresh) {
    return escalationWasActive || entryIsPaused(cached, now);
  }

  // 2) Cache ordinário OU de escalada vencido → busca o estado fresco no
  //    Receps. Um `pausedUntil` futuro é apenas a última evidência conhecida;
  //    depois do TTL o ERP pode tê-lo encerrado antecipadamente (por exemplo,
  //    pelo painel). Nunca deixe o relógio local transformar essa evidência em
  //    autoridade até o fim do carimbo.
  let state: PauseState | null;
  try {
    state = await deps.fetchState(phoneNumberId, canonicalPhone);
  } catch (error) {
    // A dependency seam may throw even though the production adapter converts
    // transport failures to null. Keep the ordinary lookup fail-closed when
    // there is prior positive evidence, without writing an inactive snapshot.
    capture(error, phoneNumberId, 'fetch-pause-state');
    state = null;
  }
  if (!state) {
    // Falha/nulo não é uma despausa. Preserve qualquer pausa ordinária ainda
    // positiva, além das autoridades sticky já conhecidas. Não escreva um
    // snapshot inativo: a próxima chamada deve tentar o GET novamente.
    return (
      Boolean(cached && entryIsPaused(cached, now)) ||
      escalationWasActive ||
      shouldFailClosedForTechnicalMaintenance({
        phoneNumberId,
        tenantSlug: peekCachedTenantSlug(phoneNumberId),
      })
    );
  }

  return isPausedFromState(
    rememberFetchedPauseState(phoneNumberId, canonicalPhone, state, now),
    now
  );
}

function rememberFetchedPauseState(
  phoneNumberId: string,
  canonicalPhone: string,
  state: PauseState,
  nowMs: number
): PauseState {
  observeTechnicalMaintenance({
    phoneNumberId,
    snapshot: parseTechnicalMaintenanceSnapshot(state.technicalMaintenance),
    tenantSlug: peekCachedTenantSlug(phoneNumberId),
  });
  const escalation = updateEscalationFromPauseState(
    phoneNumberId,
    canonicalPhone,
    state.escalation,
    nowMs
  );
  pauseCache.set(cacheKey(phoneNumberId, canonicalPhone), {
    globalUntilMs: toMs(state.globalPausedUntil),
    conversationUntilMs: toMs(state.conversationPausedUntil),
    scheduleUntilMs: toMs(state.schedulePausedUntil),
    expiresAt: nowMs + PAUSE_STATE_TTL_MS,
  });
  return { ...state, escalation };
}

/**
 * Leitura da fronteira final (advisory lock, imediatamente antes do POST).
 * Ignora o TTL ordinário de 25s e consulta `/pause-state` de novo: o overlay
 * ERP de tentativa `SENDING`/`CONFIRMATION_PENDING` (e o ECHO real pós-SENT)
 * pode nascer enquanto o brain trabalha. Falha do GET suprime o outbound
 * (fail-closed). O latch local ECHO continua soberano. Checagens anteriores
 * seguem em `isConversationPaused` (cache).
 */
export async function isConversationPausedFresh(
  phoneNumberId: string,
  customerPhone: string,
  deps: ConversationPauseDeps = defaultConversationPauseDeps
): Promise<boolean> {
  const now = deps.now();
  const canonicalPhone = canonicalCustomerPhone(customerPhone);
  const latchActive = isActiveLocalEchoLatch(
    echoLatchByConversation.get(cacheKey(phoneNumberId, canonicalPhone)),
    now
  );
  const state = await deps.fetchState(phoneNumberId, canonicalPhone);
  if (!state) return true;
  const remembered = rememberFetchedPauseState(
    phoneNumberId,
    canonicalPhone,
    state,
    now
  );
  return latchActive || isPausedFromState(remembered, now);
}

/**
 * O POST /questions/escalate cria AnaQuestion OPEN e, na mesma transação,
 * ConversationPause source=ESCALATION. O GET /pause-state agora publica
 * `escalationPause` e `humanPause` simultâneos. O ack só ignora a pausa
 * ESCALATION cujo questionId casa; `humanPause.active` bloqueia em qualquer
 * combinação. Latch local tipado ECHO (write-through do echo, preservado se
 * o POST ao ERP falhar) também bloqueia — o GET do ERP não o apaga. Sem os
 * dois campos tipados (ERP antigo no rollout) falha fechado. Fetch nulo,
 * shape inválido, ID divergente, global/schedule/técnico continuam fechados.
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
  const localEchoLatch = peekLocalEchoLatch(
    phoneNumberId,
    canonicalPhone,
    now
  );
  if (isActiveLocalEchoLatch(localEchoLatch, now)) return true;

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

  const paused = decideEscalationAcknowledgementPause({
    expectedQuestionId,
    local,
    state,
    nowMs: now,
    localEchoLatch,
  });

  const typedEscalation = parseStrictEscalationPause(state.escalationPause);
  if (typedEscalation) {
    updateEscalationCache(
      phoneNumberId,
      canonicalPhone,
      {
        active: typedEscalation.active,
        questionId: typedEscalation.questionId,
        version: typedEscalation.version,
      },
      now,
      true
    );
  }

  return paused;
}

/** Seam de teste: limpa o cache entre casos do smoke. */
export function __resetPauseCacheForTest(): void {
  pauseCache.clear();
  echoLatchByConversation.clear();
  __resetTechnicalMaintenanceCacheForTest();
}
