/**
 * Estado volátil da origem de parceira por conversa.
 *
 * O carimbo durável fica no SalesLead do Receps (feito assim que a primeira
 * mensagem casa). Este estado só mantém o slug disponível para o prompt e para
 * reenviá-lo nas escritas seguintes de lead durante a vida do processo.
 */
const partnerSlugByConversation = new Map<string, string>();

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
  }
}
