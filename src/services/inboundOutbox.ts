import axios from 'axios';
import { createHash } from 'crypto';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
  technicalHash,
} from '../observability/safeRuntime';
import { pool } from './contextManager';
import {
  isEscalationKnownActive,
  parseEscalationSnapshot,
  updateEscalationCache,
} from './escalationCache';
import {
  canonicalConversationKey,
  customerPhoneAsE164,
} from './conversationOrder';
import type {
  InboundContentStatus,
  InboundMessageType,
} from './anaWave2Store';
import { truncateForW1 } from './inboundContent';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

export const OUTBOX_SWEEP_INTERVAL_MS = 10 * 60_000;
export const FAST_RETRY_DELAYS_MS = [100, 300] as const;

export interface InboundOutboxRow {
  messageId: string;
  phoneNumberId: string;
  conversationKey: string;
  receivedAt: Date;
  messageType: InboundMessageType;
  contentStatus: InboundContentStatus;
  content: string | null;
  contentOriginalLength: number | null;
  attempts: number;
  nextRetryAt: Date;
  deliveredAt: Date | null;
  terminalAt: Date | null;
  failureCode: string | null;
}

export interface InboundDeliveryPayload {
  phoneNumberId: string;
  customerPhone: string;
  messageId: string;
  receivedAt: string;
  messageType: InboundMessageType;
  contentStatus: Exclude<InboundContentStatus, 'pending'>;
  contentText: string | null;
  contentHash: string | null;
  contentLength: number | null;
  contentOriginalLength: number | null;
}

export interface InboundDeliveryResponse {
  escalation?: unknown;
}

export class InboundContractViolationError extends Error {
  constructor() {
    super('inbound W1 contract violation');
    this.name = 'InboundContractViolationError';
  }
}

export interface InboundOutboxStore {
  load: (messageId: string) => Promise<InboundOutboxRow | null>;
  markDelivered: (messageId: string) => Promise<void>;
  markFailure: (
    messageId: string,
    attempts: number,
    nextRetryAt: Date,
    failureCode: string
  ) => Promise<void>;
  markTerminal: (
    messageId: string,
    attempts: number,
    failureCode: string
  ) => Promise<void>;
  reprocessQuarantined: (messageId: string) => Promise<boolean>;
  listReady: (limit: number) => Promise<string[]>;
  hasPending: (conversationKey: string) => Promise<boolean>;
}

interface RawOutboxRow {
  message_id: string;
  phone_number_id: string;
  conversation_key: string;
  received_at: Date;
  message_type: InboundMessageType;
  content_status: InboundContentStatus;
  content: string | null;
  content_original_length: number | null;
  attempts: number;
  next_retry_at: Date;
  delivered_at: Date | null;
  terminal_at: Date | null;
  failure_code: string | null;
}

