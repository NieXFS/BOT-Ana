/**
 * Família afirmativa natural do pt-BR para pendências CONFIRMATION e
 * CANCEL_CONFIRMATION já entregues. Allow-only: o matcher nunca confirma em
 * turno livre; os resolvedores ancoram pending OPEN + delivery aceito.
 */

export const NATURAL_AFFIRMATIVE_REPLIES_V2 = [
  'certo',
  'tá certo',
  'ta certo',
  'certinho',
  'tudo certo',
  'isso',
  'isso mesmo',
  'isso aí',
  'perfeito',
  'fechado',
  'combinado',
  'beleza',
  'blz',
  'show',
  'ótimo',
  'otimo',
  'claro',
  'com certeza',
  'positivo',
  'uhum',
  'aham',
  'ok',
  'okay',
  'okk',
] as const;

function foldPtBr(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function canonicalizeAffirmativeUtterance(value: string): string {
  return foldPtBr(value)
    .replace(/^[.!?,;:\s]+|[.!?,;:\s]+$/g, '')
    .replace(/\b(?:por favor|pf)\b/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NATURAL_AFFIRMATIVE_CANONICAL_V2 = new Set(
  NATURAL_AFFIRMATIVE_REPLIES_V2.map(canonicalizeAffirmativeUtterance)
);

/** Sinal do texto ORIGINAL. Interrogativa nunca confirma (IA-8/Q5). */
export function inboundLooksInterrogativeOriginalV2(value: string): boolean {
  return /[?？]/u.test(value);
}

/** Polaridade negativa sempre vence: "não tá certo" nunca confirma. */
export function confirmationHasNegativePolarityV2(value: string): boolean {
  return /\b(?:nao|nunca)\b/u.test(foldPtBr(value));
}

export function confirmationUtteranceBlockedV2(message: string): boolean {
  if (!message.trim()) return true;
  return (
    inboundLooksInterrogativeOriginalV2(message) ||
    confirmationHasNegativePolarityV2(message)
  );
}

export function matchesNaturalAffirmativeFamilyV2(message: string): boolean {
  const canonical = canonicalizeAffirmativeUtterance(message);
  return canonical.length > 0 && NATURAL_AFFIRMATIVE_CANONICAL_V2.has(canonical);
}

export function isNaturalAffirmativeReplyV2(message: string): boolean {
  return (
    !confirmationUtteranceBlockedV2(message) &&
    matchesNaturalAffirmativeFamilyV2(message)
  );
}
