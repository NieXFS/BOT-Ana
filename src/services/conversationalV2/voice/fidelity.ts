import { phase1AClosedGrammarReasonsV2 } from './compose';
import {
  extractOrderedLabelsV2,
  extractOrderedTimesV2,
  extractVoiceHardFactsV2,
  hasForbiddenVoiceModifierV2,
  hasNewVoiceCtaV2,
  hasPostfixNegationV2,
  sequencesEqualV2,
  setsEqualV2,
} from './extractors';
import {
  buildVoiceManifestV2,
  hashVoiceManifestV2,
  type VoiceCatalogLabelsV2,
} from './manifest';
import { normalizeVoiceTextV2, sameNormalizedVoiceTextV2 } from './normalize';
import { classifyRewriteSemanticActV2, semanticActForCopyIdV2 } from './semanticAct';
import { classifyRewriteSpeechActV2 } from './speechAct';
import type {
  VoiceCanonicalManifestV2,
  VoiceCopyIdV2,
  VoiceFidelityEvaluationV2,
  VoiceFidelityReasonV2,
  VoiceHardFactsV2,
  VoicePropositionV2,
} from './types';

const NEGATED_AVAILABILITY_RE =
  /\bnao(?:\s+\w+){0,3}\s+(?:temos?|encontrei|ha)\b/u;
const POSITIVE_AVAILABILITY_RE =
  /\b(?:encontrei horarios?|temos (?:horario|vaga)|temos \d{1,2}h)\b/u;
const COMMITMENT_RE = /\b(?:vou agendar|vou marcar|ja marquei|vou confirmar)\b/u;
const COMPLETED_WRITE_RE =
  /\b(?:ja marquei|confirmado com sucesso|foi confirmado)\b/u;
const SLOT_NEGATION_RE =
  /\bnao(?:\s+\w+){0,4}\s+(?:temos?|encontrei|ha)\s+\d{1,2}h(?:\d{2})?\b/u;

export function evaluateVoiceFidelityV2(input: {
  copyId: VoiceCopyIdV2;
  template: string;
  rewrite: string;
  catalog: VoiceCatalogLabelsV2;
  lastAcceptedPayload?: string | null;
}): VoiceFidelityEvaluationV2 {
  const canonical = buildVoiceManifestV2({
    copyId: input.copyId,
    text: input.template,
    catalog: input.catalog,
  });
  const rewriteManifest = buildVoiceManifestV2({
    copyId: input.copyId,
    text: input.rewrite,
    catalog: input.catalog,
  });
  const reasons = new Set<VoiceFidelityReasonV2>(
    collectFidelityReasonsV2({
      copyId: input.copyId,
      template: input.template,
      rewrite: input.rewrite,
      catalog: input.catalog,
      canonical,
      lastAcceptedPayload: input.lastAcceptedPayload,
    })
  );
  return {
    safe: reasons.size === 0,
    reasons: [...reasons],
    canonicalManifestHash: hashVoiceManifestV2(canonical),
    rewriteManifestHash: hashVoiceManifestV2(rewriteManifest),
  };
}

function collectFidelityReasonsV2(input: {
  copyId: VoiceCopyIdV2;
  template: string;
  rewrite: string;
  catalog: VoiceCatalogLabelsV2;
  canonical: VoiceCanonicalManifestV2;
  lastAcceptedPayload?: string | null;
}): VoiceFidelityReasonV2[] {
  const reasons: VoiceFidelityReasonV2[] = [];
  const expectedSemantic = semanticActForCopyIdV2(input.copyId);
  if (classifyRewriteSemanticActV2(input.rewrite) !== expectedSemantic) {
    reasons.push('semantic_act_mismatch');
  }
  reasons.push(
    ...phase1AClosedGrammarReasonsV2({
      copyId: input.copyId,
      template: input.template,
      rewrite: input.rewrite,
    })
  );
  const rewriteAct = classifyRewriteSpeechActV2(
    input.rewrite,
    input.canonical.speechAct
  );
  if (rewriteAct !== input.canonical.speechAct) {
    reasons.push('speech_act_mismatch');
  }

  const rewriteServices = extractOrderedLabelsV2(
    input.rewrite,
    input.catalog.services
  );
  const rewriteProfessionals = extractOrderedLabelsV2(
    input.rewrite,
    input.catalog.professionals
  );
  compareOrderedSet(
    input.canonical.serviceLabels,
    rewriteServices,
    reasons
  );
  compareOrderedSet(
    input.canonical.professionalLabels,
    rewriteProfessionals,
    reasons
  );

  const rewriteFacts = extractVoiceHardFactsV2(input.rewrite);
  compareFacts(input.canonical.facts, rewriteFacts, reasons);

  const rewriteSlots = extractOrderedTimesV2(input.rewrite);
  if (input.canonical.speechAct === 'OFFER') {
    if (!sequencesEqualV2(input.canonical.slotLabels, rewriteSlots)) {
      if (!setsEqualV2(input.canonical.slotLabels, rewriteSlots)) {
        reasons.push(
          rewriteSlots.length < input.canonical.slotLabels.length
            ? 'entity_omitted'
            : rewriteSlots.length > input.canonical.slotLabels.length
              ? 'entity_extra'
              : 'entity_set_mismatch'
        );
      } else {
        reasons.push('entity_order_mismatch');
      }
    }
  }

  reasons.push(
    ...polarityReasonsV2(input.canonical, input.rewrite, rewriteFacts)
  );

  if (hasForbiddenVoiceModifierV2(input.rewrite)) {
    reasons.push('forbidden_modifier');
  }
  if (hasNewVoiceCtaV2(input.rewrite)) {
    reasons.push('new_cta');
  }
  if (
    input.lastAcceptedPayload &&
    sameNormalizedVoiceTextV2(input.rewrite, input.lastAcceptedPayload) &&
    !sameNormalizedVoiceTextV2(input.template, input.lastAcceptedPayload)
  ) {
    reasons.push('exact_recent_repeat');
  }
  return reasons;
}

