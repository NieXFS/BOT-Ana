export interface ClauseMatchV2 {
  clause: string;
  match: string;
  groups: string[];
  positive: boolean;
}

export function normalizeClauseTextV2(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fonte única de polaridade local. A negação só vale no prefixo da mesma
 * oração; conectivos adversativos e pontuação abrem outra oração.
 */
export function clauseMatchHasPositivePolarityV2(
  normalizedClause: string,
  matchIndex: number
): boolean {
  const prefix = normalizedClause.slice(0, Math.max(0, matchIndex));
  return !/\b(?:nao|nunca)\b/u.test(prefix);
}

export function splitClausesV2(value: string): string[] {
  const normalized = normalizeClauseTextV2(value).replace(
    /\b(?:mas|porem|contudo|entretanto|so que)\b/gu,
    '.'
  );
  return normalized
    .split(/[.!?;:\n,]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

export function findClauseMatchesV2(
  value: string,
  matcher: RegExp
): ClauseMatchV2[] {
  const flags = matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`;
  const results: ClauseMatchV2[] = [];
  for (const clause of splitClausesV2(value)) {
    const clauseMatcher = new RegExp(matcher.source, flags);
    for (const match of clause.matchAll(clauseMatcher)) {
      results.push({
        clause,
        match: match[0],
        groups: match.slice(1).map((group) => group ?? ''),
        positive: clauseMatchHasPositivePolarityV2(clause, match.index ?? 0),
      });
    }
  }
  return results;
}

export function hasPositiveClauseMatchV2(value: string, matcher: RegExp): boolean {
  return findClauseMatchesV2(value, matcher).some((match) => match.positive);
}
