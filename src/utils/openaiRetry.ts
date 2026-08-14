import OpenAI from 'openai';
import * as Sentry from '@sentry/node';
import { markCaptured } from '../observability/captured';

type ErrorWithStatus = {
  status?: number;
  code?: string | null;
  cause?: { code?: string | null };
};
export type AiRetryProvider = 'openai' | 'deepseek' | 'luna';

const RETRY_DELAYS_MS = [1000, 2000, 4000];

export function isRetryableAiError(err: unknown): boolean {
  const e = err as ErrorWithStatus;

  if (
    err instanceof OpenAI.APIConnectionTimeoutError ||
    err instanceof OpenAI.APIConnectionError
  ) {
    return true;
  }

  if (e.status === 429) return true;
  if (e.status === 408) return true;
  if (e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504) {
    return true;
  }

  const networkCode = e.code ?? e.cause?.code;
  if (
    networkCode === 'ETIMEDOUT' ||
    networkCode === 'ECONNABORTED' ||
    networkCode === 'ECONNRESET' ||
    networkCode === 'ECONNREFUSED' ||
    networkCode === 'ENOTFOUND' ||
    networkCode === 'EAI_AGAIN' ||
    networkCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    networkCode === 'UND_ERR_SOCKET'
  ) {
    return true;
  }

  return false;
}

export async function callAiWithRetry<T>(
  fn: () => Promise<T>,
  context: string,
  provider: AiRetryProvider
): Promise<T> {
  let lastError: unknown;
  const providerLabel =
    provider === 'deepseek'
      ? 'DeepSeek'
      : provider === 'luna'
        ? 'OpenAI Luna'
        : 'OpenAI';

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(
          `✅ ${providerLabel} retry sucedeu na tentativa ${attempt + 1} [${context}]`
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      const isLast = attempt === RETRY_DELAYS_MS.length;
      const canRetry = isRetryableAiError(err);
      const errStatus = (err as ErrorWithStatus).status;
      const errCode =
        (err as ErrorWithStatus).code ??
        (err as ErrorWithStatus).cause?.code;

      if (isLast || !canRetry) {
        if (!canRetry) {
          console.error(
            `❌ ${providerLabel} erro permanente (não retry) [${context}] — status=${
              errStatus ?? 'n/a'
            }, code=${errCode ?? 'n/a'}.`
          );
        } else {
          console.error(
            `❌ ${providerLabel} esgotou ${
              RETRY_DELAYS_MS.length + 1
            } tentativas [${context}] — status=${errStatus ?? 'n/a'}, code=${
              errCode ?? 'n/a'
            }.`
          );
        }

        // Funil central dos providers de IA: rate limit (429), erro de modelo
        // (4xx), timeouts/5xx esgotados. A transcrição segue identificada como
        // OpenAI pelo wrapper compatível abaixo.
        const safeTelemetryError = new Error(
          `${providerLabel} request falhou após ${attempt + 1} tentativa(s).`
        );
        safeTelemetryError.name = 'AiProviderRequestError';
        Sentry.captureException(safeTelemetryError, {
          tags: {
            service: provider,
            ai_provider: provider,
            ai_status: errStatus ?? 'n/a',
            ai_error_type:
              err instanceof Error ? err.constructor.name : typeof err,
            retry_exhausted: canRetry,
          },
          contexts: {
            ai_provider: {
              provider,
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
      console.warn(
        `⚠️ ${providerLabel} falhou (tentativa ${attempt + 1}/${
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

/**
 * Compatibilidade para a transcrição de áudio, que continua exclusivamente na
 * OpenAI durante o A/B.
 */
export async function callOpenAIWithRetry<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  return callAiWithRetry(fn, context, 'openai');
}
