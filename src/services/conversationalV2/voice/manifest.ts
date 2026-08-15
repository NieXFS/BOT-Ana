import { opaqueReceiptHashV2 } from '../receipts';
import {
  extractOrderedLabelsV2,
  extractOrderedTimesV2,
  extractVoiceHardFactsV2,
} from './extractors';
import { classifyRewriteSpeechActV2, speechActForCopyIdV2 } from './speechAct';
import { semanticActForCopyIdV2 } from './semanticAct';
import type {
  VoiceCanonicalManifestV2,
  VoiceCopyIdV2,
  VoiceHardFactsV2,
  VoicePropositionV2,
} from './types';

export interface VoiceCatalogLabelsV2 {
  readonly services: readonly string[];
  readonly professionals: readonly string[];
}

export function buildVoiceManifestV2(input: {
  copyId: VoiceCopyIdV2;
  text: string;
  catalog: VoiceCatalogLabelsV2;
}): VoiceCanonicalManifestV2 {
  const speechAct = speechActForCopyIdV2(input.copyId);
  const semanticAct = semanticActForCopyIdV2(input.copyId);
  const serviceLabels = extractOrderedLabelsV2(input.text, input.catalog.services);
  const professionalLabels = extractOrderedLabelsV2(
    input.text,
    input.catalog.professionals
  );
  const facts = extractVoiceHardFactsV2(input.text);
  const slotLabels = extractOrderedTimesV2(input.text);
  return {
    copyId: input.copyId,
    speechAct,
    semanticAct,
    serviceLabels,
    professionalLabels,
    slotLabels,
    facts,
    propositions: propositionsForCopyV2(input.copyId, input.text, {
      serviceLabels,
      facts,
      speechAct,
    }),
  };
}

export function hashVoiceManifestV2(manifest: VoiceCanonicalManifestV2): string {
  return opaqueReceiptHashV2(JSON.stringify(manifest));
}

function propositionsForCopyV2(
  copyId: VoiceCopyIdV2,
  text: string,
  input: {
    serviceLabels: readonly string[];
    facts: VoiceHardFactsV2;
    speechAct: VoiceCanonicalManifestV2['speechAct'];
  }
): VoicePropositionV2[] {
  const propositions: VoicePropositionV2[] = [];
  if (input.speechAct === 'ASK') {
    propositions.push({
      kind:
        copyId === 'canonical_booking_summary' || copyId === 'confirmation_reask'
          ? 'request_confirmation'
          : 'request_selection',
      subject: copyId,
      polarity: 'positive',
      modality: 'question',
    });
  }
  if (input.speechAct === 'OFFER') {
    for (const time of input.facts.times) {
      propositions.push({
        kind: 'availability',
        subject: time,
        polarity: 'positive',
        modality: 'assertion',
      });
    }
  }
  if (input.speechAct === 'DENY') {
    propositions.push({
      kind: 'availability',
      subject: copyId,
      polarity: 'negative',
      modality: 'assertion',
    });
  }
  if (input.speechAct === 'CONFIRM_ACT') {
    propositions.push({
      kind: 'write_state',
      subject: 'bookAppointment',
      polarity: 'positive',
      modality: 'completed',
    });
  }
  if (
    copyId === 'initial_service_question' ||
    copyId === 'booking_reentry_service_question'
  ) {
    for (const label of input.serviceLabels) {
      propositions.push({
        kind: 'service_capacity',
        subject: label,
        polarity: 'positive',
        modality: 'assertion',
      });
    }
  }
  void text;
  return propositions;
}

export function rewriteSpeechActOrNullV2(
  copyId: VoiceCopyIdV2,
  rewrite: string
) {
  return classifyRewriteSpeechActV2(rewrite, speechActForCopyIdV2(copyId));
}
