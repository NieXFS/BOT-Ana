import { createHash } from 'crypto';
import axios from 'axios';
import type { PoolClient } from 'pg';
import type { WhatsAppTenantConfig } from '../whatsappCloudService';
import {
  sendFreeformMessageWithReceipt,
  WhatsAppReceiptMissingError,
} from '../whatsappCloudService';
import { pool } from './contextManager';
import {
  canonicalCustomerPhone,
  canonicalConversationKey,
  withConversationLock,
} from './conversationOrder';
import type { QuestionReplyStatus } from './anaWave2Store';
import {
  buildReceptionistEnvelope,
  validateReceptionistOutbound,
  type AuthoritativeOutboundCatalog,
  type ClinicalAuthorization,
  type ReceptionistOutboundBlock,
  type ReceptionistOutboundEvidence,
} from './receptionistOutbound';

const WHATSAPP_WINDOW_MS = 24 * 60 * 60_000;

export interface QuestionReplyInput {
  contractVersion?: number;
  phoneNumberId: string;
  customerPhone: string;
  idempotencyKey: string;
  text: string;
  sourceInboundMessageId: string;
  blocks?: ReceptionistOutboundBlock[];
  evidence?: ReceptionistOutboundEvidence;
  authoritativeCatalog?: AuthoritativeOutboundCatalog;
  clinicalAuthorization?: ClinicalAuthorization;
}

export interface QuestionReplyRow {
  idempotencyKey: string;
  payloadHash: string;
  sourceInboundMessageId: string;
  phoneNumberId: string;
  conversationKey: string;
  status: QuestionReplyStatus;
  providerMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  failureCode: string | null;
  providerStatus: 'sent' | 'delivered' | 'read' | 'failed' | null;
  providerStatusAt: Date | null;
  providerFailureCode: string | null;
  callbackPending: boolean;
}

interface RawQuestionReplyRow {
  idempotency_key: string;
  payload_hash: string;
  source_inbound_message_id: string;
  phone_number_id: string;
  conversation_key: string;
  status: QuestionReplyStatus;
  provider_message_id: string | null;
  created_at: Date;
  updated_at: Date;
  failure_code: string | null;
  provider_status: 'sent' | 'delivered' | 'read' | 'failed' | null;
  provider_status_at: Date | null;
  provider_failure_code: string | null;
  callback_pending: boolean;
}

function mapRow(row: RawQuestionReplyRow): QuestionReplyRow {
  return {
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    sourceInboundMessageId: row.source_inbound_message_id,
    phoneNumberId: row.phone_number_id,
    conversationKey: row.conversation_key,
    status: row.status,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureCode: row.failure_code,
    providerStatus: row.provider_status,
    providerStatusAt: row.provider_status_at,
    providerFailureCode: row.provider_failure_code,
    callbackPending: row.callback_pending,
  };
}

export interface QuestionReplyStore {
  reserve: (row: {
    idempotencyKey: string;
    payloadHash: string;
    sourceInboundMessageId: string;
    phoneNumberId: string;
    conversationKey: string;
  }) => Promise<{ inserted: boolean; row: QuestionReplyRow }>;
  update: (
    idempotencyKey: string,
    status: QuestionReplyStatus,
    providerMessageId: string | null,
    failureCode: string | null
  ) => Promise<QuestionReplyRow>;
  get: (idempotencyKey: string) => Promise<QuestionReplyRow | null>;
}

