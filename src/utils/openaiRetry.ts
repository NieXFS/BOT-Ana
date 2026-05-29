import * as Sentry from '@sentry/node';
import { markCaptured } from '../observability/captured';

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

export async function callOpenAIWithRetry<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(`✅ OpenAI retry sucedeu na tentativa ${attempt + 1} [${context}]`);
      }
      return result;
    } catch (err) {
      lastError = err;
      const isLast = attempt === RETRY_DELAYS_MS.length;
      const canRetry = isRetryableError(err);

      if (isLast || !canRetry) {
        if (!canRetry) {
          console.error(`❌ OpenAI erro permanente (não retry) [${context}]:`, err);
        } else {
          console.error(
            `❌ OpenAI esgotou ${RETRY_DELAYS_MS.length + 1} tentativas [${context}]:`,
            err
          );
        }

        // Funil central de erros do OpenAI (chat-completion + transcrição):
        // rate limit (429), erro de modelo (4xx), timeouts/5xx esgotados.
        const errStatus = (err as ErrorWithStatus).status;
        const errCode = (err as ErrorWithStatus).code;
        Sentry.captureException(err, {
          tags: {
            service: 'openai',
            openai_status: errStatus ?? 'n/a',
            retry_exhausted: canRetry,
          },
          contexts: {
            openai: {
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
        `⚠️ OpenAI falhou (tentativa ${attempt + 1}/${
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
