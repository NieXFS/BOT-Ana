import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../contextManager';
import { sanitizeFailureCode } from '../questionReplyService';
import { opaqueReceiptHashV2 } from './receipts';
import type {
  ProviderDeliveryStatusReceiptV2,
  ProviderDeliveryStatusV2,
} from './contracts';

/**
 * Janela em que um status sem outbox continua sendo uma obrigação pendente.
 * O sweeper tenta a correlação imediatamente; só depois desta janela marca o
 * evento como unmatched. Isso evita transformar uma corrida legítima entre o
 * callback da Meta e o commit do outbox em perda de status.
 */
export const PROVIDER_STATUS_MATCH_HORIZON_MS_V2 = 24 * 60 * 60 * 1_000;
export const PROVIDER_STATUS_INITIAL_BACKOFF_MS_V2 = 1_000;
export const PROVIDER_STATUS_MAX_BACKOFF_MS_V2 = 10 * 60_000;
export const PROVIDER_STATUS_RECOVERY_INTERVAL_MS_V2 = 60_000;

export const PROVIDER_STATUS_EVENTS_V2 = [
  'sent',
  'delivered',
  'read',
  'failed',
] as const;

export type ProviderStatusEventStateV2 =
  | 'pending'
  | 'applied'
  | 'noop'
  | 'unmatched';

export interface ProviderStatusIngestInputV2 {
  /** WAMID cru: permanece somente na memória desta chamada. */
  providerMessageId?: string;
  /** Hashed form is accepted by reconcilers that already discarded the raw id. */
  providerMessageIdHash?: string;
  providerStatus?: ProviderDeliveryStatusV2;
  /** Alias do parser legado (`WhatsAppStatusEvent.statusEvent`). */
  statusEvent?: ProviderDeliveryStatusV2;
  occurredAt: string;
  failureCode: string | null;
  observedAt?: Date;
}

export interface ProviderStatusEventRecordV2 {
  statusReceiptId: string;
  providerMessageIdHash: string;
  statusEvent: ProviderDeliveryStatusV2;
  occurredAt: string;
  failureCode: string | null;
  deliveryAttemptId: string | null;
  turnId: string | null;
  deliveryReceiptId: string | null;
  state: ProviderStatusEventStateV2;
  attempts: number;
  nextAttemptAt: string;
  observedAt: string;
  updatedAt: string;
}

export interface ProviderStatusOutboxTargetV2 {
  deliveryAttemptId: string;
  turnId: string;
  deliveryReceiptId: string;
  providerMessageIdHash: string;
  providerStatus: ProviderDeliveryStatusV2 | null;
  providerStatusAt: string | null;
  providerFailureCode: string | null;
  providerStatusVersion: number;
  /** Only accepted/accepted-uncommitted outboxes are eligible. */
  outboxState?: string;
}

export interface ProviderStatusIngestResultV2 {
  state: ProviderStatusEventStateV2;
  event: ProviderStatusEventRecordV2;
  receipt: ProviderDeliveryStatusReceiptV2 | null;
  transitionApplied: boolean;
  duplicate: boolean;
}

export interface ProviderStatusSweepResultV2 {
  attempted: number;
  applied: number;
  unmatched: number;
  /** Applied transitions are returned so the caller can emit one warning. */
  appliedEvents?: ProviderStatusIngestResultV2[];
}

export interface ProviderStatusDigestRowV2 {
  acceptedByProvider: boolean;
  providerStatus: ProviderDeliveryStatusV2 | null;
  providerFailureCode: string | null;
}

export interface ProviderStatusDigestV2 {
  acceptedByProvider: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  awaitingStatus: number;
  failuresByCode: Record<string, number>;
}

export interface ProviderStatusDigestProjectionInputV2 {
  acceptedAt: string | Date | null;
  providerStatus: ProviderDeliveryStatusV2 | null;
  providerStatusAt: string | Date | null;
  providerFailureCode: string | null;
}

export interface ProviderStatusStoreV2 {
  ingest(input: ProviderStatusIngestInputV2): Promise<ProviderStatusIngestResultV2>;
  sweep(now?: Date): Promise<ProviderStatusSweepResultV2>;
  listEvents?(): Promise<ProviderStatusEventRecordV2[]>;
}

