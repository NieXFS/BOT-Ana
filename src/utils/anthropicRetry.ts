import * as Sentry from '@sentry/node';
import { markCaptured } from '../observability/captured';

/**
 * Retry + funil central de erros pra Anthropic (Renata/salesBrain).
 *
 * `patient` é o default do fluxo assíncrono da Renata: tolera uma indisponibilidade
 * curta sem pedir que a lead repita. `quick` preserva a escada curta para o
 * reprocessamento manual, quando há uma pessoa aguardando o resultado.
 */

export type AnthropicRetryPolicy = 'patient' | 'quick';

export interface AnthropicRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Seam opcional do smoke; produção usa Math.random (uniforme em [0, 1)). */
  random?: () => number;
}

type HeadersLike = {
  get?: (name: string) => string | null;
  [key: string]: unknown;
};

type ErrorWithStatus = {
  status?: number;
  code?: string | null;
  name?: string;
  headers?: HeadersLike;
  cause?: { code?: string | null };
  error?: {
    type?: string;
    error?: { type?: string };
  };
};

const QUICK_DELAYS_MS = [1_000, 2_000, 4_000];
const QUICK_WAIT_BUDGET_MS = QUICK_DELAYS_MS.reduce(
  (total, delay) => total + delay,
  0
);
const PATIENT_WAIT_BUDGET_MS = 35_000;
const PATIENT_MAX_ATTEMPTS = 7;
const PATIENT_MAX_DELAY_MS = 10_000;
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const CONNECTION_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

function asErrorWithStatus(err: unknown): ErrorWithStatus {
  return err && typeof err === 'object' ? (err as ErrorWithStatus) : {};
}

function getErrorType(error: ErrorWithStatus): string | undefined {
  return error.error?.error?.type ?? error.error?.type;
}

export function isRetryableAnthropicError(err: unknown): boolean {
  const error = asErrorWithStatus(err);

  if (error.status === 429 || error.status === 408 || error.status === 529) {
    return true;
  }
  if (
    error.status === 500 ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  ) {
    return true;
  }
  if (getErrorType(error) === 'overloaded_error') {
    return true;
  }
  const constructorName =
    err && typeof err === 'object'
      ? (err as { constructor?: { name?: string } }).constructor?.name
      : undefined;
  if (
    CONNECTION_ERROR_NAMES.has(error.name ?? '') ||
    CONNECTION_ERROR_NAMES.has(constructorName ?? '')
  ) {
    return true;
  }

  const networkCode = error.code ?? error.cause?.code;
  return Boolean(networkCode && NETWORK_CODES.has(networkCode));
}

function readHeader(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== null) return value;
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && (typeof value === 'string' || typeof value === 'number')) {
      return String(value);
    }
  }
  return null;
}

export function parseRetryAfterMs(err: unknown, nowMs: number): number | null {
  const raw = readHeader(asErrorWithStatus(err).headers, 'retry-after')?.trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function patientDelayMs(retryIndex: number, random: () => number): number {
  const exponential = Math.min(
    1_000 * 2 ** retryIndex,
    PATIENT_MAX_DELAY_MS
  );
  const jitterMultiplier = 0.75 + random() * 0.5;
  return Math.min(
    PATIENT_MAX_DELAY_MS,
    Math.max(0, Math.round(exponential * jitterMultiplier))
  );
}

function markRetryExhausted(err: unknown): void {
  if (!err || typeof err !== 'object') return;
  try {
    (err as Record<string, unknown>).retry_exhausted = true;
  } catch {
    // Alguns erros do SDK podem ser congelados; a tag do Sentry segue autoritativa.
  }
}

function captureTerminalError(
  err: unknown,
  context: string,
  attempts: number,
  waitedMs: number,
  retryable: boolean,
  policy: AnthropicRetryPolicy
): void {
  const error = asErrorWithStatus(err);
  const errStatus = error.status;
  const errCode = error.code ?? error.cause?.code;

  Sentry.captureException(err, {
    tags: {
      service: 'anthropic',
      anthropic_status: errStatus ?? 'n/a',
      retry_exhausted: retryable,
    },
    contexts: {
      anthropic: {
        context,
        status: errStatus ?? null,
        code: errCode ?? null,
        retryable,
        attempts,
        waited_ms: waitedMs,
        policy,
      },
    },
  });
  if (retryable) markRetryExhausted(err);
  markCaptured(err);
}

export async function callAnthropicWithRetry<T>(
  fn: () => Promise<T>,
  context: string,
  policy: AnthropicRetryPolicy = 'patient',
  deps: AnthropicRetryDeps = {}
): Promise<T> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? (() => Math.random());
  const maxAttempts =
    policy === 'quick' ? QUICK_DELAYS_MS.length + 1 : PATIENT_MAX_ATTEMPTS;
  let waitedMs = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(
          `✅ Anthropic retry sucedeu na tentativa ${attempt} [${context}] após ${waitedMs}ms de espera`
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableAnthropicError(err);
      const noAttemptsLeft = attempt >= maxAttempts;
      const remainingBudget =
        policy === 'patient'
          ? Math.max(0, PATIENT_WAIT_BUDGET_MS - waitedMs)
          : Math.max(0, QUICK_WAIT_BUDGET_MS - waitedMs);

      if (!retryable || noAttemptsLeft || remainingBudget <= 0) {
        const error = asErrorWithStatus(err);
        const errStatus = error.status;
        const errCode = error.code ?? error.cause?.code;
        if (!retryable) {
          console.error(
            `❌ Anthropic erro permanente (não retry) [${context}] — status=${
              errStatus ?? 'n/a'
            }, code=${errCode ?? 'n/a'}.`
          );
        } else {
          console.error(
            `❌ Anthropic esgotou ${attempt} tentativa(s) [${context}] após ${waitedMs}ms de espera — status=${
              errStatus ?? 'n/a'
            }, code=${errCode ?? 'n/a'}.`
          );
        }
        captureTerminalError(
          err,
          context,
          attempt,
          waitedMs,
          retryable,
          policy
        );
        throw err;
      }

      const computedDelay =
        policy === 'quick'
          ? QUICK_DELAYS_MS[attempt - 1]!
          : patientDelayMs(attempt - 1, random);
      const retryAfterMs = parseRetryAfterMs(err, now()) ?? 0;
      const requestedDelay = Math.max(computedDelay, retryAfterMs);
      const delay = Math.min(requestedDelay, remainingBudget);
      const error = asErrorWithStatus(err);
      const errStatus = error.status;
      const errCode = error.code ?? error.cause?.code;

      console.warn(
        `⚠️ Anthropic falhou (tentativa ${attempt}/${maxAttempts}) [${context}] — status=${
          errStatus ?? 'n/a'
        }, code=${errCode ?? 'n/a'}. Retry em ${delay}ms.`
      );
      await sleep(delay);
      waitedMs += delay;
    }
  }

  throw lastError;
}
