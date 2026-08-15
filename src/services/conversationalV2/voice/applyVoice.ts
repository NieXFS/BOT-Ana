import type { TenantBotConfig } from '../../../configProvider';
import type { ServicesResult } from '../../calendarService';
import type { ToolTraceLike } from '../../customerReplyGuard';
import {
  evaluateBoundaryV2,
  type BoundaryEvaluationInputV2,
} from '../boundary';
import type {
  DeliveryPreemptionV2,
  ModelTurnResultV2,
  PendingTransitionCandidate,
  TurnFrameV2,
} from '../contracts';
import { opaqueReceiptHashV2 } from '../receipts';
import { evaluateVoiceFidelityV2 } from './fidelity';
import { isAnaConversationalV2VoiceEnabled } from './featureFlag';
import { resolveVoiceCopyPolicyV2 } from './registry';
import { composePhase1AVoiceRewriteV2 } from './compose';
import {
  rephraseVoiceCopyV2,
  type VoiceRephraseCompletionFactoryV2,
} from './rephraser';
import { sameNormalizedVoiceTextV2 } from './normalize';
import type {
  ServerCopyProvenanceV2,
  VoiceCopyIdV2,
  VoiceDecisionV2,
  VoiceFidelityReasonV2,
  VoiceOutcomeV2,
  VoiceReceiptV2,
} from './types';
import { VOICE_POLICY_VERSION_V2 } from './types';

export interface ApplyConversationalVoiceInputV2 {
  config: TenantBotConfig;
  enabled?: boolean;
  templatePayload: string;
  provenance: ServerCopyProvenanceV2 | null;
  lastAcceptedPayload?: string | null;
  frame: TurnFrameV2;
  candidate: PendingTransitionCandidate;
  replyPurpose: ModelTurnResultV2['replyPurpose'];
  services: ServicesResult;
  boundaryContext: Omit<BoundaryEvaluationInputV2, 'rawCandidate' | 'source'>;
  unknownServiceEvidence?: ModelTurnResultV2['unknownServiceEvidence'];
  toolTrace?: ToolTraceLike[];
  checkpoint: () => Promise<DeliveryPreemptionV2 | null>;
  timeoutMs?: number;
  completionFactory?: VoiceRephraseCompletionFactoryV2;
}

export type ApplyConversationalVoiceResultV2 =
  | {
      kind: 'payload';
      payload: string;
      receipt: VoiceReceiptV2 | null;
    }
  | {
      kind: 'preempted';
      preemption: DeliveryPreemptionV2;
      payload: string;
      receipt: VoiceReceiptV2;
    };

function outcomeFor(decision: VoiceDecisionV2): VoiceOutcomeV2 {
  if (decision === 'accepted') return 'accepted';
  if (decision === 'unchanged') return 'unchanged';
  if (decision === 'not_eligible' || decision === 'race_preempted') {
    return 'not_eligible';
  }
  return 'voice_rejected';
}

function receipt(input: {
  copyId: VoiceCopyIdV2;
  decision: VoiceDecisionV2;
  template: string;
  rewrite?: string;
  providerCallCount: 0 | 1;
  provider?: VoiceReceiptV2['provider'];
  requestedModel?: string;
  returnedModel?: string | null;
  systemFingerprint?: string | null;
  latencyMs?: number;
  fidelityReasons?: readonly VoiceFidelityReasonV2[];
  boundaryReasons?: readonly string[];
}): VoiceReceiptV2 {
  return {
    policyVersion: VOICE_POLICY_VERSION_V2,
    copyId: input.copyId,
    decision: input.decision,
    outcome: outcomeFor(input.decision),
    providerCallCount: input.providerCallCount,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(input.returnedModel ? { returnedModel: input.returnedModel } : {}),
    ...(input.systemFingerprint ? { systemFingerprint: input.systemFingerprint } : {}),
    ...(typeof input.latencyMs === 'number' ? { latencyMs: input.latencyMs } : {}),
    sourceHash: opaqueReceiptHashV2(input.template),
    ...(input.rewrite ? { rewriteHash: opaqueReceiptHashV2(input.rewrite) } : {}),
    fidelityReasons: [...(input.fidelityReasons ?? [])],
    boundaryReasons: [...(input.boundaryReasons ?? [])],
  };
}

function catalogLabels(services: ServicesResult): {
  services: string[];
  professionals: string[];
} {
  return {
    services: (services.services ?? []).map((entry) => entry.name),
    professionals: (services.professionals ?? []).map((entry) => entry.name),
  };
}

function boundaryAccepted(evaluation: ReturnType<typeof evaluateBoundaryV2>): boolean {
  return Boolean(
    evaluation.safe &&
      evaluation.originalAccepted &&
      evaluation.acceptedPayload.trim()
  );
}

