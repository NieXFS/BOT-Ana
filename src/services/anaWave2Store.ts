import type { PoolClient } from 'pg';
import { pool } from './contextManager';
import {
  canonicalConversationKey,
  withConversationLock,
} from './conversationOrder';
import { truncateForW1 } from './inboundContent';

export const QUESTION_REPLY_STATUSES = [
  'in_flight',
  'sent',
  'failed_pre_send',
  'stale_source',
  'confirmation_pending',
] as const;

export type QuestionReplyStatus = (typeof QUESTION_REPLY_STATUSES)[number];

export const INBOUND_MESSAGE_TYPES = [
  'text',
  'button',
  'list',
  'audio',
  'other',
] as const;
export type InboundMessageType = (typeof INBOUND_MESSAGE_TYPES)[number];

export const INBOUND_CONTENT_STATUSES = [
  'pending',
  'final',
  'truncated',
  'transcription_failed',
  'no_text',
] as const;
export type InboundContentStatus = (typeof INBOUND_CONTENT_STATUSES)[number];

export interface PreparedInboundContent {
  content: string;
  contentStatus: InboundContentStatus;
  contentOriginalLength: number | null;
}

/** Defesa única para persistência inicial e finalização posterior de áudio. */
export function prepareInboundContentForW1(
  contentStatus: InboundContentStatus,
  content: string,
  contentOriginalLength: number | null = null
): PreparedInboundContent {
  if (contentStatus !== 'final' && contentStatus !== 'truncated') {
    return { content: '', contentStatus, contentOriginalLength: null };
  }
  if (!content.trim()) {
    return { content: '', contentStatus: 'no_text', contentOriginalLength: null };
  }
  const truncated = truncateForW1(content);
  const originalLength = Math.max(
    contentOriginalLength ?? 0,
    truncated.originalLength,
    contentStatus === 'truncated' ? truncated.text.length + 1 : 0
  );
  return {
    content: truncated.text,
    contentStatus:
      originalLength > truncated.text.length ? 'truncated' : 'final',
    contentOriginalLength: originalLength,
  };
}

/** DDL idempotente da Onda 2. Chamado no boot antes de aceitar tráfego. */
export async function ensureAnaWave2Tables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_conversation_history (
      "id" bigserial PRIMARY KEY,
      "conversationKey" text NOT NULL,
      "role" text NOT NULL,
      "content" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    ALTER TABLE ana_conversation_history
    ADD COLUMN IF NOT EXISTS message_id text
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ana_conversation_history_message_id_uq
    ON ana_conversation_history (message_id)
    WHERE message_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_conversation_history_created_at_idx
    ON ana_conversation_history ("createdAt")
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS processed_messages_processed_at_idx
    ON processed_messages (processed_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_conversation_seq (
      conversation_key        text PRIMARY KEY,
      last_sequence           bigint NOT NULL DEFAULT 0,
      last_inbound_message_id text,
      last_inbound_at         timestamptz,
      updated_at              timestamptz NOT NULL DEFAULT now()
    )
  `);

  // `message_type` fica no outbox porque o histórico guarda a representação
  // textual final, mas não consegue reconstruir com segurança se ela veio de
  // text/button/list/audio. O plaintext NÃO é duplicado: continua só no history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbound_event_outbox (
      message_id       text PRIMARY KEY,
      phone_number_id  text NOT NULL,
      conversation_key text NOT NULL,
      received_at      timestamptz NOT NULL,
      message_type     text NOT NULL DEFAULT 'other',
      content_status   text NOT NULL DEFAULT 'no_text',
      content_original_length integer,
      attempts         integer NOT NULL DEFAULT 0,
      next_retry_at    timestamptz NOT NULL DEFAULT now(),
      delivered_at     timestamptz,
      terminal_at      timestamptz,
      failure_code     text
    )
  `);
  await pool.query(`
    ALTER TABLE inbound_event_outbox
    ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'other'
  `);
  await pool.query(`
    ALTER TABLE inbound_event_outbox
    ADD COLUMN IF NOT EXISTS content_status text NOT NULL DEFAULT 'no_text'
  `);
  await pool.query(`
    ALTER TABLE inbound_event_outbox
    ADD COLUMN IF NOT EXISTS content_original_length integer
  `);
  await pool.query(`
    ALTER TABLE inbound_event_outbox
    ADD COLUMN IF NOT EXISTS terminal_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE inbound_event_outbox
    ADD COLUMN IF NOT EXISTS failure_code text
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS inbound_event_outbox_ready_v2_idx
    ON inbound_event_outbox (next_retry_at, received_at)
    WHERE delivered_at IS NULL
      AND terminal_at IS NULL
      AND content_status <> 'pending'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS inbound_event_outbox_conversation_idx
    ON inbound_event_outbox (conversation_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS inbound_event_outbox_received_at_idx
    ON inbound_event_outbox (received_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_question_replies (
      idempotency_key          text PRIMARY KEY,
      payload_hash             text NOT NULL,
      source_inbound_message_id text NOT NULL,
      phone_number_id          text NOT NULL,
      conversation_key         text NOT NULL,
      status                    text NOT NULL CHECK (
        status IN (
          'in_flight',
          'sent',
          'failed_pre_send',
          'stale_source',
          'confirmation_pending'
        )
      ),
      provider_message_id text UNIQUE,
      provider_status     text,
      provider_status_at  timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      failure_code        text
    )
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS provider_status text
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS provider_status_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS provider_failure_code text
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS provider_status_version bigint NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS callback_pending boolean NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS callback_attempts integer NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS callback_next_attempt_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS callback_ack_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS callback_failure_code text
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sent_question_replies_conversation_idx
    ON sent_question_replies (conversation_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sent_question_replies_created_at_idx
    ON sent_question_replies (created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sent_question_replies_callback_pending_idx
    ON sent_question_replies (callback_next_attempt_at, updated_at)
    WHERE callback_pending = true
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS human_history_payload text
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS human_history_accepted_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE sent_question_replies
    ADD COLUMN IF NOT EXISTS human_history_recorded_at timestamptz
  `);
  await pool.query(`
    DROP INDEX IF EXISTS sent_question_replies_human_history_repair_idx
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sent_question_replies_human_history_repair_idx
    ON sent_question_replies (updated_at)
    WHERE human_history_recorded_at IS NULL
      AND human_history_payload IS NOT NULL
  `);
}

