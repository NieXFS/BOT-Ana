import type { HumanControlDisposition } from '../receptionistTurnDecision';
import type { CopyVariantIdV2 } from './copyVariants';
import type { VoiceReceiptV2 } from './voice/types';

export const MODEL_REPLY_PURPOSES_V2 = [
  'SOCIAL',
  'SERVICE_QUESTION',
  'PROFESSIONAL_QUESTION',
  'DATE_TIME_QUESTION',
  'OPERATIONAL_ANSWER',
  'WRITE_CONFIRMATION',
  'CLARIFICATION',
] as const;

export type ModelReplyPurposeV2 = (typeof MODEL_REPLY_PURPOSES_V2)[number];

export const PENDING_KINDS_V2 = [
  'SERVICE',
  'PROFESSIONAL',
  'DATE',
  'TIME',
  'CONFIRMATION',
] as const;

export type PendingKindV2 = (typeof PENDING_KINDS_V2)[number];

export const FLAT_NEXT_PENDING_V2 = [
  ...PENDING_KINDS_V2,
  'PRESERVE',
  'RESOLVED',
] as const;

export type FlatNextPendingV2 = (typeof FLAT_NEXT_PENDING_V2)[number];

/**
 * Única interface externa da resposta final do brain/regenerador v2.
 * Nenhum campo deste shape é autoritativo: o servidor localiza evidências,
 * deriva propósito/opções e materializa o contrato interno rico.
 */
export interface FlatModelTurnV2 {
  reply: string;
  nextPending: FlatNextPendingV2;
  chosenOptionText: string | null;
  unknownServiceText: string | null;
}

export interface InboundSpanV2 {
  inboundId: string;
  /** Inclusive code-point offset. */
  start: number;
  /** Exclusive code-point offset. */
  end: number;
}

export interface UnknownServiceEvidenceV2 {
  inboundId: string;
  span: { start: number; end: number };
}

export interface PendingOptionV2 {
  readonly position: number;
  readonly entityId: string;
  readonly displayName: string;
}

export interface PendingFrameSnapshotV2 {
  readonly questionId: string;
  readonly askedAt: string;
  readonly kind: PendingKindV2;
  readonly flowId: string;
  readonly version: number;
  readonly options: readonly PendingOptionV2[];
}

export interface FixedByProofVersionV2 {
  readonly fixedServiceId?: number;
  readonly fixedProfessionalId?: number;
  readonly resolvedDate?: number;
}

export interface BookingDraftV2 {
  readonly serviceId: string;
  readonly professionalId?: string;
  readonly date: string;
  readonly time: string;
  readonly slotEvidenceTurnId: string;
}

export interface SlotEvidenceV2 {
  readonly turnId: string;
  readonly serviceId: string;
  readonly professionalId?: string;
  readonly date: string;
  readonly slots: readonly string[];
}

export interface BookingReentryV2 {
  /** Snapshot mínimo server-owned da pergunta operacional substituída. */
  readonly pendingKind: PendingKindV2;
  readonly optionEntityIds: readonly string[];
}

export interface DuplicateResolutionEvidenceV2 {
  readonly kind: 'keep_both';
  /** Turno da releitura autoritativa que confirmou o conflito. */
  readonly readEvidenceTurnId: string;
  readonly sourcePendingVersion: number;
  /** Tupla do draft relido; mudança posterior invalida a autorização. */
  readonly serviceId: string;
  readonly professionalId?: string;
  readonly date: string;
  readonly time: string;
}

export interface DuplicatePreflightClearanceV2 {
  readonly kind: 'no_conflict';
  /** Turno da leitura autoritativa que não encontrou conflito para o draft. */
  readonly readEvidenceTurnId: string;
  /** A pendência contra a qual a leitura foi executada. */
  readonly sourcePendingKind: 'TIME' | 'CONFIRMATION';
  readonly sourcePendingVersion: number;
  /** Tupla completa: qualquer mudança invalida o pass-through. */
  readonly serviceId: string;
  readonly professionalId?: string;
  readonly date: string;
  readonly time: string;
}