export async function applyConversationalVoiceV2(
  input: ApplyConversationalVoiceInputV2
): Promise<ApplyConversationalVoiceResultV2> {
  const template = input.templatePayload;
  const enabled = isAnaConversationalV2VoiceEnabled(
    input.config.tenantSlug,
    input.enabled
  );
  const policy = resolveVoiceCopyPolicyV2(input.provenance);
  if (!enabled || !input.provenance || !policy) {
    return { kind: 'payload', payload: template, receipt: null };
  }
  const copyId = input.provenance.copyId;
  if (policy.mode !== 'rephrase_v1') {
    return {
      kind: 'payload',
      payload: template,
      receipt: receipt({
        copyId,
        decision: 'not_eligible',
        template,
        providerCallCount: 0,
      }),
    };
  }

  const firstBoundary = evaluateBoundaryV2({
    ...input.boundaryContext,
    rawCandidate: template,
    flowState: input.frame.flowState,
    pendingTransitionCandidate: input.candidate,
    replyPurpose: input.replyPurpose,
    unknownServiceEvidence: input.unknownServiceEvidence,
    toolTrace: input.toolTrace,
    source: 'GENERATED',
  });
  const approvedTemplate = boundaryAccepted(firstBoundary)
    ? firstBoundary.acceptedPayload
    : template;
  if (!boundaryAccepted(firstBoundary)) {
    return {
      kind: 'payload',
      payload: template,
      receipt: receipt({
        copyId,
        decision: 'not_eligible',
        template,
        providerCallCount: 0,
        boundaryReasons: firstBoundary.reasonCodes,
      }),
    };
  }

  const preCallRace = await input.checkpoint();
  if (preCallRace) {
    return {
      kind: 'preempted',
      preemption: preCallRace,
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'race_preempted',
        template: approvedTemplate,
        providerCallCount: 0,
      }),
    };
  }

  const rephrased = await rephraseVoiceCopyV2({
    config: input.config,
    copyId,
    template: approvedTemplate,
    timeoutMs: input.timeoutMs,
    completionFactory: input.completionFactory,
  });

  const postCallRace = await input.checkpoint();
  if (postCallRace) {
    return {
      kind: 'preempted',
      preemption: postCallRace,
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'race_preempted',
        template: approvedTemplate,
        rewrite: rephrased.ok ? rephrased.rewrite : undefined,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
      }),
    };
  }

  if (!rephrased.ok) {
    return {
      kind: 'payload',
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision:
          rephrased.reason === 'timeout'
            ? 'timeout_template'
            : 'provider_error_template',
        template: approvedTemplate,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
      }),
    };
  }

  const composed = composePhase1AVoiceRewriteV2({
    copyId,
    template: approvedTemplate,
    modelOutput: rephrased.rewrite,
  });
  if (!composed.ok) {
    return {
      kind: 'payload',
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'fidelity_rejected_template',
        template: approvedTemplate,
        rewrite: rephrased.rewrite,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
        fidelityReasons: composed.reasons,
      }),
    };
  }
  const rewrite = composed.payload;

  if (sameNormalizedVoiceTextV2(rewrite, approvedTemplate)) {
    return {
      kind: 'payload',
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'unchanged',
        template: approvedTemplate,
        rewrite,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
      }),
    };
  }

  const fidelity = evaluateVoiceFidelityV2({
    copyId,
    template: approvedTemplate,
    rewrite,
    catalog: catalogLabels(input.services),
    lastAcceptedPayload: input.lastAcceptedPayload,
  });
  if (!fidelity.safe) {
    return {
      kind: 'payload',
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'fidelity_rejected_template',
        template: approvedTemplate,
        rewrite,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
        fidelityReasons: fidelity.reasons,
      }),
    };
  }

  const secondBoundary = evaluateBoundaryV2({
    ...input.boundaryContext,
    rawCandidate: rewrite,
    flowState: input.frame.flowState,
    pendingTransitionCandidate: input.candidate,
    replyPurpose: input.replyPurpose,
    unknownServiceEvidence: input.unknownServiceEvidence,
    toolTrace: input.toolTrace,
    source: 'VOICE_REPHRASE',
  });
  if (!boundaryAccepted(secondBoundary)) {
    return {
      kind: 'payload',
      payload: approvedTemplate,
      receipt: receipt({
        copyId,
        decision: 'boundary_rejected_template',
        template: approvedTemplate,
        rewrite,
        providerCallCount: 1,
        provider: rephrased.provider,
        requestedModel: rephrased.requestedModel,
        returnedModel: rephrased.returnedModel,
        systemFingerprint: rephrased.systemFingerprint,
        latencyMs: rephrased.latencyMs,
        boundaryReasons: secondBoundary.reasonCodes,
      }),
    };
  }

  return {
    kind: 'payload',
    payload: secondBoundary.acceptedPayload,
    receipt: receipt({
      copyId,
      decision: 'accepted',
      template: approvedTemplate,
      rewrite: secondBoundary.acceptedPayload,
      providerCallCount: 1,
      provider: rephrased.provider,
      requestedModel: rephrased.requestedModel,
      returnedModel: rephrased.returnedModel,
      systemFingerprint: rephrased.systemFingerprint,
      latencyMs: rephrased.latencyMs,
    }),
  };
}