export const pgInboundOutboxStore: InboundOutboxStore = {
  async load(messageId) {
    const result = await pool.query<RawOutboxRow>(
      `SELECT o.message_id, o.phone_number_id, o.conversation_key,
              o.received_at, o.message_type, o.content_status,
              o.content_original_length, o.attempts, o.next_retry_at,
              o.delivered_at, o.terminal_at, o.failure_code,
              h."content" AS content
       FROM inbound_event_outbox o
       LEFT JOIN ana_conversation_history h ON h.message_id = o.message_id
       WHERE o.message_id = $1`,
      [messageId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      messageId: row.message_id,
      phoneNumberId: row.phone_number_id,
      conversationKey: row.conversation_key,
      receivedAt: row.received_at,
      messageType: row.message_type,
      contentStatus: row.content_status,
      content: row.content,
      contentOriginalLength: row.content_original_length,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at,
      deliveredAt: row.delivered_at,
      terminalAt: row.terminal_at,
      failureCode: row.failure_code,
    };
  },
  async markDelivered(messageId) {
    await pool.query(
      `UPDATE inbound_event_outbox
       SET delivered_at = COALESCE(delivered_at, now()),
           next_retry_at = now(),
           failure_code = NULL
       WHERE message_id = $1`,
      [messageId]
    );
  },
  async markFailure(messageId, attempts, nextRetryAt, failureCode) {
    await pool.query(
      `UPDATE inbound_event_outbox
       SET attempts = GREATEST(attempts, $2),
           next_retry_at = $3,
           failure_code = $4
       WHERE message_id = $1
         AND delivered_at IS NULL
         AND terminal_at IS NULL`,
      [messageId, attempts, nextRetryAt, failureCode]
    );
  },
  async markTerminal(messageId, attempts, failureCode) {
    await pool.query(
      `UPDATE inbound_event_outbox
       SET attempts = GREATEST(attempts, $2),
           terminal_at = COALESCE(terminal_at, now()),
           failure_code = $3
       WHERE message_id = $1 AND delivered_at IS NULL`,
      [messageId, attempts, failureCode]
    );
  },
  async reprocessQuarantined(messageId) {
    const result = await pool.query(
      `UPDATE inbound_event_outbox
       SET terminal_at = NULL,
           failure_code = NULL,
           attempts = 0,
           next_retry_at = now()
       WHERE message_id = $1
         AND delivered_at IS NULL
         AND terminal_at IS NOT NULL`,
      [messageId]
    );
    return result.rowCount === 1;
  },
  async listReady(limit) {
    const result = await pool.query<{ message_id: string }>(
      `SELECT message_id
       FROM inbound_event_outbox
       WHERE delivered_at IS NULL
         AND terminal_at IS NULL
         AND content_status <> 'pending'
         AND next_retry_at <= now()
       ORDER BY next_retry_at ASC, received_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => row.message_id);
  },
  async hasPending(conversationKey) {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM inbound_event_outbox
         WHERE conversation_key = $1 AND delivered_at IS NULL
       ) AS "exists"`,
      [conversationKey]
    );
    return result.rows[0]?.exists ?? false;
  },
};

function customerPhoneFromConversationKey(conversationKey: string): string {
  const separator = conversationKey.indexOf(':');
  return separator >= 0 ? conversationKey.slice(separator + 1) : '';
}

/** Serialização W1 única, usada por produção, smoke e harness. */
export function serializeInboundDeliveryPayload(
  row: InboundOutboxRow
): InboundDeliveryPayload {
  if (row.contentStatus === 'pending') {
    throw new InboundContractViolationError();
  }

  const hasContent =
    row.contentStatus === 'final' || row.contentStatus === 'truncated';
  const normalizedContent = hasContent
    ? truncateForW1(row.content ?? '')
    : null;
  const contentText = normalizedContent?.text ?? null;
  if (hasContent && (!contentText || !contentText.trim())) {
    throw new InboundContractViolationError();
  }
  const contentLength = contentText?.length ?? null;
  const contentOriginalLength = normalizedContent
    ? Math.max(
        row.contentOriginalLength ?? 0,
        normalizedContent.originalLength,
        row.contentStatus === 'truncated' ? normalizedContent.text.length + 1 : 0
      )
    : null;
  const contentStatus = normalizedContent
    ? (contentOriginalLength ?? 0) > normalizedContent.text.length
      ? 'truncated'
      : 'final'
    : row.contentStatus;

  let receivedAt: string;
  try {
    receivedAt = row.receivedAt.toISOString();
  } catch {
    throw new InboundContractViolationError();
  }

  return {
    phoneNumberId: row.phoneNumberId,
    customerPhone: customerPhoneAsE164(
      customerPhoneFromConversationKey(row.conversationKey)
    ),
    messageId: row.messageId,
    receivedAt,
    messageType: row.messageType,
    contentStatus,
    contentText,
    contentHash:
      contentText === null
        ? null
        : createHash('sha256').update(contentText, 'utf8').digest('hex'),
    // Contrato cross-repo em JS: comprimento da string exata (UTF-16 code units).
    contentLength,
    contentOriginalLength,
  };
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 250 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

async function postInboundToReceps(
  payload: InboundDeliveryPayload
): Promise<InboundDeliveryResponse> {
  const { data } = await axios.post<InboundDeliveryResponse>(
    `${RECEPS_INTERNAL_API_URL}/api/v1/bot/conversations/inbound`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );
  return data ?? {};
}

export interface InboundOutboxDeps {
  store: InboundOutboxStore;
  postInbound: (
    payload: InboundDeliveryPayload
  ) => Promise<InboundDeliveryResponse>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: InboundOutboxDeps = {
  store: pgInboundOutboxStore,
  postInbound: postInboundToReceps,
  wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

export interface InboundDeliveryResult {
  delivered: boolean;
  attempts: number;
  terminal: boolean;
  fastRetryAllowed: boolean;
}

export interface InboundOutboxFailure {
  terminal: boolean;
  failureCode: string;
  fastRetryAllowed: boolean;
}

/** Matriz fechada: somente violações W1 400/422 entram em quarentena. */
export function classifyInboundOutboxFailure(
  error: unknown
): InboundOutboxFailure {
  const status = safeHttpStatus(error);
  if (error instanceof InboundContractViolationError) {
    return {
      terminal: true,
      failureCode: 'W1_LOCAL_CONTRACT',
      fastRetryAllowed: false,
    };
  }
  if (status === 400 || status === 422) {
    return {
      terminal: true,
      failureCode: `W1_CONTRACT_HTTP_${status}`,
      fastRetryAllowed: false,
    };
  }
  if (status !== null) {
    return {
      terminal: false,
      failureCode: `W1_HTTP_${status}`,
      fastRetryAllowed: status >= 500,
    };
  }
  return {
    terminal: false,
    failureCode: `W1_${runtimeErrorKind(error).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48) || 'NETWORK'}`,
    fastRetryAllowed: true,
  };
}

/** Uma tentativa isolada; nunca mantém transação durante o HTTP. */
export async function attemptInboundDeliveryOnce(
  messageId: string,
  deps: InboundOutboxDeps = defaultDeps
): Promise<InboundDeliveryResult> {
  const row = await deps.store.load(messageId);
  if (!row || row.deliveredAt) {
    return {
      delivered: true,
      attempts: row?.attempts ?? 0,
      terminal: false,
      fastRetryAllowed: false,
    };
  }

  if (row.terminalAt) {
    return {
      delivered: false,
      attempts: row.attempts,
      terminal: true,
      fastRetryAllowed: false,
    };
  }

  if (row.contentStatus === 'pending') {
    return {
      delivered: false,
      attempts: row.attempts,
      terminal: false,
      fastRetryAllowed: false,
    };
  }

  const customerPhone = customerPhoneFromConversationKey(row.conversationKey);
  const nextAttempts = row.attempts + 1;
  try {
    const response = await deps.postInbound(serializeInboundDeliveryPayload(row));
    await deps.store.markDelivered(messageId);

    // A inbound entregue supersede a pergunta OPEN. Durante rollout paralelo,
    // resposta sem o campo é tolerada como inactive.
    updateEscalationCache(
      row.phoneNumberId,
      customerPhone,
      parseEscalationSnapshot(response.escalation),
      deps.now(),
      true
    );
    return {
      delivered: true,
      attempts: nextAttempts,
      terminal: false,
      fastRetryAllowed: false,
    };
  } catch (error) {
    const classified = classifyInboundOutboxFailure(error);
    if (classified.terminal) {
      await deps.store.markTerminal(
        messageId,
        nextAttempts,
        classified.failureCode
      );
    } else {
      await deps.store.markFailure(
        messageId,
        nextAttempts,
        new Date(deps.now() + retryDelayMs(nextAttempts)),
        classified.failureCode
      );
    }
    Sentry.captureException(new Error('ana inbound outbox delivery failed'), {
      level: classified.terminal ? 'error' : 'warning',
      tags: {
        service: 'ana_inbound_outbox',
        operation: classified.terminal ? 'quarantine' : 'deliver',
        phoneNumberHash: technicalHash(row.phoneNumberId),
        messageIdHash: technicalHash(row.messageId),
        failure_code: classified.failureCode,
        error_kind: runtimeErrorKind(error),
      },
    });
    return {
      delivered: false,
      attempts: nextAttempts,
      terminal: classified.terminal,
      fastRetryAllowed: classified.fastRetryAllowed,
    };
  }
}

/** Tentativa imediata + retries rápidos limitados. O sweep de 10 min é posterior. */
export async function deliverInboundWithFastRetries(
  messageId: string,
  deps: InboundOutboxDeps = defaultDeps
): Promise<InboundDeliveryResult> {
  let result = await attemptInboundDeliveryOnce(messageId, deps);
  for (const delay of FAST_RETRY_DELAYS_MS) {
    if (result.delivered || result.terminal || !result.fastRetryAllowed) break;
    await deps.wait(delay);
    result = await attemptInboundDeliveryOnce(messageId, deps);
  }
  return result;
}

/** Rearma somente item terminal e nunca o marca entregue. */
export async function reprocessQuarantinedInbound(
  messageId: string,
  store: InboundOutboxStore = pgInboundOutboxStore
): Promise<boolean> {
  return store.reprocessQuarantined(messageId);
}

export async function sweepInboundOutbox(
  deps: InboundOutboxDeps = defaultDeps,
  limit = 100
): Promise<{ attempted: number; delivered: number }> {
  const messageIds = await deps.store.listReady(limit);
  let delivered = 0;
  for (const messageId of messageIds) {
    const result = await attemptInboundDeliveryOnce(messageId, deps);
    if (result.delivered) delivered += 1;
  }
  return { attempted: messageIds.length, delivered };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startInboundOutboxSweep(
  deps: InboundOutboxDeps = defaultDeps
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepInboundOutbox(deps).catch((error) => {
      Sentry.captureException(new Error('ana inbound outbox sweep failed'), {
        tags: {
          service: 'ana_inbound_outbox',
          operation: 'sweep',
          error_kind: error instanceof Error ? error.name : typeof error,
        },
      });
    });
  }, OUTBOX_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Fail-closed só na interseção contratada: escalada ativa conhecida + pendência. */
export async function shouldSuspendForPendingInbound(
  phoneNumberId: string,
  customerPhone: string,
  store: InboundOutboxStore = pgInboundOutboxStore
): Promise<boolean> {
  if (!isEscalationKnownActive(phoneNumberId, customerPhone)) return false;
  return store.hasPending(canonicalConversationKey(phoneNumberId, customerPhone));
}

export function __stopInboundOutboxSweepForTest(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
