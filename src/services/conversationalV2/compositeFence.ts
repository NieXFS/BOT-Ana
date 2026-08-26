import { normalizeClauseTextV2 } from './polarity';

/**
 * IA-25d: razão redacted para uma tentativa de composite que não passou pela
 * cerca server-owned. Nenhum valor do inbound ou do catálogo entra no tipo ou
 * no receipt.
 */
export const COMPOSITE_FENCE_REASONS_V2 = [
  'composite_authority_unavailable',
  'layer_a_candidate_count',
  'decision_not_resolved',
  'service_outside_composite_authority',
  'components_missing',
  'components_not_distinct',
  'component_not_literal',
  'component_not_token_bounded',
  'components_overlap',
  'component_negated',
  'disjunctive_relation',
  'conjunctive_relation_missing',
] as const;

export type CompositeFenceReasonV2 =
  (typeof COMPOSITE_FENCE_REASONS_V2)[number];

export type CompositeAuthoritySourceV2 =
  | 'planner_candidates'
  | 'direct_active_catalog';

export type CompositeAuthorityV2 =
  | { source: 'planner_candidates'; serviceIds: Set<string> }
  | { source: 'direct_active_catalog'; serviceIds: Set<string> };

/**
 * A autoridade é deliberadamente derivada fora da decisão do modelo. Em
 * `direct_unresolved`, o catálogo ativo é somente o universo tenant-scoped
 * permitido à Camada B; ele não é promovido a candidatos da Camada A.
 *
 * O caso direto exige `reason === 'no_match'`: `catalog_unavailable` e
 * `inactive_only` nunca recebem licença semântica por esta porta.
 */
export function deriveCompositeAuthorityV2(input: {
  policy:
    | { mode: 'planner_authorized'; candidateServiceIds: readonly string[] }
    | { mode: 'direct_unresolved' }
    | { mode: 'not_considered' };
  deterministicResult: {
    kind: string;
    reason?: string;
  };
  activeServiceIds: Iterable<string>;
}): CompositeAuthorityV2 | null {
  if (input.policy.mode === 'planner_authorized') {
    return {
      source: 'planner_candidates',
      serviceIds: new Set(input.policy.candidateServiceIds),
    };
  }
  if (
    input.policy.mode === 'direct_unresolved' &&
    input.deterministicResult.kind === 'no_match' &&
    input.deterministicResult.reason === 'no_match'
  ) {
    return {
      source: 'direct_active_catalog',
      serviceIds: new Set(input.activeServiceIds),
    };
  }
  return null;
}

export interface CompositeFenceDecisionV2 {
  decision: 'resolved' | 'ambiguous' | 'none';
  serviceId: string | null;
  resolutionBasis: 'direct' | 'composite';
  componentEvidenceTexts: readonly string[];
}

export type CompositeFenceResultV2 =
  | { ok: true; reason: 'composite_licensed' }
  | { ok: false; reason: CompositeFenceReasonV2 };

interface LiteralOccurrenceV2 {
  start: number;
  end: number;
}