export const pgQuestionReplyStore: QuestionReplyStore = {
  async reserve(row) {
    const inserted = await pool.query<RawQuestionReplyRow>(
      `INSERT INTO sent_question_replies (
         idempotency_key, payload_hash, source_inbound_message_id,
         phone_number_id, conversation_key, status
       ) VALUES ($1, $2, $3, $4, $5, 'in_flight')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        row.idempotencyKey,
        row.payloadHash,
        row.sourceInboundMessageId,
        row.phoneNumberId,
        row.conversationKey,
      ]
    );
    if (inserted.rows[0]) {
      return { inserted: true, row: mapRow(inserted.rows[0]) };
    }
    const existing = await this.get(row.idempotencyKey);
    if (!existing) throw new Error('question reply reservation disappeared');
    return { inserted: false, row: existing };
  },
  async update(idempotencyKey, status, providerMessageId, failureCode) {
    const result = await pool.query<RawQuestionReplyRow>(
      `UPDATE sent_question_replies
       SET status = $2,
           provider_message_id = COALESCE($3, provider_message_id),
           failure_code = $4,
           updated_at = now()
       WHERE idempotency_key = $1
       RETURNING *`,
      [idempotencyKey, status, providerMessageId, failureCode]
    );
    if (!result.rows[0]) throw new Error('question reply reservation not found');
    return mapRow(result.rows[0]);
  },
  async get(idempotencyKey) {
    const result = await pool.query<RawQuestionReplyRow>(
      `SELECT * FROM sent_question_replies WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },
};

export function questionReplyPayloadHash(input: QuestionReplyInput): string {
  const conversationKey = canonicalConversationKey(
    input.phoneNumberId,
    input.customerPhone
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.idempotencyKey,
        input.phoneNumberId.trim(),
        conversationKey,
        input.sourceInboundMessageId,
        input.text,
        input.contractVersion ?? null,
        input.blocks ?? null,
        input.authoritativeCatalog ?? null,
        input.clinicalAuthorization ?? null,
        input.evidence ?? null,
      ])
    )
    .digest('hex');
}

export function sanitizeFailureCode(value: string): string {
  const safe = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
  return safe || 'UNKNOWN';
}

function classifyTransportFailure(error: unknown): {
  status: 'failed_pre_send' | 'confirmation_pending';
  failureCode: string;
} {
  if (error instanceof WhatsAppReceiptMissingError) {
    return {
      status: 'confirmation_pending',
      failureCode: 'PROVIDER_RECEIPT_MISSING',
    };
  }
  const explicit = error as { deliveryClassification?: unknown; code?: unknown };
  if (explicit?.deliveryClassification === 'pre_send') {
    return {
      status: 'failed_pre_send',
      failureCode: sanitizeFailureCode(String(explicit.code ?? 'PRE_SEND')),
    };
  }
  if (axios.isAxiosError(error) && error.response) {
    return {
      status: 'failed_pre_send',
      failureCode: sanitizeFailureCode(`META_HTTP_${error.response.status}`),
    };
  }
  return {
    status: 'confirmation_pending',
    failureCode: 'TRANSPORT_OUTCOME_UNKNOWN',
  };
}

