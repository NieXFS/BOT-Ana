import { normalizeVoiceTextV2 } from './normalize';
import { policyForCopyIdV2 } from './registry';
import type {
  VoiceCopyIdV2,
  VoiceDetectedSemanticActV2,
  VoiceSemanticActV2,
} from './types';

const HANDOFF_RE =
  /\b(?:falar com (?:a |o )?(?:equipe|dona|atendente|humano|responsavel)|te (?:passo|encaminho) (?:pra|para)|vou avisar|avisar a equipe)\b/u;
const ASK_SERVICE_RE =
  /\b(?:para qual servico voce gostaria de agendar|qual servico voce prefere)\b/u;
const ASK_DATE_RE = /\bqual dia voce prefere\b/u;
const ASK_PROFESSIONAL_RE =
  /\b(?:profissional especifico|tanto faz|qual profissional voce prefere)\b/u;
const ASK_REENTRY_RE = /\bcontinuar esse agendamento ou marcar outro\b/u;
const OFFER_RE =
  /\b(?:encontrei(?:\s+(?:estes|esses|os))?\s+horarios?|separei(?:\s+(?:estes|esses|os))?\s+horarios?)\b/u;
const DENY_RE =
  /\b(?:nao encontrei horarios?|nao temos|nao esta disponivel|indisponivel)\b/u;
const CONFIRM_ACT_RE =
  /\b(?:confirmado com sucesso|ja marquei|ja agendei|foi confirmado)\b/u;
const COMPLIANCE_RE =
  /\b(?:nao consigo conclui-lo|precisa ser tratado diretamente|equipe do estabelecimento)\b/u;

export function semanticActForCopyIdV2(copyId: VoiceCopyIdV2): VoiceSemanticActV2 {
  return policyForCopyIdV2(copyId).semanticAct;
}

export function classifyRewriteSemanticActV2(
  rewrite: string
): VoiceDetectedSemanticActV2 | null {
  const normalized = normalizeVoiceTextV2(rewrite);
  if (HANDOFF_RE.test(normalized)) return 'handoff';
  if (CONFIRM_ACT_RE.test(normalized)) return 'confirm_act';
  if (COMPLIANCE_RE.test(normalized)) return 'compliance';
  if (DENY_RE.test(normalized) && !OFFER_RE.test(normalized)) return 'deny';
  if (OFFER_RE.test(normalized)) return 'offer_slots';
  if (ASK_REENTRY_RE.test(normalized)) return 'ask_reentry';
  if (ASK_PROFESSIONAL_RE.test(normalized) && rewrite.includes('?')) {
    return 'ask_professional';
  }
  if (ASK_DATE_RE.test(normalized) && rewrite.includes('?')) return 'ask_date';
  if (ASK_SERVICE_RE.test(normalized) && rewrite.includes('?')) return 'ask_service';
  return null;
}

export function rewriteMatchesExpectedSemanticActV2(
  rewrite: string,
  expected: VoiceSemanticActV2
): boolean {
  return classifyRewriteSemanticActV2(rewrite) === expected;
}
