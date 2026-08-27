import type { TenantBotConfig } from '../../configProvider';
import type {
  ReceptionistModelLoopResult,
  ReceptionistToolTraceEntry,
} from '../brainService';
import {
  cancelAppointmentV2Authorized,
  type CancelAppointmentV2AuthorizedDeps,
} from '../cancelAppointmentV2Authorized';
import { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from '../customerIdentitySafety';
import {
  escalateCancelHumanReviewV2,
  type EscalationDeps,
  type ReceptionistEscalationV2Decision,
} from '../questionEscalation';
import type { UpcomingAppointment } from '../calendarService';
import type {
  CancellationCandidateV2,
  CancellationFlowV2,
  DeliveryPreemptionV2,
  FlowStateV2,
  GateDeclineV2,
  ModelTurnResultV2,
  PendingTransitionCandidate,
  TurnFrameV2,
} from './contracts';
import type { CurrentDateResolutionV2 } from './currentDateResolution';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';
import {
  buildCancelConfirmationCopyV2,
  buildCancelTargetUnavailableCopyV2,
  CANCEL_AMBIGUOUS_REFERENCE_COPY_V2,
  CANCEL_HUMAN_REVIEW_FALLBACK_COPY_V2,
  CANCEL_WRITE_FAILURE_COPY_V2,
  CANCEL_WRITE_SUCCESS_COPY_V2,
  candidatesFromUpcomingAppointmentsV2,
  detectPositiveCancellationIntentV2,
  isCancellationPendingKindV2,
  planCancellationIntentV2,
} from './cancellationFlowV2';
import { canonicalReadFailureCopyV2 } from './readFastPaths';
import { stampFlowOperationalActivityV2 } from './flowSession';

export type CancellationPlannerFastPathV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'preempted';
      preemption: DeliveryPreemptionV2;
      loop: ReceptionistModelLoopResult;
    }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      loop: ReceptionistModelLoopResult;
      proof: null;
      nextFlowState: FlowStateV2;
      authoritativeEscalationQuestionId?: string;
      actionRecorded?: boolean;
      refreshOperationalAt?: boolean;
    };

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function loopForTraces(
  traces: readonly ReceptionistToolTraceEntry[]
): ReceptionistModelLoopResult {
  return {
    rawReply: null,
    exhausted: false,
    provider: 'openai',
    model: 'cancel-planner-v2',
    providerReportedModels: [],
    rounds: 0,
    messages: [],
    toolTrace: [...traces],
    usage: [],
  };
}

function upcomingTrace(raw: string): ReceptionistToolTraceEntry {
  return {
    round: 0,
    name: 'getUpcomingAppointments',
    args: {},
    argumentsValidJson: true,
    result: raw,
  };
}

function cancelTrace(result: string): ReceptionistToolTraceEntry {
  return {
    round: 0,
    name: 'cancelAppointment',
    args: {},
    argumentsValidJson: true,
    result,
  };
}