export interface AtomicInboundInput {
  messageId: string;
  phoneNumberId: string;
  customerPhone: string;
  content: string;
  messageType: InboundMessageType;
  contentStatus: InboundContentStatus;
  contentOriginalLength?: number | null;
  receivedAt: Date;
}

export interface AtomicInboundResult {
  fresh: boolean;
  conversationKey: string;
  sequence: number | null;
}

export interface AtomicHumanEchoInput {
  messageId: string;
  phoneNumberId: string;
  conversationKey: string;
  content: string;
  receivedAt?: Date;
}

/**
 * Dedup e histórico do echo humano compartilham a MESMA transação. Se o
 * processo morrer entre as duas instruções, o PostgreSQL desfaz ambas; uma
 * retransmissão nunca encontra "processado" sem a fala correspondente. A linha
 * do histórico carrega o próprio message_id, reutilizando também o UNIQUE já
 * exigido para o intake.
 */
export async function persistHumanEchoAtomically(
  input: AtomicHumanEchoInput
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const processed = await client.query(
      `INSERT INTO processed_messages (
         message_id, phone_number_id, conversation_key
       ) VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [input.messageId, input.phoneNumberId, input.conversationKey]
    );
    if (processed.rowCount !== 1) {
      await client.query('COMMIT');
      return false;
    }

    await client.query(
      `INSERT INTO ana_conversation_history (
         "conversationKey", "role", "content", "createdAt", message_id
       ) VALUES ($1, 'assistant', $2, $3, $4)`,
      [
        input.conversationKey,
        input.content,
        input.receivedAt ?? new Date(),
        input.messageId,
      ]
    );
    await client.query(
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
           LIMIT 30
         )`,
      [input.conversationKey]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original; release da conexão encerra a transação.
    }
    throw error;
  } finally {
    client.release();
  }
}

export const QUESTION_REPLY_PROVISIONAL_MESSAGE_PREFIX = 'qr-intent:';

export function questionReplyProvisionalMessageId(idempotencyKey: string): string {
  return `${QUESTION_REPLY_PROVISIONAL_MESSAGE_PREFIX}${idempotencyKey}`;
}

