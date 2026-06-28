/**
 * Atividade da conversa (§8.1 / §11 do spec de automações) — decisão PURA, sem
 * rede/DB, testável isoladamente. O motor de automação do Receps consulta o
 * endpoint GET /internal/conversation-activity (irmão do pause-state) ANTES de
 * cada envio proativo, pra não cair no meio de uma conversa ativa.
 *
 * A Ana devolve só o que ELA sabe (deriva do ana_conversation_history): se o
 * último turno é um inbound do cliente sem resposta, qual foi a última atividade
 * e se há fluxo "quente". O estado de PAUSA mora no Receps (ele já tem isso no
 * banco dele) — por isso o shape NÃO inclui `paused`.
 */

/** Heurística: "fluxo ativo" = houve atividade nos últimos ~5 min. */
export const FLUXO_ATIVO_WINDOW_MS = 5 * 60_000;

export interface ConversationActivityInput {
  /** Papel da ÚLTIMA mensagem do histórico (null = conversa sem histórico). */
  lastRole: 'user' | 'assistant' | null;
  /** Timestamp (ms) da última atividade = max(createdAt). null se vazio. */
  lastActivityAtMs: number | null;
}

export interface ConversationActivity {
  /**
   * A última mensagem é um inbound do cliente SEM resposta (ele está esperando).
   * Com a captura do echo (§8.2), uma resposta do humano vira role `assistant`
   * (prefixo "[atendente] ") → conversa respondida pelo humano NÃO conta como
   * "sem resposta".
   */
  ultimoInboundSemResposta: boolean;
  /** ISO da última atividade (ou null se a conversa não tem histórico). */
  ultimaAtividadeEm: string | null;
  /**
   * Heurística best-effort: houve atividade nos últimos FLUXO_ATIVO_WINDOW_MS.
   * NÃO é detecção fina de "Ana em meio a um fluxo de agendamento" — é só
   * "conversa quente o suficiente pra ADIAR um envio proativo".
   */
  fluxoAtivo: boolean;
}

export function decideConversationActivity(
  input: ConversationActivityInput,
  nowMs: number,
  fluxoAtivoWindowMs: number = FLUXO_ATIVO_WINDOW_MS
): ConversationActivity {
  const { lastRole, lastActivityAtMs } = input;
  return {
    ultimoInboundSemResposta: lastRole === 'user',
    ultimaAtividadeEm:
      lastActivityAtMs !== null ? new Date(lastActivityAtMs).toISOString() : null,
    fluxoAtivo:
      lastActivityAtMs !== null && nowMs - lastActivityAtMs <= fluxoAtivoWindowMs,
  };
}

/**
 * Variantes do telefone do cliente para casar o conversationKey gravado.
 *
 * A Ana grava o key como `${phoneNumberId}:${wa_id}`, em que o wa_id é o número
 * CRU da Meta (ex.: `5511999998888`, sem `+`). O motor de automação do Receps
 * pode consultar com o telefone CANÔNICO (`+5511999998888`) ou formatado. Geramos
 * as variantes (cru + só-dígitos) pra o lookup casar sem depender do formato
 * exato — cada variante vira uma busca por igualdade (index-friendly), sem full
 * scan. PURO/testável.
 */
export function customerPhoneVariants(customerPhone: string): string[] {
  const trimmed = customerPhone.trim();
  const digits = trimmed.replace(/\D/g, '');
  const variants = new Set<string>();
  if (trimmed) variants.add(trimmed);
  if (digits) variants.add(digits);
  return [...variants];
}
