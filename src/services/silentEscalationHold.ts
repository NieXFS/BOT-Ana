import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
  technicalHash,
} from '../observability/safeRuntime';
import { pool } from './contextManager';
import {
  canonicalConversationKey,
  canonicalCustomerPhone,
} from './conversationOrder';
import type { UnderstandingFailureDivergenceV2 } from './conversationalV2/divergence';

export const SILENT_ESCALATION_SWEEP_INTERVAL_MS = 10 * 60_000;
export const SILENT_ESCALATION_FAST_RETRY_DELAYS_MS = [100, 300] as const;
export const SILENT_ESCALATION_SWEEP_FLOOR_MS = 10 * 60_000;

export type SilentEscalationHoldStatus =
  | 'pending'
  | 'confirmed'
  | 'released'
  | 'active_elsewhere';

export class SilentEscalationHoldPersistenceError extends Error {
  readonly name = 'SilentEscalationHoldPersistenceError';
  constructor(message = 'silent escalation hold persist failed') {
    super(message);
  }
}

export interface SilentEscalationHoldRow {
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  sourceMessageId: string;
  status: SilentEscalationHoldStatus;
  questionId: string | null;
  attempts: number;
  nextRetryAt: Date;
  failureCode: string | null;
  divergence: UnderstandingFailureDivergenceV2;
}

export interface SilentEscalationHoldStore {
  ensure: (row: {
    conversationKey: string;
    phoneNumberId: string;
    customerPhone: string;
    sourceMessageId: string;
    divergence: UnderstandingFailureDivergenceV2;
    now: Date;
  }) => Promise<SilentEscalationHoldRow>;
  loadByMessageId: (sourceMessageId: string) => Promise<SilentEscalationHoldRow | null>;
  loadActiveByConversation: (
    conversationKey: string
  ) => Promise<SilentEscalationHoldRow | null>;
  markConfirmed: (
    sourceMessageId: string,
    questionId: string
  ) => Promise<void>;
  markActiveElsewhere: (sourceMessageId: string) => Promise<void>;
  markFailure: (
    sourceMessageId: string,
    attempts: number,
    nextRetryAt: Date,
    failureCode: string
  ) => Promise<void>;
  releaseByConversation: (conversationKey: string) => Promise<void>;
  listReady: (limit: number, now: Date) => Promise<string[]>;
}

/**
 * Resultado tri-state da leitura do hold local.
 *
 * `unknown` é deliberadamente distinto de `inactive`: depois de restart ou
 * de uma falha transitória do store, a recepcionista precisa permanecer em
 * silêncio até conseguir provar que não há hold pendente. O `errorKind` é
 * apenas técnico e nunca carrega a exceção, telefone ou conteúdo da conversa.
 */
export type SilentEscalationHoldLookupV2 =
  | { kind: 'active'; sourceMessageId?: string | null }
  | { kind: 'inactive' }
  | { kind: 'unknown'; errorKind: string };

interface RawHoldRow {
  conversation_key: string;
  phone_number_id: string;
  customer_phone: string;
  source_message_id: string;
  status: SilentEscalationHoldStatus;
  question_id: string | null;
  attempts: number | string;
  next_retry_at: Date;
  failure_code: string | null;
  divergence_json: UnderstandingFailureDivergenceV2;
}

function mapHold(row: RawHoldRow): SilentEscalationHoldRow {
  return {
    conversationKey: row.conversation_key,
    phoneNumberId: row.phone_number_id,
    customerPhone: row.customer_phone,
    sourceMessageId: row.source_message_id,
    status: row.status,
    questionId: row.question_id,
    attempts: Number(row.attempts),
    nextRetryAt: row.next_retry_at,
    failureCode: row.failure_code,
    divergence: row.divergence_json,
  };
}

const SELECT_HOLD = `SELECT conversation_key, phone_number_id, customer_phone,
        source_message_id, status, question_id, attempts, next_retry_at,
        failure_code, divergence_json
 FROM ana_v2_silent_escalation_holds`;

