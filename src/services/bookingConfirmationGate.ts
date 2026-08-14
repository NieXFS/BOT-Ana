import type {
  FlowStateV2,
  GateDeclineV2,
  PendingFrameSnapshotV2,
} from './conversationalV2/contracts';
import { normalizeCustomerReplyStyle } from './customerReplyGuard';
import { buildCanonicalBookingSummaryV2 } from './conversationalV2/lifecycleReducer';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './conversationalV2/modelResultParser';
import {
  validatedBookingDraftForPendingV2,
  type PendingQuestionCatalogV2,
} from './conversationalV2/pendingQuestion';
import type { AcceptedDeliveryEvidenceV2 } from './conversationalV2/stateStore';

type ConversationMessage = {
  role: string;
  content?: unknown;
};

export interface BookingProposal {
  date: string;
  time: string;
  serviceName?: string;
  professionalName?: string;
}

export const RESCHEDULE_CANCELLATION_EVIDENCE_WINDOW_MS = 30 * 60 * 1000;

export interface RescheduleCancellationEvidence {
  conversationKey: string;
  appointmentId: string;
  succeededAt: number;
  expiresAt: number;
}

/**
 * Evidência process-local, curta e fail-closed. Ela não tenta reconstruir
 * intenção a partir da conversa: só recebe registros criados após
 * cancelAppointment success:true. A chave inclui phoneNumberId + cliente.
 *
 * Reinício do processo perde a evidência (bloqueia a remarcação, sem autorizar
 * escrita indevida). Persistir em banco exigiria um novo contrato/tabela só
 * para uma janela de 30 min; o ledger em memória cobre o cross-turn natural sem
 * transformar prosa ou um booleano durável em autorização.
 */
export class RescheduleCancellationEvidenceStore {
  private readonly entries = new Map<
    string,
    RescheduleCancellationEvidence
  >();

  private pruneExpired(now: number): void {
    for (const [conversationKey, evidence] of this.entries) {
      if (evidence.expiresAt <= now) {
        this.entries.delete(conversationKey);
      }
    }
  }

  record(
    conversationKey: string,
    appointmentId: string,
    now = Date.now()
  ): RescheduleCancellationEvidence {
    this.pruneExpired(now);
    const evidence = {
      conversationKey,
      appointmentId,
      succeededAt: now,
      expiresAt: now + RESCHEDULE_CANCELLATION_EVIDENCE_WINDOW_MS,
    };
    this.entries.set(conversationKey, evidence);
    return evidence;
  }

  peek(
    conversationKey: string,
    now = Date.now()
  ): RescheduleCancellationEvidence | null {
    const evidence = this.entries.get(conversationKey);
    if (!evidence) return null;
    if (evidence.expiresAt <= now) {
      this.entries.delete(conversationKey);
      return null;
    }
    return evidence;
  }

  consume(
    conversationKey: string,
    now = Date.now()
  ): RescheduleCancellationEvidence | null {
    const evidence = this.peek(conversationKey, now);
    if (!evidence) return null;
    this.entries.delete(conversationKey);
    return evidence;
  }