function compareOrderedSet(
  canonical: readonly string[],
  rewrite: readonly string[],
  reasons: VoiceFidelityReasonV2[]
): void {
  if (sequencesEqualV2(canonical, rewrite)) return;
  if (!setsEqualV2(canonical, rewrite)) {
    const canonicalSet = new Set(canonical);
    const rewriteSet = new Set(rewrite);
    if ([...rewriteSet].some((entry) => !canonicalSet.has(entry))) {
      reasons.push('entity_extra');
    }
    if ([...canonicalSet].some((entry) => !rewriteSet.has(entry))) {
      reasons.push('entity_omitted');
    }
    if (!reasons.includes('entity_extra') && !reasons.includes('entity_omitted')) {
      reasons.push('entity_set_mismatch');
    }
    return;
  }
  reasons.push('entity_order_mismatch');
}

function compareFacts(
  canonical: VoiceHardFactsV2,
  rewrite: VoiceHardFactsV2,
  reasons: VoiceFidelityReasonV2[]
): void {
  if (rewrite.uninterpretable.length > canonical.uninterpretable.length) {
    reasons.push('hard_fact_uninterpretable');
  }
  if (rewrite.writeState !== canonical.writeState) {
    reasons.push('write_state_mismatch');
  }
  if (rewrite.relativeDateTokens.length > 0 && canonical.relativeDateTokens.length === 0) {
    reasons.push('relative_date_forbidden');
  }
  const fields: Array<keyof Pick<
    VoiceHardFactsV2,
    'dates' | 'times' | 'moneyCents' | 'durationMinutes' | 'quantities'
  >> = ['dates', 'times', 'moneyCents', 'durationMinutes', 'quantities'];
  for (const field of fields) {
    const left = canonical[field];
    const right = rewrite[field];
    const same =
      left.length === right.length &&
      left.every((entry, index) => entry === right[index]);
    if (same) continue;
    const extra = right.some((entry) => !left.includes(entry as never));
    reasons.push(extra ? 'hard_fact_extra' : 'hard_fact_mismatch');
  }
}

function polarityReasonsV2(
  canonical: VoiceCanonicalManifestV2,
  rewrite: string,
  rewriteFacts: VoiceHardFactsV2
): VoiceFidelityReasonV2[] {
  const normalized = normalizeVoiceTextV2(rewrite);
  const reasons: VoiceFidelityReasonV2[] = [];
  if (canonical.speechAct === 'OFFER' || canonical.speechAct === 'ASK') {
    if (
      NEGATED_AVAILABILITY_RE.test(normalized) ||
      SLOT_NEGATION_RE.test(normalized) ||
      hasPostfixNegationV2(rewrite)
    ) {
      reasons.push('polarity_mismatch');
    }
  }
  if (canonical.speechAct === 'DENY' && POSITIVE_AVAILABILITY_RE.test(normalized)) {
    reasons.push('polarity_mismatch');
  }
  if (canonical.speechAct === 'ASK') {
    if (COMMITMENT_RE.test(normalized) || COMPLETED_WRITE_RE.test(normalized)) {
      reasons.push('modality_mismatch');
    }
    if (!rewrite.includes('?')) {
      reasons.push('modality_mismatch');
    }
  }
  if (
    canonical.speechAct === 'CONFIRM_ACT' &&
    rewriteFacts.writeState !== 'completed'
  ) {
    reasons.push('polarity_mismatch');
  }
  for (const proposition of canonical.propositions) {
    if (propositionViolatedV2(proposition, normalized, rewriteFacts)) {
      reasons.push(
        proposition.modality === 'question' ? 'modality_mismatch' : 'polarity_mismatch'
      );
    }
  }
  return reasons;
}

function propositionViolatedV2(
  proposition: VoicePropositionV2,
  normalizedRewrite: string,
  rewriteFacts: VoiceHardFactsV2
): boolean {
  if (proposition.kind === 'availability' && proposition.polarity === 'positive') {
    const deniedSlot = new RegExp(
      String.raw`\bnao(?:\s+\w+){0,4}\s+(?:temos?|encontrei|ha)\s+${escapeRegExp(displayTime(proposition.subject))}\b`,
      'u'
    );
    return deniedSlot.test(normalizedRewrite);
  }
  if (proposition.kind === 'service_capacity' && proposition.polarity === 'positive') {
    const label = escapeRegExp(normalizeVoiceTextV2(proposition.subject));
    const prefixDenied = new RegExp(
      String.raw`\bnao(?:\s+\w+){0,4}\s+(?:temos?|fazemos?|oferecemos?)\s+${label}\b`,
      'u'
    );
    const postfixDenied = new RegExp(
      String.raw`${label}(?:\s+\w+){0,4}\s+nao\s+(?:e|esta|foi)\s+(?:oferecid[oa]|disponivel|atendid[oa]|realizad[oa])\b`,
      'u'
    );
    return prefixDenied.test(normalizedRewrite) || postfixDenied.test(normalizedRewrite);
  }
  if (proposition.kind === 'write_state' && proposition.modality === 'completed') {
    return rewriteFacts.writeState !== 'completed';
  }
  if (
    proposition.kind === 'request_selection' ||
    proposition.kind === 'request_confirmation'
  ) {
    return proposition.modality === 'question' && !normalizedRewrite.includes('?');
  }
  return false;
}

function displayTime(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return normalizeVoiceTextV2(value);
  return match[2] === '00'
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __voiceFidelityForSmokeV2 = {
  evaluateVoiceFidelityV2,
};
