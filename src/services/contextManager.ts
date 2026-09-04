import { Pool } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { customerPhoneVariants } from './conversationActivity';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind } from '../observability/safeRuntime';
import { canonicalConversationKey } from './conversationOrder';
import { panelVisibleConversationContent } from './humanConversationContext';
export {
  HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE,
  HUMAN_ECHO_PREFIX,
} from './humanConversationContext';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface HistoryReadDeps {
  query: <T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ) => Promise<{ rows: T[] }>;
}

interface PersistedInboundExecutionContext {
  messageIds: readonly string[];
}

const persistedInboundContext =
  new AsyncLocalStorage<PersistedInboundExecutionContext>();

/**
 * O intake da Onda 2 já gravou cada inbound antes da pausa/brain. Durante o
 * turno, o brain legado ainda chama addMessage(user); este contexto transforma
 * somente essa gravação redundante em noop, sem alterar entry points externos.
 */
export async function withPersistedInboundContext<T>(
  messageIds: readonly string[],
  work: () => Promise<T>
): Promise<T> {
  return persistedInboundContext.run({ messageIds: [...messageIds] }, work);
}

export function currentSourceInboundMessageId(): string | null {
  const ids = persistedInboundContext.getStore()?.messageIds ?? [];
  return ids.length > 0 ? ids[ids.length - 1] ?? null : null;
}

export function currentSourceInboundMessageIds(): string[] {
  return [...(persistedInboundContext.getStore()?.messageIds ?? [])];
}

/**
 * Marcador de mensagem enviada por um ATENDENTE HUMANO (recepção, via
 * smb_message_echoes). Gravado no início do `content` (role `assistant`) quando a
 * Ana "escuta enquanto pausada" (§8.2/INV-10), pra distinguir do que ela mesma
 * respondeu. Fonte ÚNICA — consumido pelo echoHandler (prefixa) e pelo
 * brainService (instrui o modelo a tratar como contexto, não como fala dele).
 */
const MAX_MESSAGES = 30;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada para persistir o histórico da Ana.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'receps-ia',
  max: 10,
  idleTimeoutMillis: 30_000,
});

const defaultHistoryReadDeps: HistoryReadDeps = {
  query: async <T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ) => {
    const result = await pool.query<T>(sql, [...params]);
    return { rows: result.rows };
  },
};

/**
 * O `pg` emite `'error'` no Pool quando um client morre fora de uma query —
 * tipicamente quando o compute do Neon suspende (5 min de ociosidade) e derruba
 * as conexões. Sem este listener o Node trata o evento como exceção não
 * capturada e MATA o processo inteiro: foi o que aconteceu em 02/08 00:07 UTC
 * (ANA-6), levando o bot junto. O pool já descarta o client quebrado sozinho;
 * aqui só registramos e seguimos vivos.
 */
pool.on('error', (err) => {
  console.error(
    `[pg-pool] client ocioso derrubado | error=${runtimeErrorKind(err)}`
  );
  try {
    Sentry.captureException(new Error('postgres idle pool client failed'), {
      level: 'warning',
      tags: {
        service: 'pg-pool',
        operation: 'idle-client',
        error_kind: runtimeErrorKind(err),
      },
    });
  } catch {
    // Um handler de erro que lança é exatamente o bug que este listener existe
    // para matar. Observabilidade é secundária; continuar vivo é o ponto.
  }
});

export function buildConversationKey(phoneNumberId: string, phone: string): string {
  return canonicalConversationKey(phoneNumberId, phone);
}

export async function addMessage(
  conversationKey: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  if (role === 'user' && persistedInboundContext.getStore()) {
    return;
  }
  await pool.query(
    `INSERT INTO ana_conversation_history ("conversationKey", "role", "content")
     VALUES ($1, $2, $3)`,
    [conversationKey, role, content]
  );

  pool
    .query(
      `DELETE FROM ana_conversation_history
       WHERE "conversationKey" = $1
       AND (
         message_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM inbound_event_outbox pending
           WHERE pending.message_id = ana_conversation_history.message_id
             AND pending.delivered_at IS NULL
         )
       )
       AND "id" NOT IN (
         SELECT "id" FROM ana_conversation_history
         WHERE "conversationKey" = $1
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT $2
       )`,
      [conversationKey, MAX_MESSAGES]
    )
    .catch((err) =>
      console.error(
        `Erro ao trimar histórico | error=${runtimeErrorKind(err)}`
      )
    );
}

