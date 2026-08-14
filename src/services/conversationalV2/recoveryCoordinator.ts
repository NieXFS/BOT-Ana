import {
  buildSafeWriteConfirmation,
  type ToolTraceLike,
} from '../customerReplyGuard';
import {
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
  toolTraceHasCustomerIdentityAmbiguity,
} from '../customerIdentitySafety';
import type {
  BoundaryEvaluation,
  BoundaryReasonCodeV2,
  DeliveryPreemptionV2,
  ModelTurnResultV2,
  PendingTransitionCandidate,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import {
  evaluateBoundaryV2,
  type BoundaryEvaluationInputV2,
} from './boundary';
import type { ModelTurnResultV2ParseResult } from './modelResultParser';
import type { RegenerationResultV2 } from './regenerator';
import { opaqueReceiptHashV2 } from './receipts';
import { buildPendingQuestionV2 } from './pendingQuestion';

export const CATALOG_UNAVAILABLE_FALLBACK_V2 =
  'Não consegui consultar os serviços agora. Pode tentar novamente em instantes?';
export const NEUTRAL_CLARIFICATION_FALLBACK_V2 =
  'Não consegui confirmar com segurança. Pode me dizer novamente o que você prefere?';
export const MINIMAL_CLARIFICATION_FALLBACK_V2 =
  'Pode me dizer novamente o que você prefere?';
export const ALTERNATE_CLARIFICATION_FALLBACK_V2 =
  'Pode explicar de outro jeito o que você prefere?';

type BoundaryContextV2 = Omit<
  BoundaryEvaluationInputV2,
  | 'rawCandidate'
  | 'flowState'
  | 'pendingTransitionCandidate'
  | 'unknownServiceEvidence'
  | 'replyPurpose'
  | 'source'
  | 'serviceRelistExempt'
>;

export interface RecoveryCoordinatorInputV2 {
  frame: TurnFrameV2;
  primaryResult: ModelTurnResultV2ParseResult;
  /** Prosa final sem envelope; só pode virar copy segura + PRESERVE. */
  unparsedCandidate?: string;
  boundaryContext: BoundaryContextV2;
  toolTrace: ToolTraceLike[];
  preemption?: DeliveryPreemptionV2;
  canonicalPendingQuestion?: string;
  regenerate: (
    reasonCodes: readonly BoundaryReasonCodeV2[]
  ) => Promise<RegenerationResultV2>;
  /** Rechecks de corrida imediatamente antes/depois da completion no-tools. */
  beforeRegenerate?: () => Promise<DeliveryPreemptionV2 | null>;
  afterRegenerate?: () => Promise<DeliveryPreemptionV2 | null>;
  /** Hook diagnóstico injetável pelo harness; produção não o configura. */
  onRejectedBoundaryCandidate?: (input: {
    stage: 'primary' | 'regen';
    candidate: string;
    reasonCodes: readonly BoundaryReasonCodeV2[];
  }) => void;
}

export interface RecoveryBoundaryAttemptV2 {
  index: number;
  candidateHash: string;
  evaluation: BoundaryEvaluation;
}

export type RecoveryCoordinatorResultV2 =
  | {
      status: 'preempted';
      preemption: DeliveryPreemptionV2;
      payload: null;
      recoveryKind: 'direct_fallback';
      regenCount: 0 | 1;
      boundaryAttempts: RecoveryBoundaryAttemptV2[];
    }
  | {
      status: 'accepted';
      payload: string;
      recoveryKind:
        | 'none'
        | 'regen'
        | 'canonical_write_confirmation'
        | 'direct_fallback';
      regenCount: 0 | 1;
      pendingTransitionCandidate: PendingTransitionCandidate;
      /** Só uma prova já validada pelo parser pode alcançar o flowState. */
      resolutionProof: ResolutionProof | null;
      boundaryAttempts: RecoveryBoundaryAttemptV2[];
    };

function fallbackCandidate(
  input: RecoveryCoordinatorInputV2,
  safeWriteConfirmation: string | null
): { text: string; pendingQuestion: boolean } {
  if (toolTraceHasCustomerIdentityAmbiguity(input.toolTrace)) {
    return { text: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE, pendingQuestion: false };
  }
  if (safeWriteConfirmation) {
    return { text: safeWriteConfirmation, pendingQuestion: false };
  }
  const pending =
    input.canonicalPendingQuestion?.trim() ||
    buildPendingQuestionV2({
      pending: input.frame.pending,
      flowState: input.frame.flowState,
      catalog: input.boundaryContext.servicesResult,
    });
  const recent = new Set(
    (input.boundaryContext.recentAssistantReplies ?? []).map((reply) =>
      reply
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
  );
  const wasJustDelivered = (candidate: string): boolean =>
    recent.has(
      candidate
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  if (
    pending &&
    (input.frame.pending?.kind === 'CONFIRMATION' || !wasJustDelivered(pending))
  ) {
    return { text: pending, pendingQuestion: true };
  }
  if (input.frame.catalogState === 'unavailable') {
    return { text: CATALOG_UNAVAILABLE_FALLBACK_V2, pendingQuestion: false };
  }
  const text = [
    NEUTRAL_CLARIFICATION_FALLBACK_V2,
    MINIMAL_CLARIFICATION_FALLBACK_V2,
    ALTERNATE_CLARIFICATION_FALLBACK_V2,
  ].find((candidate) => !wasJustDelivered(candidate)) ??
    ALTERNATE_CLARIFICATION_FALLBACK_V2;
  return { text, pendingQuestion: false };
}

function boundaryAccepted(evaluation: BoundaryEvaluation): boolean {
  return Boolean(
    evaluation.safe &&
      evaluation.originalAccepted &&
      evaluation.acceptedPayload.trim()
  );
}

function asPlainProseCandidate(
  rawCandidate: string | null | undefined
): ModelTurnResultV2 | null {
  const reply = rawCandidate?.trim() ?? '';
  // JSON/cercas malformados nunca são reclassificados como copy. O unwrap e o
  // parser estrito continuam sendo os únicos caminhos para envelopes.
  if (!reply || /[{}\[\]`]/u.test(reply)) return null;
  return {
    schemaVersion: 2,
    reply,
    replyPurpose: 'OPERATIONAL_ANSWER',
    pendingTransitionCandidate: { kind: 'preserve' },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

export async function coordinateRecoveryV2(
  input: RecoveryCoordinatorInputV2
): Promise<RecoveryCoordinatorResultV2> {
  if (input.preemption) {
    return {
      status: 'preempted',
      preemption: input.preemption,
      payload: null,
      recoveryKind: 'direct_fallback',
      regenCount: 0,
      boundaryAttempts: [],
    };
  }

  const boundaryAttempts: RecoveryBoundaryAttemptV2[] = [];
  const evaluate = (
    result: ModelTurnResultV2,
    source: 'GENERATED' | 'CANONICAL',
    serviceRelistExempt = false
  ): BoundaryEvaluation => {
    const evaluation = evaluateBoundaryV2({
      ...input.boundaryContext,
      rawCandidate: result.reply,
      toolTrace: input.toolTrace,
      flowState: input.frame.flowState,
      pendingTransitionCandidate: result.pendingTransitionCandidate,
      unknownServiceEvidence: result.unknownServiceEvidence,
      replyPurpose: result.replyPurpose,
      source,
      serviceRelistExempt,
      route: input.boundaryContext.route ?? 'model',
      pendingAnaOpen:
        input.boundaryContext.pendingAnaOpen ?? input.frame.pending !== null,
      pendingSnapshot:
        input.boundaryContext.pendingSnapshot ?? input.frame.pending,
    });
    boundaryAttempts.push({
      index: boundaryAttempts.length,
      // Campo normativo de recibo: sempre SHA-256 completo. `technicalHash`
      // permanece próprio para correlação curta em logs fora dos recibos.
      candidateHash: opaqueReceiptHashV2(result.reply),
      evaluation,
    });
    return evaluation;
  };

  const safeWriteConfirmation = buildSafeWriteConfirmation(input.toolTrace);
  const primaryModelResult = input.primaryResult.ok
    ? input.primaryResult.value
    : null;

  const primaryEvaluation = primaryModelResult
    ? evaluate(primaryModelResult, 'GENERATED')
    : null;
  if (primaryEvaluation && !boundaryAccepted(primaryEvaluation)) {
    input.onRejectedBoundaryCandidate?.({
      stage: 'primary',
      candidate: primaryModelResult!.reply,
      reasonCodes: primaryEvaluation.reasonCodes,
    });
  }
  if (primaryEvaluation && boundaryAccepted(primaryEvaluation)) {
    return {
      status: 'accepted',
      payload: primaryEvaluation.acceptedPayload,
      recoveryKind: 'none',
      regenCount: 0,
      pendingTransitionCandidate: primaryModelResult!.pendingTransitionCandidate,
      resolutionProof: input.primaryResult.ok
        ? input.primaryResult.resolutionProof
        : null,
      boundaryAttempts,
    };
  }

  // Um reducer tipado pode já ter produzido a confirmação canônica como
  // primaryResult e, nesse caso, mantém recoveryKind=none. Fora desse caso, o
  // evento de write é soberano sobre qualquer copy do modelo — inclusive
  // prosa segura sem envelope — e a confirmação nasce apenas do success:true.
  if (safeWriteConfirmation) {
    const canonicalResult: ModelTurnResultV2 = {
      schemaVersion: 2,
      reply: safeWriteConfirmation,
      replyPurpose: 'WRITE_CONFIRMATION',
      pendingTransitionCandidate:
        primaryModelResult?.pendingTransitionCandidate ?? { kind: 'preserve' },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    };
    const canonicalEvaluation = evaluate(canonicalResult, 'CANONICAL');
    if (!boundaryAccepted(canonicalEvaluation)) {
      throw new Error('Confirmação canônica de write rejeitada pela boundary v2.');
    }
    return {
      status: 'accepted',
      payload: canonicalEvaluation.acceptedPayload,
      recoveryKind: 'canonical_write_confirmation',
      regenCount: 0,
      pendingTransitionCandidate: canonicalResult.pendingTransitionCandidate,
      resolutionProof: null,
      boundaryAttempts,
    };
  }

  const plainProseCandidate = !primaryModelResult
    ? asPlainProseCandidate(input.unparsedCandidate)
    : null;
  const proseEvaluation = plainProseCandidate
    ? evaluate(plainProseCandidate, 'GENERATED')
    : null;
  if (proseEvaluation && !boundaryAccepted(proseEvaluation)) {
    input.onRejectedBoundaryCandidate?.({
      stage: 'primary',
      candidate: plainProseCandidate!.reply,
      reasonCodes: proseEvaluation.reasonCodes,
    });
  }
  if (proseEvaluation && boundaryAccepted(proseEvaluation)) {
    return {
      status: 'accepted',
      payload: proseEvaluation.acceptedPayload,
      recoveryKind: 'none',
      regenCount: 0,
      pendingTransitionCandidate: { kind: 'preserve' },
      resolutionProof: null,
      boundaryAttempts,
    };
  }

  const firstReasons: BoundaryReasonCodeV2[] = primaryEvaluation
    ? primaryEvaluation.reasonCodes
    : proseEvaluation && !boundaryAccepted(proseEvaluation)
      ? proseEvaluation.reasonCodes
    : ['MODEL_RESULT_INVALID'];
  const beforeRegenPreemption = await input.beforeRegenerate?.();
  if (beforeRegenPreemption) {
    return {
      status: 'preempted',
      preemption: beforeRegenPreemption,
      payload: null,
      recoveryKind: 'direct_fallback',
      regenCount: 0,
      boundaryAttempts,
    };
  }
  const regenerated = await input.regenerate(firstReasons);
  const afterRegenPreemption = await input.afterRegenerate?.();
  if (afterRegenPreemption) {
    return {
      status: 'preempted',
      preemption: afterRegenPreemption,
      payload: null,
      recoveryKind: 'direct_fallback',
      regenCount: 1,
      boundaryAttempts,
    };
  }
  if (regenerated.ok) {
    const regeneratedEvaluation = evaluate(regenerated.result, 'GENERATED');
    if (boundaryAccepted(regeneratedEvaluation)) {
      return {
        status: 'accepted',
        payload: regeneratedEvaluation.acceptedPayload,
        recoveryKind: 'regen',
        regenCount: 1,
        pendingTransitionCandidate:
          regenerated.result.pendingTransitionCandidate,
        resolutionProof: regenerated.resolutionProof,
        boundaryAttempts,
      };
    }
    input.onRejectedBoundaryCandidate?.({
      stage: 'regen',
      candidate: regenerated.result.reply,
      reasonCodes: regeneratedEvaluation.reasonCodes,
    });
  } else if (regenerated.reasonCode === 'REGEN_MODEL_RESULT_INVALID') {
    const regeneratedProse = asPlainProseCandidate(regenerated.rawReply);
    const regeneratedProseEvaluation = regeneratedProse
      ? evaluate(regeneratedProse, 'GENERATED')
      : null;
    if (
      regeneratedProseEvaluation &&
      boundaryAccepted(regeneratedProseEvaluation)
    ) {
      return {
        status: 'accepted',
        payload: regeneratedProseEvaluation.acceptedPayload,
        recoveryKind: 'regen',
        regenCount: 1,
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionProof: null,
        boundaryAttempts,
      };
    }
    if (regeneratedProse && regeneratedProseEvaluation) {
      input.onRejectedBoundaryCandidate?.({
        stage: 'regen',
        candidate: regeneratedProse.reply,
        reasonCodes: regeneratedProseEvaluation.reasonCodes,
      });
    }
  }

  const directedFallback = fallbackCandidate(input, null);
  const fallbackTransition = input.frame.pending
    ? ({ kind: 'preserve' } as const)
    : primaryModelResult?.pendingTransitionCandidate ?? ({ kind: 'preserve' } as const);
  const fallbackResult: ModelTurnResultV2 = {
    schemaVersion: 2,
    reply: directedFallback.text,
    replyPurpose: 'CLARIFICATION',
    pendingTransitionCandidate: fallbackTransition,
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
  let fallbackEvaluation = evaluate(
    fallbackResult,
    'CANONICAL',
    directedFallback.pendingQuestion
  );
  if (!boundaryAccepted(fallbackEvaluation)) {
    const rejectedFallback = fallbackResult.reply;
    fallbackResult.reply = [
      MINIMAL_CLARIFICATION_FALLBACK_V2,
      ALTERNATE_CLARIFICATION_FALLBACK_V2,
      NEUTRAL_CLARIFICATION_FALLBACK_V2,
    ].find(
      (candidate) =>
        candidate !== rejectedFallback &&
        !(input.boundaryContext.recentAssistantReplies ?? []).some(
          (reply) => reply.trim() === candidate.trim()
        )
    ) ?? ALTERNATE_CLARIFICATION_FALLBACK_V2;
    fallbackResult.pendingTransitionCandidate = { kind: 'preserve' };
    fallbackEvaluation = evaluate(fallbackResult, 'CANONICAL');
  }
  if (!boundaryAccepted(fallbackEvaluation)) {
    throw new Error('Fallback canônico v2 rejeitado pela própria boundary.');
  }
  return {
    status: 'accepted',
    payload: fallbackEvaluation.acceptedPayload,
    recoveryKind: 'direct_fallback',
    regenCount: 1,
    pendingTransitionCandidate: fallbackResult.pendingTransitionCandidate,
    resolutionProof: null,
    boundaryAttempts,
  };
}