function resultV2(
  reply: string,
  purpose: ModelTurnResultV2['replyPurpose'],
  pendingTransitionCandidate: PendingTransitionCandidate
): ModelTurnResultV2 {
  return {
    schemaVersion: 2,
    reply,
    replyPurpose: purpose,
    pendingTransitionCandidate,
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
}

function withCancellation(
  flowState: FlowStateV2,
  cancellation: CancellationFlowV2 | undefined,
  now: Date,
  stampActivity = true
): FlowStateV2 {
  const next = cancellation
    ? { ...flowState, cancellation }
    : (() => {
        const { cancellation: _removed, ...rest } = flowState;
        void _removed;
        return rest;
      })();
  return stampActivity ? stampFlowOperationalActivityV2(next, now) : next;
}

function openConfirmationTransition(
  flow: CancellationFlowV2
): PendingTransitionCandidate {
  const token = flow.selectedToken;
  if (!token) return { kind: 'preserve' };
  return {
    kind: 'open',
    pendingKind: 'CANCEL_CONFIRMATION',
    flowId: flow.flowId,
    optionEntityIds: [token],
  };
}

function openTargetListTransition(
  flow: CancellationFlowV2
): PendingTransitionCandidate {
  return {
    kind: 'open',
    pendingKind: 'CANCEL_TARGET',
    flowId: flow.flowId,
    optionEntityIds: flow.candidates.map((candidate) => candidate.token),
  };
}

function resolvePending(frame: TurnFrameV2): PendingTransitionCandidate {
  return frame.pending
    ? { kind: 'resolve', questionId: frame.pending.questionId }
    : { kind: 'preserve' };
}

function parsedUpcoming(
  parsed: Record<string, unknown> | null
): UpcomingAppointment[] | null {
  if (!parsed || parsed.success !== true || !Array.isArray(parsed.appointments)) {
    return null;
  }
  const appointments: UpcomingAppointment[] = [];
  for (const entry of parsed.appointments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const appointment = entry as UpcomingAppointment;
    if (
      typeof appointment.id !== 'string' ||
      typeof appointment.startTime !== 'string' ||
      typeof appointment.endTime !== 'string' ||
      typeof appointment.serviceName !== 'string' ||
      typeof appointment.professionalName !== 'string'
    ) {
      return null;
    }
    appointments.push(appointment);
  }
  return appointments;
}

export async function resolveCancellationPlannerV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  dateResolution: CurrentDateResolutionV2;
  config: TenantBotConfig;
  now: Date;
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null;
  openingAcceptedDelivery?: AcceptedDeliveryEvidenceV2 | null;
  phone: string;
  inboundId: string;
  forcePlan?: boolean;
  executeUpcomingRead: () => Promise<string>;
  cancelAuthorized?: typeof cancelAppointmentV2Authorized;
  cancelDeps?: Partial<CancelAppointmentV2AuthorizedDeps>;
  beforeCancelPost?: () => Promise<DeliveryPreemptionV2 | null>;
  escalateHumanReview?: typeof escalateCancelHumanReviewV2;
  escalateDeps?: EscalationDeps;
  onGateDecline?: (decline: GateDeclineV2) => void;
}): Promise<CancellationPlannerFastPathV2> {
  const pending = input.frame.pending;
  const cancelPending = isCancellationPendingKindV2(pending?.kind);
  const cancelIntent =
    input.forcePlan === true ||
    detectPositiveCancellationIntentV2(input.inboundText);
  if (!cancelPending && !cancelIntent) {
    return { kind: 'continue_model', reason: 'no_cancellation_intent' };
  }

  let candidates: CancellationCandidateV2[] | null = null;
  const traces: ReceptionistToolTraceEntry[] = [];
  const needsRead =
    cancelIntent ||
    pending?.kind === 'CANCEL_TARGET' ||
    pending?.kind === 'CANCEL_CONFIRMATION';
  if (needsRead) {
    const raw = await input.executeUpcomingRead();
    traces.push(upcomingTrace(raw));
    const parsed = parseObject(raw);
    if (parsed?.reason === 'customer_identity_ambiguous') {
      return {
        kind: 'resolved',
        result: resultV2(
          CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
          'OPERATIONAL_ANSWER',
          { kind: 'preserve' }
        ),
        loop: loopForTraces(traces),
        proof: null,
        nextFlowState: input.frame.flowState,
      };
    }
    if (parsed?.success !== true) {
      return {
        kind: 'resolved',
        result: resultV2(
          canonicalReadFailureCopyV2('upcoming', 'executor_error'),
          'OPERATIONAL_ANSWER',
          { kind: 'preserve' }
        ),
        loop: loopForTraces(traces),
        proof: null,
        nextFlowState: input.frame.flowState,
      };
    }
    const appointments = parsedUpcoming(parsed);
    if (!appointments) {
      return {
        kind: 'resolved',
        result: resultV2(
          canonicalReadFailureCopyV2('upcoming', 'invalid_payload'),
          'OPERATIONAL_ANSWER',
          { kind: 'preserve' }
        ),
        loop: loopForTraces(traces),
        proof: null,
        nextFlowState: input.frame.flowState,
      };
    }
    candidates = candidatesFromUpcomingAppointmentsV2(
      appointments,
      input.config.timezone
    );
  }

  const plan = planCancellationIntentV2({
    currentInboundBatchText: input.inboundText,
    dateResolution: input.dateResolution,
    timezone: input.config.timezone,
    now: input.now,
    pending: input.frame.pending,
    flowState: input.frame.flowState,
    candidates,
    lastAcceptedDelivery: input.lastAcceptedDelivery,
    openingAcceptedDelivery: input.openingAcceptedDelivery,
    forcePlan: input.forcePlan,
    sourceReadTurnId: input.frame.turnId,
  });

  if (plan.kind === 'none' || plan.kind === 'pure_consult') {
    return { kind: 'continue_model', reason: plan.kind };
  }
  if (plan.kind === 'need_read') {
    return { kind: 'continue_model', reason: 'cancellation_read_required' };
  }

  const resolved = async (
    reply: string,
    purpose: ModelTurnResultV2['replyPurpose'],
    transition: PendingTransitionCandidate,
    nextFlowState: FlowStateV2,
    extra?: {
      authoritativeEscalationQuestionId?: string;
      actionRecorded?: boolean;
      extraTraces?: ReceptionistToolTraceEntry[];
      refreshOperationalAt?: boolean;
    }
  ): Promise<CancellationPlannerFastPathV2> => ({
    kind: 'resolved',
    result: resultV2(reply, purpose, transition),
    loop: loopForTraces([...traces, ...(extra?.extraTraces ?? [])]),
    proof: null,
    nextFlowState,
    ...(extra?.authoritativeEscalationQuestionId
      ? {
          authoritativeEscalationQuestionId:
            extra.authoritativeEscalationQuestionId,
        }
      : {}),
    ...(extra?.actionRecorded ? { actionRecorded: true } : {}),
    ...(extra?.refreshOperationalAt === false
      ? { refreshOperationalAt: false }
      : {}),
  });

  if (plan.kind === 'confirm_write') {
    const cancelAuthorized =
      input.cancelAuthorized ?? cancelAppointmentV2Authorized;
    const write = await cancelAuthorized({
      phone: input.phone,
      config: input.config,
      pending: input.frame.pending,
      flow: plan.flow,
      token: plan.token,
      ...(input.cancelDeps ? { deps: input.cancelDeps } : {}),
      ...(input.beforeCancelPost
        ? { beforeCancelPost: input.beforeCancelPost }
        : {}),
    });
    if (write.reason === 'preempted' && write.preemption) {
      return {
        kind: 'preempted',
        preemption: write.preemption,
        loop: loopForTraces(traces),
      };
    }
    traces.push(
      cancelTrace(
        JSON.stringify({
          success: write.success,
          message: write.message,
          ...(write.reason ? { reason: write.reason } : {}),
          ...(write.class ? { class: write.class } : {}),
          ...(write.outcome ? { outcome: write.outcome } : {}),
          ...(write.writeCommitted === false
            ? { writeCommitted: false }
            : {}),
        })
      )
    );
    if (!write.success) {
      input.onGateDecline?.({
        gate: 'cancellation',
        reason: write.reason ?? 'executor_error',
      });
      return resolved(
        write.reason === 'customer_identity_ambiguous'
          ? CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
          : write.reason === 'target_removed' ||
              write.reason === 'fingerprint_mismatch'
            ? buildCancelTargetUnavailableCopyV2()
            : CANCEL_WRITE_FAILURE_COPY_V2,
        'OPERATIONAL_ANSWER',
        { kind: 'preserve' },
        input.frame.flowState
      );
    }
    return resolved(
      CANCEL_WRITE_SUCCESS_COPY_V2,
      'WRITE_CONFIRMATION',
      resolvePending(input.frame),
      withCancellation(input.frame.flowState, undefined, input.now)
    );
  }

  if (plan.kind === 'confirmation_not_authorized') {
    input.onGateDecline?.({
      gate: 'cancellation',
      reason: plan.reason,
    });
    const selected = plan.flow.candidates.find(
      (candidate) => candidate.token === plan.flow.selectedToken
    );
    const copy = selected
      ? buildCancelConfirmationCopyV2(selected.displayName)
      : CANCEL_AMBIGUOUS_REFERENCE_COPY_V2;
    return resolved(
      copy,
      'WRITE_CONFIRMATION',
      selected
        ? openConfirmationTransition(plan.flow)
        : { kind: 'preserve' },
      withCancellation(input.frame.flowState, plan.flow, input.now)
    );
  }

  if (plan.kind === 'human_review') {
    const escalate = input.escalateHumanReview ?? escalateCancelHumanReviewV2;
    const decision: ReceptionistEscalationV2Decision = await escalate(
      {
        phoneNumberId: input.config.phoneNumberId,
        customerPhone: input.phone,
        messageId: input.inboundId,
        responsibleName: input.config.escalationResponsibleName ?? undefined,
      },
      input.escalateDeps
    );
    const reply =
      decision.matched === true
        ? decision.reply
        : CANCEL_HUMAN_REVIEW_FALLBACK_COPY_V2;
    return resolved(
      reply,
      'OPERATIONAL_ANSWER',
      resolvePending(input.frame),
      withCancellation(input.frame.flowState, undefined, input.now),
      {
        ...(decision.matched === true && decision.questionId
          ? { authoritativeEscalationQuestionId: decision.questionId }
          : {}),
        ...(decision.matched === true && decision.actionRecorded
          ? { actionRecorded: true }
          : {}),
      }
    );
  }

  if (plan.kind === 'not_cancelable') {
    return resolved(
      plan.copy,
      'OPERATIONAL_ANSWER',
      resolvePending(input.frame),
      withCancellation(input.frame.flowState, undefined, input.now)
    );
  }

  if (plan.kind === 'no_upcoming') {
    return resolved(
      plan.copy,
      'OPERATIONAL_ANSWER',
      resolvePending(input.frame),
      withCancellation(input.frame.flowState, undefined, input.now)
    );
  }

  if (plan.kind === 'target_unavailable') {
    return resolved(
      plan.copy,
      'OPERATIONAL_ANSWER',
      resolvePending(input.frame),
      withCancellation(input.frame.flowState, plan.flow, input.now)
    );
  }

  if (plan.kind === 'ambiguous_reference') {
    return resolved(
      plan.copy,
      'CLARIFICATION',
      plan.flow.candidates.length > 0 &&
        plan.flow.candidates.length <= 5 &&
        input.frame.pending?.kind === 'CANCEL_TARGET'
        ? { kind: 'preserve' }
        :       plan.flow.candidates.length > 0 && plan.flow.candidates.length <= 5
          ? openTargetListTransition(plan.flow)
          : { kind: 'preserve' },
      withCancellation(input.frame.flowState, plan.flow, input.now, false),
      { refreshOperationalAt: false }
    );
  }

  if (plan.kind === 'need_datetime') {
    return resolved(
      plan.copy,
      'CLARIFICATION',
      openTargetListTransition(plan.flow),
      withCancellation(input.frame.flowState, plan.flow, input.now)
    );
  }

  if (plan.kind === 'open_target_list') {
    return resolved(
      plan.copy,
      'CLARIFICATION',
      openTargetListTransition(plan.flow),
      withCancellation(input.frame.flowState, plan.flow, input.now)
    );
  }

  return resolved(
    plan.copy,
    'WRITE_CONFIRMATION',
    openConfirmationTransition(plan.flow),
    withCancellation(input.frame.flowState, plan.flow, input.now)
  );
}

export function cancellationBlocksBookingWriteV2(
  flowState: FlowStateV2 | undefined
): boolean {
  return Boolean(flowState?.cancellation);
}
