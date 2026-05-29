/**
 * Inicialização do Sentry da Ana. Importado o mais cedo possível no
 * `webhookServer.ts` (logo após `dotenv/config`, antes do express e dos
 * services) pra instrumentar erros e performance.
 *
 * Sem `ANA_SENTRY_DSN` o SDK vira no-op silencioso — local/dev não envia nada.
 */

import * as Sentry from '@sentry/node';
import { scrubEvent } from './scrub';

const dsn = process.env.ANA_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.ANA_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
  release: process.env.ANA_RELEASE,
  // Nunca capturar PII automaticamente (IP, headers, corpo da request).
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});

export { Sentry };