export interface QuestionReplyHumanHistoryProjection {
  idempotencyKey: string;
  conversationKey: string;
  content: string;
  createdAt: Date;
  providerMessageId?: string | null;
  payload: string;
}

function isPgUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === '23505';
}

async function trimConversationHistory(
  client: { query: PoolClient['query'] },
  conversationKey: string
): Promise<void> {
  await client.query(
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
         LIMIT 30
       )`,
    [conversationKey]
  );
}

/**
 * Persiste snapshot + linha HUMAN na mesma transação. Sem wamid, usa
 * `qr-intent:<idempotencyKey>` (intenção pré-Meta). Com wamid, promove essa
 * linha para o id/horário factuais sem duplicar. O marcador NÃO exige
 * `provider_message_id` já anexado — o reparo sobrevive ao crash pós-recibo.
 * Nunca envia WhatsApp.
 */
export async function persistQuestionReplyHumanHistoryAtomically(
  input: QuestionReplyHumanHistoryProjection
): Promise<'recorded' | 'already_recorded'> {
  const provisionalId = questionReplyProvisionalMessageId(input.idempotencyKey);
  const wamid =
    typeof input.providerMessageId === 'string' && input.providerMessageId.trim()
      ? input.providerMessageId.trim()
      : null;
  const targetId = wamid ?? provisionalId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await client.query(
      `UPDATE sent_question_replies
       SET human_history_payload = COALESCE(human_history_payload, $2),
           human_history_accepted_at = CASE
             WHEN $3::text IS NOT NULL THEN $4
             ELSE COALESCE(human_history_accepted_at, $4)
           END,
           updated_at = now()
       WHERE idempotency_key = $1
       RETURNING idempotency_key`,
      [input.idempotencyKey, input.payload, wamid, input.createdAt]
    );
    if (!reservation.rows[0]) {
      throw new Error('question reply human history reservation missing');
    }

    let wroteLine = false;
    if (wamid) {
      await client.query('SAVEPOINT promote_human');
      try {
        const promoted = await client.query(
          `UPDATE ana_conversation_history
           SET message_id = $1, "createdAt" = $2, "content" = $3
           WHERE message_id = $4 AND "conversationKey" = $5
           RETURNING "id"`,
          [wamid, input.createdAt, input.content, provisionalId, input.conversationKey]
        );
        await client.query('RELEASE SAVEPOINT promote_human');
        if (promoted.rows[0]) {
          wroteLine = true;
        } else {
          const inserted = await client.query(
            `INSERT INTO ana_conversation_history (
               "conversationKey", "role", "content", "createdAt", message_id
             ) VALUES ($1, 'assistant', $2, $3, $4)
             ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
             RETURNING "id"`,
            [input.conversationKey, input.content, input.createdAt, wamid]
          );
          wroteLine = inserted.rowCount === 1;
        }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT promote_human');
        if (!isPgUniqueViolation(error)) throw error;
        await client.query(
          `DELETE FROM ana_conversation_history
           WHERE message_id = $1 AND "conversationKey" = $2`,
          [provisionalId, input.conversationKey]
        );
      }
    } else {
      const inserted = await client.query(
        `INSERT INTO ana_conversation_history (
           "conversationKey", "role", "content", "createdAt", message_id
         ) VALUES ($1, 'assistant', $2, $3, $4)
         ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
         RETURNING "id"`,
        [input.conversationKey, input.content, input.createdAt, provisionalId]
      );
      wroteLine = inserted.rowCount === 1;
    }

    const existing = await client.query(
      `SELECT "id" FROM ana_conversation_history
       WHERE "conversationKey" = $1
         AND message_id = ANY($2::text[])
       LIMIT 1`,
      [input.conversationKey, [targetId, provisionalId]]
    );
    if (!existing.rows[0]) {
      throw new Error('question reply human history projection missing row');
    }

    await trimConversationHistory(client, input.conversationKey);

    const marked = await client.query<{
      human_history_recorded_at: Date | null;
    }>(
      `UPDATE sent_question_replies
       SET human_history_recorded_at = COALESCE(human_history_recorded_at, now()),
           updated_at = now()
       WHERE idempotency_key = $1
       RETURNING human_history_recorded_at`,
      [input.idempotencyKey]
    );
    if (!marked.rows[0]?.human_history_recorded_at) {
      throw new Error('question reply human history marker missing');
    }
    await client.query('COMMIT');
    return wroteLine ? 'recorded' : 'already_recorded';
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original; release da conexão encerra a transação.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove a linha HUMAN provisória e o snapshot só quando o wamid ainda não
 * foi anexado. Rejeição comprovadamente pre-send; nunca apaga fala promovida.
 */
export async function withdrawQuestionReplyHumanIntention(
  idempotencyKey: string,
  conversationKey: string
): Promise<void> {
  const provisionalId = questionReplyProvisionalMessageId(idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM ana_conversation_history
       WHERE message_id = $1 AND "conversationKey" = $2`,
      [provisionalId, conversationKey]
    );
    await client.query(
      `UPDATE sent_question_replies
       SET human_history_payload = NULL,
           human_history_accepted_at = NULL,
           human_history_recorded_at = NULL,
           updated_at = now()
       WHERE idempotency_key = $1
         AND provider_message_id IS NULL
         AND status IN ('in_flight', 'failed_pre_send', 'stale_source')`,
      [idempotencyKey]
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original; release da conexão encerra a transação.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface UnrepairedQuestionReplyHumanHistory {
  idempotencyKey: string;
  conversationKey: string;
  phoneNumberId: string;
  providerMessageId: string | null;
  payload: string;
  acceptedAt: Date;
}

export async function listUnrepairedQuestionReplyHumanHistory(
  limit = 100,
  providerMessageId?: string
): Promise<UnrepairedQuestionReplyHumanHistory[]> {
  const result = await pool.query<{
    idempotency_key: string;
    conversation_key: string;
    phone_number_id: string;
    provider_message_id: string | null;
    human_history_payload: string;
    human_history_accepted_at: Date;
  }>(
    `SELECT idempotency_key, conversation_key, phone_number_id,
            provider_message_id, human_history_payload,
            human_history_accepted_at
     FROM sent_question_replies
     WHERE human_history_payload IS NOT NULL
       AND human_history_accepted_at IS NOT NULL
       AND status IN ('in_flight', 'sent', 'confirmation_pending')
       AND (
         ($2::text IS NOT NULL AND provider_message_id = $2)
         OR
         ($2::text IS NULL AND human_history_recorded_at IS NULL)
       )
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit, providerMessageId ?? null]
  );
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    conversationKey: row.conversation_key,
    phoneNumberId: row.phone_number_id,
    providerMessageId: row.provider_message_id,
    payload: row.human_history_payload,
    acceptedAt: row.human_history_accepted_at,
  }));
}

async function runAtomicInboundTransaction(
  client: PoolClient,
  input: AtomicInboundInput,
  conversationKey: string
): Promise<AtomicInboundResult> {
  const prepared = prepareInboundContentForW1(
    input.contentStatus,
    input.content,
    input.contentOriginalLength
  );

  await client.query('BEGIN');
  try {
    const processed = await client.query(
      `INSERT INTO processed_messages (
         message_id, phone_number_id, conversation_key
       ) VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [input.messageId, input.phoneNumberId, conversationKey]
    );

    if (processed.rowCount !== 1) {
      await client.query('COMMIT');
      return { fresh: false, conversationKey, sequence: null };
    }

    await client.query(
      `INSERT INTO ana_conversation_history (
         "conversationKey", "role", "content", "createdAt", message_id
       ) VALUES ($1, 'user', $2, $3, $4)`,
      [conversationKey, prepared.content, input.receivedAt, input.messageId]
    );

    const sequence = await client.query<{ last_sequence: string }>(
      `INSERT INTO ana_conversation_seq (
         conversation_key, last_sequence, last_inbound_message_id,
         last_inbound_at, updated_at
       ) VALUES ($1, 1, $2, $3, now())
       ON CONFLICT (conversation_key) DO UPDATE SET
         last_sequence = ana_conversation_seq.last_sequence + 1,
         last_inbound_message_id = EXCLUDED.last_inbound_message_id,
         last_inbound_at = EXCLUDED.last_inbound_at,
         updated_at = now()
       RETURNING last_sequence::text`,
      [conversationKey, input.messageId, input.receivedAt]
    );

    await client.query(
      `INSERT INTO inbound_event_outbox (
         message_id, phone_number_id, conversation_key, received_at,
         message_type, content_status, content_original_length
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.messageId,
        input.phoneNumberId,
        conversationKey,
        input.receivedAt,
        input.messageType,
        prepared.contentStatus,
        prepared.contentOriginalLength,
      ]
    );

    // Mantém a janela histórica já contratada pela Ana. O registro recém
    // inserido e o outbox não dependem da permanência das linhas mais antigas.
    await client.query(
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
         LIMIT 30
       )`,
      [conversationKey]
    );

    await client.query('COMMIT');
    const parsedSequence = Number(sequence.rows[0]?.last_sequence ?? '0');
    return {
      fresh: true,
      conversationKey,
      sequence: Number.isFinite(parsedSequence) ? parsedSequence : null,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva o erro original; a conexão dedicada será liberada no finally.
    }
    throw error;
  }
}