  restore(
    evidence: RescheduleCancellationEvidence,
    now = Date.now()
  ): boolean {
    if (evidence.expiresAt <= now) return false;
    this.entries.set(evidence.conversationKey, evidence);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}

export type BookingConfirmationDecision =
  | { ok: true; consumesCancellationEvidence: boolean }
  | { ok: false; hintMessage: string; reason: BookingConfirmationDeclineReason };

export type BookingConfirmationDeclineReason =
  | 'duplicate_resolution_not_licensed'
  | 'explicit_confirmation_missing'
  | 'scoped_modal_not_modal'
  | 'scoped_modal_context_missing'
  | 'scoped_modal_duplicate_pending'
  | 'scoped_modal_draft_invalid'
  | 'scoped_modal_booking_mismatch'
  | 'scoped_modal_delivery_missing'
  | 'scoped_modal_delivery_not_current_pending'
  | 'scoped_modal_expired'
  | 'scoped_modal_payload_mismatch';

export type CancellationIntentDecision =
  | { ok: true }
  | { ok: false; hintMessage: string };

export const CONFIRMATION_HINT =
  'INTERNAL_HINT: O cliente ainda não confirmou o resumo de forma inequívoca. Faça ou repita o resumo com serviço, data, horário e profissional; pergunte se está tudo certo e só chame bookAppointment depois de uma resposta explícita como "sim", "confirmo" ou "pode marcar".';

export const DUPLICATE_CONFIRMATION_HINT =
  'INTERNAL_HINT: confirmedDuplicate só pode ser usado depois que a Ana apresentou o conflito de agendamentos e o cliente escolheu explicitamente manter os dois ou remarcar. Se a escolha foi remarcar, o cancelamento anterior precisa ter concluído com sucesso antes do novo agendamento.';

export const CANCELLATION_HINT =
  'INTERNAL_HINT: cancelAppointment só pode ser usado no fluxo de agendamento duplicado, depois que a Ana apresentou as opções e o cliente escolheu explicitamente remarcar ou cancelar um agendamento anterior. Não cancele nada. Ao cliente, responda SOMENTE: "Esse cancelamento precisa ser tratado diretamente pela equipe. Eu não consigo concluí-lo por aqui." Não prometa nenhuma ação futura sua nem da equipe.';

export const BOOKING_CONFIRMATION_INTERNAL_HINTS = [
  CONFIRMATION_HINT,
  DUPLICATE_CONFIRMATION_HINT,
  CANCELLATION_HINT,
] as const;

/** Fecho aprovado: exclusivo da confirmação normal da rota v2. */
export const ENABLE_V2_SCOPED_MODAL_ECHO_CONFIRMATION = true;

export interface V2BookingConfirmationContext {
  pending?: PendingFrameSnapshotV2 | null;
  flowState: FlowStateV2;
  catalog: PendingQuestionCatalogV2;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  now: Date;
  onGateDecline?: (decline: GateDeclineV2) => void;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

export function isExplicitBookingConfirmation(message: string): boolean {
  const normalized = normalize(message);
  if (!normalized) return false;

  const withoutPunctuation = normalized
    .replace(/^[.!?,;:\s]+|[.!?,;:\s]+$/g, '')
    .replace(/\s*,\s*/g, ', ')
    .trim();

  if (
    /^(?:👍[\u{1F3FB}-\u{1F3FF}]?|🆗|👌[\u{1F3FB}-\u{1F3FF}]?)$/u.test(
      withoutPunctuation
    )
  ) {
    return true;
  }

  // Correções/adversativas têm precedência absoluta sobre qualquer aceite.
  // "beleza, mas às 16h" precisa gerar um novo resumo, nunca uma escrita.
  if (
    /\b(?:mas|porem|so que|na verdade|troca(?:r)?|muda(?:r)?|outr[oa]s?)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  if (
    /\b(?:acho|talvez|quem sabe|provavelmente|nao sei|se der|acredito que)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  // "pode ser" isolado continua ambíguo. Complementos afirmativos explícitos
  // ("pode ser sim/então/pode marcar") resolvem a ambiguidade em pt-BR.
  if (withoutPunctuation === 'pode ser') {
    return false;
  }

  return /^(?:(?:sim(?:,? sim)*|ok|okay)(?:,? (?:por favor|pode (?:marcar|agendar|confirmar)|tudo certo))?|isso(?: mesmo)?|e isso|perfeito|beleza|blz|show|ta (?:bom|otimo)|pode sim|quero sim|bora(?: sim)?|vamos(?: sim)?|aham|uhum|por favor|confirmo|confirma(?:,? sim)?|confirmado(?:,? sim)?|pode (?:marcar|agendar|confirmar)(?:,? (?:por favor|sim))?|pode ser(?:,? sim|,? entao|,? pode (?:marcar|agendar|confirmar))|(?:esta |ta )?tudo certo|fechado|combinado|manda ver)$/.test(
    withoutPunctuation
  );
}

function assistantMessages(history: ConversationMessage[]): string[] {
  return history
    .filter(
      (message) =>
        message.role === 'assistant' && typeof message.content === 'string'
    )
    .map((message) => message.content as string);
}

function latestAssistantMessage(
  history: ConversationMessage[]
): string | null {
  return (
    [...history]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' && typeof message.content === 'string'
    )?.content as string | undefined
  ) ?? null;
}

function containsExpectedTime(message: string, expectedTime: string): boolean {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(expectedTime.trim());
  if (!match) return false;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const normalized = normalize(message);
  const variants = new Set([
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    `${hour}:${String(minute).padStart(2, '0')}`,
    minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, '0')}`,
    `${hour}h${String(minute).padStart(2, '0')}`,
  ]);

  return [...variants].some((variant) => normalized.includes(variant));
}

function containsExpectedDate(message: string, expectedDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expectedDate.trim());
  if (!match) return false;

  const [, year, month, day] = match;
  const monthNames = [
    'janeiro',
    'fevereiro',
    'marco',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ];
  const normalized = normalize(message);
  const dayNumber = String(Number(day));
  const monthNumber = String(Number(month));
  const variants = [
    expectedDate,
    `${day}/${month}`,
    `${dayNumber}/${monthNumber}`,
    `${day}/${month}/${year}`,
    `${dayNumber}/${monthNumber}/${year}`,
    `${dayNumber} de ${monthNames[Number(month) - 1]}`,
  ];

  return variants.some((variant) => normalized.includes(variant));
}

function messageMatchesProposal(
  message: string,
  expected: BookingProposal
): boolean {
  const normalized = normalize(message);
  if (
    !containsExpectedDate(message, expected.date) ||
    !containsExpectedTime(message, expected.time)
  ) {
    return false;
  }

  if (
    expected.serviceName &&
    !normalized.includes(normalize(expected.serviceName))
  ) {
    return false;
  }
  if (
    expected.professionalName &&
    !normalized.includes(normalize(expected.professionalName))
  ) {
    return false;
  }

  return true;
}

function assistantRequestedConfirmation(
  message: string,
  expected?: BookingProposal
): boolean {
  const normalized = normalize(message);
  const hasConfirmationCue =
    /(tudo certo|posso confirmar|voce confirma|confirma (esse|este|o) horario|vou agendar|vou marcar)/.test(
      normalized
    );
  const hasConcreteTime =
    /\b(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)\b/.test(normalized);
  const hasConcreteDate =
    /\b(?:\d{4}-\d{2}-\d{2}|(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])(?:[/-]\d{2,4})?|(?:0?[1-9]|[12]\d|3[01]) de (?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))\b/.test(
      normalized
    );
  const endsInQuestion = message
    .trim()
    .replace(
      /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/gu,
      ''
    )
    .trimEnd()
    .endsWith('?');
  const hasStructuredConfirmationRequest =
    hasConcreteTime && hasConcreteDate && endsInQuestion;

  return (
    ((hasConfirmationCue && hasConcreteTime) ||
      hasStructuredConfirmationRequest) &&
    (!expected || messageMatchesProposal(message, expected))
  );
}

function previousAssistantRequestedConfirmation(
  history: ConversationMessage[],
  expected?: BookingProposal
): boolean {
  const previousAssistant = latestAssistantMessage(history);
  return Boolean(
    previousAssistant &&
      assistantRequestedConfirmation(previousAssistant, expected)
  );
}

function normalizedModalEcho(message: string): boolean {
  const value = normalize(message)
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
  return /^(?:pode|pode sim|pode marcar)$/u.test(value);
}

/**
 * Modal curto só ecoa a pergunta canônica da pendência CONFIRMATION atual.
 * A função é pura para o smoke; o gate só a consulta quando a constante acima
 * estiver ativa.
 */
export function diagnoseScopedV2ModalEchoConfirmation(input: {
  currentUserMessage: string;
  history: ConversationMessage[];
  expectedBooking?: BookingProposal;
  context?: V2BookingConfirmationContext;
}): { ok: true } | { ok: false; reason: BookingConfirmationDeclineReason } {
  if (!normalizedModalEcho(input.currentUserMessage)) {
    return { ok: false, reason: 'scoped_modal_not_modal' };
  }
  const pending = input.context?.pending;
  const flowState = input.context?.flowState;
  const catalog = input.context?.catalog;
  if (!pending || !flowState?.flowId || !catalog || !input.context) {
    return { ok: false, reason: 'scoped_modal_context_missing' };
  }
  if (
    pending.options.some((option) =>
      option.entityId.startsWith('duplicate-resolution:')
    )
  ) {
    return { ok: false, reason: 'scoped_modal_duplicate_pending' };
  }
  const draft = validatedBookingDraftForPendingV2({
    pending,
    flowState,
    catalog,
  });
  if (!draft) {
    return { ok: false, reason: 'scoped_modal_draft_invalid' };
  }
  if (
    draft.date !== input.expectedBooking?.date ||
    draft.time !== input.expectedBooking?.time
  ) {
    return { ok: false, reason: 'scoped_modal_booking_mismatch' };
  }

  const delivery = input.context.lastAcceptedDelivery;
  const transition = delivery?.transition;
  if (!delivery) {
    return { ok: false, reason: 'scoped_modal_delivery_missing' };
  }
  if (
    delivery.conversationCommitOutcome !== 'committed' ||
    delivery.pendingCommitOutcome !== 'opened' ||
    transition?.kind !== 'open' ||
    transition.frame.questionId !== pending.questionId ||
    transition.frame.version !== pending.version ||
    transition.frame.flowId !== pending.flowId ||
    transition.frame.askedAt !== pending.askedAt ||
    transition.frame.kind !== pending.kind ||
    transition.frame.options.length !== pending.options.length ||
    transition.frame.options.some((option, index) => {
      const current = pending.options[index];
      return (
        !current ||
        option.position !== current.position ||
        option.entityId !== current.entityId ||
        option.displayName !== current.displayName
      );
    })
  ) {
    return {
      ok: false,
      reason: 'scoped_modal_delivery_not_current_pending',
    };
  }

  const nowMs = input.context.now.getTime();
  const askedAtMs = Date.parse(pending.askedAt);
  const terminalAtMs = Date.parse(delivery.terminalAt);
  const askedAge = nowMs - askedAtMs;
  const terminalAge = nowMs - terminalAtMs;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(askedAtMs) ||
    !Number.isFinite(terminalAtMs) ||
    askedAge < 0 ||
    terminalAge < 0 ||
    askedAge > PENDING_FAST_PATH_MAX_AGE_MS ||
    terminalAge > PENDING_FAST_PATH_MAX_AGE_MS
  ) {
    return { ok: false, reason: 'scoped_modal_expired' };
  }

  const canonicalCopy = buildCanonicalBookingSummaryV2({
    draft,
    services: catalog,
  });
  return normalizeCustomerReplyStyle(delivery.payload) ===
    normalizeCustomerReplyStyle(canonicalCopy)
    ? { ok: true }
    : { ok: false, reason: 'scoped_modal_payload_mismatch' };
}

export function matchesScopedV2ModalEchoConfirmation(input: {
  currentUserMessage: string;
  history: ConversationMessage[];
  expectedBooking?: BookingProposal;
  context?: V2BookingConfirmationContext;
}): boolean {
  return diagnoseScopedV2ModalEchoConfirmation(input).ok;
}

function isExplicitConfirmationForGate(input: {
  currentUserMessage: string;
  history: ConversationMessage[];
  expectedBooking?: BookingProposal;
  v2ConfirmationContext?: V2BookingConfirmationContext;
}): boolean {
  if (
    ENABLE_V2_SCOPED_MODAL_ECHO_CONFIRMATION &&
    input.v2ConfirmationContext &&
    normalizedModalEcho(input.currentUserMessage)
  ) {
    return matchesScopedV2ModalEchoConfirmation({
      currentUserMessage: input.currentUserMessage,
      history: input.history,
      expectedBooking: input.expectedBooking,
      context: input.v2ConfirmationContext,
    });
  }
  return isExplicitBookingConfirmation(input.currentUserMessage);
}

function historyContainsConfirmedProposal(
  history: ConversationMessage[],
  expected?: BookingProposal
): boolean {
  return assistantMessages(history).some((message) =>
    assistantRequestedConfirmation(message, expected)
  );
}

function assistantPresentedDuplicateChoice(message: string): boolean {
  const normalized = normalize(message);
  const hasExistingAppointment =
    /(?:ja tem|agendamento(?:s)? futuro|outro(?:s)? agendamento)/.test(
      normalized
    );
  const optionCount = [
    /\bmanter\b/.test(normalized),
    /\bremarcar\b/.test(normalized),
    /\bcancelar\b/.test(normalized),
    /\bpensar\b/.test(normalized),
  ].filter(Boolean).length;

  return hasExistingAppointment && optionCount >= 2;
}

function assistantAskedWhichDuplicate(message: string): boolean {
  const normalized = normalize(message);
  return (
    /qual(?: dos| deles| agendamento)?.{0,50}(?:cancelar|remarcar|agendamento)/.test(
      normalized
    ) ||
    /(?:data|dia).{0,40}(?:horario|hora).{0,50}(?:cancelar|remarcar)/.test(
      normalized
    )
  );
}

function historyContainsDuplicateChoice(
  history: ConversationMessage[]
): boolean {
  return assistantMessages(history).some(assistantPresentedDuplicateChoice);
}

function isConfirmedDuplicateDecision(message: string): boolean {
  const normalized = normalize(message);
  return (
    /\bmanter (?:os )?dois\b/.test(normalized) ||
    /\b(?:e |um |marcar )?outro atendimento\b/.test(normalized) ||
    /\bremarcar\b/.test(normalized) ||
    /\bcancel(?:e|ar).{0,50}(?:anterior|antigo).{0,80}(?:marc|agend)/.test(
      normalized
    )
  );
}

function isRemarriageDecision(message: string): boolean {
  return /\b(remarcar|substituir|trocar (?:o|um) agendamento)\b/.test(
    normalize(message)
  );
}

function isKeepBothDecision(message: string): boolean {
  return /\b(?:manter (?:os )?dois|(?:e |um |marcar )?outro atendimento)\b/.test(
    normalize(message)
  );
}

export function hasTypedKeepBothEvidenceV2(
  context?: V2BookingConfirmationContext
): boolean {
  const pending = context?.pending;
  const flowState = context?.flowState;
  const evidence = flowState?.duplicateResolution;
  const draft = flowState?.bookingDraft;
  if (
    !context ||
    !pending ||
    pending.kind !== 'CONFIRMATION' ||
    pending.flowId !== flowState?.flowId ||
    pending.options.length !== 1 ||
    pending.options[0]?.entityId !== `booking-confirmation:${pending.flowId}` ||
    evidence?.kind !== 'keep_both' ||
    !evidence.readEvidenceTurnId.trim() ||
    evidence.sourcePendingVersion >= pending.version ||
    !draft ||
    evidence.serviceId !== draft.serviceId ||
    evidence.professionalId !== draft.professionalId ||
    evidence.date !== draft.date ||
    evidence.time !== draft.time
  ) {
    return false;
  }
  return Boolean(
    validatedBookingDraftForPendingV2({
      pending,
      flowState,
      catalog: context.catalog,
    })
  );
}

export function priorUserSelectedDuplicateAction(
  history: ConversationMessage[],
  currentUserMessageIndex: number
): boolean {
  // A posição é a identidade do turno atual. Comparar conteúdo faria mensagens
  // repetidas como "remarcar" confundirem uma ocorrência com outra.
  const currentIndex = Number.isInteger(currentUserMessageIndex)
    ? currentUserMessageIndex
    : history.length;

  return history.some((message, index) => {
    if (
      index >= currentIndex ||
      message.role !== 'user' ||
      typeof message.content !== 'string'
    ) {
      return false;
    }
    return isConfirmedDuplicateDecision(message.content);
  });
}

/**
 * Hard block anterior ao bookAppointment. O LLM pode interpretar linguagem
 * vaga como autorização; o código só libera após resumo no turno anterior +
 * confirmação inequívoca. O fluxo de duplicidade tem sua própria confirmação.
 */
export function bookingConfirmationGate(input: {
  currentUserMessage: string;
  history: ConversationMessage[];
  confirmedDuplicate: boolean;
  expectedBooking?: BookingProposal;
  duplicateCancellationSucceeded?: boolean;
  currentUserMessageIndex?: number;
  v2ConfirmationContext?: V2BookingConfirmationContext;
}): BookingConfirmationDecision {
  const typedKeepBoth = hasTypedKeepBothEvidenceV2(
    input.v2ConfirmationContext
  );
  const isSameTurnRemarriageAfterCancellation =
    input.duplicateCancellationSucceeded === true &&
    isRemarriageDecision(input.currentUserMessage);
  if (
    input.confirmedDuplicate ||
    typedKeepBoth ||
    isSameTurnRemarriageAfterCancellation
  ) {
    const previousAssistant = latestAssistantMessage(input.history);
    const duplicateWasPresented = historyContainsDuplicateChoice(input.history);
    const proposalWasPresented = historyContainsConfirmedProposal(
      input.history,
      input.expectedBooking
    );
    const currentDecision = isConfirmedDuplicateDecision(
      input.currentUserMessage
    );
    const keepBoth = isKeepBothDecision(input.currentUserMessage);
    const remarriage = isRemarriageDecision(input.currentUserMessage);
    const choiceIsCurrent =
      Boolean(
        previousAssistant &&
          (assistantPresentedDuplicateChoice(previousAssistant) ||
            assistantAskedWhichDuplicate(previousAssistant))
      ) && currentDecision;
    const confirmedAfterPriorChoice =
      isExplicitConfirmationForGate(input) &&
      previousAssistantRequestedConfirmation(
        input.history,
        input.expectedBooking
      ) &&
      priorUserSelectedDuplicateAction(
        input.history,
        input.currentUserMessageIndex ?? input.history.length
      );

    const canKeepBoth =
      (keepBoth && choiceIsCurrent) ||
      (typedKeepBoth && confirmedAfterPriorChoice);
    const canRemarry =
      (remarriage || confirmedAfterPriorChoice) &&
      input.duplicateCancellationSucceeded === true;

    if (
      duplicateWasPresented &&
      proposalWasPresented &&
      (canKeepBoth || canRemarry)
    ) {
      return {
        ok: true,
        consumesCancellationEvidence: canRemarry,
      };
    }

    return {
      ok: false,
      hintMessage: DUPLICATE_CONFIRMATION_HINT,
      reason: 'duplicate_resolution_not_licensed',
    };
  }

  if (
    isExplicitConfirmationForGate(input) &&
    previousAssistantRequestedConfirmation(
      input.history,
      input.expectedBooking
    )
  ) {
    return { ok: true, consumesCancellationEvidence: false };
  }

  const modalDiagnostic = diagnoseScopedV2ModalEchoConfirmation({
    currentUserMessage: input.currentUserMessage,
    history: input.history,
    expectedBooking: input.expectedBooking,
    context: input.v2ConfirmationContext,
  });
  return {
    ok: false,
    hintMessage: CONFIRMATION_HINT,
    reason: modalDiagnostic.ok
      ? 'explicit_confirmation_missing'
      : modalDiagnostic.reason,
  };
}

/**
 * Hard block anterior ao cancelAppointment. Cancelamento avulso nunca é uma
 * ferramenta da Ana; só o fluxo de conflito já apresentado ao cliente libera a
 * consulta defensiva do calendarService.
 */
export function cancellationIntentGate(input: {
  currentUserMessage: string;
  history: ConversationMessage[];
}): CancellationIntentDecision {
  const previousAssistant = latestAssistantMessage(input.history);
  const current = normalize(input.currentUserMessage);
  const directDecision =
    /\b(remarcar|cancelar|cancele|substituir)\b/.test(current);
  const duplicateChoiceIsAdjacent = Boolean(
    previousAssistant && assistantPresentedDuplicateChoice(previousAssistant)
  );
  const duplicateTargetQuestionIsAdjacent = Boolean(
    previousAssistant && assistantAskedWhichDuplicate(previousAssistant)
  );
  const selectedAfterQuestion =
    duplicateTargetQuestionIsAdjacent &&
    /\b(?:primeiro|segundo|anterior|antigo|dia|\d{1,2}[/-]\d{1,2}|\d{1,2}h|\d{1,2}:\d{2})\b/.test(
      current
    );

  if (
    (duplicateChoiceIsAdjacent && directDecision) ||
    (duplicateTargetQuestionIsAdjacent &&
      (directDecision || selectedAfterQuestion))
  ) {
    return { ok: true };
  }

  return { ok: false, hintMessage: CANCELLATION_HINT };
}
