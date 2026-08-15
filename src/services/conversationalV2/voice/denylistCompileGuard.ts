/**
 * Guard de compilação: âncoras permanentes não são VoiceEligibleCopyIdV2.
 * Se esta diretiva ficar unused, o tsc falha — a denylist voltou a ser
 * alcançável por fastPathProvenanceV2.
 */
import { fastPathProvenanceV2 } from './provenance';

export function assertPermanentAnchorsAreNotVoiceEligibleV2(): void {
  // @ts-expect-error âncora permanente não é VoiceEligibleCopyIdV2
  fastPathProvenanceV2('canonical_booking_summary');
}
