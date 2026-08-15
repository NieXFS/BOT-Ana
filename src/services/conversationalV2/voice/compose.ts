import { isPhase1ARephraseCopyV2, policyForCopyIdV2 } from './registry';
import {
  VOICE_CONNECTIVE_IDS_BY_ACT_V2,
  VOICE_CONNECTIVE_IDS_V2,
  VOICE_CONNECTIVE_PHRASES_V2,
  type VoiceConnectiveIdV2,
  type VoiceCopyIdV2,
  type VoiceFidelityReasonV2,
  type VoiceSemanticActV2,
} from './types';

const ASK_SERVICE_CORE_START = 'Para qual serviço você gostaria de agendar?';
const ASK_DATE_CORE = 'Qual dia você prefere?';

export interface VoiceTemplateSplitV2 {
  readonly connective: string;
  readonly core: string;
}

export function isVoiceConnectiveIdV2(
  value: string
): value is VoiceConnectiveIdV2 {
  return (VOICE_CONNECTIVE_IDS_V2 as readonly string[]).includes(value);
}

export function phase1AConnectiveActV2(
  semanticAct: VoiceSemanticActV2
): 'ask_service' | 'ask_date' | null {
  if (semanticAct === 'ask_service' || semanticAct === 'ask_date') {
    return semanticAct;
  }
  return null;
}

export function connectiveIdsForActV2(
  semanticAct: VoiceSemanticActV2
): readonly VoiceConnectiveIdV2[] {
  const act = phase1AConnectiveActV2(semanticAct);
  return act ? VOICE_CONNECTIVE_IDS_BY_ACT_V2[act] : [];
}

export function isConnectiveIdCompatibleV2(
  connectiveId: VoiceConnectiveIdV2,
  semanticAct: VoiceSemanticActV2
): boolean {
  return connectiveIdsForActV2(semanticAct).includes(connectiveId);
}

export function materializeVoiceConnectiveV2(
  connectiveId: VoiceConnectiveIdV2
): string {
  return VOICE_CONNECTIVE_PHRASES_V2[connectiveId];
}

export function splitPhase1ATemplateV2(
  template: string,
  semanticAct: VoiceSemanticActV2
): VoiceTemplateSplitV2 | null {
  const trimmed = template.trim();
  if (semanticAct === 'ask_date') {
    if (!trimmed.endsWith(ASK_DATE_CORE)) return null;
    const connective = trimmed
      .slice(0, trimmed.length - ASK_DATE_CORE.length)
      .trim();
    return { connective, core: ASK_DATE_CORE };
  }
  if (semanticAct === 'ask_service') {
    const start = trimmed.indexOf(ASK_SERVICE_CORE_START);
    if (start < 0) return null;
    const core = trimmed.slice(start).trim();
    if (!core.endsWith('Qual você prefere?')) return null;
    return { connective: trimmed.slice(0, start).trim(), core };
  }
  return null;
}

export function composePhase1AUtteranceV2(
  connective: string,
  core: string
): string {
  const trimmed = connective.trim();
  return trimmed ? `${trimmed} ${core}` : core;
}

/**
 * O modelo só pode devolver um VoiceConnectiveId. Texto livre, campo
 * `connective`, JSON extra ou ID fora do enum ⇒ null (template cru).
 */
export function parseVoiceConnectiveIdV2(
  raw: string
): VoiceConnectiveIdV2 | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const jsonMatch = /\{[\s\S]*\}/u.exec(trimmed);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length !== 1 || keys[0] !== 'connectiveId') return null;
      if (typeof record.connectiveId !== 'string') return null;
      const id = record.connectiveId.trim();
      return isVoiceConnectiveIdV2(id) ? id : null;
    } catch {
      return null;
    }
  }
  return isVoiceConnectiveIdV2(trimmed) ? trimmed : null;
}

export function approvedConnectivePhraseV2(
  prefix: string,
  semanticAct: VoiceSemanticActV2
): VoiceConnectiveIdV2 | null {
  const trimmed = prefix.trim();
  for (const connectiveId of connectiveIdsForActV2(semanticAct)) {
    if (materializeVoiceConnectiveV2(connectiveId) === trimmed) {
      return connectiveId;
    }
  }
  return null;
}

export function composePhase1AVoiceRewriteV2(input: {
  copyId: VoiceCopyIdV2;
  template: string;
  modelOutput: string;
}):
  | {
      ok: true;
      payload: string;
      connectiveId: VoiceConnectiveIdV2;
      connective: string;
      core: string;
    }
  | { ok: false; reasons: VoiceFidelityReasonV2[] } {
  if (!isPhase1ARephraseCopyV2(input.copyId)) {
    return { ok: false, reasons: ['closed_grammar_violation'] };
  }
  const semanticAct = policyForCopyIdV2(input.copyId).semanticAct;
  const split = splitPhase1ATemplateV2(input.template, semanticAct);
  if (!split) {
    return { ok: false, reasons: ['closed_grammar_violation'] };
  }
  const connectiveId = parseVoiceConnectiveIdV2(input.modelOutput);
  if (!connectiveId || !isConnectiveIdCompatibleV2(connectiveId, semanticAct)) {
    return { ok: false, reasons: ['closed_grammar_violation'] };
  }
  const connective = materializeVoiceConnectiveV2(connectiveId);
  return {
    ok: true,
    payload: composePhase1AUtteranceV2(connective, split.core),
    connectiveId,
    connective,
    core: split.core,
  };
}

export function phase1AClosedGrammarReasonsV2(input: {
  copyId: VoiceCopyIdV2;
  template: string;
  rewrite: string;
}): VoiceFidelityReasonV2[] {
  if (!isPhase1ARephraseCopyV2(input.copyId)) return [];
  const semanticAct = policyForCopyIdV2(input.copyId).semanticAct;
  const split = splitPhase1ATemplateV2(input.template, semanticAct);
  if (!split) return ['closed_grammar_violation'];
  const rewrite = input.rewrite.trim();
  if (!rewrite.endsWith(split.core)) return ['closed_grammar_violation'];
  const prefix = rewrite.slice(0, rewrite.length - split.core.length).trim();
  if (composePhase1AUtteranceV2(prefix, split.core) !== rewrite) {
    return ['closed_grammar_violation'];
  }
  if (!approvedConnectivePhraseV2(prefix, semanticAct)) {
    return ['closed_grammar_violation'];
  }
  return [];
}