/**
 * Intake exatamente-uma-vez: lock distribuído + UMA transação para processed,
 * history.message_id, sequência/última inbound e outbox. Não faz HTTP.
 */
export async function persistInboundAtomically(
  input: AtomicInboundInput
): Promise<AtomicInboundResult> {
  const conversationKey = canonicalConversationKey(
    input.phoneNumberId,
    input.customerPhone
  );
  return withConversationLock(
    input.phoneNumberId,
    input.customerPhone,
    (client) => runAtomicInboundTransaction(client, input, conversationKey)
  );
}

export async function updateInboundHistoryContent(
  messageId: string,
  content: string
): Promise<void> {
  const truncated = truncateForW1(content);
  await finalizeInboundContent(
    messageId,
    truncated.truncated ? 'truncated' : 'final',
    truncated.text,
    truncated.originalLength
  );
}

/**
 * Finaliza áudio em uma única transação: o histórico vira a transcrição real e
 * o outbox só então fica elegível para POST. Plaintext continua existindo uma
 * única vez, em `ana_conversation_history`.
 */
export async function finalizeInboundContent(
  messageId: string,
  contentStatus: Exclude<InboundContentStatus, 'pending'>,
  content: string,
  contentOriginalLength: number | null = null
): Promise<void> {
  const client = await pool.connect();
  try {
    await finalizeInboundContentWithClient(
      client,
      messageId,
      contentStatus,
      content,
      contentOriginalLength
    );
  } finally {
    client.release();
  }
}