export async function getHistory(
  conversationKey: string,
  deps: HistoryReadDeps = defaultHistoryReadDeps
): Promise<Message[]> {
  const snapshotMessageIds = persistedInboundContext.getStore()?.messageIds ?? [];
  let snapshotMaxId: string | null = null;
  if (snapshotMessageIds.length > 0) {
    const snapshot = await deps.query<{
      max_id: string | null;
      found_ids: string[] | null;
    }>(
      `SELECT max("id")::text AS max_id,
              array_agg(DISTINCT message_id) FILTER (WHERE message_id IS NOT NULL) AS found_ids
       FROM ana_conversation_history
       WHERE "conversationKey" = $1
         AND message_id = ANY($2::text[])`,
      [conversationKey, snapshotMessageIds]
    );
    snapshotMaxId = snapshot.rows[0]?.max_id ?? null;
    const foundIds = new Set(snapshot.rows[0]?.found_ids ?? []);
    const expectedIds = new Set(snapshotMessageIds);
    if (
      !snapshotMaxId ||
      foundIds.size !== expectedIds.size ||
      [...expectedIds].some((messageId) => !foundIds.has(messageId))
    ) {
      throw new Error(
        'Lote de inbound persistido ficou incompleto ao fixar o snapshot do histórico.'
      );
    }
  }

  const result = await deps.query<{
      role: string;
      content: string;
      message_id: string | null;
    }>(
    `SELECT "role", "content", message_id
     FROM (
       SELECT "id", "role", "content", "createdAt", message_id
       FROM ana_conversation_history
       WHERE "conversationKey" = $1
         AND ($3::bigint IS NULL OR "id" <= $3::bigint)
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $2
     ) recent
     ORDER BY "createdAt" ASC, "id" ASC`,
    [conversationKey, MAX_MESSAGES, snapshotMaxId]
  );

  // Cada message.id é uma linha física. Para o brain, inbounds atômicas
  // consecutivas ainda sem resposta equivalem ao texto consolidado do debounce
  // legado, mantendo o comportamento conversacional com a flag de escalada OFF.
  const logical: Array<{ message: Message; atomicInbound: boolean }> = [];
  for (const row of result.rows) {
    const role = row.role === 'assistant' ? 'assistant' : 'user';
    const atomicInbound = role === 'user' && row.message_id !== null;
    const previous = logical[logical.length - 1];
    if (
      atomicInbound &&
      previous?.atomicInbound &&
      previous.message.role === 'user'
    ) {
      previous.message.content = `${previous.message.content} ${row.content}`;
      continue;
    }
    logical.push({
      message: { role, content: row.content },
      atomicInbound,
    });
  }
  return logical.map((entry) => entry.message);
}

export interface PersistedInboundBatchEntry {
  messageId: string;
  content: string;
}

/**
 * Reconstrói somente o lote atômico nomeado pelo sucessor v2. Os ids já vivem
 * no history durável; o registro do sucessor guarda apenas a referência e evita
 * duplicar o texto/PII em outra tabela.
 */
