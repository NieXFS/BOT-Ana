import type { ServiceSummary, ServicesResult } from '../calendarService';
import { normalizeServiceAlias, normalizeServiceAliases } from '../../lib/services/service-aliases';
import type { AuthoritativeOutboundCatalog } from '../receptionistOutbound';

/**
 * Resolvedor server-owned de serviços. Ele só lê o snapshot tenant-scoped que
 * recebeu; não consulta rede/DB, não lê histórico e não produz texto de prompt.
 * Aliases são tratados como dados do catálogo e nunca são devolvidos como
 * instrução.
 */

export type ServiceResolverSource =
  | 'canonical_exact'
  | 'alias_exact'
  /** IA-25: decisão já validada pela camada semântica separada. */
  | 'semantic';

export type ServiceResolverReason =
  | 'catalog_unavailable'
  | 'no_match'
  | 'duplicate_alias'
  | 'multiple_canonical'
  | 'shared_partial'
  | 'bare_nail'
  | 'negative_only'
  | 'inactive_only';

export type ServiceResolverResult =
  | {
      kind: 'resolved';
      serviceId: string;
      service: ServiceSummary;
      source: ServiceResolverSource;
      matchedText: string;
    }
  | {
      kind: 'ambiguous';
      reason: Exclude<ServiceResolverReason, 'catalog_unavailable' | 'no_match' | 'negative_only' | 'inactive_only'>;
      serviceIds: string[];
      services: ServiceSummary[];
      clarification: string;
    }
  | {
      kind: 'negative_clarification';
      reason: 'negative_only';
      mentionedServiceIds: string[];
      services: ServiceSummary[];
      clarification: string;
    }
  | {
      kind: 'no_match';
      reason: Exclude<ServiceResolverReason, 'duplicate_alias' | 'multiple_canonical' | 'shared_partial' | 'bare_nail' | 'negative_only'>;
    };

type ResolverService = ServiceSummary & {
  active?: boolean;
  isActive?: boolean;
};

type Match = {
  service: ResolverService;
  source: ServiceResolverSource;
  phrase: string;
  start: number;
  end: number;
};

