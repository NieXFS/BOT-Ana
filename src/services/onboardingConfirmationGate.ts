import { isExplicitBookingConfirmation } from './bookingConfirmationGate';
import { normalizeForMatch } from './salesOpeners';

export const ONBOARDING_WRITE_TOOLS = [
  'upsertService',
  'setSchedule',
  'addProfessional',
  'updateClinicInfo',
  'completeOnboarding',
] as const;

export type OnboardingWriteTool =
  (typeof ONBOARDING_WRITE_TOOLS)[number];

export interface PendingOnboardingProposal {
  tool: OnboardingWriteTool;
  input: Record<string, unknown>;
  fingerprint: string;
  createdAt: number;
}

export type OnboardingWriteDecision =
  | { ok: true; proposal: PendingOnboardingProposal }
  | {
      ok: false;
      reason:
        | 'proposal_required'
        | 'proposal_mismatch'
        | 'confirmation_required';
      hintMessage: string;
    };

const pendingByConversation =
  new Map<string, PendingOnboardingProposal>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'confirmed')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  );
}

export function onboardingProposalFingerprint(
  tool: OnboardingWriteTool,
  input: Record<string, unknown>
): string {
  return `${tool}:${JSON.stringify(stableValue(input))}`;
}

export function rememberPendingOnboardingProposal(
  conversationKey: string,
  tool: OnboardingWriteTool,
  input: Record<string, unknown>,
  now = Date.now()
): PendingOnboardingProposal {
  const existing = pendingByConversation.get(conversationKey);
  if (existing) return existing;

  const proposal = {
    tool,
    input: stableValue(input) as Record<string, unknown>,
    fingerprint: onboardingProposalFingerprint(tool, input),
    createdAt: now,
  };
  pendingByConversation.set(conversationKey, proposal);
  return proposal;
}

export function getPendingOnboardingProposal(
  conversationKey: string
): PendingOnboardingProposal | null {
  return pendingByConversation.get(conversationKey) ?? null;
}

export function clearPendingOnboardingProposal(
  conversationKey: string
): void {
  pendingByConversation.delete(conversationKey);
}

/**
 * Hesitação, correção ou qualquer resposta que não seja confirmação inequívoca
 * invalida a proposta anterior antes de o modelo poder tentar a escrita.
 */
export function invalidateProposalForInbound(
  conversationKey: string,
  currentUserMessage: string
): void {
  if (
    pendingByConversation.has(conversationKey) &&
    !isExplicitBookingConfirmation(currentUserMessage)
  ) {
    pendingByConversation.delete(conversationKey);
  }
}

export function authorizeOnboardingWrite(input: {
  conversationKey: string;
  tool: OnboardingWriteTool;
  toolInput: Record<string, unknown>;
  currentUserMessage: string;
}): OnboardingWriteDecision {
  const pending = pendingByConversation.get(input.conversationKey);
  if (!pending) {
    return {
      ok: false,
      reason: 'proposal_required',
      hintMessage:
        'INTERNAL_HINT: Não grave ainda. Apresente uma proposta explícita com todos os dados desta alteração, pergunte se a cliente confirma e espere a resposta dela em um NOVO turno.',
    };
  }

  const fingerprint = onboardingProposalFingerprint(
    input.tool,
    input.toolInput
  );
  if (
    pending.tool !== input.tool ||
    pending.fingerprint !== fingerprint
  ) {
    pendingByConversation.delete(input.conversationKey);
    return {
      ok: false,
      reason: 'proposal_mismatch',
      hintMessage:
        'INTERNAL_HINT: Os dados pedidos agora não são idênticos à proposta anterior. Não grave. Faça uma nova proposta explícita com estes dados e espere uma nova confirmação.',
    };
  }

  if (!isExplicitBookingConfirmation(input.currentUserMessage)) {
    pendingByConversation.delete(input.conversationKey);
    return {
      ok: false,
      reason: 'confirmation_required',
      hintMessage:
        'INTERNAL_HINT: A resposta atual não é uma confirmação inequívoca. Hesitação, correção e adversativa invalidam a proposta. Não grave; apresente a proposta novamente e espere um novo turno.',
    };
  }

  // Consumir ANTES do I/O é fail-closed: retry de transporte exige nova
  // proposta/confirmação e nunca repete uma escrita por acidente.
  pendingByConversation.delete(input.conversationKey);
  return { ok: true, proposal: pending };
}

function normalizedContains(
  normalizedReply: string,
  value: unknown
): boolean {
  if (typeof value === 'number') {
    return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`).test(normalizedReply);
  }
  if (typeof value !== 'string') return true;
  const normalizedValue = normalizeForMatch(value);
  return !normalizedValue || normalizedReply.includes(normalizedValue);
}

function weekdayName(day: number): string {
  return [
    'domingo',
    'segunda',
    'terca',
    'quarta',
    'quinta',
    'sexta',
    'sabado',
  ][day] ?? String(day);
}

/**
 * A proposta só entra no Map se a mensagem FINAL da Renata realmente pediu
 * confirmação e repetiu os dados materiais da escrita bloqueada.
 */
export function replyContainsOnboardingProposal(
  reply: string,
  tool: OnboardingWriteTool,
  input: Record<string, unknown>
): boolean {
  const normalized = normalizeForMatch(reply);
  const asksConfirmation =
    /\b(?:confirma|confirmar|posso (?:cadastrar|salvar|configurar|atualizar|finalizar)|tudo certo)\b/.test(
      normalized
    );
  if (!asksConfirmation) return false;

  switch (tool) {
    case 'upsertService':
      return (
        normalizedContains(normalized, input.name) &&
        normalizedContains(normalized, input.durationMin) &&
        normalizedContains(normalized, input.price)
      );
    case 'setSchedule': {
      const basic =
        normalizedContains(normalized, input.openingTime) &&
        normalizedContains(normalized, input.closingTime) &&
        normalizedContains(normalized, input.slotIntervalMinutes);
      if (!basic) return false;
      const closed = Array.isArray(input.closedWeekdays)
        ? input.closedWeekdays
        : [];
      return closed.every(
        (day) =>
          typeof day !== 'number' ||
          normalized.includes(weekdayName(day))
      );
    }
    case 'addProfessional':
      return normalizedContains(normalized, input.name);
    case 'updateClinicInfo': {
      const values = Object.values(input).filter(
        (value) =>
          (typeof value === 'string' && value.trim()) ||
          typeof value === 'number'
      );
      return (
        values.length > 0 &&
        values.every((value) => normalizedContains(normalized, value))
      );
    }
    case 'completeOnboarding':
      return /\b(?:finalizar|concluir|encerrar).*(?:configuracao|onboarding)|(?:configuracao|onboarding).*(?:finalizar|concluir|encerrar)\b/.test(
        normalized
      );
  }
}

export function rememberProposalFromReply(input: {
  conversationKey: string;
  reply: string;
  tool: OnboardingWriteTool;
  toolInput: Record<string, unknown>;
}): boolean {
  if (
    !replyContainsOnboardingProposal(
      input.reply,
      input.tool,
      input.toolInput
    )
  ) {
    return false;
  }
  rememberPendingOnboardingProposal(
    input.conversationKey,
    input.tool,
    input.toolInput
  );
  return true;
}

export function clearPendingOnboardingProposals(
  conversationKeys: string[]
): void {
  for (const conversationKey of conversationKeys) {
    pendingByConversation.delete(conversationKey);
  }
}

export function __resetOnboardingConfirmationGateForTest(): void {
  pendingByConversation.clear();
}

