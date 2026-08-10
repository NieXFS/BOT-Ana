/**
 * Inicialização do Sentry do Receps-IA. Importado o mais cedo possível no
 * `webhookServer.ts` (logo após `dotenv/config`, antes do express e dos
 * services) pra instrumentar erros e performance.
 *
 * Sem `RECEPS_IA_SENTRY_DSN` (ou o alias legado `ANA_SENTRY_DSN`) o SDK vira
 * no-op silencioso — local/dev não envia nada.
 */

import * as Sentry from '@sentry/node';
import { scrubEvent } from './scrub';
import {
  RECEPS_IA_SENTRY_SCOPE,
  resolveRecepsIaSentryConfig,
} from './sentryConfig';

const config = resolveRecepsIaSentryConfig(process.env);
for (const [canonicalName, legacyName] of config.conflictingEnvNames) {
  console.warn(
    `[Receps-IA] ${canonicalName} e ${legacyName} divergem; o nome canônico será usado.`
  );
}

Sentry.init({
  dsn: config.dsn,
  enabled: Boolean(config.dsn),
  environment: config.environment,
  release: config.release,
  initialScope: RECEPS_IA_SENTRY_SCOPE,
  // Nunca capturar PII automaticamente (IP, headers, corpo da request).
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});

export { Sentry };
