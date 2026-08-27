import {
  RECEPS_IA_RUNTIME_TAG,
  recepsIaEnvValuesConflict,
  resolveRecepsIaEnvValue,
} from '../runtimeIdentity';
import { safeAnaRuntimeModeTag } from '../runtimePolicy';

type SentryEnvironment = Record<string, string | undefined>;

export interface RecepsIaSentryConfig {
  dsn?: string;
  environment: string;
  release?: string;
  conflictingEnvNames: Array<[canonical: string, legacy: string]>;
}

const CONFIG_PAIRS = [
  ['RECEPS_IA_SENTRY_DSN', 'ANA_SENTRY_DSN'],
  ['RECEPS_IA_SENTRY_ENVIRONMENT', 'ANA_SENTRY_ENVIRONMENT'],
  ['RECEPS_IA_RELEASE', 'ANA_RELEASE'],
] as const;

export const RECEPS_IA_SENTRY_SCOPE = {
  tags: {
    runtime: RECEPS_IA_RUNTIME_TAG,
    runtime_mode: safeAnaRuntimeModeTag(process.env),
  },
} as const;

/** Resolve a configuração do SDK sem inicializar rede nem expor valores. */
export function resolveRecepsIaSentryConfig(
  env: SentryEnvironment
): RecepsIaSentryConfig {
  return {
    dsn: resolveRecepsIaEnvValue(
      env,
      'RECEPS_IA_SENTRY_DSN',
      'ANA_SENTRY_DSN'
    ),
    environment:
      resolveRecepsIaEnvValue(
        env,
        'RECEPS_IA_SENTRY_ENVIRONMENT',
        'ANA_SENTRY_ENVIRONMENT'
      ) ?? env.NODE_ENV ?? 'production',
    release: resolveRecepsIaEnvValue(
      env,
      'RECEPS_IA_RELEASE',
      'ANA_RELEASE'
    ),
    conflictingEnvNames: CONFIG_PAIRS.filter(([canonical, legacy]) =>
      recepsIaEnvValuesConflict(env, canonical, legacy)
    ).map(([canonical, legacy]) => [canonical, legacy]),
  };
}
