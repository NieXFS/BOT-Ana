export const ANA_CONVERSATIONAL_V2_TENANT_SLUGS_ENV =
  'ANA_CONVERSATIONAL_V2_TENANT_SLUGS';

export const ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS_ENV =
  'ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS';

export const ANA_V2_SERVICE_RESOLVER_ROLLOUT_TENANT_SLUGS_ENV =
  'ANA_V2_SERVICE_RESOLVER_ROLLOUT_TENANT_SLUGS';

/**
 * Allowlist deliberadamente fechada. O contrato v2 proíbe `*`; vazio, ausente
 * ou uma entrada inválida mantêm o tenant integralmente na rota v1.
 */
export function isAnaConversationalV2Enabled(
  tenantSlug: string,
  rawAllowlist = process.env[ANA_CONVERSATIONAL_V2_TENANT_SLUGS_ENV]
): boolean {
  const slug = tenantSlug.trim();
  if (!slug || !rawAllowlist?.trim()) return false;
  const entries = rawAllowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return false;
  return entries.includes(slug);
}

/**
 * Rollout temporário do planner de contexto de serviço (IA-22). Default vazio.
 * `*` é proibido. Produção também exige a allowlist v2. Fixtures injetam o
 * booleano explícito e não relêem a env no meio do turno.
 */
export function isAnaV2ServiceContextEnabled(
  tenantSlug: string,
  explicit?: boolean,
  rawAllowlist = process.env[ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS_ENV]
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  if (!isAnaConversationalV2Enabled(tenantSlug)) return false;
  const slug = tenantSlug.trim();
  if (!slug || !rawAllowlist?.trim()) return false;
  const entries = rawAllowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return false;
  return entries.includes(slug);
}

/**
 * IA-24: rollout independente do resolvedor determinístico. Em produção a
 * flag só arma quando o tenant já está na allowlist geral da V2 e o planner de
 * contexto de serviço também está ativo. `*` é sempre inválido. Fixtures podem
 * injetar o booleano explícito para não depender de processo/env global.
 */
export function isAnaV2ServiceResolverEnabled(
  tenantSlug: string,
  explicit?: boolean,
  serviceContextEnabled?: boolean,
  rawAllowlist = process.env[ANA_V2_SERVICE_RESOLVER_ROLLOUT_TENANT_SLUGS_ENV]
): boolean {
  if (typeof explicit === 'boolean') {
    return explicit && serviceContextEnabled !== false;
  }
  if (!isAnaConversationalV2Enabled(tenantSlug)) return false;
  if (serviceContextEnabled !== true) return false;
  const slug = tenantSlug.trim();
  if (!slug || !rawAllowlist?.trim()) return false;
  const entries = rawAllowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return false;
  return entries.includes(slug);
}
