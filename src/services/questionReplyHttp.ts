import type { QuestionReplyResult } from './questionReplyService';

export interface QuestionReplyHttpResponse {
  statusCode: number;
  body: Record<string, string>;
}

/** Mapeamento único da resposta interna, compartilhado pela rota e pelo harness. */
export function questionReplyResultToHttp(
  result: QuestionReplyResult
): QuestionReplyHttpResponse {
  if (result.kind === 'sent') {
    return {
      statusCode: 200,
      body: {
        providerMessageId: result.providerMessageId,
        sentAt: result.sentAt,
      },
    };
  }
  if (result.kind === 'conflict') {
    return { statusCode: 409, body: { error: 'CONFLICT' } };
  }
  if (result.kind === 'pending') {
    return {
      statusCode: 202,
      body: {
        status: result.status,
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
      },
    };
  }
  if (result.kind === 'stale_source') {
    return { statusCode: 409, body: { status: 'stale_source' } };
  }
  return {
    statusCode: 422,
    body: {
      status: 'failed_pre_send',
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    },
  };
}
