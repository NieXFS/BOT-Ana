import {
  VOICE_COMPILED_POOL_COPY_IDS_V2,
  VOICE_COPY_IDS_V2,
  VOICE_ELIGIBLE_COPY_IDS_V2,
  VOICE_PERMANENT_DENYLIST_V2,
  VOICE_PHASE_1A_COPY_IDS_V2,
  VOICE_PROMPT_PROFILE_V2,
  type PermanentVoiceAnchorIdV2,
  type ServerCopyProvenanceV2,
  type VoiceCopyIdV2,
  type VoiceCopyPolicyV2,
  type VoiceEligibleCopyIdV2,
  type VoiceSpeechActV2,
} from './types';

const PHASE_1A_POLICIES: Record<
  (typeof VOICE_PHASE_1A_COPY_IDS_V2)[number],
  VoiceCopyPolicyV2
> = {
  initial_service_question: {
    mode: 'rephrase_v1',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct: 'ASK',
    semanticAct: 'ask_service',
    entityPolicy: 'exact_ordered_catalog_labels',
    historyAssistantTurns: 0,
  },
  booking_reentry_service_question: {
    mode: 'rephrase_v1',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct: 'ASK',
    semanticAct: 'ask_service',
    entityPolicy: 'exact_ordered_catalog_labels',
    historyAssistantTurns: 0,
  },
  service_selected_date_question: {
    mode: 'rephrase_v1',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct: 'ASK',
    semanticAct: 'ask_date',
    entityPolicy: 'none',
    historyAssistantTurns: 0,
  },
};

const COMPILED_POOL_POLICIES: Record<
  (typeof VOICE_COMPILED_POOL_COPY_IDS_V2)[number],
  VoiceCopyPolicyV2
> = {
  availability_slots_offer: {
    mode: 'compiled_pool',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct: 'OFFER',
    semanticAct: 'offer_slots',
    entityPolicy: 'exact_ordered_slots',
    historyAssistantTurns: 0,
  },
  booking_reentry_question: {
    mode: 'compiled_pool',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct: 'ASK',
    semanticAct: 'ask_reentry',
    entityPolicy: 'exact_ordered_reentry_stems',
    historyAssistantTurns: 0,
  },
};

const DENYLIST_SPEECH_ACT: Record<PermanentVoiceAnchorIdV2, VoiceSpeechActV2> = {
  canonical_booking_summary: 'ASK',
  write_success_confirmation: 'CONFIRM_ACT',
  duplicate_choice_question: 'ASK',
  half_hour_clarifier: 'ASK',
  licensed_service_denial: 'DENY',
  cancel_compliance: 'COMPLIANCE',
  identity_safe: 'COMPLIANCE',
  confirmation_reask: 'ASK',
};

function denylistPolicy(copyId: PermanentVoiceAnchorIdV2): VoiceCopyPolicyV2 {
  const speechAct = DENYLIST_SPEECH_ACT[copyId];
  return {
    mode: 'off',
    promptProfile: VOICE_PROMPT_PROFILE_V2,
    speechAct,
    semanticAct:
      speechAct === 'CONFIRM_ACT'
        ? 'confirm_act'
        : speechAct === 'COMPLIANCE'
          ? 'compliance'
          : speechAct === 'DENY'
            ? 'deny'
            : copyId === 'canonical_booking_summary' || copyId === 'confirmation_reask'
              ? 'ask_date'
              : 'ask_service',
    entityPolicy: 'none',
    historyAssistantTurns: 0,
  };
}

const PROFESSIONAL_POLICY: VoiceCopyPolicyV2 = {
  mode: 'off',
  promptProfile: VOICE_PROMPT_PROFILE_V2,
  speechAct: 'ASK',
  semanticAct: 'ask_professional',
  entityPolicy: 'exact_ordered_catalog_labels',
  historyAssistantTurns: 0,
};

const EMPTY_DAY_POLICY: VoiceCopyPolicyV2 = {
  mode: 'off',
  promptProfile: VOICE_PROMPT_PROFILE_V2,
  speechAct: 'DENY',
  semanticAct: 'deny',
  entityPolicy: 'none',
  historyAssistantTurns: 0,
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as object)) {
      deepFreeze(nested);
    }
  }
  return value;
}

const VOICE_COPY_REGISTRY_V2 = deepFreeze({
  ...PHASE_1A_POLICIES,
  ...COMPILED_POOL_POLICIES,
  professional_selection_question: PROFESSIONAL_POLICY,
  deny_slots_empty_day: EMPTY_DAY_POLICY,
  canonical_booking_summary: denylistPolicy('canonical_booking_summary'),
  write_success_confirmation: denylistPolicy('write_success_confirmation'),
  duplicate_choice_question: denylistPolicy('duplicate_choice_question'),
  half_hour_clarifier: denylistPolicy('half_hour_clarifier'),
  licensed_service_denial: denylistPolicy('licensed_service_denial'),
  cancel_compliance: denylistPolicy('cancel_compliance'),
  identity_safe: denylistPolicy('identity_safe'),
  confirmation_reask: denylistPolicy('confirmation_reask'),
} satisfies { readonly [K in VoiceCopyIdV2]: VoiceCopyPolicyV2 });

export function getVoiceCopyRegistryV2(): {
  readonly [K in VoiceCopyIdV2]: VoiceCopyPolicyV2;
} {
  return VOICE_COPY_REGISTRY_V2;
}

export function policyForCopyIdV2(copyId: VoiceCopyIdV2): VoiceCopyPolicyV2 {
  return VOICE_COPY_REGISTRY_V2[copyId];
}

export function isVoiceEligibleCopyIdV2(
  value: string
): value is VoiceEligibleCopyIdV2 {
  return (VOICE_ELIGIBLE_COPY_IDS_V2 as readonly string[]).includes(value);
}

export function isPermanentVoiceDenylistV2(
  copyId: string
): copyId is PermanentVoiceAnchorIdV2 {
  return (VOICE_PERMANENT_DENYLIST_V2 as readonly string[]).includes(copyId);
}

export function isVoiceCopyIdV2(value: string): value is VoiceCopyIdV2 {
  return (VOICE_COPY_IDS_V2 as readonly string[]).includes(value);
}

export function resolveVoiceCopyPolicyV2(
  provenance: ServerCopyProvenanceV2 | null | undefined
): VoiceCopyPolicyV2 | null {
  if (!provenance || provenance.producer !== 'fast_path') return null;
  const copyId = String(provenance.copyId);
  if (isPermanentVoiceDenylistV2(copyId)) return null;
  if (!isVoiceEligibleCopyIdV2(copyId)) return null;
  return VOICE_COPY_REGISTRY_V2[copyId];
}

export function isPhase1ARephraseCopyV2(copyId: string): boolean {
  return (VOICE_PHASE_1A_COPY_IDS_V2 as readonly string[]).includes(copyId);
}

export function isCompiledPoolCopyV2(copyId: string): boolean {
  return (VOICE_COMPILED_POOL_COPY_IDS_V2 as readonly string[]).includes(copyId);
}