export async function finalizeInboundContentWithClient(
  client: Pick<PoolClient, 'query'>,
  messageId: string,
  contentStatus: Exclude<InboundContentStatus, 'pending'>,
  content: string,
  contentOriginalLength: number | null = null
): Promise<void> {
  const prepared = prepareInboundContentForW1(
    contentStatus,
    content,
    contentOriginalLength
  );
  await client.query('BEGIN');
  try {
    const history = await client.query(
      `UPDATE ana_conversation_history
       SET "content" = $2
       WHERE message_id = $1 AND "role" = 'user'
       RETURNING message_id`,
      [messageId, prepared.content]
    );
    if (history.rowCount !== 1) {
      throw new Error('inbound history row not found while finalizing content');
    }
    const outbox = await client.query(
      `UPDATE inbound_event_outbox
       SET content_status = $2,
           content_original_length = $3
       WHERE message_id = $1
       RETURNING message_id`,
      [messageId, prepared.contentStatus, prepared.contentOriginalLength]
    );
    if (outbox.rowCount !== 1) {
      throw new Error('inbound outbox row not found while finalizing content');
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original da operação atômica.
    }
    throw error;
  }
}

export async function markInboundTranscriptionFailed(
  messageId: string
): Promise<void> {
  await finalizeInboundContent(messageId, 'transcription_failed', '');
}

export async function getLastInboundMessageId(
  conversationKey: string,
  client: Pick<PoolClient, 'query'> = pool
): Promise<string | null> {
  const result = await client.query<{ last_inbound_message_id: string | null }>(
    `SELECT last_inbound_message_id
     FROM ana_conversation_seq
     WHERE conversation_key = $1`,
    [conversationKey]
  );
  return result.rows[0]?.last_inbound_message_id ?? null;
}
