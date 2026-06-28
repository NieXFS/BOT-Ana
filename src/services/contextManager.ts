import { Pool } from 'pg';
import { customerPhoneVariants } from './conversationActivity';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Marcador de mensagem enviada por um ATENDENTE HUMANO (recepção, via
 * smb_message_echoes). Gravado no início do `content` (role `assistant`) quando a
 * Ana "escuta enquanto pausada" (§8.2/INV-10), pra distinguir do que ela mesma
 * respondeu. Fonte ÚNICA — consumido pelo echoHandler (prefixa) e pelo
 * brainService (instrui o modelo a tratar como contexto, não como fala dele).
 */
export const HUMAN_ECHO_PREFIX = '[atendente] ';

const MAX_MESSAGES = 30;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada para persistir o histórico da Ana.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export function buildConversationKey(phoneNumberId: string, phone: string): string {
  return `${phoneNumberId}:${phone}`;
}

export async function addMessage(
  conversationKey: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await pool.query(
    `INSERT INTO ana_conversation_history ("conversationKey", "role", "content")
     VALUES ($1, $2, $3)`,
    [conversationKey, role, content]
  );

  pool
    .query(
      `DELETE FROM ana_conversation_history
       WHERE "conversationKey" = $1
       AND "id" NOT IN (
         SELECT "id" FROM ana_conversation_history
         WHERE "conversationKey" = $1
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT $2
       )`,
      [conversationKey, MAX_MESSAGES]
    )
    .catch((err) => console.error('Erro ao trimar histórico:', err));
}

export async function getHistory(conversationKey: string): Promise<Message[]> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT "role", "content"
     FROM (
       SELECT "id", "role", "content", "createdAt"
       FROM ana_conversation_history
       WHERE "conversationKey" = $1
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $2
     ) recent
     ORDER BY "createdAt" ASC, "id" ASC`,
    [conversationKey, MAX_MESSAGES]
  );

  return result.rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));
}

export interface LastMessageMeta {
  role: 'user' | 'assistant';
  /** ms epoch da última atividade da conversa = max(createdAt). */
  lastActivityAtMs: number;
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
  const keys = customerPhoneVariants(customerPhone).map((variant) =>
    buildConversationKey(phoneNumberId, variant)
  );
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

export async function hasConversation(conversationKey: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ana_conversation_history
       WHERE "conversationKey" = $1
       LIMIT 1
     ) AS "exists"`,
    [conversationKey]
  );

  return result.rows[0]?.exists ?? false;
}
