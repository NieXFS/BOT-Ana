export const VOICE_POLICY_VERSION_V2 = 3;
export const VOICE_TEMPLATE_VERSION_V2 = 2;
export const VOICE_FIDELITY_VERSION_V2 = 3;
export const VOICE_POOL_SCHEMA_VERSION_V2 = 1;
export const VOICE_REPHRASE_TIMEOUT_MS = 4_000;
export const VOICE_REPHRASE_MAX_TOKENS = 48;
export const VOICE_REPHRASE_TEMPERATURE = 0.3;
export const VOICE_PROMPT_PROFILE_V2 = 'warm_concise_ptbr_v1' as const;

export const VOICE_CONNECTIVE_IDS_V2 = [
  'claro',
  'combinado',
  'vamos_la',
  'perfeito',
  'otimo',
  'combinado_dot',
] as const;

export type VoiceConnectiveIdV2 = (typeof VOICE_CONNECTIVE_IDS_V2)[number];

export const VOICE_CONNECTIVE_PHRASES_V2: Record<VoiceConnectiveIdV2, string> = {
  claro: 'Claro!',
  combinado: 'Combinado!',
  vamos_la: 'Vamos lá!',
  perfeito: 'Perfeito.',
  otimo: 'Ótimo.',
  combinado_dot: 'Combinado, então.',
};

export const VOICE_CONNECTIVE_IDS_BY_ACT_V2 = {
  ask_service: ['claro', 'combinado', 'vamos_la'],
  ask_date: ['perfeito', 'otimo', 'combinado_dot'],
} as const satisfies Record<
  'ask_service' | 'ask_date',
  readonly VoiceConnectiveIdV2[]
>;

export const VOICE_PHASE_1A_COPY_IDS_V2 = [
  'initial_service_question',
  'booking_reentry_service_question',
  'service_selected_date_question',
] as const;

export const VOICE_COMPILED_POOL_COPY_IDS_V2 = [
  'availability_slots_offer',
  'booking_reentry_question',
] as const;

export const VOICE_ELIGIBLE_COPY_IDS_V2 = [
  ...VOICE_PHASE_1A_COPY_IDS_V2,
  ...VOICE_COMPILED_POOL_COPY_IDS_V2,
  'professional_selection_question',
  'deny_slots_empty_day',
] as const;

export const VOICE_PERMANENT_DENYLIST_V2 = [
  'canonical_booking_summary',
  'write_success_confirmation',
  'duplicate_choice_question',
  'half_hour_clarifier',
  'licensed_service_denial',
  'cancel_compliance',
  'identity_safe',
  'confirmation_reask',
] as const;

export const VOICE_COPY_IDS_V2 = [
  ...VOICE_ELIGIBLE_COPY_IDS_V2,
  ...VOICE_PERMANENT_DENYLIST_V2,
] as const;

export type VoiceEligibleCopyIdV2 = (typeof VOICE_ELIGIBLE_COPY_IDS_V2)[number];
export type PermanentVoiceAnchorIdV2 = (typeof VOICE_PERMANENT_DENYLIST_V2)[number];
export type VoiceCopyIdV2 = VoiceEligibleCopyIdV2 | PermanentVoiceAnchorIdV2;

export const VOICE_SPEECH_ACTS_V2 = [
  'OFFER',
  'DENY',
  'ASK',
  'CONFIRM_ACT',
  'COMPLIANCE',
] as const;

export type VoiceSpeechActV2 = (typeof VOICE_SPEECH_ACTS_V2)[number];

export type VoiceCopyModeV2 = 'off' | 'rephrase_v1' | 'compiled_pool';

export type VoicePromptProfileV2 = typeof VOICE_PROMPT_PROFILE_V2;

export type VoiceSemanticActV2 =
  | 'ask_service'
  | 'ask_date'
  | 'ask_professional'
  | 'offer_slots'
  | 'ask_reentry'
  | 'deny'
  | 'confirm_act'
  | 'compliance';

export type VoiceDetectedSemanticActV2 = VoiceSemanticActV2 | 'handoff';

export type VoiceEntityPolicyV2 =
  | 'none'
  | 'exact_ordered_catalog_labels'
  | 'exact_ordered_slots'
  | 'exact_ordered_reentry_stems';

export interface ServerCopyProvenanceV2 {
  readonly producer: 'fast_path';
  readonly copyId: VoiceEligibleCopyIdV2;
  readonly templateVersion: number;
}

