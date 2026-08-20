import axios from 'axios';
import { ERP_API_TOKEN } from '../erpApiToken';
import {
  parseEscalationSnapshot,
  updateEscalationCache,
} from './escalationCache';
import {
  canonicalConversationKey,
  customerPhoneAsE164,
} from './conversationOrder';
import { buildHumanReviewCancelFallbackCopyV2 } from './conversationalV2/cancellationFlowV2';
import type { UnderstandingFailureDivergenceV2 } from './conversationalV2/divergence';
import {
  classifySilentEscalationPostFailure,
  persistSilentEscalationHold,
  recomputeSilentEscalationHoldOverlay,
  releaseSilentEscalationHold,
  setSilentEscalationHoldOverlay,
  SilentEscalationHoldPersistenceError,
  SILENT_ESCALATION_FAST_RETRY_DELAYS_MS,
  pgSilentEscalationHoldStore,
  sweepRetryDelayMs,
  type SilentEscalationHoldStore,
  invalidateSilentEscalationHoldOverlay,
} from './silentEscalationHold';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind, technicalHash } from '../observability/safeRuntime';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

export const ESCALATION_REASON_CODES = [
  'CLINICAL_DOUBT',
  'UNCADASTRED_INFO',
  'HUMAN_REQUEST',
  'OUT_OF_SCOPE',
  'REPEATED_FAILURE',
] as const;

