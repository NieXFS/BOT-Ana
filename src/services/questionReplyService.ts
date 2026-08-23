import { createHash } from 'crypto';
import axios from 'axios';
import type { PoolClient } from 'pg';
import type { WhatsAppTenantConfig } from '../whatsappCloudService';
import {
  sendFreeformMessageWithReceipt,
  WhatsAppReceiptMissingError,
} from '../whatsappCloudService';
import { parseConversationKey, pool } from './contextManager';
import {
  canonicalCustomerPhone,
  canonicalConversationKey,
  withConversationLock,
} from './conversationOrder';
import type { ConversationalV2LockClient } from './conversationalV2/stateStore';
import type { QuestionReplyStatus } from './anaWave2Store';
import {
  listUnrepairedQuestionReplyHumanHistory,
  persistQuestionReplyHumanHistoryAtomically,
  questionReplyProvisionalMessageId,
  withdrawQuestionReplyHumanIntention,
} from './anaWave2Store';
import { HUMAN_ECHO_PREFIX } from './humanConversationContext';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind, technicalHash } from '../observability/safeRuntime';
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
  humanHistoryPayload: string | null;
  humanHistoryAcceptedAt: Date | null;
  humanHistoryRecordedAt: Date | null;
}

export interface QuestionReplyAcceptanceSnapshot {
  payload: string;
  acceptedAt: Date;
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
  human_history_payload: string | null;
  human_history_accepted_at: Date | null;
  human_history_recorded_at: Date | null;
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
    humanHistoryPayload: row.human_history_payload ?? null,
    humanHistoryAcceptedAt: row.human_history_accepted_at ?? null,
    humanHistoryRecordedAt: row.human_history_recorded_at ?? null,
  };
}

export function questionReplyHumanHistoryContent(validatedPayload: string): string {
  return `${HUMAN_ECHO_PREFIX}${validatedPayload}`;
}

export function questionReplyNeedsHumanHistoryProjection(
  row: Pick<
    QuestionReplyRow,
    | 'status'
    | 'humanHistoryPayload'
    | 'humanHistoryAcceptedAt'
    | 'humanHistoryRecordedAt'
  >
): boolean {
  return (
    row.humanHistoryRecordedAt == null &&
    row.humanHistoryPayload != null &&
    row.humanHistoryAcceptedAt != null &&
    (row.status === 'in_flight' ||
      row.status === 'sent' ||
      row.status === 'confirmation_pending')
  );
}

