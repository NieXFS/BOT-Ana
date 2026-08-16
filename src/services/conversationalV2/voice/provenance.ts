import type { ModelTurnResultV2 } from '../contracts';
import {
  VOICE_TEMPLATE_VERSION_V2,
  type ServerCopyProvenanceV2,
  type VoiceEligibleCopyIdV2,
} from './types';
import { isPermanentVoiceDenylistV2, isVoiceEligibleCopyIdV2 } from './registry';

export type VoiceCopyProducerPathV2 =
  | 'initial_service'
  | 'booking_reentry'
  | 'selection'
  | 'date_slots'
  | 'duplicate'
  | 'booking_confirmation'
  | 'lifecycle_write'
  | 'lifecycle_slots'
  | 'interpreter_novo'
  | 'read'
  | 'cancellation';

export function fastPathProvenanceV2(
  copyId: VoiceEligibleCopyIdV2
): ServerCopyProvenanceV2 {
  return {
    producer: 'fast_path',
    copyId,
    templateVersion: VOICE_TEMPLATE_VERSION_V2,
  };
}

/**
 * Identidade do produtor = caminho de código + campos estruturais do resultado.
 * Nunca infere copyId a partir do texto. Âncoras permanentes devolvem null.
 */
export function provenanceFromProducerPathV2(input: {
  producer: VoiceCopyProducerPathV2;
  result: ModelTurnResultV2;
}): ServerCopyProvenanceV2 | null {
  const copyId = copyIdFromProducerPathV2(input.producer, input.result);
  if (!copyId || isPermanentVoiceDenylistV2(copyId)) return null;
  if (!isVoiceEligibleCopyIdV2(copyId)) return null;
  return fastPathProvenanceV2(copyId);
}

export function shouldKeepVoiceProvenanceV2(input: {
  recoveryKind: string;
  recoveryPayload: string;
  provenancedPayload: string | null;
}): boolean {
  return (
    input.recoveryKind === 'none' &&
    input.provenancedPayload !== null &&
    input.recoveryPayload === input.provenancedPayload
  );
}

function copyIdFromProducerPathV2(
  producer: VoiceCopyProducerPathV2,
  result: ModelTurnResultV2
): string | null {
  const transition = result.pendingTransitionCandidate;
  const pendingKind = transition.kind === 'open' ? transition.pendingKind : null;
  switch (producer) {
    case 'initial_service':
    case 'interpreter_novo':
      return 'initial_service_question';
    case 'booking_reentry':
      if (result.replyPurpose === 'SERVICE_QUESTION') {
        return 'booking_reentry_service_question';
      }
      if (result.replyPurpose === 'CLARIFICATION' && pendingKind === 'CONFIRMATION') {
        return 'booking_reentry_question';
      }
      return null;
    case 'selection':
      if (result.replyPurpose === 'DATE_TIME_QUESTION' && pendingKind === 'DATE') {
        return 'service_selected_date_question';
      }
      if (result.replyPurpose === 'PROFESSIONAL_QUESTION') {
        return 'professional_selection_question';
      }
      return null;
    case 'date_slots':
      if (pendingKind === 'TIME') return 'availability_slots_offer';
      if (pendingKind === 'DATE') return 'deny_slots_empty_day';
      return null;
    case 'duplicate':
    case 'booking_confirmation':
    case 'lifecycle_write':
    case 'read':
    case 'cancellation':
      return null;
    case 'lifecycle_slots':
      return 'availability_slots_offer';
  }
}