export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];
export type EscalationTopicCode = 'PROCEDURE_INFO';
export const ESCALATION_ACTIONS = [
  'ANSWER_IN_RECEPS',
  'TAKE_OVER_WHATSAPP',
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export function isAnaEscalationEnabled(
  value: string | undefined = process.env.ANA_ESCALATION_ENABLED
): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function isEscalationReasonCode(
  value: unknown
): value is EscalationReasonCode {
  return (
    typeof value === 'string' &&
    (ESCALATION_REASON_CODES as readonly string[]).includes(value)
  );
}

/** Classificador local conservador. A flag OFF torna esta função sem efeito. */
export function detectEscalationReason(
  text: string
): EscalationReasonCode | null {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (
    /\b(falar|conversar)\s+com\s+(uma?\s+)?(pessoa|humano|atendente|recepcionista|equipe|profissional)\b/.test(
      normalized
    ) ||
    /\bquero\s+(uma?\s+)?(atendente|humano|pessoa)\b/.test(normalized) ||
    /\b(?:posso|quero)\s+falar\s+com\s+(?:a\s+)?(?:dona|responsavel|gerente)\b/.test(
      normalized
    ) ||
    /\b(?:chama|chame|pode\s+chamar)\s+(?:a\s+)?(?:dona|responsavel|gerente|uma\s+pessoa)\b/.test(
      normalized
    )
  ) {
    return 'HUMAN_REQUEST';
  }

  if (
    /\b(gravida|gestante|alergia|alergico|contraindic|doenca|medicamento|remedio|dor|ferida|infecc|inflamac|diagnostic|cura|resultado)\b/.test(
      normalized
    ) ||
    /\b(posso|pode|seguro|indicado|recomendad[oa])\b.*\b(procedimento|tratamento|sessao|servico)\b/.test(
      normalized
    )
  ) {
    return 'CLINICAL_DOUBT';
  }

  return null;
}

export interface EscalationInput {
  phoneNumberId: string;
  customerPhone: string;
  reasonCode: EscalationReasonCode;
  messageId: string;
  topicCode?: EscalationTopicCode;
  requiredAction?: EscalationAction;
  divergence?: UnderstandingFailureDivergenceV2;
}

export type EscalationOutcome =
  | { kind: 'created'; questionId: string }
  | { kind: 'active_question_different_source' }
  | { kind: 'echo_human_active' }
  | { kind: 'failed' };

export interface EscalationDeps {
  post: (input: EscalationInput) => Promise<unknown>;
}

const defaultDeps: EscalationDeps = {
  async post(input) {
    const { data } = await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/questions/escalate`,
      {
        ...input,
        customerPhone: customerPhoneAsE164(input.customerPhone),
      },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    return data;
  },
};

function validationResponseShape(error: unknown): {
  status: number | null;
  data: unknown;
} {
  if (!error || typeof error !== 'object') return { status: null, data: null };
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return { status: null, data: null };
  const status = (response as { status?: unknown }).status;
  return {
    status: typeof status === 'number' ? status : null,
    data: (response as { data?: unknown }).data,
  };
}

function isEmptyObject(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0
  );
}

function isTopicCodeValidationFailure(error: unknown): boolean {
  const response = validationResponseShape(error);
  if (response.status !== 400 && response.status !== 422) return false;
  let marker = '';
  try {
    marker = JSON.stringify(response.data ?? '').toLowerCase();
  } catch {
    return false;
  }
  if (marker.includes('topiccode') || marker.includes('topic_code')) return true;

  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const body = data as Record<string, unknown>;
  if (body.code !== 'ANA_QUESTION_INVALID_INPUT') return false;
  const errorText =
    typeof body.error === 'string'
      ? body.error
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
      : '';
  return errorText.includes('body invalido') || isEmptyObject(body.details);
}

function escalationOutcomeFromPayload(raw: unknown): EscalationOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as {
    code?: unknown;
    error?: unknown;
    questionId?: unknown;
    escalation?: unknown;
    version?: unknown;
  };
  const code = data.code ?? data.error;
  if (code === 'ACTIVE_QUESTION_DIFFERENT_SOURCE') {
    return { kind: 'active_question_different_source' };
  }
  if (code === 'ECHO_HUMAN_ACTIVE') {
    return { kind: 'echo_human_active' };
  }
  const questionId =
    typeof data.questionId === 'string' ? data.questionId.trim() : '';
  if (!questionId) return null;
  return { kind: 'created', questionId };
}

async function postEscalationWithTopicCompatibility(
  input: EscalationInput,
  deps: EscalationDeps
): Promise<unknown> {
  try {
    return await deps.post(input);
  } catch (error) {
    if (!input.topicCode || !isTopicCodeValidationFailure(error)) throw error;
    console.warn(
      '[ana-procedure-info] ERP rejeitou topicCode; retry compatível sem o campo.'
    );
    const { topicCode: _topicCode, ...legacyInput } = input;
    return deps.post(legacyInput);
  }
}

export async function escalateQuestion(
  input: EscalationInput,
  deps: EscalationDeps = defaultDeps
): Promise<EscalationOutcome> {
  if (!isEscalationReasonCode(input.reasonCode)) return { kind: 'failed' };
  try {
    const raw = await postEscalationWithTopicCompatibility(input, deps);
    const outcome = escalationOutcomeFromPayload(raw);
    if (!outcome) return { kind: 'failed' };
    if (outcome.kind !== 'created') return outcome;
    const data = raw as {
      escalation?: unknown;
      version?: unknown;
    };
    const questionId = outcome.questionId;

    const parsed = parseEscalationSnapshot(
      data.escalation ?? {
        active: true,
        questionId,
        version: data.version,
      }
    );
    updateEscalationCache(input.phoneNumberId, input.customerPhone, {
      active: true,
      questionId,
      version: parsed.version,
    });
    return { kind: 'created', questionId };
  } catch (error) {
    const response = validationResponseShape(error);
    const classified = escalationOutcomeFromPayload(response.data);
    if (
      classified?.kind === 'active_question_different_source' ||
      classified?.kind === 'echo_human_active'
    ) {
      return classified;
    }
    return { kind: 'failed' };
  }
}

export async function escalateProcedureInfoQuestionV2(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string | null;
    responsibleName?: string;
  },
  deps: EscalationDeps = defaultDeps
): Promise<ReceptionistEscalationV2Decision> {
  if (!isAnaEscalationEnabled() || !input.messageId) {
    const outcome = { kind: 'failed' } as const;
    return {
      matched: true,
      reply: buildEscalationReplyV2(outcome, input.responsibleName),
      actionRecorded: false,
      questionId: null,
      outcome: outcome.kind,
    };
  }
  const outcome = await escalateQuestion(
    {
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      reasonCode: 'UNCADASTRED_INFO',
      topicCode: 'PROCEDURE_INFO',
    },
    deps
  );
  return {
    matched: true,
    reply: buildEscalationReplyV2(outcome, input.responsibleName),
    actionRecorded: outcome.kind === 'created',
    questionId: outcome.kind === 'created' ? outcome.questionId : null,
    outcome: outcome.kind,
  };
}

/**
 * Pedido operacional de cancelamento que a Ana não pode escrever sozinha
 * (PAID, fiscal, comissão, pacote consumido, contrato ausente). OUT_OF_SCOPE
 * — não é UNCADASTRED_INFO nem HUMAN_REQUEST: a cliente pediu cancelar, não
 * falar com alguém, e a Ana não tem a informação em falta; o ato automático
 * está fora do alcance dela.
 */
export async function escalateCancelHumanReviewV2(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string | null;
    responsibleName?: string;
  },
  deps: EscalationDeps = defaultDeps
): Promise<ReceptionistEscalationV2Decision> {
  if (!isAnaEscalationEnabled() || !input.messageId) {
    const outcome = { kind: 'failed' } as const;
    return {
      matched: true,
      reply: buildHumanReviewCancelFallbackCopyV2(),
      actionRecorded: false,
      questionId: null,
      outcome: outcome.kind,
    };
  }
  const outcome = await escalateQuestion(
    {
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      reasonCode: 'OUT_OF_SCOPE',
    },
    deps
  );
  return {
    matched: true,
    reply:
      outcome.kind === 'created'
        ? buildEscalationReplyV2(outcome, input.responsibleName)
        : buildHumanReviewCancelFallbackCopyV2(),
    actionRecorded: outcome.kind === 'created',
    questionId: outcome.kind === 'created' ? outcome.questionId : null,
    outcome: outcome.kind,
  };
}

/** Uma única fonte determinística de copy; nunca recebe texto livre do provider. */
export function buildEscalationReply(
  outcome: EscalationOutcome,
  responsibleName?: string
): string {
  if (outcome.kind === 'created') {
    const responsible = responsibleName?.trim();
    return responsible
      ? `Sua pergunta foi registrada para ${responsible}, responsável por este atendimento.`
      : 'Sua pergunta foi registrada para a equipe responsável pelo atendimento.';
  }
  return 'Não consigo responder isso com segurança por aqui. Você pode falar diretamente com a equipe do estabelecimento.';
}

/** Copy v2: a promessa só é usada depois de questionId autoritativo. */
export function buildEscalationReplyV2(
  outcome: EscalationOutcome,
  responsibleName?: string
): string {
  if (outcome.kind !== 'created') {
    return buildEscalationReply(outcome, responsibleName);
  }
  const responsible = responsibleName?.trim();
  return responsible
    ? `Vou avisar ${responsible}, responsável por este atendimento.`
    : 'Vou avisar a equipe responsável pelo atendimento.';
}

export type ReceptionistEscalationV2Decision =
  | { matched: false }
  | {
      matched: true;
      reply: string;
      actionRecorded: boolean;
      questionId: string | null;
      outcome: EscalationOutcome['kind'];
    };

export async function maybeEscalateReceptionistQuestionV2(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string | null;
    text: string;
    responsibleName?: string;
    /** Somente após testemunha lexical server-side do intérprete poder-zero. */
    witnessedHumanRequest?: boolean;
  },
  deps: EscalationDeps = defaultDeps
): Promise<ReceptionistEscalationV2Decision> {
  if (!isAnaEscalationEnabled() || !input.messageId) return { matched: false };
  const reasonCode =
    detectEscalationReason(input.text) ??
    (input.witnessedHumanRequest === true ? 'HUMAN_REQUEST' : null);
  if (!reasonCode) return { matched: false };
  const outcome = await escalateQuestion(
    {
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      reasonCode,
      messageId: input.messageId,
    },
    deps
  );
  return {
    matched: true,
    reply: buildEscalationReplyV2(outcome, input.responsibleName),
    actionRecorded: outcome.kind === 'created',
    questionId: outcome.kind === 'created' ? outcome.questionId : null,
    outcome: outcome.kind,
  };
}

/**
 * Gatilho da recepcionista, integralmente isolado pelo kill-switch. OFF (default)
 * retorna null antes de classificar ou fazer I/O, preservando o fluxo atual.
 */
export async function maybeEscalateReceptionistQuestion(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string | null;
    text: string;
    responsibleName?: string;
  },
  deps: EscalationDeps = defaultDeps
): Promise<string | null> {
  if (!isAnaEscalationEnabled() || !input.messageId) return null;
  const reasonCode = detectEscalationReason(input.text);
  if (!reasonCode) return null;
  const outcome = await escalateQuestion(
    {
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      reasonCode,
      messageId: input.messageId,
    },
    deps
  );
  return buildEscalationReply(outcome, input.responsibleName);
}

export type SilentUnderstandingFailureOutcome =
  | { kind: 'created'; questionId: string }
  | { kind: 'deduplicated'; questionId: string }
  | { kind: 'active_elsewhere' }
  | { kind: 'pending' }
  | { kind: 'released' };

export interface SilentUnderstandingFailureDeps {
  post?: EscalationDeps['post'];
  holdStore?: SilentEscalationHoldStore;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function captureSilentEscalationHousekeepingFailure(
  input: {
    phoneNumberId: string;
    sourceMessageId: string;
    operation: string;
  },
  error: unknown
): void {
  Sentry.captureException(new Error('silent escalation housekeeping failed'), {
    level: 'warning',
    tags: {
      service: 'silent_escalation',
      operation: input.operation,
      phoneNumberHash: technicalHash(input.phoneNumberId),
      messageIdHash: technicalHash(input.sourceMessageId),
      error_kind: runtimeErrorKind(error),
    },
  });
}

async function reconcileSilentEscalationOverlayAfterAuthoritativeOutcome(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string;
  },
  holdStore: SilentEscalationHoldStore
): Promise<void> {
  try {
    await recomputeSilentEscalationHoldOverlay(
      input.phoneNumberId,
      input.customerPhone,
      holdStore
    );
  } catch (error) {
    // The ERP outcome remains authoritative, but a failed residual-owner
    // read must not create an eternal positive latch either. The current turn
    // is already silent; the next lookup must re-read the store and return
    // unknown while it remains unavailable.
    invalidateSilentEscalationHoldOverlay(
      input.phoneNumberId,
      input.customerPhone
    );
    captureSilentEscalationHousekeepingFailure(
      {
        phoneNumberId: input.phoneNumberId,
        sourceMessageId: input.messageId,
        operation: 'recompute_overlay',
      },
      error
    );
  }
}

async function postSilentUnderstandingFailureOnce(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string;
    divergence: UnderstandingFailureDivergenceV2;
  },
  post: EscalationDeps['post']
): Promise<EscalationOutcome> {
  return escalateQuestion(
    {
      phoneNumberId: input.phoneNumberId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      reasonCode: 'REPEATED_FAILURE',
      requiredAction: 'TAKE_OVER_WHATSAPP',
      divergence: input.divergence,
    },
    { post }
  );
}

/**
 * Escala incompreensão terminal: hold durável ANTES de qualquer HTTP, silêncio
 * sempre, POST idempotente por messageId, retry no padrão do inbound outbox.
 */
export async function escalateSilentUnderstandingFailure(
  input: {
    phoneNumberId: string;
    customerPhone: string;
    messageId: string;
    divergence: UnderstandingFailureDivergenceV2;
  },
  deps: SilentUnderstandingFailureDeps = {}
): Promise<SilentUnderstandingFailureOutcome> {
  const holdStore = deps.holdStore ?? pgSilentEscalationHoldStore;
  const post = deps.post ?? defaultDeps.post;
  const wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = deps.now ?? (() => new Date());

  let persisted: Awaited<ReturnType<typeof persistSilentEscalationHold>>;
  try {
    persisted = await persistSilentEscalationHold({
      ...input,
      sourceMessageId: input.messageId,
      store: holdStore,
      now: nowFn(),
    });
  } catch (error) {
    Sentry.captureException(new Error('silent escalation hold persist failed'), {
      tags: {
        service: 'silent_escalation',
        operation: 'persist_hold',
        phoneNumberHash: technicalHash(input.phoneNumberId),
        messageIdHash: technicalHash(input.messageId),
        error_kind: runtimeErrorKind(error),
      },
    });
    if (error instanceof SilentEscalationHoldPersistenceError) throw error;
    throw new SilentEscalationHoldPersistenceError(
      error instanceof Error ? error.message : 'silent escalation hold persist failed'
    );
  }

  if (persisted.kind === 'active_elsewhere') {
    return { kind: 'active_elsewhere' };
  }
  if (persisted.hold.status === 'released') {
    return { kind: 'released' };
  }
  if (persisted.hold.status === 'confirmed' && persisted.hold.questionId) {
    return { kind: 'deduplicated', questionId: persisted.hold.questionId };
  }
  if (persisted.hold.status === 'active_elsewhere') {
    return { kind: 'active_elsewhere' };
  }

  const attemptOnce = async (): Promise<SilentUnderstandingFailureOutcome> => {
    const current = await holdStore.loadByMessageId(input.messageId);
    if (!current || current.status === 'released') return { kind: 'released' };
    if (current.status === 'confirmed' && current.questionId) {
      return { kind: 'deduplicated', questionId: current.questionId };
    }
    if (current.status === 'active_elsewhere') return { kind: 'active_elsewhere' };

    const nextAttempts = current.attempts + 1;
    try {
      const outcome = await postSilentUnderstandingFailureOnce(input, post);
      if (outcome.kind === 'created') {
        await holdStore.markConfirmed(input.messageId, outcome.questionId);
        try {
          await holdStore.releaseSupersededConfirmedByConversation(
            canonicalConversationKey(input.phoneNumberId, input.customerPhone),
            input.messageId
          );
        } catch (error) {
          // ERP creation is authoritative. Historical housekeeping is
          // best-effort and must never turn a created question into a retry,
          // M24, duplicate POST or lost receipt.
          captureSilentEscalationHousekeepingFailure(
            {
              phoneNumberId: input.phoneNumberId,
              sourceMessageId: input.messageId,
              operation: 'release_superseded_confirmed',
            },
            error
          );
        }
        await reconcileSilentEscalationOverlayAfterAuthoritativeOutcome(
          input,
          holdStore
        );
        return { kind: 'created', questionId: outcome.questionId };
      }
      if (outcome.kind === 'active_question_different_source') {
        await holdStore.markActiveElsewhere(input.messageId);
        await reconcileSilentEscalationOverlayAfterAuthoritativeOutcome(
          input,
          holdStore
        );
        return { kind: 'active_elsewhere' };
      }
      if (outcome.kind === 'echo_human_active') {
        await releaseSilentEscalationHold(
          input.phoneNumberId,
          input.customerPhone,
          holdStore
        );
        return { kind: 'released' };
      }
      await holdStore.markFailure(
        input.messageId,
        nextAttempts,
        new Date(nowFn().getTime() + sweepRetryDelayMs(nextAttempts)),
        'ESCALATE_FAILED'
      );
      setSilentEscalationHoldOverlay(
        input.phoneNumberId,
        input.customerPhone,
        true
      );
      return { kind: 'pending' };
    } catch (error) {
      const classified = classifySilentEscalationPostFailure(error);
      if (classified.activeElsewhere) {
        await holdStore.markActiveElsewhere(input.messageId);
        await reconcileSilentEscalationOverlayAfterAuthoritativeOutcome(
          input,
          holdStore
        );
        return { kind: 'active_elsewhere' };
      }
      if (classified.released) {
        await releaseSilentEscalationHold(
          input.phoneNumberId,
          input.customerPhone,
          holdStore
        );
        return { kind: 'released' };
      }
      await holdStore.markFailure(
        input.messageId,
        nextAttempts,
        new Date(nowFn().getTime() + sweepRetryDelayMs(nextAttempts)),
        classified.failureCode
      );
      setSilentEscalationHoldOverlay(
        input.phoneNumberId,
        input.customerPhone,
        true
      );
      Sentry.captureException(new Error('silent escalation post failed'), {
        level: 'warning',
        tags: {
          service: 'silent_escalation',
          operation: 'post',
          phoneNumberHash: technicalHash(input.phoneNumberId),
          messageIdHash: technicalHash(input.messageId),
          failure_code: classified.failureCode,
          error_kind: runtimeErrorKind(error),
        },
      });
      return { kind: 'pending' };
    }
  };

  try {
    let result = await attemptOnce();
    for (const delay of SILENT_ESCALATION_FAST_RETRY_DELAYS_MS) {
      if (result.kind !== 'pending') break;
      await wait(delay);
      result = await attemptOnce();
    }
    return result;
  } catch (error) {
    if (error instanceof SilentEscalationHoldPersistenceError) throw error;
    Sentry.captureException(new Error('silent escalation after hold persist failed'), {
      level: 'warning',
      tags: {
        service: 'silent_escalation',
        operation: 'post_persist',
        phoneNumberHash: technicalHash(input.phoneNumberId),
        messageIdHash: technicalHash(input.messageId),
        error_kind: runtimeErrorKind(error),
      },
    });
    return { kind: 'pending' };
  }
}

export async function sweepSilentEscalationHolds(
  deps: SilentUnderstandingFailureDeps = {},
  limit = 100
): Promise<{ attempted: number; confirmed: number }> {
  const holdStore = deps.holdStore ?? pgSilentEscalationHoldStore;
  const now = deps.now?.() ?? new Date();
  const messageIds = await holdStore.listReady(limit, now);
  let confirmed = 0;
  for (const messageId of messageIds) {
    const row = await holdStore.loadByMessageId(messageId);
    if (!row || row.status !== 'pending') continue;
    const result = await escalateSilentUnderstandingFailure(
      {
        phoneNumberId: row.phoneNumberId,
        customerPhone: row.customerPhone,
        messageId: row.sourceMessageId,
        divergence: row.divergence,
      },
      { ...deps, holdStore }
    );
    if (result.kind === 'created' || result.kind === 'deduplicated') {
      confirmed += 1;
    }
  }
  return { attempted: messageIds.length, confirmed };
}