export { questionReplyProvisionalMessageId };

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
    failureCode: string | null,
    acceptanceSnapshot?: QuestionReplyAcceptanceSnapshot | null
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
  async update(
    idempotencyKey,
    status,
    providerMessageId,
    failureCode,
    acceptanceSnapshot
  ) {
    const result = await pool.query<RawQuestionReplyRow>(
      `UPDATE sent_question_replies
       SET status = $2,
           provider_message_id = COALESCE($3, provider_message_id),
           failure_code = $4,
           human_history_payload = COALESCE(human_history_payload, $5),
           human_history_accepted_at = CASE
             WHEN $3::text IS NOT NULL AND $6::timestamptz IS NOT NULL THEN $6
             ELSE COALESCE(human_history_accepted_at, $6)
           END,
           updated_at = now()
       WHERE idempotency_key = $1
       RETURNING *`,
      [
        idempotencyKey,
        status,
        providerMessageId,
        failureCode,
        acceptanceSnapshot?.payload ?? null,
        acceptanceSnapshot?.acceptedAt ?? null,
      ]
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

export interface QuestionReplyHumanHistoryInput {
  idempotencyKey: string;
  conversationKey: string;
  phoneNumberId: string;
  providerMessageId: string | null;
  payload: string;
  acceptedAt: Date;
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
  projectHumanHistory: (
    input: QuestionReplyHumanHistoryInput
  ) => Promise<'recorded' | 'already_recorded'>;
  withdrawHumanHistory: (input: {
    idempotencyKey: string;
    conversationKey: string;
  }) => Promise<void>;
  /**
   * Ownership humano da aba Perguntas. Opcional nos testes; produção grava o
   * cutoff v2 mesmo sem PendingFrame OPEN.
   */
  invalidateConversationalFlowStateByHuman?: (
    phoneNumberId: string,
    customerPhone: string,
    now?: Date,
    client?: ConversationalV2LockClient
  ) => Promise<number>;
}

async function projectHumanHistoryDefault(
  input: QuestionReplyHumanHistoryInput
): Promise<'recorded' | 'already_recorded'> {
  return persistQuestionReplyHumanHistoryAtomically({
    idempotencyKey: input.idempotencyKey,
    conversationKey: input.conversationKey,
    content: questionReplyHumanHistoryContent(input.payload),
    createdAt: input.acceptedAt,
    providerMessageId: input.providerMessageId,
    payload: input.payload,
  });
}

async function withdrawHumanHistoryDefault(input: {
  idempotencyKey: string;
  conversationKey: string;
}): Promise<void> {
  await withdrawQuestionReplyHumanIntention(
    input.idempotencyKey,
    input.conversationKey
  );
}

async function invalidateConversationalFlowStateByHumanDefault(
  phoneNumberId: string,
  customerPhone: string,
  now?: Date,
  client?: ConversationalV2LockClient
): Promise<number> {
  const raw = process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS?.trim();
  if (!raw) return 0;
  const { getTenantConfig } = await import('../configProvider');
  const config = await getTenantConfig(phoneNumberId);
  if (!config) return 0;
  const [{ isAnaConversationalV2Enabled }, stateStore] = await Promise.all([
    import('./conversationalV2/featureFlag'),
    import('./conversationalV2/stateStore'),
  ]);
  if (!isAnaConversationalV2Enabled(config.tenantSlug, raw)) return 0;
  const conversationKey = canonicalConversationKey(phoneNumberId, customerPhone);
  if (client) {
    return stateStore.invalidateOpenPendingByHumanWithClient(client, conversationKey, now);
  }
  return stateStore.pgConversationalV2StateStore.invalidateOpenPendingByHuman(
    conversationKey,
    now
  );
}

async function recordHumanOwnershipCutoff(
  phoneNumberId: string,
  customerPhone: string,
  deps: QuestionReplyDeps,
  client?: ConversationalV2LockClient
): Promise<void> {
  const invalidate = deps.invalidateConversationalFlowStateByHuman;
  if (!invalidate) return;
  await invalidate(phoneNumberId, customerPhone, new Date(deps.now()), client);
}

function captureHumanHistoryProjectionFailure(
  error: unknown,
  phoneNumberId: string,
  providerMessageId: string | null
): void {
  Sentry.captureException(new Error('question reply human history projection failed'), {
    level: 'warning',
    tags: {
      service: 'question_reply',
      operation: 'project_human_history',
      phoneNumberHash: technicalHash(phoneNumberId),
      providerMessageHash: technicalHash(providerMessageId ?? 'unattached'),
      error_kind: runtimeErrorKind(error),
    },
  });
}

async function withdrawHumanHistorySafely(
  deps: QuestionReplyDeps,
  idempotencyKey: string,
  conversationKey: string
): Promise<void> {
  try {
    await deps.withdrawHumanHistory({ idempotencyKey, conversationKey });
  } catch (error) {
    Sentry.captureException(new Error('question reply human history withdraw failed'), {
      level: 'warning',
      tags: {
        service: 'question_reply',
        operation: 'withdraw_human_history',
        error_kind: runtimeErrorKind(error),
      },
    });
  }
}

export async function projectQuestionReplyHumanHistory(
  input: QuestionReplyHumanHistoryInput,
  project: (
    input: QuestionReplyHumanHistoryInput
  ) => Promise<'recorded' | 'already_recorded'> = projectHumanHistoryDefault
): Promise<'recorded' | 'already_recorded' | 'skipped'> {
  try {
    return await project(input);
  } catch (error) {
    captureHumanHistoryProjectionFailure(
      error,
      input.phoneNumberId,
      input.providerMessageId
    );
    return 'skipped';
  }
}

export async function repairUnrecordedQuestionReplyHumanHistory(
  options: {
    providerMessageId?: string;
    limit?: number;
    project?: (
      input: QuestionReplyHumanHistoryInput
    ) => Promise<'recorded' | 'already_recorded'>;
    listUnrepaired?: typeof listUnrepairedQuestionReplyHumanHistory;
  } = {}
): Promise<{ attempted: number; recorded: number }> {
  const unrepaired = await (options.listUnrepaired ??
    listUnrepairedQuestionReplyHumanHistory)(
    options.limit ?? 100,
    options.providerMessageId
  );
  let recorded = 0;
  for (const row of unrepaired) {
    const result = await projectQuestionReplyHumanHistory(
      {
        idempotencyKey: row.idempotencyKey,
        conversationKey: row.conversationKey,
        phoneNumberId: row.phoneNumberId,
        providerMessageId: row.providerMessageId,
        payload: row.payload,
        acceptedAt: row.acceptedAt,
      },
      options.project ?? projectHumanHistoryDefault
    );
    if (result !== 'skipped') recorded += 1;
  }
  return { attempted: unrepaired.length, recorded };
}

const defaultDeps: QuestionReplyDeps = {
  store: pgQuestionReplyStore,
  now: Date.now,
  withLock: (phoneNumberId, customerPhone, work) =>
    withConversationLock(phoneNumberId, customerPhone, work),
  getLatestSource: getLatestSourceWithClient,
  getLastInboundAtMs: getLastInboundAtMsWithClient,
  sendReceipt: sendFreeformMessageWithReceipt,
  projectHumanHistory: projectHumanHistoryDefault,
  withdrawHumanHistory: withdrawHumanHistoryDefault,
  invalidateConversationalFlowStateByHuman:
    invalidateConversationalFlowStateByHumanDefault,
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

function questionReplyShouldProjectHumanHistory(
  row: Pick<
    QuestionReplyRow,
    'status' | 'humanHistoryPayload' | 'humanHistoryAcceptedAt'
  >
): boolean {
  if (row.status === 'failed_pre_send' || row.status === 'stale_source') {
    return false;
  }
  return (
    row.humanHistoryPayload != null &&
    row.humanHistoryAcceptedAt != null &&
    (row.status === 'in_flight' ||
      row.status === 'sent' ||
      row.status === 'confirmation_pending')
  );
}

async function maybeProjectAcceptedReply(
  row: QuestionReplyRow,
  deps: QuestionReplyDeps
): Promise<void> {
  if (!questionReplyShouldProjectHumanHistory(row)) return;
  await projectQuestionReplyHumanHistory(
    {
      idempotencyKey: row.idempotencyKey,
      conversationKey: row.conversationKey,
      phoneNumberId: row.phoneNumberId,
      providerMessageId: row.providerMessageId,
      payload: row.humanHistoryPayload!,
      acceptedAt: row.humanHistoryAcceptedAt!,
    },
    deps.projectHumanHistory
  );
  await recordHumanOwnershipCutoff(
    row.phoneNumberId,
    parseConversationKey(row.conversationKey).customerPhone,
    deps
  );
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
    await maybeProjectAcceptedReply(row, deps);
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
  const snapshotFor = (): QuestionReplyAcceptanceSnapshot => ({
    payload: transportInput.text,
    acceptedAt: new Date(deps.now()),
  });
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

        const intended = snapshotFor();
        try {
          await deps.projectHumanHistory({
            idempotencyKey: input.idempotencyKey,
            conversationKey,
            phoneNumberId: input.phoneNumberId,
            providerMessageId: null,
            payload: intended.payload,
            acceptedAt: intended.acceptedAt,
          });
          await recordHumanOwnershipCutoff(
            input.phoneNumberId,
            input.customerPhone,
            deps,
            client
          );
        } catch {
          const row = await deps.store.update(
            input.idempotencyKey,
            'failed_pre_send',
            null,
            'HUMAN_INTENTION_FAILED'
          );
          await withdrawHumanHistorySafely(
            deps,
            input.idempotencyKey,
            conversationKey
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
          const snapshot = snapshotFor();
          try {
            const sent = await deps.store.update(
              input.idempotencyKey,
              'sent',
              receipt.providerMessageId,
              null,
              snapshot
            );
            await maybeProjectAcceptedReply(sent, deps);
            return {
              kind: 'sent',
              providerMessageId: receipt.providerMessageId,
              sentAt: sent.updatedAt.toISOString(),
            };
          } catch {
            // A Meta aceitou, mas a confirmação local falhou/colidiu. Nunca retry
            // e nunca rebaixa o aceite para failed_pre_send. A intenção HUMAN
            // pré-Meta permanece mesmo se o promote do wamid falhar.
            let pending: QuestionReplyRow | null = null;
            try {
              pending = await deps.store.update(
                input.idempotencyKey,
                'confirmation_pending',
                receipt.providerMessageId,
                'RECEIPT_PERSIST_FAILED',
                snapshot
              );
            } catch {
              pending = null;
            }
            if (pending) {
              await maybeProjectAcceptedReply(pending, deps);
            } else {
              await projectQuestionReplyHumanHistory(
                {
                  idempotencyKey: input.idempotencyKey,
                  conversationKey,
                  phoneNumberId: input.phoneNumberId,
                  providerMessageId: receipt.providerMessageId,
                  payload: snapshot.payload,
                  acceptedAt: snapshot.acceptedAt,
                },
                deps.projectHumanHistory
              );
            }
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
            await withdrawHumanHistorySafely(
              deps,
              input.idempotencyKey,
              conversationKey
            );
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
    const snapshot =
      acceptedProviderMessageId != null ? snapshotFor() : undefined;
    const row = await deps.store.update(
      input.idempotencyKey,
      status,
      acceptedProviderMessageId,
      failureCode,
      snapshot
    );
    if (status === 'failed_pre_send') {
      await withdrawHumanHistorySafely(
        deps,
        input.idempotencyKey,
        conversationKey
      );
      return { kind: 'failed_pre_send', failureCode: row.failureCode };
    }
    await maybeProjectAcceptedReply(row, deps);
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
