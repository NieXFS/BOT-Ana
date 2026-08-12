import type OpenAI from 'openai';

export type UpcomingAppointmentGateReason =
  | 'explicit_customer_intent'
  | 'duplicate_resolution_reply'
  | 'missing_customer_intent';

export type UpcomingAppointmentGateResult =
  | { ok: true; reason: Exclude<UpcomingAppointmentGateReason, 'missing_customer_intent'> }
  | { ok: false; reason: 'missing_customer_intent'; hintMessage: string };

export const UPCOMING_APPOINTMENT_INTENT_HINT =
  'INTERNAL_HINT: não consulte agendamentos futuros sem um pedido explícito do cliente para ver, cancelar ou remarcar o próprio agendamento. Responda somente ao pedido atual, sem introduzir serviço, profissional, data ou horário do histórico.';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitlyRequestsExistingAppointment(message: string): boolean {
  const text = normalize(message);
  if (!text) return false;

  if (/\b(?:nao|nunca)\b[^.!?\n]{0,25}\b(?:cancelar|remarcar|reagendar)\b/.test(text)) {
    return false;
  }

  if (
    /\b(?:remarcar|remarcacao|reagendar|cancelar|cancelamento)\b/.test(text) &&
    /\b(?:meu|minha|meus|minhas|agendamento|horario|retorno|consulta)\b/.test(text)
  ) {
    return true;
  }

  if (
    /\b(?:meu|minha|meus|minhas|tenho|marquei|agendei|ficou)\b[^.!?\n]{0,45}\b(?:agendamento|horario|retorno|consulta)\b/.test(
      text
    )
  ) {
    return true;
  }

  return /\b(?:qual|quando|que dia|que horas)\b[^.!?\n]{0,35}\b(?:meu|minha|agendamento marcado|horario marcado|retorno marcado)\b/.test(
    text
  );
}

function textContent(
  message: OpenAI.Chat.Completions.ChatCompletionMessageParam
): string {
  return typeof message.content === 'string' ? message.content : '';
}

function isShortDuplicateDecision(message: string): boolean {
  const text = normalize(message).replace(/[.!?]+$/g, '').trim();
  return /^(?:1|2|3|4|sim|isso|esse|essa|o primeiro|o segundo|a primeira|a segunda|manter os dois|so cancelar|pensar depois)$/.test(
    text
  );
}

function previousAssistantOfferedDuplicateResolution(
  history: readonly OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || message.role === 'user') continue;
    if (message.role !== 'assistant') continue;
    if ('name' in message && message.name === 'equipe_humana') continue;
    const content = normalize(textContent(message));
    if (!content) continue;
    return (
      /\b(?:agendamento|horario)\b/.test(content) &&
      /\b(?:remarcar|cancelar|manter os dois|pensar depois)\b/.test(content)
    );
  }
  return false;
}

/**
 * Gate determinístico anterior à I/O de `getUpcomingAppointments`. A descrição
 * da tool continua ajudando o modelo, mas não é mais a fronteira de segurança.
 */
export function upcomingAppointmentReadGate(input: {
  currentUserMessage: string;
  conversationHistory?: readonly OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}): UpcomingAppointmentGateResult {
  if (explicitlyRequestsExistingAppointment(input.currentUserMessage)) {
    return { ok: true, reason: 'explicit_customer_intent' };
  }

  if (
    isShortDuplicateDecision(input.currentUserMessage) &&
    previousAssistantOfferedDuplicateResolution(input.conversationHistory ?? [])
  ) {
    return { ok: true, reason: 'duplicate_resolution_reply' };
  }

  return {
    ok: false,
    reason: 'missing_customer_intent',
    hintMessage: UPCOMING_APPOINTMENT_INTENT_HINT,
  };
}
