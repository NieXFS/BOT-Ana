import { Pool } from 'pg';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

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
