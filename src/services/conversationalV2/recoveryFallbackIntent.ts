import type { ServicesResult } from '../calendarService';
import {
  matchInboundToExpectedSlot,
  isAffirmativeCompact,
  type PendingOperationalQuestion,
} from '../receptionistTurnDecision';
import type { TurnFrameV2 } from './contracts';
import { resolvePendingOptionProofV2 } from './fastPaths';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';

export const RECOVERY_FALLBACK_INTENTS_V2 = [
  'ANSWER_TO_PENDING',
  'INFORMATION_QUESTION',
  'TRANSACTION_REQUEST',
  'OTHER',
] as const;

export type RecoveryFallbackIntentV2 =
  (typeof RECOVERY_FALLBACK_INTENTS_V2)[number];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasFreshPendingV2(frame: TurnFrameV2, now: Date): boolean {
  if (!frame.pending || frame.pending.flowId !== frame.flowState.flowId) {
    return false;
  }
  const askedAt = Date.parse(frame.pending.askedAt);
  return (
    Number.isFinite(askedAt) &&
    now.getTime() - askedAt <= PENDING_FAST_PATH_MAX_AGE_MS
  );
}

function legacyPendingSnapshotV2(
  frame: TurnFrameV2
): PendingOperationalQuestion | null {
  const pending = frame.pending;
  if (!pending) return null;
  if (
    pending.kind === 'CANCEL_TARGET' ||
    pending.kind === 'CANCEL_CONFIRMATION'
  ) {
    return {
      source: 'ANA',
      listedServiceNames: [],
      listedProfessionalNames: [],
      alreadyAskedConfirmation: pending.kind === 'CANCEL_CONFIRMATION',
    };
  }
  const displayed = pending.options
    .map((option) => option.displayName.trim())
    .filter(Boolean);
  return {
    source: 'ANA',
    expectedSlot: pending.kind,
    listedServiceNames: pending.kind === 'SERVICE' ? displayed : [],
    listedProfessionalNames: pending.kind === 'PROFESSIONAL' ? displayed : [],
    confirmationCandidate:
      pending.kind === 'CONFIRMATION' && displayed.length === 1
        ? displayed[0]
        : undefined,
    alreadyAskedConfirmation: pending.kind === 'CONFIRMATION',
  };
}

/**
 * Relação allow-only com o PendingFrame. Primeiro reutiliza a prova v2; o
 * compositor legado entra somente como matcher fechado de slot e seu único
 * resultado aceito é `unequivocal`. `unknown`/`ambiguous` nunca viram resposta.
 */
function answersFreshPendingV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  servicesResult: ServicesResult;
  now: Date;
  lastAcceptedAssistantText?: string;
}): boolean {
  if (!hasFreshPendingV2(input.frame, input.now)) return false;
  const proof = resolvePendingOptionProofV2({
    frame: input.frame,
    inboundId: input.inboundId,
    inboundText: input.inboundText,
    now: input.now,
    catalog: input.servicesResult,
    lastAcceptedAssistantText: input.lastAcceptedAssistantText,
  });
  if (proof?.kind === 'pending_option') return true;

  const normalized = normalize(input.inboundText);
  // O matcher legado é mais amplo que a relação exigida pelo recovery: menção
  // curta de catálogo pode ser informação, não escolha. Formas lexicalmente
  // interrogativas nunca alcançam esse segundo degrau; `?` isolado permanece
  // permitido para respostas como “pode ser drenagem?” e “15h?”.
  if (hasInformationLexicalCueV2(normalized)) return false;

  const pending = legacyPendingSnapshotV2(input.frame);
  if (!pending) return false;
  return (
    matchInboundToExpectedSlot(
      input.inboundText,
      pending,
      input.servicesResult
    ).kind === 'unequivocal'
  );
}

function isTransactionRequestV2(normalized: string): boolean {
  return (
    /\b(?:quero|queria|gostaria|preciso|desejo|pode|poderia|posso|consigo|vamos|tem como)\b(?:\s+\w+){0,6}\s+\b(?:agendar|marcar|cancelar|desmarcar|remarcar|reagendar|confirmar)\b/u.test(
      normalized
    ) ||
    /\b(?:agende|marque|cancele|desmarque|remarque|reagende|confirme)\b/u.test(
      normalized
    ) ||
    /^(?:agendar|marcar|cancelar|desmarcar|remarcar|reagendar|confirmar)\b/u.test(
      normalized
    )
  );
}

function hasInformationLexicalCueV2(normalized: string): boolean {
  return (
    /\b(?:como funciona|como e feito|o que e|o que sao|em que consiste|qual|quais|quanto|quantos|quanta|quantas|quem|onde|quando|por que|porque)\b/u.test(
      normalized
    ) ||
    /\b(?:pode me explicar|me explica|explique|queria saber|gostaria de saber|quero saber)\b/u.test(
      normalized
    )
  );
}

function isInformationQuestionV2(raw: string, normalized: string): boolean {
  if (isAffirmativeCompact(raw)) return false;
  return /[?？]/u.test(raw) || hasInformationLexicalCueV2(normalized);
}

/** Classificação pura usada exclusivamente pelo fallback final do recovery. */
export function classifyRecoveryFallbackIntentV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  servicesResult: ServicesResult;
  now: Date;
  lastAcceptedAssistantText?: string;
}): RecoveryFallbackIntentV2 {
  if (answersFreshPendingV2(input)) return 'ANSWER_TO_PENDING';

  const normalized = normalize(input.inboundText);
  const transactionRequest = isTransactionRequestV2(normalized);
  if (
    !transactionRequest &&
    isInformationQuestionV2(input.inboundText, normalized)
  ) {
    return 'INFORMATION_QUESTION';
  }
  if (transactionRequest) return 'TRANSACTION_REQUEST';
  return 'OTHER';
}