export const pgSilentEscalationHoldStore: SilentEscalationHoldStore = {
  async ensure(input) {
    const existing = await this.loadByMessageId(input.sourceMessageId);
    if (existing) return existing;
    await pool.query(
      `INSERT INTO ana_v2_silent_escalation_holds (
         conversation_key, phone_number_id, customer_phone, source_message_id,
         status, question_id, attempts, next_retry_at, failure_code, divergence_json
       ) VALUES ($1, $2, $3, $4, 'pending', NULL, 0, $5, NULL, $6::jsonb)
       ON CONFLICT (source_message_id) DO NOTHING`,
      [
        input.conversationKey,
        input.phoneNumberId,
        input.customerPhone,
        input.sourceMessageId,
        input.now,
        JSON.stringify(input.divergence),
      ]
    );
    const created = await this.loadByMessageId(input.sourceMessageId);
    if (!created) {
      throw new Error('silent escalation hold missing after insert');
    }
    return created;
  },
  async loadByMessageId(sourceMessageId) {
    const result = await pool.query<RawHoldRow>(
      `${SELECT_HOLD} WHERE source_message_id = $1`,
      [sourceMessageId]
    );
    const row = result.rows[0];
    return row ? mapHold(row) : null;
  },
  async loadActiveByConversation(conversationKey) {
    const result = await pool.query<RawHoldRow>(
      `${SELECT_HOLD}
       WHERE conversation_key = $1
         AND status IN ('pending', 'confirmed')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conversationKey]
    );
    const row = result.rows[0];
    return row ? mapHold(row) : null;
  },
  async markConfirmed(sourceMessageId, questionId) {
    await pool.query(
      `UPDATE ana_v2_silent_escalation_holds
       SET status = 'confirmed',
           question_id = $2,
           failure_code = NULL,
           updated_at = now()
       WHERE source_message_id = $1
         AND status IN ('pending', 'confirmed')`,
      [sourceMessageId, questionId]
    );
  },
  async markActiveElsewhere(sourceMessageId) {
    await pool.query(
      `UPDATE ana_v2_silent_escalation_holds
       SET status = 'active_elsewhere',
           updated_at = now()
       WHERE source_message_id = $1
         AND status = 'pending'`,
      [sourceMessageId]
    );
  },
  async markFailure(sourceMessageId, attempts, nextRetryAt, failureCode) {
    await pool.query(
      `UPDATE ana_v2_silent_escalation_holds
       SET attempts = GREATEST(attempts, $2),
           next_retry_at = $3,
           failure_code = $4,
           updated_at = now()
       WHERE source_message_id = $1
         AND status = 'pending'`,
      [sourceMessageId, attempts, nextRetryAt, failureCode]
    );
  },
  async releaseByConversation(conversationKey) {
    await pool.query(
      `UPDATE ana_v2_silent_escalation_holds
       SET status = 'released',
           updated_at = now()
       WHERE conversation_key = $1
         AND status IN ('pending', 'confirmed', 'active_elsewhere')`,
      [conversationKey]
    );
  },
  async listReady(limit, now) {
    const result = await pool.query<{ source_message_id: string }>(
      `SELECT source_message_id
       FROM ana_v2_silent_escalation_holds
       WHERE status = 'pending'
         AND next_retry_at <= $1
       ORDER BY next_retry_at ASC, created_at ASC
       LIMIT $2`,
      [now, limit]
    );
    return result.rows.map((row) => row.source_message_id);
  },
};

export class MemorySilentEscalationHoldStore implements SilentEscalationHoldStore {
  private readonly byMessageId = new Map<string, SilentEscalationHoldRow>();

  async ensure(input: Parameters<SilentEscalationHoldStore['ensure']>[0]) {
    const existing = this.byMessageId.get(input.sourceMessageId);
    if (existing) return existing;
    const row: SilentEscalationHoldRow = {
      conversationKey: input.conversationKey,
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      sourceMessageId: input.sourceMessageId,
      status: 'pending',
      questionId: null,
      attempts: 0,
      nextRetryAt: input.now,
      failureCode: null,
      divergence: input.divergence,
    };
    this.byMessageId.set(input.sourceMessageId, row);
    return row;
  }

  async loadByMessageId(sourceMessageId: string) {
    return this.byMessageId.get(sourceMessageId) ?? null;
  }

  async loadActiveByConversation(conversationKey: string) {
    const matches = [...this.byMessageId.values()].filter(
      (row) =>
        row.conversationKey === conversationKey &&
        (row.status === 'pending' || row.status === 'confirmed')
    );
    return matches.at(-1) ?? null;
  }

  async markConfirmed(sourceMessageId: string, questionId: string) {
    const row = this.byMessageId.get(sourceMessageId);
    if (!row || (row.status !== 'pending' && row.status !== 'confirmed')) return;
    row.status = 'confirmed';
    row.questionId = questionId;
    row.failureCode = null;
  }

  async markActiveElsewhere(sourceMessageId: string) {
    const row = this.byMessageId.get(sourceMessageId);
    if (!row || row.status !== 'pending') return;
    row.status = 'active_elsewhere';
  }

  async markFailure(
    sourceMessageId: string,
    attempts: number,
    nextRetryAt: Date,
    failureCode: string
  ) {
    const row = this.byMessageId.get(sourceMessageId);
    if (!row || row.status !== 'pending') return;
    row.attempts = Math.max(row.attempts, attempts);
    row.nextRetryAt = nextRetryAt;
    row.failureCode = failureCode;
  }

  async releaseByConversation(conversationKey: string) {
    for (const row of this.byMessageId.values()) {
      if (
        row.conversationKey === conversationKey &&
        (row.status === 'pending' ||
          row.status === 'confirmed' ||
          row.status === 'active_elsewhere')
      ) {
        row.status = 'released';
      }
    }
  }

  async listReady(limit: number, now: Date) {
    return [...this.byMessageId.values()]
      .filter(
        (row) => row.status === 'pending' && row.nextRetryAt.getTime() <= now.getTime()
      )
      .sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime())
      .slice(0, limit)
      .map((row) => row.sourceMessageId);
  }
}

const activeHoldCache = new Map<
  string,
  { active: boolean; sourceMessageId: string | null }
>();

function cacheKey(phoneNumberId: string, customerPhone: string): string {
  return canonicalConversationKey(phoneNumberId, customerPhone);
}

function rememberActive(
  phoneNumberId: string,
  customerPhone: string,
  active: boolean,
  sourceMessageId: string | null
): void {
  activeHoldCache.set(cacheKey(phoneNumberId, customerPhone), {
    active,
    sourceMessageId,
  });
}

export async function ensureSilentEscalationHoldTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ana_v2_silent_escalation_holds (
      source_message_id text PRIMARY KEY,
      conversation_key text NOT NULL,
      phone_number_id text NOT NULL,
      customer_phone text NOT NULL,
      status text NOT NULL CHECK (status IN (
        'pending', 'confirmed', 'released', 'active_elsewhere'
      )),
      question_id text,
      attempts integer NOT NULL DEFAULT 0,
      next_retry_at timestamptz NOT NULL DEFAULT now(),
      failure_code text,
      divergence_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_silent_escalation_holds_active_idx
    ON ana_v2_silent_escalation_holds (conversation_key, updated_at DESC)
    WHERE status IN ('pending', 'confirmed')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ana_v2_silent_escalation_holds_sweep_idx
    ON ana_v2_silent_escalation_holds (next_retry_at, created_at)
    WHERE status = 'pending'
  `);
}

export function sweepRetryDelayMs(attempts: number): number {
  const exponential = Math.min(
    60 * 60_000,
    250 * 2 ** Math.min(Math.max(attempts, 1), 8)
  );
  return Math.max(SILENT_ESCALATION_SWEEP_FLOOR_MS, exponential);
}

export async function lookupSilentEscalationHold(
  phoneNumberId: string,
  customerPhone: string,
  store: SilentEscalationHoldStore = pgSilentEscalationHoldStore
): Promise<SilentEscalationHoldLookupV2> {
  lookupCountForTest += 1;
  const key = cacheKey(phoneNumberId, customerPhone);
  const cached = activeHoldCache.get(key);
  if (cached) {
    return cached.active
      ? { kind: 'active', sourceMessageId: cached.sourceMessageId }
      : { kind: 'inactive' };
  }
  try {
    const row = await store.loadActiveByConversation(
      canonicalConversationKey(phoneNumberId, customerPhone)
    );
    const active = row?.status === 'pending';
    rememberActive(phoneNumberId, customerPhone, active, row?.sourceMessageId ?? null);
    return active
      ? { kind: 'active', sourceMessageId: row?.sourceMessageId ?? null }
      : { kind: 'inactive' };
  } catch (error) {
    Sentry.captureException(new Error('silent escalation hold lookup failed'), {
      level: 'warning',
      tags: {
        service: 'silent_escalation_hold',
        operation: 'lookup',
        phoneNumberHash: technicalHash(phoneNumberId),
        error_kind: runtimeErrorKind(error),
      },
    });
    // Importante: não escrever `inactive` no cache aqui. Uma falha transitória
    // não pode abrir a conversa até o próximo restart/TTL.
    return { kind: 'unknown', errorKind: runtimeErrorKind(error) };
  }
}

/**
 * Compatibilidade para callers antigos. O wrapper fail-closed nunca converte
 * `unknown` em `false`; somente a leitura tipada permite distinguir o estado.
 */
export async function isSilentEscalationHoldActive(
  phoneNumberId: string,
  customerPhone: string,
  store: SilentEscalationHoldStore = pgSilentEscalationHoldStore
): Promise<boolean> {
  return (
    (await lookupSilentEscalationHold(phoneNumberId, customerPhone, store)).kind !==
    'inactive'
  );
}

export async function releaseSilentEscalationHold(
  phoneNumberId: string,
  customerPhone: string,
  store: SilentEscalationHoldStore = pgSilentEscalationHoldStore
): Promise<void> {
  releaseCountForTest += 1;
  const conversationKey = canonicalConversationKey(phoneNumberId, customerPhone);
  rememberActive(phoneNumberId, customerPhone, false, null);
  try {
    await store.releaseByConversation(conversationKey);
  } catch (error) {
    Sentry.captureException(new Error('silent escalation hold release failed'), {
      tags: {
        service: 'silent_escalation_hold',
        operation: 'release',
        phoneNumberHash: technicalHash(phoneNumberId),
        error_kind: runtimeErrorKind(error),
      },
    });
  }
}

export function classifySilentEscalationPostFailure(error: unknown): {
  retryable: boolean;
  activeElsewhere: boolean;
  released: boolean;
  failureCode: string;
} {
  const status = safeHttpStatus(error);
  const code =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response &&
    error.response.data &&
    typeof error.response.data === 'object'
      ? (error.response.data as { code?: unknown }).code
      : undefined;
  if (code === 'ACTIVE_QUESTION_DIFFERENT_SOURCE') {
    return {
      retryable: false,
      activeElsewhere: true,
      released: false,
      failureCode: 'ACTIVE_QUESTION_DIFFERENT_SOURCE',
    };
  }
  if (code === 'ECHO_HUMAN_ACTIVE') {
    return {
      retryable: false,
      activeElsewhere: false,
      released: true,
      failureCode: 'ECHO_HUMAN_ACTIVE',
    };
  }
  if (status === 409 && code === 'INBOUND_MESSAGE_REQUIRED') {
    return {
      retryable: true,
      activeElsewhere: false,
      released: false,
      failureCode: 'INBOUND_MESSAGE_REQUIRED',
    };
  }
  if (status === 400 || status === 422) {
    return {
      retryable: true,
      activeElsewhere: false,
      released: false,
      failureCode: `ESCALATE_CONTRACT_HTTP_${status}`,
    };
  }
  if (status !== null) {
    return {
      retryable: true,
      activeElsewhere: false,
      released: false,
      failureCode: `ESCALATE_HTTP_${status}`,
    };
  }
  return {
    retryable: true,
    activeElsewhere: false,
    released: false,
    failureCode: `ESCALATE_${runtimeErrorKind(error)
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 48) || 'NETWORK'}`,
  };
}

export async function persistSilentEscalationHold(input: {
  phoneNumberId: string;
  customerPhone: string;
  sourceMessageId: string;
  divergence: UnderstandingFailureDivergenceV2;
  store?: SilentEscalationHoldStore;
  now?: Date;
}): Promise<
  | { kind: 'created' | 'existing'; hold: SilentEscalationHoldRow }
  | { kind: 'active_elsewhere'; hold: SilentEscalationHoldRow }
> {
  const store = input.store ?? pgSilentEscalationHoldStore;
  const now = input.now ?? new Date();
  const conversationKey = canonicalConversationKey(
    input.phoneNumberId,
    input.customerPhone
  );
  try {
    const active = await store.loadActiveByConversation(conversationKey);
    if (
      active &&
      active.sourceMessageId !== input.sourceMessageId &&
      (active.status === 'pending' || active.status === 'confirmed')
    ) {
      // Overlay local só cobre pending: depois do POST, a pausa ESCALATION do
      // ERP é autoritativa e o echo humano precisa conseguir encerrá-la.
      rememberActive(
        input.phoneNumberId,
        input.customerPhone,
        active.status === 'pending',
        active.sourceMessageId
      );
      return { kind: 'active_elsewhere', hold: active };
    }
    const hold = await store.ensure({
      conversationKey,
      phoneNumberId: input.phoneNumberId,
      customerPhone: canonicalCustomerPhone(input.customerPhone),
      sourceMessageId: input.sourceMessageId,
      divergence: input.divergence,
      now,
    });
    if (hold.status === 'released') {
      rememberActive(input.phoneNumberId, input.customerPhone, false, hold.sourceMessageId);
      return { kind: 'existing', hold };
    }
    rememberActive(
      input.phoneNumberId,
      input.customerPhone,
      hold.status === 'pending',
      hold.sourceMessageId
    );
    return {
      kind: hold.status === 'confirmed' ? 'existing' : 'created',
      hold,
    };
  } catch (error) {
    if (error instanceof SilentEscalationHoldPersistenceError) throw error;
    throw new SilentEscalationHoldPersistenceError(
      error instanceof Error ? error.message : 'silent escalation hold persist failed'
    );
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let lookupCountForTest = 0;
let releaseCountForTest = 0;

export function startSilentEscalationHoldSweep(
  sweep: () => Promise<unknown>
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweep().catch((error) => {
      Sentry.captureException(new Error('silent escalation hold sweep failed'), {
        tags: {
          service: 'silent_escalation_hold',
          operation: 'sweep',
          error_kind: error instanceof Error ? error.name : typeof error,
        },
      });
    });
  }, SILENT_ESCALATION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function __resetSilentEscalationHoldForTest(): void {
  activeHoldCache.clear();
  lookupCountForTest = 0;
  releaseCountForTest = 0;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function __silentHoldEventCountsForTest(): {
  lookups: number;
  releases: number;
} {
  return { lookups: lookupCountForTest, releases: releaseCountForTest };
}

export function __rememberSilentEscalationHoldForTest(
  phoneNumberId: string,
  customerPhone: string,
  active: boolean
): void {
  rememberActive(phoneNumberId, customerPhone, active, active ? 'test' : null);
}

/** Overlay local: true só enquanto o POST ainda não confirmou a pausa no ERP. */
export function setSilentEscalationHoldOverlay(
  phoneNumberId: string,
  customerPhone: string,
  active: boolean
): void {
  rememberActive(phoneNumberId, customerPhone, active, null);
}
