/**
 * Marcador pra evitar captura duplicada no Sentry. Quando um erro já foi
 * `captureException`-ado num ponto específico (ex.: no funil do OpenAI), ele é
 * marcado e os catches mais externos não o reenviam.
 */

const FLAG = '__anaSentryCaptured';

export function markCaptured(err: unknown): void {
  if (err && typeof err === 'object') {
    try {
      (err as Record<string, unknown>)[FLAG] = true;
    } catch {
      // alguns erros são imutáveis/congelados — ignora
    }
  }
}

export function isCaptured(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as Record<string, unknown>)[FLAG] === true,
  );
}