export async function getPersistedInboundBatch(
  conversationKey: string,
  messageIds: readonly string[]
): Promise<PersistedInboundBatchEntry[]> {
  const uniqueIds = [...new Set(messageIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const result = await pool.query<{
    message_id: string;
    content: string;
  }>(
    `SELECT message_id, "content"
     FROM ana_conversation_history
     WHERE "conversationKey" = $1
       AND "role" = 'user'
       AND message_id = ANY($2::text[])
     ORDER BY "createdAt" ASC, "id" ASC`,
    [conversationKey, uniqueIds]
  );
  return result.rows.map((row) => ({
    messageId: row.message_id,
    content: row.content,
  }));
}

export interface LastMessageMeta {
  role: 'user' | 'assistant';
  /** ms epoch da última atividade da conversa = max(createdAt). */
  lastActivityAtMs: number;
}

function conversationLookupKeys(
  phoneNumberId: string,
  customerPhone: string
): string[] {
  const prefix = phoneNumberId.trim();
  return customerPhoneVariants(customerPhone).map(
    (variant) => `${prefix}:${variant}`
  );
}

/**
 * Última atividade da conversa (§8.1): papel da ÚLTIMA mensagem + max(createdAt),
 * em UMA query — a linha mais recente por createdAt JÁ é o max. Tolerante ao
 * formato do telefone (variantes cru/só-dígitos — ver customerPhoneVariants).
 * Devolve null se a conversa não tem histórico.
 */
export async function getLastMessageMeta(
  phoneNumberId: string,
  customerPhone: string
): Promise<LastMessageMeta | null> {
  const keys = conversationLookupKeys(phoneNumberId, customerPhone);
  if (keys.length === 0) return null;

  const result = await pool.query<{ role: string; createdAt: Date }>(
    `SELECT "role", "createdAt"
     FROM ana_conversation_history
     WHERE "conversationKey" = ANY($1)
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 1`,
    [keys]
  );

  const row = result.rows[0];
  if (!row) return null;

  const ms =
    row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : Date.parse(String(row.createdAt));
  if (Number.isNaN(ms)) return null;

  return {
    role: row.role === 'assistant' ? 'assistant' : 'user',
    lastActivityAtMs: ms,
  };
}

/**
 * Timestamp (ms epoch) da última mensagem RECEBIDA do cliente (role `user`), ou
 * null se ele nunca escreveu. É a âncora da janela de serviço de 24h do
 * WhatsApp — que conta a partir do último INBOUND, não da última mensagem da
 * conversa (um follow-up nosso não reabre janela nenhuma). Por isso NÃO dá pra
 * reusar `getLastMessageMeta`, que devolve a última mensagem de qualquer papel.
 * Tolerante ao formato do telefone (ver customerPhoneVariants).
 */
export async function getLastInboundAtMs(
  phoneNumberId: string,
  customerPhone: string
): Promise<number | null> {
  const keys = conversationLookupKeys(phoneNumberId, customerPhone);
  if (keys.length === 0) return null;

  const result = await pool.query<{ createdAt: Date }>(
    `SELECT "createdAt"
     FROM ana_conversation_history
     WHERE "conversationKey" = ANY($1) AND "role" = 'user'
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 1`,
    [keys]
  );

  const row = result.rows[0];
  if (!row) return null;

  const ms =
    row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : Date.parse(String(row.createdAt));
  return Number.isNaN(ms) ? null : ms;
}

export async function hasConversation(conversationKey: string): Promise<boolean> {
  const currentMessageIds = persistedInboundContext.getStore()?.messageIds ?? [];
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ana_conversation_history
       WHERE "conversationKey" = $1
       AND (
         cardinality($2::text[]) = 0
         OR message_id IS NULL
         OR NOT (message_id = ANY($2::text[]))
       )
       LIMIT 1
     ) AS "exists"`,
    [conversationKey, currentMessageIds]
  );

  return result.rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// Leitores READ-ONLY para o painel interno do Receps (histórico de conversas da
// Ana em /painel-receps). NÃO tocam no caminho de escrita nem no trim — apenas
// LEEM a janela rolante de MAX_MESSAGES por conversa que a Ana já mantém.
// Consumidos pelos endpoints GET /internal/conversations e
// /internal/conversation-messages (webhookServer). NUNCA logam PII.
// ---------------------------------------------------------------------------

/**
 * Executor de query INJETÁVEL — permite ao smoke exercitar o mapeamento de shape
 * com um pool falso, sem DB real. Default = o `pool` do módulo. Só as leituras
 * novas usam isso; o caminho de escrita segue no `pool` direto.
 */
export type QueryFn = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

const defaultQueryFn: QueryFn = (text, params) => pool.query(text, params);

export const CONVERSATIONS_DEFAULT_LIMIT = 20;
export const CONVERSATIONS_MAX_LIMIT = 50;

/** Clampa o `limit` da listagem: default 20, teto 50, piso 1. PURO/testável. */
export function clampConversationsLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return CONVERSATIONS_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), CONVERSATIONS_MAX_LIMIT);
}

/** Clampa o `offset` da listagem: default/piso 0. PURO/testável. */
export function clampConversationsOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}

/**
 * Escapa os metacaracteres de LIKE (`\`, `%`, `_`) para usar o valor como
 * prefixo LITERAL. Casado com `ESCAPE '\'` na query. O `\` é escapado junto,
 * num único passo, para não reprocessar as barras já inseridas. PURO/testável.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Divide o `conversationKey` (`${phoneNumberId}:${phone}`) no PRIMEIRO `:`. Todo
 * o sufixo após esse `:` é o telefone (um telefone jamais contém `:`, mas manter
 * o resto é o comportamento seguro). Sem `:` → phone vazio. Inverso de
 * `buildConversationKey`. PURO/testável.
 */
export function parseConversationKey(key: string): {
  phoneNumberId: string;
  customerPhone: string;
} {
  const idx = key.indexOf(':');
  if (idx === -1) {
    return { phoneNumberId: key, customerPhone: '' };
  }
  return {
    phoneNumberId: key.slice(0, idx),
    customerPhone: key.slice(idx + 1),
  };
}

/** Trunca o preview da última mensagem a `maxLen` chars (default 120). PURO. */
export function truncatePreview(content: string, maxLen = 120): string {
  return content.length <= maxLen ? content : content.slice(0, maxLen);
}

export interface ConversationSummary {
  /** Sufixo do conversationKey = o telefone cru gravado pela Ana. */
  customerPhone: string;
  /** ISO da última atividade da conversa (max createdAt). */
  lastActivityAt: string;
  /** Papel da última mensagem. `assistant` inclui echo do humano ("[atendente] "). */
  lastRole: 'user' | 'assistant';
  /** Nº de mensagens na janela (≤ MAX_MESSAGES — efeito do trim; 30 = janela cheia). */
  messageCount: number;
  /** `content` da última mensagem truncado a 120 chars. */
  lastPreview: string;
}

export interface ListConversationsResult {
  conversations: ConversationSummary[];
  total: number;
}

interface ConversationAggRow {
  conversationKey: string;
  lastActivityAt: Date | string;
  lastRole: string;
  lastContent: string | null;
  messageCount: number | string;
}

/** Converte timestamp do pg (Date ou string) em ISO. createdAt é NOT NULL. */
function toIsoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Lista as conversas de um phoneNumberId, agregando `ana_conversation_history`
 * por `conversationKey` com prefixo `${phoneNumberId}:` (LIKE de prefixo com
 * escape), ordenando por última atividade DESC. Paginação com clamp (limit ≤ 50).
 * A tabela é pequena por construção (trim de MAX_MESSAGES por conversa), então o
 * LIKE de prefixo é aceitável sem índice novo. READ-ONLY.
 */
export async function listConversations(
  phoneNumberId: string,
  rawLimit: number | undefined,
  rawOffset: number | undefined,
  queryFn: QueryFn = defaultQueryFn
): Promise<ListConversationsResult> {
  const limit = clampConversationsLimit(rawLimit);
  const offset = clampConversationsOffset(rawOffset);
  const likePattern = escapeLikePattern(`${phoneNumberId}:`) + '%';

  const [pageResult, totalResult] = await Promise.all([
    queryFn(
      `WITH matching AS (
         SELECT "conversationKey", "role", "content", "createdAt", "id"
         FROM ana_conversation_history
         WHERE "conversationKey" LIKE $1 ESCAPE '\\'
       ),
       agg AS (
         SELECT
           "conversationKey",
           COUNT(*)::int AS "messageCount",
           MAX("createdAt") AS "lastActivityAt"
         FROM matching
         GROUP BY "conversationKey"
       ),
       last_msg AS (
         SELECT DISTINCT ON ("conversationKey")
           "conversationKey", "role", "content"
         FROM matching
         ORDER BY "conversationKey", "createdAt" DESC, "id" DESC
       )
       SELECT
         a."conversationKey" AS "conversationKey",
         a."messageCount"    AS "messageCount",
         a."lastActivityAt"  AS "lastActivityAt",
         l."role"            AS "lastRole",
         l."content"         AS "lastContent"
       FROM agg a
       JOIN last_msg l USING ("conversationKey")
       ORDER BY a."lastActivityAt" DESC
       LIMIT $2 OFFSET $3`,
      [likePattern, limit, offset]
    ),
    queryFn(
      `SELECT COUNT(DISTINCT "conversationKey")::int AS "total"
       FROM ana_conversation_history
       WHERE "conversationKey" LIKE $1 ESCAPE '\\'`,
      [likePattern]
    ),
  ]);

  const conversations: ConversationSummary[] = (pageResult.rows as ConversationAggRow[]).map(
    (row) => ({
      customerPhone: parseConversationKey(row.conversationKey).customerPhone,
      lastActivityAt: toIsoString(row.lastActivityAt),
      lastRole: row.lastRole === 'assistant' ? 'assistant' : 'user',
      messageCount: Number(row.messageCount),
      lastPreview: truncatePreview(
        panelVisibleConversationContent(row.lastRole, row.lastContent ?? '')
      ),
    })
  );

  const totalRows = totalResult.rows as { total: number | string }[];
  const total = totalRows[0] ? Number(totalRows[0].total) : 0;

  return { conversations, total };
}

export interface TimestampedMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO de createdAt. */
  createdAt: string;
}

/**
 * Histórico da conversa (janela de MAX_MESSAGES) COM timestamps, em ordem ASC
 * (mais antiga primeiro). Espelha `getHistory`, mas devolve `createdAt` — o
 * `getHistory` não devolve (os consumidores do brain não precisam), e por isso
 * NÃO é alterado. Tolerante ao formato do telefone (variantes cru/só-dígitos,
 * mesmo padrão do `getLastMessageMeta`). Conversa inexistente → []. READ-ONLY.
 */
export async function getHistoryWithTimestamps(
  phoneNumberId: string,
  customerPhone: string,
  queryFn: QueryFn = defaultQueryFn
): Promise<TimestampedMessage[]> {
  const keys = conversationLookupKeys(phoneNumberId, customerPhone);
  if (keys.length === 0) return [];

  const result = await queryFn(
    `SELECT "role", "content", "createdAt"
     FROM (
       SELECT "id", "role", "content", "createdAt"
       FROM ana_conversation_history
       WHERE "conversationKey" = ANY($1)
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $2
     ) recent
     ORDER BY "createdAt" ASC, "id" ASC`,
    [keys, MAX_MESSAGES]
  );

  return (
    result.rows as { role: string; content: string; createdAt: Date | string }[]
  ).map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: toIsoString(row.createdAt),
  }));
}
