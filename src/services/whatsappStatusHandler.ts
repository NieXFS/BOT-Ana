import axios from 'axios';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
  technicalHash,
} from '../observability/safeRuntime';
import { pool } from './contextManager';
import { sanitizeFailureCode } from './questionReplyService';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

export const STATUS_CALLBACK_RETRY_DELAYS_MS = [50, 150, 450] as const;
export const STATUS_CALLBACK_SWEEP_INTERVAL_MS = 60_000;
export const WHATSAPP_STATUS_EVENTS = [
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type WhatsAppStatusEventName = (typeof WHATSAPP_STATUS_EVENTS)[number];

export interface WhatsAppStatusEvent {
  providerMessageId: string;
  statusEvent: WhatsAppStatusEventName;
  occurredAt: string;
  failureCode: string | null;
}

export interface QuestionReplyStatusCallbackPayload {
  phoneNumberId: string;
  providerMessageId: string;
  statusEvent: WhatsAppStatusEventName;
  occurredAt: string;
  failureCode: string | null;
}

export interface StatusCallbackObligation
  extends QuestionReplyStatusCallbackPayload {
  version: number;
  attempts: number;
}

function parseOccurredAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  const ms =
    Number.isFinite(numeric) && numeric > 0
      ? numeric < 1_000_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseFailureCode(raw: Record<string, unknown>): string | null {
  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  const first = errors[0];
  const code =
    first && typeof first === 'object'
      ? (first as { code?: unknown }).code
      : null;
  if (typeof code !== 'string' && typeof code !== 'number') {
    return 'META_FAILED';
  }
  return sanitizeFailureCode(`META_${String(code)}`);
}

/** Parser estrito: ignora status/timestamp inválidos e nunca lê recipient/body. */
export function parseWhatsAppStatuses(value: unknown): WhatsAppStatusEvent[] {
  if (!value || typeof value !== 'object') return [];
  const statuses = (value as { statuses?: unknown }).statuses;
  if (!Array.isArray(statuses)) return [];

  const result: WhatsAppStatusEvent[] = [];
  for (const raw of statuses) {
    if (!raw || typeof raw !== 'object') continue;
    const status = raw as Record<string, unknown>;
    const providerMessageId =
      typeof status.id === 'string' ? status.id.trim() : '';
    const statusEvent =
      typeof status.status === 'string' ? status.status.trim() : '';
    const occurredAt = parseOccurredAt(status.timestamp);
    if (
      !providerMessageId ||
      !occurredAt ||
      !WHATSAPP_STATUS_EVENTS.includes(statusEvent as WhatsAppStatusEventName)
    ) {
      continue;
    }
    const typedStatus = statusEvent as WhatsAppStatusEventName;
    result.push({
      providerMessageId,
      statusEvent: typedStatus,
      occurredAt,
      failureCode: typedStatus === 'failed' ? parseFailureCode(status) : null,
    });
  }
  return result;
}

export type LocalStatusUpdate =
  | { kind: 'applied'; obligation: StatusCallbackObligation }
  | { kind: 'reactivated'; obligation: StatusCallbackObligation }
  | { kind: 'noop' }
  | { kind: 'unknown' };

export interface WhatsAppStatusStore {
  apply: (event: WhatsAppStatusEvent) => Promise<LocalStatusUpdate>;
  markCallbackAck: (
    providerMessageId: string,
    statusEvent: WhatsAppStatusEventName,
    version: number
  ) => Promise<boolean>;
  markCallbackFailure: (
    providerMessageId: string,
    statusEvent: WhatsAppStatusEventName,
    version: number,
    attempts: number,
    nextAttemptAt: Date,
    failureCode: string
  ) => Promise<boolean>;
  listPendingCallbacks: (limit: number) => Promise<StatusCallbackObligation[]>;
}

export function canApplyWhatsAppStatus(
  current: WhatsAppStatusEventName | null,
  next: WhatsAppStatusEventName
): boolean {
  if (current === null) return true;
  if (current === 'sent') {
    return next === 'delivered' || next === 'read' || next === 'failed';
  }
  if (current === 'delivered') return next === 'read';
  return false;
}

function transitionPredicate(status: WhatsAppStatusEventName): string {
  if (status === 'sent') return 'provider_status IS NULL';
  if (status === 'delivered') {
    return "(provider_status IS NULL OR provider_status = 'sent')";
  }
  if (status === 'read') {
    return "(provider_status IS NULL OR provider_status IN ('sent', 'delivered'))";
  }
  return "(provider_status IS NULL OR provider_status = 'sent')";
}

interface RawStatusObligationRow {
  phone_number_id: string;
  provider_message_id: string;
  provider_status: WhatsAppStatusEventName;
  provider_status_at: Date;
  provider_failure_code: string | null;
  provider_status_version: string | number;
  callback_attempts: number;
  callback_pending: boolean;
}

function mapObligation(row: RawStatusObligationRow): StatusCallbackObligation {
  return {
    phoneNumberId: row.phone_number_id,
    providerMessageId: row.provider_message_id,
    statusEvent: row.provider_status,
    occurredAt: new Date(row.provider_status_at).toISOString(),
    failureCode: row.provider_failure_code,
    version: Number(row.provider_status_version),
    attempts: row.callback_attempts,
  };
}

export const pgWhatsAppStatusStore: WhatsAppStatusStore = {
  async apply(event) {
    // Uma única escrita atômica persiste o fato monotônico e cria/substitui a
    // obrigação do callback. O HTTP nunca ocorre dentro desta transação SQL.
    const updated = await pool.query<RawStatusObligationRow>(
      `UPDATE sent_question_replies
       SET provider_status = $2,
           provider_status_at = $3,
           provider_failure_code = CASE
             WHEN $2 = 'failed' THEN $4
             ELSE NULL
           END,
           failure_code = CASE
             WHEN $2 = 'failed' THEN $4
             ELSE failure_code
           END,
           provider_status_version = provider_status_version + 1,
           callback_pending = true,
           callback_attempts = 0,
           callback_next_attempt_at = now(),
           callback_ack_at = NULL,
           callback_failure_code = NULL,
           updated_at = now()
       WHERE provider_message_id = $1
         AND ${transitionPredicate(event.statusEvent)}
         AND (provider_status_at IS NULL OR provider_status_at <= $3)
       RETURNING phone_number_id, provider_message_id, provider_status,
                 provider_status_at, provider_failure_code,
                 provider_status_version, callback_attempts, callback_pending`,
      [
        event.providerMessageId,
        event.statusEvent,
        event.occurredAt,
        event.failureCode,
      ]
    );
    if (updated.rows[0]) {
      return { kind: 'applied', obligation: mapObligation(updated.rows[0]) };
    }

    const existing = await pool.query<RawStatusObligationRow>(
      `SELECT phone_number_id, provider_message_id, provider_status,
              provider_status_at, provider_failure_code,
              provider_status_version, callback_attempts, callback_pending
       FROM sent_question_replies
       WHERE provider_message_id = $1`,
      [event.providerMessageId]
    );
    const row = existing.rows[0];
    if (!row) return { kind: 'unknown' };
    if (row.provider_status === event.statusEvent && row.callback_pending) {
      return { kind: 'reactivated', obligation: mapObligation(row) };
    }
    return { kind: 'noop' };
  },
  async markCallbackAck(providerMessageId, statusEvent, version) {
    const result = await pool.query(
      `UPDATE sent_question_replies
       SET callback_pending = false,
           callback_ack_at = now(),
           callback_failure_code = NULL,
           updated_at = now()
       WHERE provider_message_id = $1
         AND provider_status = $2
         AND provider_status_version = $3
         AND callback_pending = true`,
      [providerMessageId, statusEvent, version]
    );
    return result.rowCount === 1;
  },
  async markCallbackFailure(
    providerMessageId,
    statusEvent,
    version,
    attempts,
    nextAttemptAt,
    failureCode
  ) {
    const result = await pool.query(
      `UPDATE sent_question_replies
       SET callback_attempts = GREATEST(callback_attempts, $4),
           callback_next_attempt_at = $5,
           callback_failure_code = $6,
           updated_at = now()
       WHERE provider_message_id = $1
         AND provider_status = $2
         AND provider_status_version = $3
         AND callback_pending = true`,
      [
        providerMessageId,
        statusEvent,
        version,
        attempts,
        nextAttemptAt,
        failureCode,
      ]
    );
    return result.rowCount === 1;
  },
  async listPendingCallbacks(limit) {
    const result = await pool.query<RawStatusObligationRow>(
      `SELECT phone_number_id, provider_message_id, provider_status,
              provider_status_at, provider_failure_code,
              provider_status_version, callback_attempts, callback_pending
       FROM sent_question_replies
       WHERE callback_pending = true
         AND COALESCE(callback_next_attempt_at, now()) <= now()
         AND provider_message_id IS NOT NULL
         AND provider_status IS NOT NULL
         AND provider_status_at IS NOT NULL
       ORDER BY callback_next_attempt_at ASC NULLS FIRST, updated_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapObligation);
  },
};

async function postStatusCallback(
  payload: QuestionReplyStatusCallbackPayload
): Promise<void> {
  await axios.post(
    `${RECEPS_INTERNAL_API_URL}/api/v1/bot/question-replies/status-callback`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );
}

export interface WhatsAppStatusDeps {
  store: WhatsAppStatusStore;
  postCallback: (payload: QuestionReplyStatusCallbackPayload) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultDeps: WhatsAppStatusDeps = {
  store: pgWhatsAppStatusStore,
  postCallback: postStatusCallback,
  wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function callbackFailureCode(error: unknown): string {
  const status = safeHttpStatus(error);
  if (status !== null) return `CALLBACK_HTTP_${status}`;
  return sanitizeFailureCode(`CALLBACK_${runtimeErrorKind(error)}`);
}

function callbackBackoffMs(attempts: number): number {
  return Math.min(10 * 60_000, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 9));
}

async function attemptStatusCallbackOnce(
  obligation: StatusCallbackObligation,
  deps: WhatsAppStatusDeps,
  attempts: number
): Promise<{ delivered: boolean; stillCurrent: boolean }> {
  try {
    await deps.postCallback({
      phoneNumberId: obligation.phoneNumberId,
      providerMessageId: obligation.providerMessageId,
      statusEvent: obligation.statusEvent,
      occurredAt: obligation.occurredAt,
      failureCode: obligation.failureCode,
    });
    const acknowledged = await deps.store.markCallbackAck(
      obligation.providerMessageId,
      obligation.statusEvent,
      obligation.version
    );
    // CAS falso significa que um status mais novo venceu; nunca o apagamos.
    return { delivered: true, stillCurrent: acknowledged };
  } catch (error) {
    const now = deps.now?.() ?? Date.now();
    const persisted = await deps.store.markCallbackFailure(
      obligation.providerMessageId,
      obligation.statusEvent,
      obligation.version,
      attempts,
      new Date(now + callbackBackoffMs(attempts)),
      callbackFailureCode(error)
    );
    return { delivered: false, stillCurrent: persisted };
  }
}

async function postCallbackWithRetries(
  obligation: StatusCallbackObligation,
  deps: WhatsAppStatusDeps
): Promise<boolean> {
  let attempts = obligation.attempts;
  for (
    let attempt = 0;
    attempt <= STATUS_CALLBACK_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await deps.wait(STATUS_CALLBACK_RETRY_DELAYS_MS[attempt - 1]);
    }
    attempts += 1;
    const result = await attemptStatusCallbackOnce(obligation, deps, attempts);
    if (result.delivered || !result.stillCurrent) return result.delivered;
  }

  Sentry.captureException(
    new Error('whatsapp status callback retries exhausted'),
    {
      level: 'warning',
      tags: {
        service: 'whatsapp_status_handler',
        operation: 'status_callback',
        phoneNumberHash: technicalHash(obligation.phoneNumberId),
        providerMessageHash: technicalHash(obligation.providerMessageId),
        status: obligation.statusEvent,
        failure_code: 'CALLBACK_RETRIES_EXHAUSTED',
      },
    }
  );
  console.warn(
    `[whatsapp-status] callback pendente após retries | phoneNumberHash=${technicalHash(
      obligation.phoneNumberId
    )} | providerMessageHash=${technicalHash(
      obligation.providerMessageId
    )} | status=${obligation.statusEvent}`
  );
  return false;
}

let unknownProviderCount = 0;
let ignoredTransitionCount = 0;

/** Status real: fato+obrigação primeiro; callback durável e retomável depois. */
export async function handleWhatsAppStatuses(
  value: unknown,
  deps: WhatsAppStatusDeps = defaultDeps
): Promise<number> {
  const events = parseWhatsAppStatuses(value);
  let applied = 0;

  for (const event of events) {
    try {
      const local = await deps.store.apply(event);
      if (local.kind === 'unknown') {
        unknownProviderCount += 1;
        console.warn(
          `[whatsapp-status] provider desconhecido ignorado | providerMessageHash=${technicalHash(
            event.providerMessageId
          )}`
        );
        continue;
      }
      if (local.kind === 'noop') {
        ignoredTransitionCount += 1;
        continue;
      }
      if (local.kind === 'reactivated') {
        ignoredTransitionCount += 1;
      } else {
        applied += 1;
      }

      await postCallbackWithRetries(local.obligation, deps);
    } catch (error) {
      Sentry.captureException(new Error('whatsapp status processing failed'), {
        level: 'warning',
        tags: {
          service: 'whatsapp_status_handler',
          operation: 'process_status',
          providerMessageHash: technicalHash(event.providerMessageId),
          status: event.statusEvent,
          error_kind: runtimeErrorKind(error),
        },
      });
    }
  }

  return applied;
}

export async function sweepWhatsAppStatusCallbacks(
  deps: WhatsAppStatusDeps = defaultDeps,
  limit = 100
): Promise<{ attempted: number; acknowledged: number }> {
  const obligations = await deps.store.listPendingCallbacks(limit);
  let acknowledged = 0;
  for (const obligation of obligations) {
    const result = await attemptStatusCallbackOnce(
      obligation,
      deps,
      obligation.attempts + 1
    );
    if (result.delivered) acknowledged += 1;
  }
  return { attempted: obligations.length, acknowledged };
}

interface CallbackSweepRuntime {
  timer: NodeJS.Timeout | null;
  running: boolean;
}

const CALLBACK_SWEEP_RUNTIME_KEY = Symbol.for(
  'ana.whatsapp-status-callback-sweep.runtime.v1'
);

function callbackSweepRuntime(): CallbackSweepRuntime {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[CALLBACK_SWEEP_RUNTIME_KEY] as
    | CallbackSweepRuntime
    | undefined;
  if (existing) return existing;
  const created = { timer: null, running: false };
  globals[CALLBACK_SWEEP_RUNTIME_KEY] = created;
  return created;
}

export function startWhatsAppStatusCallbackSweep(
  deps: WhatsAppStatusDeps = defaultDeps,
  intervalMs = STATUS_CALLBACK_SWEEP_INTERVAL_MS
): boolean {
  const runtime = callbackSweepRuntime();
  if (runtime.timer) return false;
  runtime.timer = setInterval(() => {
    if (runtime.running) return;
    runtime.running = true;
    void sweepWhatsAppStatusCallbacks(deps)
      .catch((error) => {
        Sentry.captureException(new Error('whatsapp status callback sweep failed'), {
          level: 'warning',
          tags: {
            service: 'whatsapp_status_handler',
            operation: 'callback_sweep',
            error_kind: runtimeErrorKind(error),
          },
        });
      })
      .finally(() => {
        runtime.running = false;
      });
  }, intervalMs);
  runtime.timer.unref();
  return true;
}

export function getWhatsAppStatusCountersForTest(): {
  unknownProviderCount: number;
  ignoredTransitionCount: number;
} {
  return { unknownProviderCount, ignoredTransitionCount };
}

export function resetWhatsAppStatusCountersForTest(): void {
  unknownProviderCount = 0;
  ignoredTransitionCount = 0;
}

export function __resetWhatsAppStatusCallbackSweepForTest(): void {
  const runtime = callbackSweepRuntime();
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.running = false;
}
