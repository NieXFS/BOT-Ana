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
  UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2,
  type BoundaryEvaluationInputV2,
} from './boundary';
import type { ModelTurnResultV2ParseResult } from './modelResultParser';
import type { RegenerationResultV2 } from './regenerator';
import { opaqueReceiptHashV2 } from './receipts';
import { buildPendingQuestionV2 } from './pendingQuestion';
import type { RecoveryFallbackIntentV2 } from './recoveryFallbackIntent';
import { closedReasonCodesV2 } from './divergence';
import { isDeferredAvailabilityConsumableV2 } from './serviceContext';

export const CATALOG_UNAVAILABLE_FALLBACK_V2 =
  'Não consegui consultar os serviços agora. Pode tentar novamente em instantes?';
export const ANSWER_TO_PENDING_FALLBACK_V2 =
  'Não consegui confirmar com segurança. Pode me dizer novamente o que você prefere?';
export const INFORMATION_QUESTION_FALLBACK_V2 =
  'Não consegui te responder direito agora. Pode fazer a pergunta de outro jeito?';
export const TRANSACTION_REQUEST_FALLBACK_V2 =
  'Não consegui concluir isso com segurança. Pode me dizer de outro jeito o que você quer fazer?';
export const OTHER_FALLBACK_V2 =
  'Não consegui entender com segurança. Pode explicar de outro jeito?';
export const EMPTY_OPEN_SERVICE_CLARIFICATION_V2 =
  'Não achei esse nome na nossa lista. Você sabe se o serviço tem outro nome?';
export const VISIBLE_HANDOFF_CANONICAL_V2 =
  'Não consigo responder isso com segurança por aqui. Você pode falar diretamente com a equipe do estabelecimento.';

type BoundaryContextV2 = Omit<
  BoundaryEvaluationInputV2,
  | 'rawCandidate'
  | 'flowState'
  | 'pendingTransitionCandidate'
  | 'unknownServiceEvidence'
  | 'replyPurpose'
  | 'source'
  | 'exactCanonicalServiceListText'
>;

export interface RecoveryCoordinatorInputV2 {
  frame: TurnFrameV2;
  primaryResult: ModelTurnResultV2ParseResult;
  /** Prosa final sem envelope; só pode virar copy segura + PRESERVE. */
  unparsedCandidate?: string;
  boundaryContext: BoundaryContextV2;
  toolTrace: ToolTraceLike[];
  fallbackIntent: RecoveryFallbackIntentV2;
  preemption?: DeliveryPreemptionV2;
  canonicalPendingQuestion?: string;
  /** Relógio do turno; default `new Date()` só para smokes isolados do coordenador. */
  now?: Date;
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
    }
  | {
      status: 'silent_escalation';
      payload: null;
      recoveryKind: 'silent_escalation';
      regenCount: 0 | 1;
      fallbackIntent: RecoveryFallbackIntentV2;
      primaryReasonCodes: BoundaryReasonCodeV2[];
      regenerationReasonCodes: BoundaryReasonCodeV2[];
      pendingTransitionCandidate: PendingTransitionCandidate;
      resolutionProof: null;
      boundaryAttempts: RecoveryBoundaryAttemptV2[];
    }
  | {
      status: 'visible_escalation';
      payload: string;
      recoveryKind: 'visible_escalation';
      regenCount: 0 | 1;
      fallbackIntent: RecoveryFallbackIntentV2;
      primaryReasonCodes: BoundaryReasonCodeV2[];
      regenerationReasonCodes: BoundaryReasonCodeV2[];
      pendingTransitionCandidate: PendingTransitionCandidate;
      resolutionProof: null;
      boundaryAttempts: RecoveryBoundaryAttemptV2[];
    };

type FallbackDecisionV2 =
  | { kind: 'copy'; text: string }
  | { kind: 'silent_escalation' }
  | { kind: 'visible_escalation'; text: string };

export function isEmptyOpenServicePendingWithConsumableDeferredV2(
  frame: TurnFrameV2,
  now: Date
): boolean {
  const pending = frame.pending;
  if (!pending || pending.kind !== 'SERVICE') return false;
  if (pending.options.length !== 0) return false;
  if (pending.flowId !== frame.flowState.flowId) return false;
  return isDeferredAvailabilityConsumableV2(
    frame.flowState.deferredAvailability,
    frame.flowState.flowId,
    now
  );
}

function overlayCanonicalUnknownServiceDenialV2(
  result: ModelTurnResultV2,
  frame: TurnFrameV2,
  now: Date
): ModelTurnResultV2 | null {
  if (!result.unknownServiceEvidence) return null;
  if (!isEmptyOpenServicePendingWithConsumableDeferredV2(frame, now)) {
    return null;
  }
  return {
    schemaVersion: 2,
    reply: UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2,
    replyPurpose: 'OPERATIONAL_ANSWER',
    pendingTransitionCandidate: { kind: 'preserve' },
    resolutionCandidate: null,
    unknownServiceEvidence: result.unknownServiceEvidence,
  };
}

