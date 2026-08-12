export const CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE =
  'Não consegui identificar seu cadastro com segurança. Esse atendimento precisa ser tratado diretamente pela equipe do estabelecimento.';

export const CUSTOMER_IDENTITY_AMBIGUOUS_HINT =
  `INTERNAL_HINT: há mais de um cadastro para este telefone e não é seguro escolher um deles. NÃO consulte nem ofereça outros horários, NÃO tente agendar/cancelar de novo e NÃO mencione duplicidade ou detalhes técnicos. Ao cliente, responda SOMENTE: "${CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE}"`;

export interface CustomerIdentityTraceEntry {
  result: string;
}

/**
 * Detecta a falha por evidência estruturada retornada pela ferramenta. Texto do
 * modelo, histórico e INTERNAL_HINT nunca são usados como prova.
 */
export function toolTraceHasCustomerIdentityAmbiguity(
  toolTrace: readonly CustomerIdentityTraceEntry[] | undefined
): boolean {
  return (toolTrace ?? []).some((entry) => {
    try {
      const parsed = JSON.parse(entry.result) as {
        success?: unknown;
        reason?: unknown;
      };
      return (
        parsed.success === false &&
        parsed.reason === 'customer_identity_ambiguous'
      );
    } catch {
      return false;
    }
  });
}

/** Substituição determinística aplicada antes de qualquer estilo ou validação. */
export function enforceCustomerIdentitySafeReply(
  toolTrace: readonly CustomerIdentityTraceEntry[] | undefined,
  candidateReply: string | null | undefined
): string | null | undefined {
  return toolTraceHasCustomerIdentityAmbiguity(toolTrace)
    ? CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
    : candidateReply;
}
