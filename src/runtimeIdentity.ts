export const RECEPS_IA_RUNTIME_NAME = 'Receps-IA';
export const RECEPS_IA_RUNTIME_TAG = 'receps-ia';

type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Resolve uma configuração técnica renomeada sem quebrar o primeiro ciclo de
 * deploy. O nome canônico sempre vence o alias legado e valores vazios contam
 * como ausentes.
 */
export function resolveRecepsIaEnvValue(
  env: RuntimeEnvironment,
  canonicalName: string,
  legacyName: string
): string | undefined {
  return env[canonicalName]?.trim() || env[legacyName]?.trim() || undefined;
}

/** Compara somente em memória; os valores nunca devem entrar em logs. */
export function recepsIaEnvValuesConflict(
  env: RuntimeEnvironment,
  canonicalName: string,
  legacyName: string
): boolean {
  const canonicalValue = env[canonicalName]?.trim();
  const legacyValue = env[legacyName]?.trim();
  return Boolean(
    canonicalValue && legacyValue && canonicalValue !== legacyValue
  );
}
