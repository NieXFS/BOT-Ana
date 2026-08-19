import { customerPhoneVariants } from './conversationActivity';
import { clearEscalationCacheForConversation } from './escalationCache';
import {
  canonicalConversationKey,
  withConversationLock,
} from './conversationOrder';

export interface PurgeConversationResult {
  history: number;
  outbox: number;
  processedMessages: number;
  replyDedup: number;
  sequence: number;
}

export async function purgeConversationData(
  phoneNumberId: string,
  customerPhone: string
): Promise<PurgeConversationResult> {
  const keys = new Set<string>([
    canonicalConversationKey(phoneNumberId, customerPhone),
    ...customerPhoneVariants(customerPhone).map(
      (variant) => `${phoneNumberId}:${variant}`
    ),
  ]);

  const result = await withConversationLock(
    phoneNumberId,
    customerPhone,
    async (client) => {
      await client.query('BEGIN');
      try {
        // Apaga processed primeiro, enquanto history/outbox ainda permitem
        // correlacionar message_id sem varrer ou atingir outra conversa.
        const processed = await client.query(
          `DELETE FROM processed_messages
           WHERE conversation_key = ANY($1)
              OR message_id IN (
                SELECT message_id FROM inbound_event_outbox
                WHERE conversation_key = ANY($1)
                UNION
                SELECT message_id FROM ana_conversation_history
                WHERE "conversationKey" = ANY($1) AND message_id IS NOT NULL
              )`,
          [[...keys]]
        );
        const replies = await client.query(
          `DELETE FROM sent_question_replies
           WHERE conversation_key = ANY($1)`,
          [[...keys]]
        );
        // Snapshot human_history_* vive nesta linha; o DELETE cobre o reparo.
        const outbox = await client.query(
          `DELETE FROM inbound_event_outbox
           WHERE conversation_key = ANY($1)`,
          [[...keys]]
        );
        const history = await client.query(
          `DELETE FROM ana_conversation_history
           WHERE "conversationKey" = ANY($1)`,
          [[...keys]]
        );
        const sequence = await client.query(
          `DELETE FROM ana_conversation_seq
           WHERE conversation_key = ANY($1)`,
          [[...keys]]
        );
        await client.query('COMMIT');
        return {
          history: history.rowCount ?? 0,
          outbox: outbox.rowCount ?? 0,
          processedMessages: processed.rowCount ?? 0,
          replyDedup: replies.rowCount ?? 0,
          sequence: sequence.rowCount ?? 0,
        };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserva a falha original.
        }
        throw error;
      }
    }
  );
  clearEscalationCacheForConversation(phoneNumberId, customerPhone);
  return result;
}