function normalizeLookupText(value: string): string {
  // Canonical names accept harmless punctuation variants. `&` is the only
  // punctuation with semantic text in the catalog; all other punctuation is a
  // boundary, so it cannot manufacture a token match.
  return normalizeServiceAlias(value)
    .replace(/&/gu, ' e ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isActive(service: ResolverService): boolean {
  return service.active !== false && service.isActive !== false;
}

function activeServices(catalog: ServicesResult): ResolverService[] {
  return (catalog.services ?? []).filter((service): service is ResolverService =>
    Boolean(service && service.id && service.name && isActive(service as ResolverService))
  );
}

function phraseMatchesAt(text: string, phrase: string, start: number): boolean {
  const before = start === 0 ? '' : text[start - 1] ?? '';
  const end = start + phrase.length;
  const after = text[end] ?? '';
  return (!before || before === ' ') && (!after || after === ' ');
}

function findPhraseMatches(
  text: string,
  phrase: string,
  service: ResolverService,
  source: ServiceResolverSource
): Match[] {
  if (!phrase) return [];
  const matches: Match[] = [];
  let from = 0;
  while (from <= text.length - phrase.length) {
    const start = text.indexOf(phrase, from);
    if (start < 0) break;
    if (phraseMatchesAt(text, phrase, start)) {
      matches.push({
        service,
        source,
        phrase,
        start,
        end: start + phrase.length,
      });
    }
    from = start + 1;
  }
  return matches;
}

function serviceAliases(service: ResolverService): string[] {
  // ServicesResult from the ERP is already normalized. Re-normalizing here is
  // intentional: it proves/guards parity for injected fixtures and makes a
  // malformed legacy payload fail closed instead of becoming a synonym.
  return normalizeServiceAliases(service.aliases);
}

function canonicalMatches(text: string, services: ResolverService[]): Match[] {
  const all = services.flatMap((service) =>
    findPhraseMatches(text, normalizeLookupText(service.name), service, 'canonical_exact')
  );
  // A specific canonical name absorbs a shorter parent match in the same span.
  return all.filter(
    (candidate) =>
      !all.some(
        (other) =>
          other !== candidate &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.phrase.length > candidate.phrase.length
      )
  );
}

function aliasMatches(
  text: string,
  services: ResolverService[]
): { matches: Match[]; duplicateAliases: Map<string, ResolverService[]> } {
  const byAlias = new Map<string, ResolverService[]>();
  for (const service of services) {
    for (const alias of serviceAliases(service)) {
      const list = byAlias.get(alias) ?? [];
      if (!list.some((entry) => entry.id === service.id)) list.push(service);
      byAlias.set(alias, list);
    }
  }
  const duplicateAliases = new Map<string, ResolverService[]>();
  const matches: Match[] = [];
  for (const [alias, owners] of byAlias) {
    if (owners.length !== 1) {
      if (
        owners.length > 1 &&
        findPhraseMatches(text, alias, owners[0]!, 'alias_exact').length > 0
      ) {
        duplicateAliases.set(alias, owners);
      }
      continue;
    }
    matches.push(...findPhraseMatches(text, alias, owners[0]!, 'alias_exact'));
  }
  return { matches, duplicateAliases };
}

function splitClauses(text: string): string[] {
  return text
    .split(/[.!?;,]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function clauseIsNegative(clause: string): boolean {
  const normalized = normalizeLookupText(clause);
  return /^nao(?:\s+e|\s+eh|\s+quero|\s+sou|\s+so)?\b/u.test(normalized) ||
    /\b(?:nao|nunca)\s+(?:e|eh|quero|sou|so)?\s*[a-z0-9]/u.test(normalized);
}

function negativeTokenMentions(
  text: string,
  services: ResolverService[]
): ResolverService[] {
  const tokens = new Set(text.match(/[a-z0-9]{4,}/gu) ?? []);
  const mentioned = services.filter((service) => {
    const serviceTokens = normalizeLookupText(service.name)
      .split(' ')
      .filter((token) => token.length >= 4);
    return serviceTokens.some((token) => tokens.has(token));
  });
  return dedupeServices(mentioned);
}

function dedupeMatches(matches: Match[]): Match[] {
  const byKey = new Map<string, Match>();
  for (const match of matches) {
    const key = `${match.service.id}:${match.source}:${match.start}:${match.end}`;
    const previous = byKey.get(key);
    if (!previous || match.phrase.length > previous.phrase.length) byKey.set(key, match);
  }
  return [...byKey.values()];
}

function dedupeServices(services: ResolverService[]): ResolverService[] {
  const seen = new Set<string>();
  return services.filter((service) => {
    if (seen.has(service.id)) return false;
    seen.add(service.id);
    return true;
  });
}

function broadNailCategoryServices(services: ResolverService[]): ResolverService[] {
  const hasBaseManicure = services.some(
    (service) => normalizeLookupText(service.name) === 'manicure'
  );
  const hasBasePedicure = services.some(
    (service) => normalizeLookupText(service.name) === 'pedicure'
  );
  return services.filter((service) => {
    const canonical = normalizeLookupText(service.name);
    if (hasBaseManicure && /^manicure\s+(?:tradicional|normal)$/u.test(canonical)) {
      return false;
    }
    if (hasBasePedicure && /^pedicure\s+(?:tradicional|normal)$/u.test(canonical)) {
      return false;
    }
    if (/\b(?:manicure|pedicure)\b/u.test(canonical)) return true;
    // A tenant may choose a different canonical display name; only aliases
    // that explicitly carry hand/foot evidence make it a plausible category.
    return serviceAliases(service).some((alias) =>
      /\b(?:mao|pe|maos|pes)\b/u.test(alias)
    );
  });
}

function isBareNailRequest(text: string): boolean {
  const normalized = normalizeLookupText(text);
  return (
    /^unha$/u.test(normalized) ||
    /\b(?:fazer|quero|servico|serviço)\b[^.!?;]*\bunha\b/u.test(normalized)
  );
}

function joinNames(services: readonly ResolverService[]): string {
  const names = services.map((service) => service.name.trim()).filter(Boolean);
  if (names.length <= 1) return names[0] ?? 'um serviço de unhas';
  if (names.length === 2) return `${names[0]} ou ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} ou ${names.at(-1)}`;
}

function clarificationFor(services: readonly ResolverService[]): string {
  return `Você quer ${joinNames(services)}?`;
}

function ambiguousResult(
  reason: Extract<ServiceResolverReason, 'duplicate_alias' | 'multiple_canonical' | 'shared_partial' | 'bare_nail'>,
  services: ResolverService[]
): ServiceResolverResult {
  const unique = dedupeServices(services);
  return {
    kind: 'ambiguous',
    reason,
    serviceIds: unique.map((service) => service.id),
    services: unique,
    clarification: clarificationFor(unique),
  };
}

/**
 * Resolve somente evidência positiva atual. Sem alias global, fuzzy ou
 * eliminação por exclusão: a ausência de uma correspondência é fail-closed.
 */
export function resolveServiceFromCatalog(input: {
  text: string;
  catalog: ServicesResult;
}): ServiceResolverResult {
  if (!input.catalog.success || !Array.isArray(input.catalog.services)) {
    return { kind: 'no_match', reason: 'catalog_unavailable' };
  }
  const rawServices = input.catalog.services as Array<ResolverService>;
  const services = activeServices(input.catalog);
  if (services.length === 0) {
    return rawServices.length > 0
      ? { kind: 'no_match', reason: 'inactive_only' }
      : { kind: 'no_match', reason: 'catalog_unavailable' };
  }
  const text = normalizeLookupText(input.text);
  if (!text) return { kind: 'no_match', reason: 'no_match' };
  const inactiveAliasMentioned = rawServices
    .filter((service) => !isActive(service))
    .some((service) =>
      serviceAliases(service).some((alias) => {
        if (findPhraseMatches(text, alias, service, 'alias_exact').length === 0) {
          return false;
        }
        // An inactive duplicate does not poison a uniquely owned active alias;
        // an alias with no active owner remains fail-closed.
        return !services.some((active) => serviceAliases(active).includes(alias));
      })
    );
  if (inactiveAliasMentioned) return { kind: 'no_match', reason: 'inactive_only' };

  const clauses = splitClauses(input.text);
  const positiveMatches: Match[] = [];
  const negativeMatches: Match[] = [];
  const duplicateAliasOwners = new Map<string, ResolverService[]>();
  for (const clause of clauses.length > 0 ? clauses : [input.text]) {
    const normalizedClause = normalizeLookupText(clause);
    const clauseCanonical = canonicalMatches(normalizedClause, services);
    const aliasResult = aliasMatches(normalizedClause, services);
    for (const [alias, owners] of aliasResult.duplicateAliases) {
      duplicateAliasOwners.set(alias, owners);
    }
    const clauseMatches = dedupeMatches([...clauseCanonical, ...aliasResult.matches]);
    const negative = clauseIsNegative(clause);
    if (negative) {
      negativeMatches.push(...clauseMatches);
      if (clauseMatches.length === 0) {
        negativeMatches.push(
          ...negativeTokenMentions(normalizedClause, services).map((service) => ({
            service,
            source: 'canonical_exact' as const,
            phrase: normalizeLookupText(service.name),
            start: 0,
            end: 0,
          }))
        );
      }
    } else positiveMatches.push(...clauseMatches);
  }

  // Canonical exact names are sovereign over alias/partial evidence. A longer
  // canonical phrase absorbs a shorter one; unrelated exact names remain
  // ambiguous instead of silently choosing one.
  const canonicalPositive = positiveMatches.filter((match) => match.source === 'canonical_exact');
  const canonicalIds = [...new Set(canonicalPositive.map((match) => match.service.id))];
  if (canonicalIds.length > 1) {
    return ambiguousResult('multiple_canonical', canonicalPositive.map((match) => match.service));
  }
  if (canonicalIds.length === 1) {
    const match = canonicalPositive.find((entry) => entry.service.id === canonicalIds[0])!;
    return {
      kind: 'resolved',
      serviceId: match.service.id,
      service: match.service,
      source: 'canonical_exact',
      matchedText: match.phrase,
    };
  }

  if (duplicateAliasOwners.size > 0) {
    return ambiguousResult(
      'duplicate_alias',
      [...duplicateAliasOwners.values()].flat()
    );
  }

  const aliasPositive = positiveMatches.filter((match) => match.source === 'alias_exact');
  const aliasIds = [...new Set(aliasPositive.map((match) => match.service.id))];
  if (aliasIds.length > 1) {
    return ambiguousResult('duplicate_alias', aliasPositive.map((match) => match.service));
  }
  if (aliasIds.length === 1) {
    const match = aliasPositive.find((entry) => entry.service.id === aliasIds[0])!;
    return {
      kind: 'resolved',
      serviceId: match.service.id,
      service: match.service,
      source: 'alias_exact',
      matchedText: match.phrase,
    };
  }

  if (negativeMatches.length > 0) {
    const mentioned = dedupeServices(negativeMatches.map((match) => match.service));
    return {
      kind: 'negative_clarification',
      reason: 'negative_only',
      mentionedServiceIds: mentioned.map((service) => service.id),
      services: mentioned,
      clarification: mentioned.length > 0
        ? `Só para confirmar: você quer ${joinNames(mentioned)} ou está dizendo que não é ${joinNames(mentioned)}?`
        : 'Só para confirmar: qual serviço você quer fazer?',
    };
  }

  if (isBareNailRequest(input.text)) {
    return ambiguousResult('bare_nail', broadNailCategoryServices(services));
  }
  // Tokens compartilhados (por exemplo, só "normal" ou "unha" fora de uma
  // categoria) nunca viram escolha por sobra.
  if (/\b(?:normal|tradicional|servico|serviço)\b/u.test(text)) {
    return ambiguousResult('shared_partial', []);
  }
  return { kind: 'no_match', reason: 'no_match' };
}

export function resolveServiceFromTenantCatalog(
  text: string,
  catalog: ServicesResult
): ServiceResolverResult {
  return resolveServiceFromCatalog({ text, catalog });
}

/**
 * Une o snapshot de agenda com o catálogo autoritativo já exposto na config.
 * O ERP é a fonte dos campos operacionais; aliases só entram como dado
 * tenant-scoped e, quando o contrato os expõe, substituem qualquer cópia
 * anterior. Nenhum alias é levado ao prompt/model history.
 */
export function mergeAuthoritativeServiceAliases(
  servicesResult: ServicesResult,
  authoritativeCatalog?: AuthoritativeOutboundCatalog
): ServicesResult {
  const authoritative = authoritativeCatalog?.services;
  if (!Array.isArray(servicesResult.services)) return servicesResult;
  const byId = new Map(
    (authoritative ?? [])
      .filter((service) => service && typeof service.id === 'string')
      .map((service) => [service.id, service])
  );
  return {
    ...servicesResult,
    services: servicesResult.services.map((service) => {
      const configService = byId.get(service.id);
      const aliases = configService && Object.prototype.hasOwnProperty.call(configService, 'aliases')
        ? normalizeServiceAliases(configService.aliases)
        : normalizeServiceAliases(service.aliases);
      return { ...service, aliases };
    }),
  };
}

/** Exportado para o smoke de paridade, sem expor aliases a qualquer prompt. */
export const __serviceResolverInternals = {
  normalizeLookupText,
  normalizeServiceAlias,
  normalizeServiceAliases,
};
