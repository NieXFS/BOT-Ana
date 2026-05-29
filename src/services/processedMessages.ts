import { pool } from './contextManager';

/**
 * Idempotência por message_id (a Meta retransmite webhooks em timeout/erro).
 * Sem isso, a mesma mensagem é processada 2x → resposta duplicada e até
 * agendamento duplicado. Usamos INSERT ... ON CONFLICT DO NOTHING: o primeiro
 * processa, os reenvios viram noop.
 */

/** Cria a tabela se não existir (chamado no boot). */
export async function ensureProcessedMessagesTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id      text PRIMARY KEY,
      phone_number_id text,
      processed_at    timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Marca a mensagem como processada de forma atômica.
 * @returns `true` se for a PRIMEIRA vez (deve processar); `false` se já existia
 *          (retransmissão → noop). Atômico via ON CONFLICT, seguro sob corrida.
 */
export async function markMessageProcessed(
  messageId: string,
  phoneNumberId: string
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO processed_messages (message_id, phone_number_id)
     VALUES ($1, $2)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, phoneNumberId]
  );
  return result.rowCount === 1;
}

/** Limpa registros com mais de 7 dias (chamado no boot — sem cron). */
export async function cleanupOldProcessedMessages(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '7 days'`
  );
  return result.rowCount ?? 0;
}
