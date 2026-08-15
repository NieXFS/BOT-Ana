import { normalizeVoiceTextV2 } from './normalize';
import type { VoiceCopyIdV2, VoiceSpeechActV2 } from './types';
import { policyForCopyIdV2 } from './registry';

const OFFER_RE =
  /\b(?:encontrei(?:\s+(?:estes|esses|os))?\s+horarios?|separei(?:\s+(?:estes|esses|os))?\s+horarios?|para [^:]{3,40}, encontrei)\b/u;
const DENY_RE =
  /\b(?:nao encontrei horarios?|nao temos|nao esta disponivel|indisponivel|nao consegui identificar)\b/u;
const CONFIRM_ACT_RE =
  /\b(?:confirmado com sucesso|ja marquei|ja agendei|foi confirmado)\b/u;
const COMPLIANCE_RE =
  /\b(?:nao consigo conclui-lo|precisa ser tratado diretamente|equipe do estabelecimento)\b/u;

const HANDOFF_RE =
  /\b(?:falar com (?:a |o )?(?:equipe|dona|atendente|humano|responsavel)|vou avisar)\b/u;

export function speechActForCopyIdV2(copyId: VoiceCopyIdV2): VoiceSpeechActV2 {
  return policyForCopyIdV2(copyId).speechAct;
}

/**
 * Classifica o rewrite a partir do texto. Falha fechada: se o ato esperado não
 * puder ser confirmado, devolve null e a conferência rejeita.
 */
export function classifyRewriteSpeechActV2(
  rewrite: string,
  expected: VoiceSpeechActV2
): VoiceSpeechActV2 | null {
  const normalized = normalizeVoiceTextV2(rewrite);
  const hasQuestion = rewrite.includes('?');
  if (CONFIRM_ACT_RE.test(normalized)) {
    return expected === 'CONFIRM_ACT' ? 'CONFIRM_ACT' : 'CONFIRM_ACT';
  }
  if (COMPLIANCE_RE.test(normalized) && expected === 'COMPLIANCE') {
    return 'COMPLIANCE';
  }
  if (DENY_RE.test(normalized) && !hasPositiveAvailabilityAssertion(normalized)) {
    return 'DENY';
  }
  if (OFFER_RE.test(normalized) && expected === 'OFFER') {
    return 'OFFER';
  }
  if (expected === 'ASK') {
    if (!hasQuestion) return null;
    if (CONFIRM_ACT_RE.test(normalized)) return 'CONFIRM_ACT';
    if (HANDOFF_RE.test(normalized)) return null;
    if (/\b(?:vou agendar|vou marcar|ja marquei|temos \d{1,2}h\b)/u.test(normalized)) {
      return null;
    }
    return 'ASK';
  }
  if (expected === 'OFFER') {
    return OFFER_RE.test(normalized) ? 'OFFER' : null;
  }
  if (expected === 'DENY') {
    return DENY_RE.test(normalized) ? 'DENY' : null;
  }
  if (expected === 'COMPLIANCE') {
    return COMPLIANCE_RE.test(normalized) ? 'COMPLIANCE' : null;
  }
  if (expected === 'CONFIRM_ACT') {
    return CONFIRM_ACT_RE.test(normalized) ? 'CONFIRM_ACT' : null;
  }
  return null;
}

function hasPositiveAvailabilityAssertion(normalized: string): boolean {
  return /\b(?:encontrei horarios?|temos (?:horario|vaga)|\bdisponive(?:l|is)\b)/u.test(
    normalized
  );
}
