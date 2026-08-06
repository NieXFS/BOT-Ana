import { createHash } from 'crypto';

/** Hash técnico curto para ids isolados (provider, phone-number-id, message). */
export function technicalHash(value: string): string {
  return createHash('sha256')
    .update(value.trim(), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Identificador estável e não reversível para correlacionar uma conversa nos
 * logs sem expor `customerPhone`, `conversationKey` ou `bufferKey`.
 */
export function conversationHash(
  phoneNumberId: string,
  customerPhone: string
): string {
  return createHash('sha256')
    .update(`${phoneNumberId.trim()}:${customerPhone.trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** Somente classe/código técnico; nunca serializa mensagem, request ou body. */
export function runtimeErrorKind(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

export function safeHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : null;
}