export interface ProviderStatusStoreTestSurfaceV2 extends ProviderStatusStoreV2 {
  registerOutbox(target: ProviderStatusOutboxTargetV2): void;
  getOutbox(providerMessageIdHash: string): ProviderStatusOutboxTargetV2 | null;
  getEvents(): ProviderStatusEventRecordV2[];
}

export function hashProviderMessageIdV2(providerMessageId: string): string {
  return opaqueReceiptHashV2(providerMessageId);
}

function dayBoundsUtc(targetDay: string): { start: number; end: number } {
  const start = Date.parse(`${targetDay}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error('invalid digest target day');
  return { start, end: start + 24 * 60 * 60_000 };
}

function isInDigestDay(value: string | Date | null, bounds: { start: number; end: number }): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= bounds.start && timestamp < bounds.end;
}

/**
 * Projects one outbox row for exactly one digest day. Acceptance and provider
 * status have independent clocks: an older acceptance with a later failure is
 * `acceptedByProvider` only on the acceptance day and `failed` only on the
 * status day, never both.
 */
export function projectProviderStatusForDigestDayV2(
  input: ProviderStatusDigestProjectionInputV2,
  targetDay: string
): ProviderStatusDigestRowV2 {
  const bounds = dayBoundsUtc(targetDay);
  const acceptedOnDay = isInDigestDay(input.acceptedAt, bounds);
  const statusOnDay = isInDigestDay(input.providerStatusAt, bounds);
  return {
    acceptedByProvider: acceptedOnDay,
    providerStatus: statusOnDay ? input.providerStatus : null,
    providerFailureCode: statusOnDay ? input.providerFailureCode : null,
  };
}

export function providerStatusBackoffMsV2(attempts: number): number {
  return Math.min(
    PROVIDER_STATUS_MAX_BACKOFF_MS_V2,
    PROVIDER_STATUS_INITIAL_BACKOFF_MS_V2 *
      2 ** Math.min(Math.max(attempts - 1, 0), 9)
  );
}

/**
 * Única matriz de transição para a projeção v2. O receipt terminal do POST não
 * participa desta função e nunca é reescrito por ela.
 */
export function canApplyProviderDeliveryStatusV2(
  current: ProviderDeliveryStatusV2 | null,
  next: ProviderDeliveryStatusV2
): boolean {
  if (current === null) return true;
  if (current === 'sent') {
    return next === 'delivered' || next === 'read' || next === 'failed';
  }
  if (current === 'delivered') return next === 'read';
  return false;
}

function normalizeFailureCode(code: string | null): string | null {
  if (!code) return null;
  return sanitizeFailureCode(code);
}

function inputProviderStatus(input: ProviderStatusIngestInputV2): ProviderDeliveryStatusV2 {
  const status = input.providerStatus ?? input.statusEvent;
  if (!status) throw new Error('provider status event missing');
  return status;
}

function inputProviderMessageHash(input: ProviderStatusIngestInputV2): string {
  if (input.providerMessageIdHash?.trim()) {
    const provided = input.providerMessageIdHash.trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(provided)
      ? provided
      : opaqueReceiptHashV2(provided);
  }
  if (input.providerMessageId?.trim()) {
    return hashProviderMessageIdV2(input.providerMessageId);
  }
  throw new Error('provider message hash missing');
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function makeReceipt(
  event: ProviderStatusEventRecordV2
): ProviderDeliveryStatusReceiptV2 | null {
  if (
    event.state !== 'applied' ||
    !event.deliveryAttemptId ||
    !event.turnId ||
    !event.deliveryReceiptId
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    statusReceiptId: event.statusReceiptId,
    turnId: event.turnId,
    deliveryReceiptId: event.deliveryReceiptId,
    deliveryAttemptId: event.deliveryAttemptId,
    providerMessageIdHash: event.providerMessageIdHash,
    providerStatus: event.statusEvent,
    occurredAt: event.occurredAt,
    failureCode: event.failureCode,
    observedAt: event.observedAt,
  };
}

function rowToEvent(row: RawProviderStatusEventRowV2): ProviderStatusEventRecordV2 {
  return {
    statusReceiptId: row.status_receipt_id,
    providerMessageIdHash: row.provider_message_id_hash,
    statusEvent: row.status_event,
    occurredAt: iso(row.occurred_at),
    failureCode: row.failure_code,
    deliveryAttemptId: row.delivery_attempt_id,
    turnId: row.turn_id,
    deliveryReceiptId: row.delivery_receipt_id,
    state: row.state,
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    observedAt: iso(row.observed_at),
    updatedAt: iso(row.updated_at),
  };
}

interface RawProviderStatusEventRowV2 {
  status_receipt_id: string;
  provider_message_id_hash: string;
  status_event: ProviderDeliveryStatusV2;
  occurred_at: Date | string;
  failure_code: string | null;
  delivery_attempt_id: string | null;
  turn_id: string | null;
  delivery_receipt_id: string | null;
  state: ProviderStatusEventStateV2;
  attempts: number | string;
  next_attempt_at: Date | string;
  observed_at: Date | string;
  updated_at: Date | string;
}

interface RawProviderStatusOutboxRowV2 {
  delivery_attempt_id: string;
  turn_id: string;
  provider_message_id_hash: string;
  provider_status: ProviderDeliveryStatusV2 | null;
  provider_status_at: Date | string | null;
  provider_failure_code: string | null;
  provider_status_version: number | string;
  outbox_state: string;
  delivery_receipt_id: string | null;
}

function outboxFromRow(
  row: RawProviderStatusOutboxRowV2
): ProviderStatusOutboxTargetV2 {
  return {
    deliveryAttemptId: row.delivery_attempt_id,
    turnId: row.turn_id,
    deliveryReceiptId: row.delivery_receipt_id ?? '',
    providerMessageIdHash: row.provider_message_id_hash,
    providerStatus: row.provider_status,
    providerStatusAt: row.provider_status_at ? iso(row.provider_status_at) : null,
    providerFailureCode: row.provider_failure_code,
    providerStatusVersion: Number(row.provider_status_version ?? 0),
    outboxState: row.outbox_state,
  };
}

function eligibleOutbox(target: ProviderStatusOutboxTargetV2): boolean {
  return (
    Boolean(target.providerMessageIdHash) &&
    Boolean(target.deliveryAttemptId) &&
    Boolean(target.turnId) &&
    Boolean(target.deliveryReceiptId) &&
    (target.outboxState === undefined ||
      target.outboxState === 'accepted_by_provider' ||
      target.outboxState === 'accepted_uncommitted')
  );
}

function buildMemoryEvent(
  input: ProviderStatusIngestInputV2,
  observedAt: Date,
  statusReceiptId: string,
  state: ProviderStatusEventStateV2,
  target: ProviderStatusOutboxTargetV2 | null,
  providerMessageIdHash: string
): ProviderStatusEventRecordV2 {
  const observed = observedAt.toISOString();
  return {
    statusReceiptId,
    providerMessageIdHash,
    statusEvent: inputProviderStatus(input),
    occurredAt: input.occurredAt,
    failureCode: normalizeFailureCode(input.failureCode),
    deliveryAttemptId: target?.deliveryAttemptId ?? null,
    turnId: target?.turnId ?? null,
    deliveryReceiptId: target?.deliveryReceiptId ?? null,
    state,
    attempts: 0,
    nextAttemptAt: observed,
    observedAt: observed,
    updatedAt: observed,
  };
}

function isOlderThanCurrent(
  target: ProviderStatusOutboxTargetV2,
  occurredAt: string
): boolean {
  return (
    target.providerStatusAt !== null &&
    Date.parse(occurredAt) <= Date.parse(target.providerStatusAt)
  );
}

function scheduleMemoryPendingAttempt(
  event: ProviderStatusEventRecordV2,
  now: Date
): void {
  event.attempts += 1;
  event.nextAttemptAt = new Date(
    now.getTime() + providerStatusBackoffMsV2(event.attempts)
  ).toISOString();
  event.updatedAt = now.toISOString();
}

function applyMemoryEvent(
  event: ProviderStatusEventRecordV2,
  target: ProviderStatusOutboxTargetV2,
  now: Date
): ProviderStatusIngestResultV2 {
  event.deliveryAttemptId = target.deliveryAttemptId;
  event.turnId = target.turnId;
  event.deliveryReceiptId = target.deliveryReceiptId;
  const current = target.providerStatus;
  const shouldApply =
    !isOlderThanCurrent(target, event.occurredAt) &&
    canApplyProviderDeliveryStatusV2(current, event.statusEvent);
  if (!shouldApply) {
    event.state = 'noop';
    event.updatedAt = now.toISOString();
    return {
      state: 'noop',
      event,
      receipt: null,
      transitionApplied: false,
      duplicate: false,
    };
  }
  target.providerStatus = event.statusEvent;
  target.providerStatusAt = event.occurredAt;
  target.providerFailureCode =
    event.statusEvent === 'failed' ? event.failureCode : null;
  target.providerStatusVersion += 1;
  event.state = 'applied';
  event.updatedAt = now.toISOString();
  return {
    state: 'applied',
    event,
    receipt: makeReceipt(event),
    transitionApplied: true,
    duplicate: false,
  };
}

/**
 * In-memory implementation used by the deterministic provider-status smoke.
 * It mirrors the PG store's transaction boundary synchronously: an event and
 * its outbox projection are changed as one operation, with no network/DB I/O.
 */
export class MemoryProviderStatusStoreV2
  implements ProviderStatusStoreTestSurfaceV2
{
  readonly events = new Map<string, ProviderStatusEventRecordV2>();
  readonly outbox = new Map<string, ProviderStatusOutboxTargetV2>();

  registerOutbox(target: ProviderStatusOutboxTargetV2): void {
    this.outbox.set(target.providerMessageIdHash, { ...target });
  }

  getOutbox(providerMessageIdHash: string): ProviderStatusOutboxTargetV2 | null {
    const target = this.outbox.get(providerMessageIdHash);
    return target ? { ...target } : null;
  }

  getEvents(): ProviderStatusEventRecordV2[] {
    return [...this.events.values()].map((event) => ({ ...event }));
  }

  async listEvents(): Promise<ProviderStatusEventRecordV2[]> {
    return this.getEvents();
  }

  async ingest(input: ProviderStatusIngestInputV2): Promise<ProviderStatusIngestResultV2> {
    const observedAt = input.observedAt ?? new Date();
    const hash = inputProviderMessageHash(input);
    const status = inputProviderStatus(input);
    const duplicateKey = `${hash}|${status}|${input.occurredAt}`;
    const existing = this.events.get(duplicateKey);
    if (existing) {
      const target = this.outbox.get(hash);
      if (existing.state === 'pending' && target && eligibleOutbox(target)) {
        const result = applyMemoryEvent(existing, target, observedAt);
        result.duplicate = true;
        return result;
      }
      if (
        existing.state === 'pending' &&
        observedAt.getTime() >= Date.parse(existing.nextAttemptAt)
      ) {
        scheduleMemoryPendingAttempt(existing, observedAt);
      }
      return {
        state: existing.state,
        event: { ...existing },
        receipt: makeReceipt(existing),
        transitionApplied: false,
        duplicate: true,
      };
    }

    const target = this.outbox.get(hash) ?? null;
    const event = buildMemoryEvent(
      input,
      observedAt,
      randomUUID(),
      target && eligibleOutbox(target) ? 'pending' : 'pending',
      target && eligibleOutbox(target) ? target : null,
      hash
    );
    this.events.set(duplicateKey, event);
    if (!target || !eligibleOutbox(target)) {
      scheduleMemoryPendingAttempt(event, observedAt);
      return {
        state: 'pending',
        event: { ...event },
        receipt: null,
        transitionApplied: false,
        duplicate: false,
      };
    }
    return applyMemoryEvent(event, target, observedAt);
  }

  async sweep(now = new Date()): Promise<ProviderStatusSweepResultV2> {
    let attempted = 0;
    let applied = 0;
    let unmatched = 0;
    const appliedEvents: ProviderStatusIngestResultV2[] = [];
    for (const event of this.events.values()) {
      if (event.state !== 'pending') continue;
      if (Date.parse(event.nextAttemptAt) > now.getTime()) continue;
      attempted += 1;
      const target = this.outbox.get(event.providerMessageIdHash);
      if (target && eligibleOutbox(target)) {
        const result = applyMemoryEvent(event, target, now);
        if (result.transitionApplied) {
          applied += 1;
          appliedEvents.push(result);
        }
        continue;
      }
      if (
        now.getTime() - Date.parse(event.observedAt) >=
        PROVIDER_STATUS_MATCH_HORIZON_MS_V2
      ) {
        event.state = 'unmatched';
        event.attempts += 1;
        event.nextAttemptAt = now.toISOString();
        event.updatedAt = now.toISOString();
        unmatched += 1;
      } else {
        scheduleMemoryPendingAttempt(event, now);
      }
    }
    return { attempted, applied, unmatched, appliedEvents };
  }
}

async function selectProviderStatusEvent(
  client: Pick<PoolClient, 'query'>,
  statusReceiptId: string
): Promise<ProviderStatusEventRecordV2 | null> {
  const result = await client.query<RawProviderStatusEventRowV2>(
    `SELECT status_receipt_id, provider_message_id_hash, status_event,
            occurred_at, failure_code, delivery_attempt_id, turn_id,
            delivery_receipt_id, state, attempts, next_attempt_at,
            observed_at, updated_at
       FROM ana_v2_provider_status_events
      WHERE status_receipt_id = $1
      FOR UPDATE`,
    [statusReceiptId]
  );
  return result.rows[0] ? rowToEvent(result.rows[0]) : null;
}

async function selectProviderStatusOutbox(
  client: Pick<PoolClient, 'query'>,
  providerMessageIdHash: string
): Promise<ProviderStatusOutboxTargetV2 | null> {
  const result = await client.query<RawProviderStatusOutboxRowV2>(
    `SELECT o.delivery_attempt_id, o.turn_id, o.provider_message_id_hash,
            o.provider_status, o.provider_status_at,
            o.provider_failure_code, o.provider_status_version, o.state AS outbox_state,
            o.commit_payload_json->'deliveryReceipt'->>'deliveryReceiptId'
              AS delivery_receipt_id
       FROM ana_v2_outbound_outbox o
      WHERE o.provider_message_id_hash = $1
      ORDER BY o.updated_at DESC
      LIMIT 1
      FOR UPDATE`,
    [providerMessageIdHash]
  );
  return result.rows[0] ? outboxFromRow(result.rows[0]) : null;
}

async function ingestPgByHash(
  client: PoolClient,
  input: {
    providerMessageIdHash: string;
    providerStatus: ProviderDeliveryStatusV2;
    occurredAt: string;
    failureCode: string | null;
    observedAt: Date;
    statusReceiptId: string;
  }
): Promise<ProviderStatusIngestResultV2> {
  const existing = await selectProviderStatusEvent(client, input.statusReceiptId);
  const event = existing ?? {
    statusReceiptId: input.statusReceiptId,
    providerMessageIdHash: input.providerMessageIdHash,
    statusEvent: input.providerStatus,
    occurredAt: input.occurredAt,
    failureCode: input.failureCode,
    deliveryAttemptId: null,
    turnId: null,
    deliveryReceiptId: null,
    state: 'pending' as const,
    attempts: 0,
    nextAttemptAt: input.observedAt.toISOString(),
    observedAt: input.observedAt.toISOString(),
    updatedAt: input.observedAt.toISOString(),
  };

  if (event.state === 'applied' || event.state === 'noop' || event.state === 'unmatched') {
    return {
      state: event.state,
      event,
      receipt: makeReceipt(event),
      transitionApplied: false,
      duplicate: true,
    };
  }

  const target = await selectProviderStatusOutbox(
    client,
    input.providerMessageIdHash
  );
  if (!target || !eligibleOutbox(target)) {
    if (
      Date.parse(event.nextAttemptAt) > input.observedAt.getTime()
    ) {
      return {
        state: 'pending',
        event,
        receipt: null,
        transitionApplied: false,
        duplicate: Boolean(existing),
      };
    }
    const nextAttempt = new Date(
      input.observedAt.getTime() + providerStatusBackoffMsV2(event.attempts + 1)
    );
    await client.query(
      `UPDATE ana_v2_provider_status_events
          SET attempts = attempts + 1,
              next_attempt_at = $3,
              updated_at = $2
        WHERE status_receipt_id = $1`,
      [event.statusReceiptId, input.observedAt, nextAttempt]
    );
    return {
      state: 'pending',
      event: {
        ...event,
        attempts: event.attempts + 1,
        nextAttemptAt: nextAttempt.toISOString(),
        updatedAt: input.observedAt.toISOString(),
      },
      receipt: null,
      transitionApplied: false,
      duplicate: Boolean(existing),
    };
  }

  const shouldApply =
    !isOlderThanCurrent(target, event.occurredAt) &&
    canApplyProviderDeliveryStatusV2(target.providerStatus, event.statusEvent);
  const nextState: ProviderStatusEventStateV2 = shouldApply ? 'applied' : 'noop';
  const linkage = {
    deliveryAttemptId: target.deliveryAttemptId,
    turnId: target.turnId,
    deliveryReceiptId: target.deliveryReceiptId,
  };
  const nextEvent: ProviderStatusEventRecordV2 = {
    ...event,
    ...linkage,
    state: nextState,
    attempts: event.attempts + 1,
    updatedAt: input.observedAt.toISOString(),
  };

  if (shouldApply) {
    await client.query(
      `UPDATE ana_v2_outbound_outbox
          SET provider_status = $2,
              provider_status_at = $3,
              provider_failure_code = $4,
              provider_status_version = provider_status_version + 1,
              updated_at = $5
        WHERE delivery_attempt_id = $1
          AND provider_message_id_hash = $6`,
      [
        target.deliveryAttemptId,
        event.statusEvent,
        event.occurredAt,
        event.statusEvent === 'failed' ? event.failureCode : null,
        input.observedAt,
        input.providerMessageIdHash,
      ]
    );
  }
  await client.query(
    `UPDATE ana_v2_provider_status_events
        SET delivery_attempt_id = $2,
            turn_id = $3,
            delivery_receipt_id = $4,
            state = $5,
            attempts = $6,
            updated_at = $7
      WHERE status_receipt_id = $1`,
    [
      event.statusReceiptId,
      linkage.deliveryAttemptId,
      linkage.turnId,
      linkage.deliveryReceiptId,
      nextState,
      nextEvent.attempts,
      input.observedAt,
    ]
  );
  return {
    state: nextState,
    event: nextEvent,
    receipt: shouldApply ? makeReceipt(nextEvent) : null,
    transitionApplied: shouldApply,
    duplicate: Boolean(existing),
  };
}

/** Creates the additive inbox/projection tables used by the v2 status path. */
export async function ensureProviderStatusV2Tables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_provider_status_events (
      status_receipt_id text PRIMARY KEY,
      provider_message_id_hash text NOT NULL,
      status_event text NOT NULL CHECK (status_event IN ('sent','delivered','read','failed')),
      occurred_at timestamptz NOT NULL,
      failure_code text,
      delivery_attempt_id text,
      turn_id text,
      delivery_receipt_id text,
      state text NOT NULL CHECK (state IN ('pending','applied','noop','unmatched')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      observed_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_message_id_hash, status_event, occurred_at)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_provider_status_events_pending_idx
      ON ana_v2_provider_status_events (next_attempt_at, observed_at)
     WHERE state = 'pending'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_provider_status_events_hash_idx
      ON ana_v2_provider_status_events (provider_message_id_hash, occurred_at DESC)
  `);
}