export interface FlowStateV2 {
  readonly flowId: string;
  /** Relógio server-owned do último avanço operacional commitado. */
  readonly lastOperationalAt?: string;
  readonly fixedServiceId?: string;
  readonly fixedProfessionalId?: string;
  readonly resolvedDate?: string;
  /** Rascunho tipado do servidor; nunca licencia write por si só. */
  readonly bookingDraft?: BookingDraftV2;
  /** Evidência tipada que originou um PendingFrame TIME. */
  readonly slotEvidence?: SlotEvidenceV2;
  /** Escolha intermediária continuar|novo; nunca licencia write. */
  readonly bookingReentry?: BookingReentryV2;
  /** Resolução tipada de duplicidade; só o gate v2 pode consumi-la. */
  readonly duplicateResolution?: DuplicateResolutionEvidenceV2;
  /** Read v2 já executado para este draft e sem conflito computável. */
  readonly duplicatePreflightClearance?: DuplicatePreflightClearanceV2;
  readonly fixedByProofVersion: FixedByProofVersionV2;
}

export interface TurnFrameV2 {
  readonly schemaVersion: 2;
  readonly turnId: string;
  readonly inputSequence: number;
  readonly catalogSnapshotHash: string;
  readonly catalogState: 'available' | 'unavailable';
  readonly humanControl: HumanControlDisposition;
  readonly currentInboundIds: readonly string[];
  readonly pending: PendingFrameSnapshotV2 | null;
  readonly flowState: FlowStateV2;
}

export type PendingTransitionCandidate =
  | { kind: 'preserve' }
  | { kind: 'resolve'; questionId: string }
  | { kind: 'invalidate'; questionId: string; reason: string }
  | {
      kind: 'open';
      pendingKind: PendingKindV2;
      flowId: string;
      optionEntityIds: string[];
      /**
       * Marcador exclusivamente server-side. Uma clarificação TIME precisa de
       * questionId/versão próprios mesmo quando suas opções coincidem com o
       * snapshot atual. O parser externo nunca produz este campo.
       */
      forceSupersede?: 'time_disambiguation';
    };

export type ResolutionCandidate =
  | {
      kind: 'pending_option';
      questionId: string;
      position: number;
      entityId: string;
      inboundId: string;
    }
  | {
      kind: 'catalog_entity';
      entityKind: 'service' | 'professional';
      entityId: string;
      inboundId: string;
      span: { start: number; end: number };
    }
  | null;

export interface ModelTurnResultV2 {
  schemaVersion: 2;
  reply: string;
  replyPurpose: ModelReplyPurposeV2;
  pendingTransitionCandidate: PendingTransitionCandidate;
  resolutionCandidate: ResolutionCandidate;
  unknownServiceEvidence: UnknownServiceEvidenceV2 | null;
}

