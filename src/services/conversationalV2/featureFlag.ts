export const ANA_CONVERSATIONAL_V2_TENANT_SLUGS_ENV =
  'ANA_CONVERSATIONAL_V2_TENANT_SLUGS';

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