export const pgProviderStatusStoreV2: ProviderStatusStoreV2 = {
  async ingest(input) {
    const observedAt = input.observedAt ?? new Date();
    const providerMessageIdHash = inputProviderMessageHash(input);
    const providerStatus = inputProviderStatus(input);
    const failureCode = normalizeFailureCode(input.failureCode);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ status_receipt_id: string }>(
        `INSERT INTO ana_v2_provider_status_events (
           status_receipt_id, provider_message_id_hash, status_event,
           occurred_at, failure_code, state, attempts,
           next_attempt_at, observed_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'pending',0,$6,$6,$6)
         ON CONFLICT (provider_message_id_hash, status_event, occurred_at)
         DO NOTHING
         RETURNING status_receipt_id`,
        [
          randomUUID(),
          providerMessageIdHash,
          providerStatus,
          input.occurredAt,
          failureCode,
          observedAt,
        ]
      );
      let statusReceiptId = inserted.rows[0]?.status_receipt_id;
      if (!statusReceiptId) {
        const duplicate = await client.query<{ status_receipt_id: string }>(
          `SELECT status_receipt_id
             FROM ana_v2_provider_status_events
            WHERE provider_message_id_hash = $1
              AND status_event = $2
              AND occurred_at = $3
            FOR UPDATE`,
          [providerMessageIdHash, providerStatus, input.occurredAt]
        );
        statusReceiptId = duplicate.rows[0]?.status_receipt_id;
      }
      if (!statusReceiptId) throw new Error('provider status inbox row missing');
      const result = await ingestPgByHash(client, {
        providerMessageIdHash,
        providerStatus,
        occurredAt: input.occurredAt,
        failureCode,
        observedAt,
        statusReceiptId,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the local persistence error as the source of the webhook 500.
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async sweep(now = new Date()) {
    const pending = await pool.query<RawProviderStatusEventRowV2>(
      `SELECT status_receipt_id, provider_message_id_hash, status_event,
              occurred_at, failure_code, delivery_attempt_id, turn_id,
              delivery_receipt_id, state, attempts, next_attempt_at,
              observed_at, updated_at
        FROM ana_v2_provider_status_events
        WHERE state = 'pending'
          AND next_attempt_at <= $1
        ORDER BY next_attempt_at ASC, observed_at ASC
        LIMIT 100`,
      [now]
    );
    let applied = 0;
    let unmatched = 0;
    const appliedEvents: ProviderStatusIngestResultV2[] = [];
    for (const row of pending.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await ingestPgByHash(client, {
          providerMessageIdHash: row.provider_message_id_hash,
          providerStatus: row.status_event,
          occurredAt: iso(row.occurred_at),
          failureCode: row.failure_code,
          observedAt: now,
          statusReceiptId: row.status_receipt_id,
        });
        if (result.transitionApplied) {
          applied += 1;
          appliedEvents.push(result);
        }
        if (
          result.state === 'pending' &&
          now.getTime() - Date.parse(result.event.observedAt) >=
            PROVIDER_STATUS_MATCH_HORIZON_MS_V2
        ) {
          await client.query(
            `UPDATE ana_v2_provider_status_events
                SET state = 'unmatched', attempts = $2,
                    next_attempt_at = $3, updated_at = $3
              WHERE status_receipt_id = $1 AND state = 'pending'`,
            [row.status_receipt_id, result.event.attempts, now]
          );
          unmatched += 1;
        }
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* preserve next sweep */
        }
      } finally {
        client.release();
      }
    }
    return { attempted: pending.rows.length, applied, unmatched, appliedEvents };
  },

  async listEvents() {
    const result = await pool.query<RawProviderStatusEventRowV2>(
      `SELECT status_receipt_id, provider_message_id_hash, status_event,
              occurred_at, failure_code, delivery_attempt_id, turn_id,
              delivery_receipt_id, state, attempts, next_attempt_at,
              observed_at, updated_at
         FROM ana_v2_provider_status_events
        ORDER BY observed_at ASC, status_receipt_id ASC`,
      []
    );
    return result.rows.map(rowToEvent);
  },
};

