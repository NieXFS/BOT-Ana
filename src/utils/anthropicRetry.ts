import * as Sentry from '@sentry/node';
import { markCaptured } from '../observability/captured';

/**
 * Retry + funil central de erros pra Anthropic (Renata/salesBrain), espelhando
 * `openaiRetry`. Mesma política de retry (429/408/5xx + erros de rede), mesmo
 * shape de tags no Sentry (`service`, `*_status`, `retry_exhausted`).
 */

type ErrorWithStatus = { status?: number; code?: string; message?: string };

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function isRetryableError(err: unknown): boolean {
  const e = err as ErrorWithStatus;

  if (e.status === 429) return true;
  if (e.status === 408) return true;
  if (e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504) {
    return true;
  }

  if (
    e.code === 'ETIMEDOUT' ||
    e.code === 'ECONNRESET' ||
    e.code === 'ECONNREFUSED' ||
    e.code === 'ENOTFOUND' ||
    e.code === 'EAI_AGAIN'
  ) {
    return true;
  }

  return false;
}

export async function callAnthropicWithRetry<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(`✅ Anthropic retry sucedeu na tentativa ${attempt + 1} [${context}]`);
      }
      return result;
    } catch (err) {
      lastError = err;
      const isLast = attempt === RETRY_DELAYS_MS.length;
      const canRetry = isRetryableError(err);

      if (isLast || !canRetry) {
        if (!canRetry) {
          console.error(`❌ Anthropic erro permanente (não retry) [${context}]:`, err);
        } else {
          console.error(
            `❌ Anthropic esgotou ${RETRY_DELAYS_MS.length + 1} tentativas [${context}]:`,
            err
          );
        }

        const errStatus = (err as ErrorWithStatus).status;
        const errCode = (err as ErrorWithStatus).code;
        Sentry.captureException(err, {
          tags: {
            service: 'anthropic',
            anthropic_status: errStatus ?? 'n/a',
            retry_exhausted: canRetry,
          },
          contexts: {
            anthropic: {
              context,
              status: errStatus ?? null,
              code: errCode ?? null,
              retryable: canRetry,
              attempts: attempt + 1,
            },
          },
        });
        markCaptured(err);

        throw err;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      const errStatus = (err as ErrorWithStatus).status;
      const errCode = (err as ErrorWithStatus).code;
      console.warn(
        `⚠️ Anthropic falhou (tentativa ${attempt + 1}/${
          RETRY_DELAYS_MS.length + 1
        }) [${context}] — status=${errStatus ?? 'n/a'}, code=${
          errCode ?? 'n/a'
        }. Retry em ${delay}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
