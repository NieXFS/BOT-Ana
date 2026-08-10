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
    /\bquero\s+(uma?\s+)?(atendente|humano|pessoa)\b/.test(normalized)
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

export async function escalateQuestion(
  input: EscalationInput,
  deps: EscalationDeps = defaultDeps
): Promise<EscalationOutcome> {
  if (!isEscalationReasonCode(input.reasonCode)) return { kind: 'failed' };
  try {
    const raw = await deps.post(input);
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