/**
 * Recovery estritamente local para status v2 que chegou antes do outbox.
 * A única dependência executada é o store local; não há callback ERP, reparo
 * de histórico, transporte WhatsApp ou observabilidade remota neste caminho.
 */
export async function sweepProviderStatusRecoveryV2(
  store: ProviderStatusStoreV2 = pgProviderStatusStoreV2,
  now = new Date()
): Promise<ProviderStatusSweepResultV2> {
  return store.sweep(now);
}

interface ProviderStatusRecoveryRuntimeV2 {
  timer: NodeJS.Timeout | null;
  running: boolean;
}

const PROVIDER_STATUS_RECOVERY_RUNTIME_KEY_V2 = Symbol.for(
  'ana.provider-status-v2-recovery.runtime.v1'
);

function providerStatusRecoveryRuntimeV2(): ProviderStatusRecoveryRuntimeV2 {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[PROVIDER_STATUS_RECOVERY_RUNTIME_KEY_V2] as
    | ProviderStatusRecoveryRuntimeV2
    | undefined;
  if (existing) return existing;
  const created = { timer: null, running: false };
  globals[PROVIDER_STATUS_RECOVERY_RUNTIME_KEY_V2] = created;
  return created;
}

export function startProviderStatusRecoverySweepV2(
  store: ProviderStatusStoreV2 = pgProviderStatusStoreV2,
  intervalMs = PROVIDER_STATUS_RECOVERY_INTERVAL_MS_V2
): boolean {
  const runtime = providerStatusRecoveryRuntimeV2();
  if (runtime.timer) return false;
  runtime.timer = setInterval(() => {
    if (runtime.running) return;
    runtime.running = true;
    void sweepProviderStatusRecoveryV2(store)
      .catch(() => {
        // Mensagem constante e local: não inclui driver, URL, WAMID ou PII.
        console.warn('[provider-status-v2] recovery local falhou');
      })
      .finally(() => {
        runtime.running = false;
      });
  }, intervalMs);
  runtime.timer.unref();
  return true;
}

