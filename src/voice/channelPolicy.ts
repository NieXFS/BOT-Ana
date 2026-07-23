export type DeliveryPlan =
  | { mode: 'text' }
  | { mode: 'audio' }
  | { mode: 'audio+text'; voiceText: string; linkText: string };

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TIME_RE = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s?h(?:\d{2})?)\b/gi;
const URL_RE =
  /\b(?:https?:\/\/[^\s<>()]+|(?:www\.)?(?:wa\.me|receps\.com\.br)\/[^\s<>()]*)/gi;

function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,!?;:)\]}]+$/g, '');
}

export function hasEmail(text: string): boolean {
  return EMAIL_RE.test(text);
}

export function countTimeMentions(text: string): number {
  return Array.from(text.matchAll(TIME_RE)).length;
}

export function extractUrls(text: string): string[] {
  const matches = Array.from(text.matchAll(URL_RE), (match) =>
    trimUrlPunctuation(match[0])
  ).filter(Boolean);
  return [...new Set(matches)];
}

export function stripUrls(text: string): string {
  const withoutUrls = text.replace(URL_RE, (match) => {
    const trailing = match.slice(trimUrlPunctuation(match).length);
    return trailing;
  });

  return withoutUrls
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/(?:\s*[:\-–—]\s*)+$/g, '')
    .replace(/^\s*[:\-–—]\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function alphanumericCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Política determinística áudio-primeiro, na precedência fechada do produto. */
export function decideDelivery(input: {
  text: string;
  voiceEnabled: boolean;
  prefersText: boolean;
  maxChars: number;
}): DeliveryPlan {
  if (!input.voiceEnabled) return { mode: 'text' };
  if (input.prefersText) return { mode: 'text' };
  if (hasEmail(input.text)) return { mode: 'text' };
  if (countTimeMentions(input.text) >= 2) return { mode: 'text' };
  if (input.text.length > input.maxChars) return { mode: 'text' };

  const urls = extractUrls(input.text);
  if (urls.length > 0) {
    const voiceText = stripUrls(input.text);
    if (alphanumericCount(voiceText) < 15) {
      return { mode: 'text' };
    }
    return {
      mode: 'audio+text',
      voiceText,
      linkText: urls.join('\n'),
    };
  }

  return { mode: 'audio' };
}