export interface ModelToolCallV2 {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelStepV2 =
  | { kind: 'tool_calls'; round: number; toolCalls: ModelToolCallV2[] }
  | { kind: 'final'; round: number; result: ModelTurnResultV2 };

export type ResolutionProof =
  | {
      kind: 'pending_option';
      proofVersion: number;
      flowId: string;
      questionId: string;
      pendingVersion: number;
      position: number;
      entityId: string;
      inboundId: string;
    }
  | {
      kind: 'catalog_entity';
      proofVersion: number;
      flowId: string;
      entityKind: 'service' | 'professional';
      entityId: string;
      inboundId: string;
      span: { start: number; end: number };
    };

export type BoundaryReasonCodeV2 =
  | 'EMPTY_PAYLOAD'
  | 'INTERNAL_HINT'
  | 'CATALOG_SERVICE_ID'
  | 'CATALOG_PROFESSIONAL_ID'
  | 'APPOINTMENT_ID'
  | 'TECHNICAL_ID'
  | 'MESSAGE_ID_LEAK'
  | 'FALSE_WRITE_CLAIM'
  | 'UNVERIFIED_AVAILABILITY'
  | 'UNVERIFIED_APPOINTMENT_CONTEXT'
  | 'UNKNOWN_SERVICE_OFFER'
  | 'UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'
  | 'UNVERIFIED_IMPLICIT_COMMITMENT'
  | 'INELIGIBLE_PROFESSIONAL'
  | 'SERVICE_RELIST_AFTER_FIXED'
  | 'UNLICENSED_SOCIAL_TEMPORAL_ECHO'
  | 'SOCIAL_OPERATIONAL_FACT'
  | 'SOCIAL_PRICE_FACT'
  | 'SOCIAL_BUSINESS_HOURS_FACT'
  | 'SOCIAL_COMMERCE_FACT'
  | 'SOCIAL_ADDRESS_FACT'
  | 'SOCIAL_CAPACITY_FACT'
  | 'SOCIAL_DURATION_FACT'
  | 'SOCIAL_STAFF_FACT'
  | 'SOCIAL_PARALLEL_CHANNEL'
  | 'SOCIAL_CLINICAL_CLAIM'
  | 'SOCIAL_ATTENDANCE_INSTRUCTION'
  | 'SOCIAL_PERSON_IDENTITY_FACT'
  | 'SOCIAL_HUMAN_RETURN_PROMISE'
  | 'SOCIAL_RECENT_REPLY_REPETITION'
  | 'REPEATED_CLARIFICATION'
  | 'SOCIAL_FORMAT_VIOLATION'
  | 'MODEL_RESULT_INVALID'
  | 'REGEN_PROVIDER_ERROR'
  | 'REGEN_TOOL_CALLS'
  | 'REGEN_MODEL_RESULT_INVALID'
  | 'PAYLOAD_BLOCK_MISMATCH'
  | 'MALFORMED_ENVELOPE'
  | 'UNSUPPORTED_CONTRACT'
  | 'UNKNOWN_PRICE'
  | 'UNKNOWN_PROFESSIONAL'
  | 'HUMAN_RESPONSE_DEADLINE'
  | 'EXPLICIT_PII'
  | 'TOO_MANY_EMOJIS'
  | 'UNRECORDED_HANDOFF'
  | 'UNAUTHORIZED_CLINICAL_PROMISE'
  | 'UNLICENSED_SERVICE_DESCRIPTION'
  | 'INTERNAL_CONVERSATION_MARKER'
  | 'SOCIAL_CONTEXT_DRIFT'
  | 'UNSAFE_CUSTOMER_IDENTITY_RESPONSE';

export type BoundaryStageV2 =
  | 'raw_candidate_scan'
  | 'mechanical_normalization'
  | 'customer_reply_guard'
  | 'receptionist_outbound';

export interface BoundaryStageEvaluationV2 {
  stage: BoundaryStageV2;
  safe: boolean;
  reasonCodes: BoundaryReasonCodeV2[];
}

export interface BoundaryEvaluation {
  kind: 'boundary_evaluation_v2';
  safe: boolean;
  originalAccepted: boolean;
  /** Empty on rejection. Recovery must branch on safe/originalAccepted first. */
  acceptedPayload: string;
  normalizedCandidate: string;
  reasonCodes: BoundaryReasonCodeV2[];
  stages: BoundaryStageEvaluationV2[];
}

export type RedactedPendingTransitionCandidateV2 =
  | { kind: 'preserve' }
  | { kind: 'resolve'; questionIdHash: string }
  | { kind: 'invalidate'; questionIdHash: string; reasonCodeHash: string }
  | {
      kind: 'open';
      pendingKind: PendingKindV2;
      flowIdHash: string;
      optionCount: number;
    };

export type ToolEffectClassV2 = 'read' | 'write';
export type ToolEffectOutcomeV2 =
  | 'success'
  | 'failure'
  | 'blocked'
  | 'error';

export interface TurnPlanToolEffectV2 {
  invocationId: string;
  tool: string;
  class: ToolEffectClassV2;
  outcome: ToolEffectOutcomeV2;
  writeCommitted: boolean;
}

export interface TurnPlanBoundaryAttemptV2 {
  index: number;
  candidateHash: string;
  reasonCodes: BoundaryReasonCodeV2[];
}

export interface GateDeclineV2 {
  gate:
    | 'booking_reentry'
    | 'date_slots'
    | 'existing_appointment_read'
    | 'duplicate_resolution'
    | 'duplicate_preflight'
    | 'initial_service_question'
    | 'selection'
    | 'booking_confirmation'
    | 'upcoming_appointment_read'
    | 'cancellation';
  reason: string;
}

export interface TurnPlanReceiptV2 {
  schemaVersion: 2;
  planReceiptId: string;
  turnId: string;
  frameHash: string;
  inputSequence: number;
  route:
    | 'fast_path'
    | 'model'
    | 'regen'
    | 'fallback'
    | 'preempted'
    | 'interpreter_hit'
    | 'interpreter_nenhuma'
    | 'interpreter_error';
  /** Fingerprint técnico do motor; nunca contém prompt, fala ou identificador. */
  provider: 'openai' | 'deepseek' | 'luna';
  requestedModel: string;
  response: {
    model: string | null;
    systemFingerprint: string | null;
  };
  thinkingMode: 'disabled' | 'enabled';
  strictTools: boolean;
  primaryModelRounds: number;
  primaryProviderCalls: number;
  regenProviderCalls: number;
  pendingTransitionCandidate: RedactedPendingTransitionCandidateV2;
  toolEffects: TurnPlanToolEffectV2[];
  boundaryAttempts: TurnPlanBoundaryAttemptV2[];
  /** Último declínio determinístico relevante; valores são enumerações técnicas. */
  gateDecline?: GateDeclineV2;
  recoveryKind:
    | 'none'
    | 'regen'
    | 'canonical_write_confirmation'
    | 'direct_fallback';
  /** Proveniência técnica da copy; nunca contém texto da conversa. */
  copyVariant?: CopyVariantIdV2;
  /** Subrecibo da camada de voz; hashes/enums apenas, sem copy. */
  voice?: VoiceReceiptV2;
  result: 'accepted_for_delivery';
}

export type TransportOutcomeV2 =
  | 'accepted_by_provider'
  | 'transport_unknown'
  | 'transport_failed'
  | 'suppressed_pause'
  | 'superseded';

export type OutboxStateV2 =
  | 'prepared'
  | 'transport_started'
  | 'accepted_by_provider'
  | 'transport_unknown'
  | 'transport_failed'
  | 'accepted_uncommitted';

export interface TurnDeliveryReceiptV2 {
  schemaVersion: 2;
  deliveryReceiptId: string;
  planReceiptId: string;
  turnId: string;
  deliveryAttemptId: string;
  transportStartedAt: string | null;
  transportOutcome: TransportOutcomeV2;
  providerMessageIdHash?: string;
  outboxState: OutboxStateV2;
  conversationCommitOutcome:
    | 'committed'
    | 'accepted_uncommitted'
    | 'not_applicable'
    | 'failed';
  pendingCommitOutcome:
    | 'opened'
    | 'preserved'
    | 'resolved'
    | 'invalidated'
    | 'cas_conflict'
    | 'not_applicable'
    | 'failed';
  successorTurnId?: string;
  expectedPendingVersion: number | null;
  observedPendingVersion: number | null;
  terminalAt: string;
}

export type DeliveryPreemptionV2 =
  | 'HUMAN_ACTIVE'
  | 'PAUSE_RECHECK'
  | 'INBOUND_SUSPENDED'
  | 'OUTSIDE_HOURS_THROTTLED'
  | 'TRANSPORT_OUTCOME_UNKNOWN'
  | 'SUPERSEDED_BY_NEW_INBOUND';
