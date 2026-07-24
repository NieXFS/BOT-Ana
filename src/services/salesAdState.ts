const MAX_AD_HEADLINE_CHARS = 200;
const adHeadlineByConversation = new Map<string, string>();

/** Estado volátil, first-write-wins; a headline nunca é logada. */
export function rememberConversationAdHeadline(
  conversationKey: string,
  headline: string
): void {
  if (adHeadlineByConversation.has(conversationKey)) return;
  const truncated = headline.trim().slice(0, MAX_AD_HEADLINE_CHARS);
  if (truncated) adHeadlineByConversation.set(conversationKey, truncated);
}

export function getConversationAdHeadline(
  conversationKey: string
): string | null {
  return adHeadlineByConversation.get(conversationKey) ?? null;
}

export function clearConversationAdHeadlines(
  conversationKeys: string[]
): void {
  for (const conversationKey of conversationKeys) {
    adHeadlineByConversation.delete(conversationKey);
  }
}