function fallbackCandidate(
  input: RecoveryCoordinatorInputV2,
  safeWriteConfirmation: string | null
): FallbackDecisionV2 {
  if (toolTraceHasCustomerIdentityAmbiguity(input.toolTrace)) {
    return { kind: 'copy', text: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE };
  }
  if (safeWriteConfirmation) {
    return { kind: 'copy', text: safeWriteConfirmation };
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
  const now = input.now ?? new Date();
  // A valid answer to a live TIME question is still an active booking turn.
  // If model and regeneration both fail, do not let the generic OTHER path
  // turn that turn into an accidental silent escalation. Re-anchor the
  // canonical question (which names the fixed service/date) or take the
  // recorded visible-handoff path when the state is no longer renderable.
  if (
    input.fallbackIntent === 'ANSWER_TO_PENDING' &&
    input.frame.pending?.kind === 'TIME' &&
    input.frame.pending.flowId === input.frame.flowState.flowId
  ) {
    const reanchored = buildPendingQuestionV2({
      pending: input.frame.pending,
      flowState: input.frame.flowState,
      catalog: input.boundaryContext.servicesResult,
      reanchor: true,
    });
    if (reanchored?.trim() && !wasJustDelivered(reanchored)) {
      return { kind: 'copy', text: reanchored };
    }
    return { kind: 'visible_escalation', text: VISIBLE_HANDOFF_CANONICAL_V2 };
  }
  if (isEmptyOpenServicePendingWithConsumableDeferredV2(input.frame, now)) {
    if (
      wasJustDelivered(EMPTY_OPEN_SERVICE_CLARIFICATION_V2) ||
      wasJustDelivered(VISIBLE_HANDOFF_CANONICAL_V2)
    ) {
      return { kind: 'visible_escalation', text: VISIBLE_HANDOFF_CANONICAL_V2 };
    }
    return { kind: 'copy', text: EMPTY_OPEN_SERVICE_CLARIFICATION_V2 };
  }
  // OTHER é a fala sem testemunha suficiente: com PendingFrame OPEN ela é o
  // caso genuinamente ambíguo. Pergunta/transação nova preserva o estado sem
  // repetir a moldura antiga na mensagem. A moldura pendente NÃO é
  // reformulação — só vira silêncio quando a pergunta acabou de ser entregue.
  const relatesToPending =
    input.fallbackIntent === 'ANSWER_TO_PENDING' ||
    input.fallbackIntent === 'OTHER';
  if (
    pending &&
    relatesToPending &&
    (input.frame.pending?.kind === 'CONFIRMATION' || !wasJustDelivered(pending))
  ) {
    return { kind: 'copy', text: pending };
  }
  const catalogUnavailableIsMaterial =
    input.frame.catalogState === 'unavailable' &&
    (input.fallbackIntent !== 'OTHER' || input.frame.pending !== null);
  if (catalogUnavailableIsMaterial) {
    return { kind: 'copy', text: CATALOG_UNAVAILABLE_FALLBACK_V2 };
  }
  return { kind: 'silent_escalation' };
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
    source: 'GENERATED' | 'CANONICAL'
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
  const now = input.now ?? new Date();
  const emptyOpenServicePreserveGenerated = (
    transition: PendingTransitionCandidate
  ): boolean =>
    isEmptyOpenServicePendingWithConsumableDeferredV2(input.frame, now) &&
    transition.kind === 'preserve';

  // Write confirmado é soberano sobre qualquer overlay de serviço desconhecido.
  // Sempre entrega a copy do success:true. recoveryKind=none só quando o
  // reducer já tinha materializado essa mesma copy no primary — o overlay
  // não pode mais trocá-la por negativa.
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
    const primaryAlreadyCanonicalWrite =
      primaryModelResult?.reply.trim() === safeWriteConfirmation.trim();
    return {
      status: 'accepted',
      payload: canonicalEvaluation.acceptedPayload,
      recoveryKind: primaryAlreadyCanonicalWrite
        ? 'none'
        : 'canonical_write_confirmation',
      regenCount: 0,
      pendingTransitionCandidate: canonicalResult.pendingTransitionCandidate,
      resolutionProof:
        primaryAlreadyCanonicalWrite && input.primaryResult.ok
          ? input.primaryResult.resolutionProof
          : null,
      boundaryAttempts,
    };
  }

  const overlaidPrimary = primaryModelResult
    ? overlayCanonicalUnknownServiceDenialV2(primaryModelResult, input.frame, now)
    : null;
  if (overlaidPrimary) {
    const overlaidEvaluation = evaluate(overlaidPrimary, 'CANONICAL');
    if (boundaryAccepted(overlaidEvaluation)) {
      return {
        status: 'accepted',
        payload: overlaidEvaluation.acceptedPayload,
        recoveryKind:
          primaryModelResult!.reply.trim() ===
          UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2
            ? 'none'
            : 'direct_fallback',
        regenCount: 0,
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionProof: null,
        boundaryAttempts,
      };
    }
  }

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
  if (
    primaryEvaluation &&
    boundaryAccepted(primaryEvaluation) &&
    !emptyOpenServicePreserveGenerated(
      primaryModelResult!.pendingTransitionCandidate
    )
  ) {
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
  if (
    proseEvaluation &&
    boundaryAccepted(proseEvaluation) &&
    !emptyOpenServicePreserveGenerated({ kind: 'preserve' })
  ) {
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
  let regenerationReasonCodes: BoundaryReasonCodeV2[] = [];
  if (regenerated.ok) {
    const overlaidRegen = overlayCanonicalUnknownServiceDenialV2(
      regenerated.result,
      input.frame,
      now
    );
    if (overlaidRegen) {
      const overlaidEvaluation = evaluate(overlaidRegen, 'CANONICAL');
      if (boundaryAccepted(overlaidEvaluation)) {
        return {
          status: 'accepted',
          payload: overlaidEvaluation.acceptedPayload,
          recoveryKind: 'direct_fallback',
          regenCount: 1,
          pendingTransitionCandidate: { kind: 'preserve' },
          resolutionProof: null,
          boundaryAttempts,
        };
      }
    }
    const regeneratedEvaluation = evaluate(regenerated.result, 'GENERATED');
    if (
      boundaryAccepted(regeneratedEvaluation) &&
      !emptyOpenServicePreserveGenerated(
        regenerated.result.pendingTransitionCandidate
      )
    ) {
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
    regenerationReasonCodes = [...regeneratedEvaluation.reasonCodes];
    input.onRejectedBoundaryCandidate?.({
      stage: 'regen',
      candidate: regenerated.result.reply,
      reasonCodes: regeneratedEvaluation.reasonCodes,
    });
  } else if (regenerated.reasonCode === 'REGEN_MODEL_RESULT_INVALID') {
    regenerationReasonCodes = ['REGEN_MODEL_RESULT_INVALID'];
    const regeneratedProse = asPlainProseCandidate(regenerated.rawReply);
    const regeneratedProseEvaluation = regeneratedProse
      ? evaluate(regeneratedProse, 'GENERATED')
      : null;
    if (
      regeneratedProseEvaluation &&
      boundaryAccepted(regeneratedProseEvaluation) &&
      !emptyOpenServicePreserveGenerated({ kind: 'preserve' })
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
      regenerationReasonCodes = [...regeneratedProseEvaluation.reasonCodes];
      input.onRejectedBoundaryCandidate?.({
        stage: 'regen',
        candidate: regeneratedProse.reply,
        reasonCodes: regeneratedProseEvaluation.reasonCodes,
      });
    }
  } else {
    regenerationReasonCodes = [regenerated.reasonCode];
  }

  const fallbackTransition = input.frame.pending
    ? ({ kind: 'preserve' } as const)
    : primaryModelResult?.pendingTransitionCandidate ?? ({ kind: 'preserve' } as const);
  const silentEscalation = (): RecoveryCoordinatorResultV2 => ({
    status: 'silent_escalation',
    payload: null,
    recoveryKind: 'silent_escalation',
    regenCount: 1,
    fallbackIntent: input.fallbackIntent,
    primaryReasonCodes: closedReasonCodesV2(firstReasons),
    regenerationReasonCodes: closedReasonCodesV2(regenerationReasonCodes),
    pendingTransitionCandidate: fallbackTransition,
    resolutionProof: null,
    boundaryAttempts,
  });

  const directedFallback = fallbackCandidate(input, null);
  if (directedFallback.kind === 'silent_escalation') {
    return silentEscalation();
  }
  const fallbackResult: ModelTurnResultV2 = {
    schemaVersion: 2,
    reply: directedFallback.text,
    replyPurpose: 'CLARIFICATION',
    pendingTransitionCandidate: fallbackTransition,
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
  const fallbackEvaluation = evaluate(fallbackResult, 'CANONICAL');
  if (!boundaryAccepted(fallbackEvaluation)) {
    if (directedFallback.kind === 'visible_escalation') {
      throw new Error(
        'Copy canônica de handoff visível rejeitada pela boundary v2.'
      );
    }
    return silentEscalation();
  }
  if (directedFallback.kind === 'visible_escalation') {
    return {
      status: 'visible_escalation',
      payload: fallbackEvaluation.acceptedPayload,
      recoveryKind: 'visible_escalation',
      regenCount: 1,
      fallbackIntent: input.fallbackIntent,
      primaryReasonCodes: closedReasonCodesV2(firstReasons),
      regenerationReasonCodes: closedReasonCodesV2(regenerationReasonCodes),
      pendingTransitionCandidate: fallbackResult.pendingTransitionCandidate,
      resolutionProof: null,
      boundaryAttempts,
    };
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