/** Pure digest projection shared by the daily digest and deterministic smoke. */
export function buildProviderStatusDigestV2(
  rows: readonly ProviderStatusDigestRowV2[]
): ProviderStatusDigestV2 {
  const digest: ProviderStatusDigestV2 = {
    acceptedByProvider: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    awaitingStatus: 0,
    failuresByCode: {},
  };
  for (const row of rows) {
    if (row.acceptedByProvider) digest.acceptedByProvider += 1;
    if (row.providerStatus === null) {
      if (row.acceptedByProvider) digest.awaitingStatus += 1;
      continue;
    }
    switch (row.providerStatus) {
      case 'sent':
        digest.sent += 1;
        break;
      case 'delivered':
        digest.delivered += 1;
        break;
      case 'read':
        digest.read += 1;
        break;
      case 'failed':
        digest.failed += 1;
        break;
    }
    if (row.providerStatus === 'failed') {
      const code = row.providerFailureCode ?? 'META_FAILED';
      digest.failuresByCode[code] = (digest.failuresByCode[code] ?? 0) + 1;
    }
  }
  return digest;
}

/** Small adapter useful when a caller already has a memory outbox map. */
export function providerStatusTargetFromDeliveryV2(input: {
  deliveryAttemptId: string;
  turnId: string;
  deliveryReceiptId: string;
  providerMessageIdHash: string | null;
  state: string;
  providerStatus?: ProviderDeliveryStatusV2 | null;
  providerStatusAt?: string | null;
  providerFailureCode?: string | null;
  providerStatusVersion?: number;
}): ProviderStatusOutboxTargetV2 | null {
  if (!input.providerMessageIdHash) return null;
  return {
    deliveryAttemptId: input.deliveryAttemptId,
    turnId: input.turnId,
    deliveryReceiptId: input.deliveryReceiptId,
    providerMessageIdHash: input.providerMessageIdHash,
    providerStatus: input.providerStatus ?? null,
    providerStatusAt: input.providerStatusAt ?? null,
    providerFailureCode: input.providerFailureCode ?? null,
    providerStatusVersion: input.providerStatusVersion ?? 0,
    outboxState: input.state,
  };
}
