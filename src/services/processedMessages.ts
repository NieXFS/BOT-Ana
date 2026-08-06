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
  await pool.query(`
    ALTER TABLE processed_messages
    ADD COLUMN IF NOT EXISTS conversation_key text
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS processed_messages_conversation_key_idx
    ON processed_messages (conversation_key)
    WHERE conversation_key IS NOT NULL
  `);
}

/**
 * Marca a mensagem como processada de forma atômica.
 * @returns `true` se for a PRIMEIRA vez (deve processar); `false` se já existia
 *          (retransmissão → noop). Atômico via ON CONFLICT, seguro sob corrida.
 */
export async function markMessageProcessed(
  messageId: string,
  phoneNumberId: string,
  conversationKey?: string
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO processed_messages (
       message_id, phone_number_id, conversation_key
     ) VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, phoneNumberId, conversationKey ?? null]
  );
  return result.rowCount === 1;
}

/**
 * Desfaz markMessageProcessed (apaga o registro do id). Usado SÓ no caminho do
 * ECHO (§8.2): se a GRAVAÇÃO do echo no histórico falhar DEPOIS de marcar o id, a
 * marca é desfeita pra a retransmissão da Meta poder reprocessar e gravar — a
 * captura do echo é o objetivo da feature, então não pode sumir num blip de DB.
 * Não cria janela de gravação dupla: só desfaz quando a gravação FALHOU (no
 * sucesso a marca fica). (No caminho do INBOUND a marca é mantida na falha, de
 * propósito — não re-processa; ver webhookServer.)
 */
export async function unmarkMessageProcessed(messageId: string): Promise<void> {
  await pool.query(`DELETE FROM processed_messages WHERE message_id = $1`, [messageId]);
}

/**
 * Limpa registros após a retenção máxima da Onda 2. Manter 90 dias evita que um
 * replay tardio perca o dedup enquanto history.message_id/outbox ainda existem.
 */
export async function cleanupOldProcessedMessages(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '90 days'`
  );
  return result.rowCount ?? 0;
}
