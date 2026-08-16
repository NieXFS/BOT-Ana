/**
 * Estado volátil da origem de parceira por conversa.
 *
 * O carimbo durável fica no SalesLead do Receps. O estado de saudação mantém o
 * slug disponível para o prompt somente quando a PRIMEIRA janela casa; a
 * máquina de atribuição continua procurando nos inbounds seguintes, com teto
 * defensivo, até o POST ser confirmado.
 */
const partnerSlugByConversation = new Map<string, string>();

export const MAX_PARTNER_ATTRIBUTION_INBOUNDS = 10;

type PartnerAttributionStatus =
  | 'searching'
  | 'posting'
  | 'attributed'
  | 'exhausted';

type PartnerAttributionState = {
  inboundCount: number;
  status: PartnerAttributionStatus;
  candidateSlug?: string;
};

const partnerAttributionByConversation = new Map<
  string,
  PartnerAttributionState
>();

export interface PartnerAttributionInboundInput {
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  userMessage: string;
  isFirstInboundWindow: boolean;
}

export interface PartnerAttributionInboundDeps {
  matchPartnerMention: (message: string) => string | null;
  capturePartnerAttribution: (
    phoneNumberId: string,
    customerPhone: string,
    partnerSlug: string
  ) => Promise<'attributed' | 'not-attributed' | 'failed'>;
}

/**
 * Observa um inbound da Renata sem bloquear a resposta ao lead.
 *
 * A regex roda no máximo nos 10 primeiros inbounds e para assim que encontra
 * um candidato. Enquanto o POST está em voo, novos inbounds não duplicam a
 * escrita. Se a rede falhar, o slug candidato é reaproveitado no próximo
 * inbound sem nova detecção; sucesso torna a conversa terminal neste processo.
 * A saudação continua estritamente limitada à primeira janela.
 */
export function observePartnerAttributionInbound(
  input: PartnerAttributionInboundInput,
  deps: PartnerAttributionInboundDeps
): void {
  const existing = partnerAttributionByConversation.get(input.conversationKey);
  const state = existing ?? { inboundCount: 0, status: 'searching' as const };

  if (!existing) {
    partnerAttributionByConversation.set(input.conversationKey, state);
  }

  if (
    state.status === 'posting' ||
    state.status === 'attributed' ||
    state.status === 'exhausted'
  ) {
    return;
  }

  if (state.inboundCount >= MAX_PARTNER_ATTRIBUTION_INBOUNDS) {
    state.status = 'exhausted';
    return;
  }

  state.inboundCount += 1;
  let partnerSlug = state.candidateSlug;

  if (!partnerSlug) {
    partnerSlug = deps.matchPartnerMention(input.userMessage) ?? undefined;
    if (!partnerSlug) {
      if (state.inboundCount >= MAX_PARTNER_ATTRIBUTION_INBOUNDS) {
        state.status = 'exhausted';
      }
      return;
    }
    state.candidateSlug = partnerSlug;
  }

  if (input.isFirstInboundWindow) {
    rememberConversationPartnerSlug(input.conversationKey, partnerSlug);
  }

  state.status = 'posting';
  let capturePromise: Promise<'attributed' | 'not-attributed' | 'failed'>;
  try {
    capturePromise = deps.capturePartnerAttribution(
      input.phoneNumberId,
      input.customerPhone,
      partnerSlug
    );
  } catch {
    state.status = 'searching';
    return;
  }

  void capturePromise
    .then((result) => {
      if (result === 'attributed') {
        state.status = 'attributed';
        return;
      }

      if (result === 'not-attributed') {
        state.candidateSlug = undefined;
      }
      state.status = 'searching';
    })
    .catch(() => {
      state.status = 'searching';
    });
}

export function rememberConversationPartnerSlug(
  conversationKey: string,
  partnerSlug: string
): void {
  if (!partnerSlugByConversation.has(conversationKey)) {
    partnerSlugByConversation.set(conversationKey, partnerSlug);
  }
}

export function getConversationPartnerSlug(
  conversationKey: string
): string | null {
  return partnerSlugByConversation.get(conversationKey) ?? null;
}

/** O reset administrativo inicia uma conversa realmente limpa no mesmo processo. */
export function clearConversationPartnerSlugs(
  conversationKeys: string[]
): void {
  for (const conversationKey of conversationKeys) {
    partnerSlugByConversation.delete(conversationKey);
    partnerAttributionByConversation.delete(conversationKey);
  }
}
