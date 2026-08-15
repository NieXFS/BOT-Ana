export const ANA_CONVERSATIONAL_V2_VOICE_TENANT_SLUGS_ENV =
  'ANA_CONVERSATIONAL_V2_VOICE_TENANT_SLUGS';

/**
 * Allowlist fechada, vazia por default. `*` não habilita ninguém. Testes e a
 * matriz injetam o booleano do braço; produção não lê a env no meio do turno.
 */
export function isAnaConversationalV2VoiceEnabled(
  tenantSlug: string,
  explicit?: boolean,
  rawAllowlist = process.env[ANA_CONVERSATIONAL_V2_VOICE_TENANT_SLUGS_ENV]
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const slug = tenantSlug.trim();
  if (!slug || !rawAllowlist?.trim()) return false;
  const entries = rawAllowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return false;
  return entries.includes(slug);
}
