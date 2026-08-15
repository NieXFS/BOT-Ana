export const LICENSED_SERVICE_DESCRIPTION_POLICY_V1 =
  'licensed-service-description-v1' as const;

export const LICENSED_SERVICE_DESCRIPTION_FACETS_V1 = [
  'WHAT_IT_IS',
  'HOW_PERFORMED',
] as const;

export type LicensedServiceDescriptionFacetV2 =
  (typeof LICENSED_SERVICE_DESCRIPTION_FACETS_V1)[number];

export interface LicensedServiceDescriptionClauseV2 {
  clauseId: string;
  facet: LicensedServiceDescriptionFacetV2;
  exactText: string;
}

export interface LicensedServiceDescriptionV2 {
  sourceHash: string;
  policyVersion: typeof LICENSED_SERVICE_DESCRIPTION_POLICY_V1;
  clauses: LicensedServiceDescriptionClauseV2[];
}

export interface DescriptionTermAcceptanceV2 {
  clauseVersion: string;
  acceptedAt: string;
}

/**
 * Evidência efêmera da materialização server-side. Não contém credencial nem
 * texto vindo do modelo: os ids e o texto precisam ser revalidados contra o
 * snapshot autoritativo pela fronteira imediatamente anterior à entrega.
 */
export interface LicensedServiceDescriptionEvidenceV2 {
  serviceId: string;
  sourceHash: string;
  policyVersion: typeof LICENSED_SERVICE_DESCRIPTION_POLICY_V1;
  clauseIds: readonly string[];
  exactText: string;
  termAcceptance: DescriptionTermAcceptanceV2;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/iu;
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/u;
const PHONE_RE = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/u;

export function validDescriptionTermAcceptanceV2(
  value: unknown
): value is DescriptionTermAcceptanceV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Boolean(
    typeof candidate.clauseVersion === 'string' &&
      candidate.clauseVersion.trim() &&
      typeof candidate.acceptedAt === 'string' &&
      !Number.isNaN(Date.parse(candidate.acceptedAt))
  );
}

export function descriptionContainsTechnicalPiiV2(text: string): boolean {
  return EMAIL_RE.test(text) || CPF_RE.test(text) || PHONE_RE.test(text);
}

/** Runtime fail-closed para payload legado, importado ou adulterado. */
export function normalizeLicensedServiceDescriptionV2(
  value: unknown
): LicensedServiceDescriptionV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceHash !== 'string' ||
    !SHA256_HEX_RE.test(candidate.sourceHash) ||
    candidate.policyVersion !== LICENSED_SERVICE_DESCRIPTION_POLICY_V1 ||
    !Array.isArray(candidate.clauses) ||
    candidate.clauses.length === 0
  ) {
    return null;
  }

  const ids = new Set<string>();
  const clauses: LicensedServiceDescriptionClauseV2[] = [];
  for (const [index, rawClause] of candidate.clauses.entries()) {
    if (!rawClause || typeof rawClause !== 'object' || Array.isArray(rawClause)) {
      return null;
    }
    const clause = rawClause as Record<string, unknown>;
    const clauseId =
      typeof clause.clauseId === 'string' ? clause.clauseId : '';
    const exactText =
      typeof clause.exactText === 'string' ? clause.exactText : '';
    if (
      !clauseId ||
      clauseId !== clauseId.trim() ||
      ids.has(clauseId) ||
      !exactText ||
      exactText !== exactText.trim() ||
      descriptionContainsTechnicalPiiV2(exactText) ||
      !(LICENSED_SERVICE_DESCRIPTION_FACETS_V1 as readonly unknown[]).includes(
        clause.facet
      ) ||
      (index === 0 && clause.facet !== 'WHAT_IT_IS') ||
      (index > 0 && clause.facet !== 'HOW_PERFORMED')
    ) {
      return null;
    }
    ids.add(clauseId);
    clauses.push({
      clauseId,
      facet: clause.facet as LicensedServiceDescriptionFacetV2,
      exactText,
    });
  }

  return {
    sourceHash: candidate.sourceHash.toLowerCase(),
    policyVersion: LICENSED_SERVICE_DESCRIPTION_POLICY_V1,
    clauses,
  };
}