async function getLastInboundAtMsWithClient(
  client: PoolClient,
  conversationKey: string
): Promise<number | null> {
  const result = await client.query<{ created_at: Date }>(
    `SELECT "createdAt" AS created_at
     FROM ana_conversation_history
     WHERE "conversationKey" = $1 AND "role" = 'user'
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 1`,
    [conversationKey]
  );
  const value = result.rows[0]?.created_at;
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

async function getLatestSourceWithClient(
  client: PoolClient,
  conversationKey: string
): Promise<string | null> {
  const result = await client.query<{ last_inbound_message_id: string | null }>(
    `SELECT last_inbound_message_id
     FROM ana_conversation_seq
     WHERE conversation_key = $1`,
    [conversationKey]
  );
  return result.rows[0]?.last_inbound_message_id ?? null;
}

export interface QuestionReplyDeps {
  store: QuestionReplyStore;
  now: () => number;
  withLock: <T>(
    phoneNumberId: string,
    customerPhone: string,
    work: (client: PoolClient) => Promise<T>
  ) => Promise<T>;
  getLatestSource: (
    client: PoolClient,
    conversationKey: string
  ) => Promise<string | null>;
  getLastInboundAtMs: (
    client: PoolClient,
    conversationKey: string
  ) => Promise<number | null>;
  sendReceipt: (
    to: string,
    text: string,
    config: WhatsAppTenantConfig
  ) => Promise<{ providerMessageId: string }>;
}

const defaultDeps: QuestionReplyDeps = {
  store: pgQuestionReplyStore,
  now: Date.now,
  withLock: (phoneNumberId, customerPhone, work) =>
    withConversationLock(phoneNumberId, customerPhone, work),
  getLatestSource: getLatestSourceWithClient,
  getLastInboundAtMs: getLastInboundAtMsWithClient,
  sendReceipt: sendFreeformMessageWithReceipt,
};

export function createQuestionReplyDeps(
  overrides: Partial<QuestionReplyDeps> = {}
): QuestionReplyDeps {
  return { ...defaultDeps, ...overrides };
}

export type QuestionReplyResult =
  | { kind: 'sent'; providerMessageId: string; sentAt: string }
  | { kind: 'conflict' }
  | {
      kind: 'pending';
      status: 'in_flight' | 'confirmation_pending';
      providerMessageId: string | null;
    }
  | { kind: 'failed_pre_send'; failureCode: string | null }
  | { kind: 'stale_source' };

function resultFromExisting(row: QuestionReplyRow): QuestionReplyResult {
  if (row.status === 'sent' && row.providerMessageId) {
    return {
      kind: 'sent',
      providerMessageId: row.providerMessageId,
      sentAt: row.updatedAt.toISOString(),
    };
  }
  if (row.status === 'failed_pre_send') {
    return { kind: 'failed_pre_send', failureCode: row.failureCode };
  }
  if (row.status === 'stale_source') return { kind: 'stale_source' };
  return {
    kind: 'pending',
    status: row.status === 'in_flight' ? 'in_flight' : 'confirmation_pending',
    providerMessageId: row.providerMessageId,
  };
}

export async function sendQuestionReply(
  input: QuestionReplyInput,
  waConfig: WhatsAppTenantConfig,
  deps: QuestionReplyDeps = defaultDeps
): Promise<QuestionReplyResult> {
  const envelope = buildReceptionistEnvelope({
    purpose: 'TEAM_REPLY',
    exactPayload: input.text,
    blocks:
      input.blocks && input.blocks.length > 0
        ? input.blocks
        : [{ source: 'TEAM_REPLY', text: input.text }],
    authoritativeCatalog: input.authoritativeCatalog ?? {
      services: [],
      professionals: [],
    },
    evidence: {
      ...input.evidence,
      clinicalAuthorization:
        input.clinicalAuthorization ?? input.evidence?.clinicalAuthorization,
      sourceInboundMessageId: input.sourceInboundMessageId,
    },
  });
  if (input.contractVersion !== undefined) {
    (envelope as { contractVersion: number }).contractVersion = input.contractVersion;
  }
  const validated = validateReceptionistOutbound(envelope);
  if (!validated.originalAccepted) {
    console.warn(
      `[receptionist-outbound] suppressed purpose=${validated.purpose} reasons=${validated.reasonCodes.join(',')} sources=${validated.sources.join(',')}`
    );
  }
  const transportInput: QuestionReplyInput = {
    ...input,
    text: validated.payload,
  };
  const conversationKey = canonicalConversationKey(
    transportInput.phoneNumberId,
    transportInput.customerPhone
  );
  const payloadHash = questionReplyPayloadHash(transportInput);
  const reservation = await deps.store.reserve({
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    sourceInboundMessageId: input.sourceInboundMessageId,
    phoneNumberId: input.phoneNumberId,
    conversationKey,
  });

  if (!reservation.inserted) {
    const row = reservation.row;
    const samePayload =
      row.payloadHash === payloadHash &&
      row.sourceInboundMessageId === input.sourceInboundMessageId &&
      row.phoneNumberId === input.phoneNumberId &&
      row.conversationKey === conversationKey;
    if (!samePayload) return { kind: 'conflict' };
    return resultFromExisting(row);
  }

  if (!validated.originalAccepted) {
    const row = await deps.store.update(
      input.idempotencyKey,
      'failed_pre_send',
      null,
      sanitizeFailureCode(
        `SAFETY_REJECTED_${validated.reasonCodes.join('_') || 'UNKNOWN'}`
      )
    );
    return { kind: 'failed_pre_send', failureCode: row.failureCode };
  }

  let transportAttempted = false;
  let transportKnownPreSend = false;
  let acceptedProviderMessageId: string | null = null;
  try {
    return await deps.withLock(
      input.phoneNumberId,
      input.customerPhone,
      async (client) => {
        const latestSource = await deps.getLatestSource(client, conversationKey);
        if (latestSource !== input.sourceInboundMessageId) {
          await deps.store.update(
            input.idempotencyKey,
            'stale_source',
            null,
            'STALE_SOURCE'
          );
          return { kind: 'stale_source' };
        }

        const lastInboundAtMs = await deps.getLastInboundAtMs(
          client,
          conversationKey
        );
        const nowMs = deps.now();
        if (
          lastInboundAtMs === null ||
          nowMs - lastInboundAtMs > WHATSAPP_WINDOW_MS
        ) {
          const row = await deps.store.update(
            input.idempotencyKey,
            'failed_pre_send',
            null,
            'WINDOW_CLOSED'
          );
          return { kind: 'failed_pre_send', failureCode: row.failureCode };
        }

        try {
          transportAttempted = true;
          const receipt = await deps.sendReceipt(
            canonicalCustomerPhone(input.customerPhone),
            transportInput.text,
            waConfig
          );
          acceptedProviderMessageId = receipt.providerMessageId;
          try {
            const sent = await deps.store.update(
              input.idempotencyKey,
              'sent',
              receipt.providerMessageId,
              null
            );
            return {
              kind: 'sent',
              providerMessageId: receipt.providerMessageId,
              sentAt: sent.updatedAt.toISOString(),
            };
          } catch {
            // A Meta aceitou, mas a confirmação local falhou/colidiu. Nunca retry.
            await deps.store.update(
              input.idempotencyKey,
              'confirmation_pending',
              receipt.providerMessageId,
              'RECEIPT_PERSIST_FAILED'
            );
            return {
              kind: 'pending',
              status: 'confirmation_pending',
              providerMessageId: receipt.providerMessageId,
            };
          }
        } catch (error) {
          const classified = classifyTransportFailure(error);
          transportKnownPreSend = classified.status === 'failed_pre_send';
          const row = await deps.store.update(
            input.idempotencyKey,
            classified.status,
            null,
            classified.failureCode
          );
          if (classified.status === 'failed_pre_send') {
            return { kind: 'failed_pre_send', failureCode: row.failureCode };
          }
          return {
            kind: 'pending',
            status: 'confirmation_pending',
            providerMessageId: null,
          };
        }
      }
    );
  } catch (error) {
    // Falha antes de chamar transporte é comprovadamente pre-send. Se a chamada
    // já começou, qualquer falha residual permanece ambígua e nunca faz retry.
    const status = transportAttempted && !transportKnownPreSend
      ? 'confirmation_pending'
      : 'failed_pre_send';
    const failureCode = transportAttempted && !transportKnownPreSend
      ? 'TRANSPORT_OUTCOME_UNKNOWN'
      : 'LOCAL_PRE_SEND_FAILED';
    const row = await deps.store.update(
      input.idempotencyKey,
      status,
      acceptedProviderMessageId,
      failureCode
    );
    if (status === 'failed_pre_send') {
      return { kind: 'failed_pre_send', failureCode: row.failureCode };
    }
    return {
      kind: 'pending',
      status: 'confirmation_pending',
      providerMessageId: row.providerMessageId ?? acceptedProviderMessageId,
    };
  }
}

export async function getQuestionReplyStatus(
  idempotencyKey: string,
  store: QuestionReplyStore = pgQuestionReplyStore
): Promise<{
  key: string;
  status: QuestionReplyStatus;
  providerMessageId: string | null;
  failureCode: string | null;
  providerStatus: 'sent' | 'delivered' | 'read' | 'failed' | null;
  providerStatusAt: string | null;
  providerFailureCode: string | null;
  callbackPending: boolean;
  updatedAt: string;
} | null> {
  const row = await store.get(idempotencyKey);
  if (!row) return null;
  return {
    key: row.idempotencyKey,
    status: row.status,
    providerMessageId: row.providerMessageId,
    failureCode: row.failureCode,
    providerStatus: row.providerStatus,
    providerStatusAt: row.providerStatusAt?.toISOString() ?? null,
    providerFailureCode: row.providerFailureCode,
    callbackPending: row.callbackPending,
    updatedAt: row.updatedAt.toISOString(),
  };
}
