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
  | { ok: false; hintMessage: string };

export type CancellationIntentDecision =
  | { ok: true }
  | { ok: false; hintMessage: string };

const CONFIRMATION_HINT =
  'INTERNAL_HINT: O cliente ainda não confirmou o resumo de forma inequívoca. Faça ou repita o resumo com serviço, data, horário e profissional; pergunte se está tudo certo e só chame bookAppointment depois de uma resposta explícita como "sim", "confirmo" ou "pode marcar".';

const DUPLICATE_CONFIRMATION_HINT =
  'INTERNAL_HINT: confirmedDuplicate só pode ser usado depois que a Ana apresentou o conflito de agendamentos e o cliente escolheu explicitamente manter os dois ou remarcar. Se a escolha foi remarcar, o cancelamento anterior precisa ter concluído com sucesso antes do novo agendamento.';

const CANCELLATION_HINT =
  'INTERNAL_HINT: cancelAppointment só pode ser usado no fluxo de agendamento duplicado, depois que a Ana apresentou as opções e o cliente escolheu explicitamente remarcar ou cancelar um agendamento anterior. Não cancele nada; encaminhe cancelamentos avulsos para a equipe.';

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
  return /\bmanter (?:os )?dois\b/.test(normalize(message));
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
}): BookingConfirmationDecision {
  const isSameTurnRemarriageAfterCancellation =
    input.duplicateCancellationSucceeded === true &&
    isRemarriageDecision(input.currentUserMessage);
  if (input.confirmedDuplicate || isSameTurnRemarriageAfterCancellation) {
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
      isExplicitBookingConfirmation(input.currentUserMessage) &&
      previousAssistantRequestedConfirmation(
        input.history,
        input.expectedBooking
      ) &&
      priorUserSelectedDuplicateAction(
        input.history,
        input.currentUserMessageIndex ?? input.history.length
      );

    const canKeepBoth = keepBoth && choiceIsCurrent;
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

    return { ok: false, hintMessage: DUPLICATE_CONFIRMATION_HINT };
  }

  if (
    isExplicitBookingConfirmation(input.currentUserMessage) &&
    previousAssistantRequestedConfirmation(
      input.history,
      input.expectedBooking
    )
  ) {
    return { ok: true, consumesCancellationEvidence: false };
  }

  return { ok: false, hintMessage: CONFIRMATION_HINT };
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
