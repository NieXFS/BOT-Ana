import axios from 'axios';
import { ERP_API_TOKEN } from '../erpApiToken';
import {
  parseEscalationSnapshot,
  updateEscalationCache,
} from './escalationCache';
import { customerPhoneAsE164 } from './conversationOrder';

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
}

export type EscalationOutcome =
  | { kind: 'created'; questionId: string }
  | { kind: 'active_question_different_source' }
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

function isTopicCodeValidationFailure(error: unknown): boolean {
  const response = validationResponseShape(error);
  if (response.status !== 400 && response.status !== 422) return false;
  let marker = '';
  try {
    marker = JSON.stringify(response.data ?? '').toLowerCase();
  } catch {
    return false;
  }
  return (
    marker.includes('topiccode') ||
    marker.includes('topic_code') ||
    marker.includes('unrecognized') ||
    marker.includes('unknown field') ||
    marker.includes('campo desconhecido')
  );
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
    const data = raw as {
      questionId?: unknown;
      escalation?: unknown;
      version?: unknown;
    };
    const questionId =
      typeof data?.questionId === 'string' ? data.questionId.trim() : '';
    if (!questionId) return { kind: 'failed' };

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
    if (
      axios.isAxiosError(error) &&
      error.response?.data &&
      typeof error.response.data === 'object' &&
      ((error.response.data as { code?: unknown; error?: unknown }).code ===
        'ACTIVE_QUESTION_DIFFERENT_SOURCE' ||
        (error.response.data as { code?: unknown; error?: unknown }).error ===
          'ACTIVE_QUESTION_DIFFERENT_SOURCE')
    ) {
      return { kind: 'active_question_different_source' };
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