function normalizeComponent(value: string): string {
  return value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizedPrefix(value: string): string {
  return normalizeClauseTextV2(value).replace(/\s+/gu, ' ').trim();
}

function correctionBoundaryEnd(value: string, before: number): number {
  const prefix = value.slice(0, before);
  let boundary = 0;
  const punctuation = /[.!?,;:\n]+/gu;
  for (const match of prefix.matchAll(punctuation)) {
    boundary = Math.max(boundary, (match.index ?? 0) + match[0].length);
  }
  const adversative = /\b(?:mas|porem|porém|contudo|entretanto|so que)\b/giu;
  for (const match of prefix.matchAll(adversative)) {
    boundary = Math.max(boundary, (match.index ?? 0) + match[0].length);
  }
  // The boundary intentionally matches only `agora` when it is immediately
  // followed by `quero`; the positive verb remains inside the new clause.
  const corrections =
    /\b(?:na verdade|melhor|quer dizer|corrigindo|pera(?:i)?|alias|mudei de ideia|agora(?=\s+quero\b)|em vez|ao inves|troquei|trocar)\b/gu;
  for (const match of prefix.matchAll(corrections)) {
    boundary = Math.max(boundary, (match.index ?? 0) + match[0].length);
  }
  return boundary;
}

/**
 * Polaridade local da oração que contém o span. A decisão não herda `não` de
 * uma oração anterior separada por pontuação/adversativa/correção; dentro da
 * própria oração, `não`, `nunca` e `sem` bloqueiam o componente.
 */
function componentHasPositiveLocalPolarity(
  currentBatch: string,
  occurrence: LiteralOccurrenceV2
): boolean {
  // The raw clause boundary is authoritative; normalize only the text used by
  // the polarity predicate, so accents never turn a literal check into a
  // reconstructed span.
  const rawBoundary = correctionBoundaryEnd(currentBatch, occurrence.start);
  const clausePrefix = normalizedPrefix(
    currentBatch.slice(rawBoundary, occurrence.start)
  );
  return !/\b(?:nao|nunca|sem)\b/u.test(clausePrefix);
}

function literalOccurrences(
  currentBatch: string,
  component: string
): LiteralOccurrenceV2[] {
  const occurrences: LiteralOccurrenceV2[] = [];
  let from = 0;
  while (from <= currentBatch.length - component.length) {
    const start = currentBatch.indexOf(component, from);
    if (start < 0) break;
    occurrences.push({ start, end: start + component.length });
    from = start + Math.max(component.length, 1);
  }
  return occurrences;
}

const UNICODE_TOKEN_CHARACTER_BEFORE = /[\p{L}\p{N}\p{M}]$/u;
const UNICODE_TOKEN_CHARACTER_AFTER = /^[\p{L}\p{N}\p{M}]/u;

function isTokenBoundedOccurrence(
  currentBatch: string,
  occurrence: LiteralOccurrenceV2
): boolean {
  const hasTokenCharacterBefore = UNICODE_TOKEN_CHARACTER_BEFORE.test(
    currentBatch.slice(0, occurrence.start)
  );
  const hasTokenCharacterAfter = UNICODE_TOKEN_CHARACTER_AFTER.test(
    currentBatch.slice(occurrence.end)
  );
  return !hasTokenCharacterBefore && !hasTokenCharacterAfter;
}

function spansOverlap(
  left: LiteralOccurrenceV2,
  right: LiteralOccurrenceV2
): boolean {
  return left.start < right.end && right.start < left.end;
}

function hasExplicitConjunction(value: string): boolean {
  const normalized = normalizedPrefix(value);
  return /(?:^|\s)(?:e|com|mais|junt(?:o|a|os|as)|ambos|ambas|os dois|as duas)(?:$|\s)/u.test(
    normalized
  ) || /\+/u.test(value);
}

/**
 * Licença server-owned para `resolutionBasis=composite`.
 *
 * O caller passa uma autoridade server-owned, nunca um booleano derivado da
 * resposta do modelo. A função é deliberadamente cega ao significado dos
 * componentes: ela só verifica a evidência formal que o modelo declarou.
 */
export function licenseCompositeDecisionV2(input: {
  decision: CompositeFenceDecisionV2;
  currentBatch: string;
  authority: CompositeAuthorityV2 | null;
}): CompositeFenceResultV2 {
  if (input.decision.resolutionBasis !== 'composite') {
    return { ok: true, reason: 'composite_licensed' };
  }
  if (!input.authority) {
    return { ok: false, reason: 'composite_authority_unavailable' };
  }
  if (
    input.authority.source === 'planner_candidates' &&
    input.authority.serviceIds.size < 2
  ) {
    return { ok: false, reason: 'layer_a_candidate_count' };
  }
  if (input.decision.decision !== 'resolved') {
    return { ok: false, reason: 'decision_not_resolved' };
  }
  if (
    !input.decision.serviceId ||
    !input.authority.serviceIds.has(input.decision.serviceId)
  ) {
    return { ok: false, reason: 'service_outside_composite_authority' };
  }

  const components = input.decision.componentEvidenceTexts;
  if (!Array.isArray(components) || components.length === 0) {
    return { ok: false, reason: 'components_missing' };
  }
  const normalizedComponents = components.map(normalizeComponent);
  if (normalizedComponents.some((component) => !component)) {
    return { ok: false, reason: 'components_missing' };
  }
  if (
    new Set(normalizedComponents).size < 2 ||
    new Set(normalizedComponents).size !== normalizedComponents.length
  ) {
    return { ok: false, reason: 'components_not_distinct' };
  }

  const positiveOccurrences: LiteralOccurrenceV2[][] = [];
  for (const component of components) {
    if (typeof component !== 'string' || !component) {
      return { ok: false, reason: 'components_missing' };
    }
    const occurrences = literalOccurrences(input.currentBatch, component);
    if (occurrences.length === 0) {
      return { ok: false, reason: 'component_not_literal' };
    }
    const tokenBounded = occurrences.filter((occurrence) =>
      isTokenBoundedOccurrence(input.currentBatch, occurrence)
    );
    if (tokenBounded.length === 0) {
      return { ok: false, reason: 'component_not_token_bounded' };
    }
    const positive = tokenBounded.filter((occurrence) =>
      componentHasPositiveLocalPolarity(input.currentBatch, occurrence)
    );
    if (positive.length === 0) {
      return { ok: false, reason: 'component_negated' };
    }
    positiveOccurrences.push(positive);
  }

  // The measured contract has two components. For larger lists, preserve the
  // same conservative rule by requiring an explicit conjunction between every
  // adjacent chosen span. We choose the earliest positive occurrence of each
  // component; repeated/ambiguous spans are handled by the duplicate and
  // polarity checks above rather than guessed by the server.
  const chosen = positiveOccurrences.map((occurrences) => occurrences[0]!);
  const ordered = [...chosen].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (spansOverlap(ordered[index - 1]!, ordered[index]!)) {
      return { ok: false, reason: 'components_overlap' };
    }
  }
  const relationStart = ordered[0]!.start;
  const relationEnd = ordered.at(-1)!.end;
  const interval = input.currentBatch.slice(relationStart, relationEnd);
  if (/\bou\b/iu.test(normalizedPrefix(interval))) {
    return { ok: false, reason: 'disjunctive_relation' };
  }
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const between = input.currentBatch.slice(
      ordered[index]!.end,
      ordered[index + 1]!.start
    );
    if (!hasExplicitConjunction(between)) {
      return { ok: false, reason: 'conjunctive_relation_missing' };
    }
  }

  return { ok: true, reason: 'composite_licensed' };
}

export const __compositeFenceInternals = {
  normalizeComponent,
  componentHasPositiveLocalPolarity,
  literalOccurrences,
  isTokenBoundedOccurrence,
  spansOverlap,
  hasExplicitConjunction,
};
