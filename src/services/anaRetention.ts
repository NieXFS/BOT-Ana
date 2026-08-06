import type { PoolClient } from 'pg';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind } from '../observability/safeRuntime';
import { pool } from './contextManager';

export const ANA_RETENTION_WINDOW_MS = 90 * 24 * 60 * 60_000;
export const ANA_RETENTION_INTERVAL_MS = 6 * 60 * 60_000;

export interface AnaRetentionResult {
  cutoff: string;
  outboxTerminalized: number;
  history: number;
  outbox: number;
  processedMessages: number;
  sentQuestionReplies: number;
  conversationSequences: number;
}

export interface AnaRetentionState {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: AnaRetentionResult | null;
  lastError: string | null;
}

interface RetentionRuntime {
  timer: NodeJS.Timeout | null;
  inFlight: Promise<AnaRetentionResult> | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: AnaRetentionResult | null;
  lastError: string | null;
}

const RETENTION_RUNTIME_KEY = Symbol.for('ana.retention.runtime.v1');

function retentionRuntime(): RetentionRuntime {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[RETENTION_RUNTIME_KEY] as RetentionRuntime | undefined;
  if (existing) return existing;
  const created: RetentionRuntime = {
    timer: null,
    inFlight: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastResult: null,
    lastError: null,
  };
  globals[RETENTION_RUNTIME_KEY] = created;
  return created;
}

export interface AnaRetentionDeps {
  connect: () => Promise<PoolClient>;
  now: () => number;
}

const defaultDeps: AnaRetentionDeps = {
  connect: () => pool.connect(),
  now: Date.now,
};

async function executeAnaRetention(
  deps: AnaRetentionDeps,
  cutoff: Date
): Promise<AnaRetentionResult> {
  const client = await deps.connect();
  try {
    await client.query('BEGIN');

    // Primeiro fecha explicitamente retry vencido. O delete ocorre na mesma
    // transação, depois de o estado terminal coerente ter sido materializado.
    const terminalized = await client.query(
      `UPDATE inbound_event_outbox
       SET terminal_at = COALESCE(terminal_at, now()),
           failure_code = 'RETENTION_EXPIRED'
       WHERE received_at < $1
         AND delivered_at IS NULL
         AND terminal_at IS NULL`,
      [cutoff]
    );

    // Processed precisa sair antes de perdermos a correlação. Isso cobre replay
    // processado hoje cujo receivedAt/history já nasceu vencido há mais de 90d.
    const processed = await client.query(
      `DELETE FROM processed_messages p
       WHERE p.processed_at < $1
          OR EXISTS (
            SELECT 1 FROM ana_conversation_history h
            WHERE h.message_id = p.message_id
              AND h."createdAt" < $1
          )
          OR EXISTS (
            SELECT 1 FROM inbound_event_outbox o
            WHERE o.message_id = p.message_id
              AND o.received_at < $1
          )`,
      [cutoff]
    );

    // History ligado a outbox vencido morre junto, ainda que um relógio legado
    // tenha produzido createdAt divergente. Todo o restante obedece seu cutoff.
    const history = await client.query(
      `DELETE FROM ana_conversation_history h
       WHERE h."createdAt" < $1
          OR EXISTS (
            SELECT 1 FROM inbound_event_outbox expired
            WHERE expired.message_id = h.message_id
              AND expired.received_at < $1
          )`,
      [cutoff]
    );

    const outbox = await client.query(
      `DELETE FROM inbound_event_outbox
       WHERE received_at < $1`,
      [cutoff]
    );

    const replies = await client.query(
      `DELETE FROM sent_question_replies
       WHERE created_at < $1`,
      [cutoff]
    );

    // Sequência só deixa de existir quando nenhuma superfície operacional da
    // conversa a justifica. É bulk e independente da quantidade de conversas.
    const sequences = await client.query(
      `DELETE FROM ana_conversation_seq s
       WHERE NOT EXISTS (
         SELECT 1 FROM ana_conversation_history h
         WHERE h."conversationKey" = s.conversation_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM inbound_event_outbox o
         WHERE o.conversation_key = s.conversation_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM sent_question_replies r
         WHERE r.conversation_key = s.conversation_key
       )`
    );

    await client.query('COMMIT');
    return {
      cutoff: cutoff.toISOString(),
      outboxTerminalized: terminalized.rowCount ?? 0,
      history: history.rowCount ?? 0,
      outbox: outbox.rowCount ?? 0,
      processedMessages: processed.rowCount ?? 0,
      sentQuestionReplies: replies.rowCount ?? 0,
      conversationSequences: sequences.rowCount ?? 0,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserva a falha original e não imprime detalhes do banco.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Operação bulk transacional, com cutoff único e coalescência concorrente. */
export function runAnaRetention(
  deps: AnaRetentionDeps = defaultDeps
): Promise<AnaRetentionResult> {
  const runtime = retentionRuntime();
  if (runtime.inFlight) return runtime.inFlight;

  const startedAtMs = deps.now();
  const cutoff = new Date(startedAtMs - ANA_RETENTION_WINDOW_MS);
  runtime.lastStartedAt = new Date(startedAtMs).toISOString();
  runtime.lastError = null;

  const operation = executeAnaRetention(deps, cutoff)
    .then((result) => {
      runtime.lastResult = result;
      return result;
    })
    .catch((error) => {
      const errorKind = runtimeErrorKind(error);
      runtime.lastError = errorKind;
      Sentry.captureException(new Error('ana retention execution failed'), {
        level: 'warning',
        tags: {
          service: 'ana_retention',
          operation: 'run',
          error_kind: errorKind,
        },
      });
      console.error(`❌ Retenção Ana falhou | error=${errorKind}`);
      throw error;
    })
    .finally(() => {
      runtime.lastFinishedAt = new Date(deps.now()).toISOString();
      runtime.inFlight = null;
    });

  runtime.inFlight = operation;
  return operation;
}

/** Singleton real entre bundles: estado ancorado em globalThis/Symbol.for. */
export function startAnaRetentionScheduler(
  deps: AnaRetentionDeps = defaultDeps,
  intervalMs = ANA_RETENTION_INTERVAL_MS
): boolean {
  const runtime = retentionRuntime();
  if (runtime.timer) return false;
  runtime.timer = setInterval(() => {
    void runAnaRetention(deps).catch(() => undefined);
  }, intervalMs);
  runtime.timer.unref();
  return true;
}

export function getAnaRetentionState(): AnaRetentionState {
  const runtime = retentionRuntime();
  return {
    running: runtime.inFlight !== null,
    lastStartedAt: runtime.lastStartedAt,
    lastFinishedAt: runtime.lastFinishedAt,
    lastResult: runtime.lastResult ? { ...runtime.lastResult } : null,
    lastError: runtime.lastError,
  };
}

export function __resetAnaRetentionRuntimeForTest(): void {
  const runtime = retentionRuntime();
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.inFlight = null;
  runtime.lastStartedAt = null;
  runtime.lastFinishedAt = null;
  runtime.lastResult = null;
  runtime.lastError = null;
}