export interface VoiceCopyPolicyV2 {
  readonly mode: VoiceCopyModeV2;
  readonly promptProfile: VoicePromptProfileV2;
  readonly speechAct: VoiceSpeechActV2;
  readonly semanticAct: VoiceSemanticActV2;
  readonly entityPolicy: VoiceEntityPolicyV2;
  readonly historyAssistantTurns: 0 | 1 | 2;
}

export type VoiceDecisionV2 =
  | 'not_eligible'
  | 'accepted'
  | 'unchanged'
  | 'timeout_template'
  | 'provider_error_template'
  | 'fidelity_rejected_template'
  | 'boundary_rejected_template'
  | 'race_preempted';

export type VoiceOutcomeV2 =
  | 'not_eligible'
  | 'accepted'
  | 'unchanged'
  | 'voice_rejected';

export const VOICE_FIDELITY_REASONS_V2 = [
  'speech_act_mismatch',
  'semantic_act_mismatch',
  'closed_grammar_violation',
  'entity_set_mismatch',
  'entity_order_mismatch',
  'entity_extra',
  'entity_omitted',
  'hard_fact_mismatch',
  'hard_fact_extra',
  'hard_fact_uninterpretable',
  'polarity_mismatch',
  'modality_mismatch',
  'forbidden_modifier',
  'new_cta',
  'write_state_mismatch',
  'exact_recent_repeat',
  'relative_date_forbidden',
] as const;

export type VoiceFidelityReasonV2 = (typeof VOICE_FIDELITY_REASONS_V2)[number];

export interface VoicePropositionV2 {
  readonly kind:
    | 'availability'
    | 'service_capacity'
    | 'professional_eligibility'
    | 'write_state'
    | 'request_selection'
    | 'request_confirmation';
  readonly subject: string;
  readonly polarity: 'positive' | 'negative';
  readonly modality:
    | 'question'
    | 'possibility'
    | 'assertion'
    | 'commitment'
    | 'completed';
}

export type VoiceWriteStateV2 =
  | 'not_started'
  | 'pending_confirmation'
  | 'completed'
  | 'failed';

export interface VoiceHardFactsV2 {
  readonly dates: readonly string[];
  readonly times: readonly string[];
  readonly moneyCents: readonly number[];
  readonly durationMinutes: readonly number[];
  readonly quantities: readonly number[];
  readonly writeState: VoiceWriteStateV2;
  readonly relativeDateTokens: readonly string[];
  readonly uninterpretable: readonly string[];
}

export interface VoiceCanonicalManifestV2 {
  readonly copyId: VoiceCopyIdV2;
  readonly speechAct: VoiceSpeechActV2;
  readonly semanticAct: VoiceSemanticActV2;
  readonly serviceLabels: readonly string[];
  readonly professionalLabels: readonly string[];
  readonly slotLabels: readonly string[];
  readonly facts: VoiceHardFactsV2;
  readonly propositions: readonly VoicePropositionV2[];
}

export interface VoiceFidelityEvaluationV2 {
  readonly safe: boolean;
  readonly reasons: VoiceFidelityReasonV2[];
  readonly canonicalManifestHash: string;
  readonly rewriteManifestHash: string;
}

export interface VoiceReceiptV2 {
  readonly policyVersion: number;
  readonly copyId: VoiceCopyIdV2;
  readonly decision: VoiceDecisionV2;
  readonly outcome: VoiceOutcomeV2;
  readonly providerCallCount: 0 | 1;
  readonly provider?: 'openai' | 'deepseek' | 'luna';
  readonly requestedModel?: string;
  readonly returnedModel?: string;
  readonly systemFingerprint?: string;
  readonly latencyMs?: number;
  readonly sourceHash: string;
  readonly rewriteHash?: string;
  readonly fidelityReasons: VoiceFidelityReasonV2[];
  readonly boundaryReasons: string[];
}

export type CompiledPoolReviewStatusV2 = 'PENDENTE-PAINEL' | 'aprovado';

export interface CompiledVoicePoolVariantV2 {
  readonly variantId: string;
  /** Só o conectivo; `{date}`, `{slots}`, `{service}`, `{timePart}` vêm do template. */
  readonly connective: string;
}

export interface CompiledVoicePoolV2 {
  readonly schemaVersion: typeof VOICE_POOL_SCHEMA_VERSION_V2;
  readonly poolId: string;
  readonly copyId: VoiceCopyIdV2;
  readonly templateVersion: number;
  readonly reviewStatus: CompiledPoolReviewStatusV2;
  readonly provenance: {
    readonly generator: 'mock_fixture';
    readonly generatedAt: string;
    readonly conferenceVersion: number;
    readonly note: 'PENDENTE-PAINEL';
  };
  readonly variants: readonly CompiledVoicePoolVariantV2[];
}
