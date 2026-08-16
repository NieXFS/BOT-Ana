import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import {
  getCustomerUpcomingAppointmentsV2,
  type UpcomingAppointment,
} from './calendarService';
import { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from './customerIdentitySafety';
import {
  cancellationFingerprintV2,
  CANCEL_WRITE_FAILURE_COPY_V2,
  CANCEL_WRITE_SUCCESS_COPY_V2,
  effectiveCancellationDispositionV2,
} from './conversationalV2/cancellationFlowV2';
import type {
  CancellationCandidateV2,
  CancellationFlowV2,
  CancellationTargetTokenV2,
  DeliveryPreemptionV2,
  PendingFrameSnapshotV2,
} from './conversationalV2/contracts';
import {
  runtimeErrorKind,
  safeHttpStatus,
} from '../observability/safeRuntime';
import { ERP_API_TOKEN } from '../erpApiToken';

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';

export interface CancelAppointmentV2Payload {
  tenantSlug: string;
  customerPhone: string;
  appointmentId: string;
}

export interface CancelAppointmentV2AuthorizedDeps {
  getUpcomingAppointments: typeof getCustomerUpcomingAppointmentsV2;
  postCancel: (payload: CancelAppointmentV2Payload) => Promise<void>;
  normalizeCustomerPhone: (phone: string) => string;
}

export type CancelAppointmentV2AuthorizedResult = {
  success: boolean;
  message: string;
  posted: boolean;
  reason?:
    | 'customer_identity_ambiguous'
    | 'pending_invalid'
    | 'candidate_missing'
    | 'target_removed'
    | 'fingerprint_mismatch'
    | 'disposition_denied'
    | 'executor_error'
    | 'preempted';
  preemption?: DeliveryPreemptionV2;
};

function normalizeCustomerPhone(phone: string): string {
  const sanitized = phone.trim();
  if (!sanitized) return sanitized;
  return sanitized.startsWith('+') ? sanitized : `+${sanitized}`;
}

const defaultDeps: CancelAppointmentV2AuthorizedDeps = {
  getUpcomingAppointments: getCustomerUpcomingAppointmentsV2,
  postCancel: async (payload) => {
    await axios.post(`${ERP_BASE_URL}/api/v1/agenda/cancel`, payload, {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
  },
  normalizeCustomerPhone,
};

function selectedCandidateV2(
  pending: PendingFrameSnapshotV2 | null,
  flow: CancellationFlowV2 | undefined,
  token: CancellationTargetTokenV2
): CancellationCandidateV2 | null {
  if (
    !pending ||
    pending.kind !== 'CANCEL_CONFIRMATION' ||
    !flow ||
    pending.flowId !== flow.flowId ||
    pending.options.length !== 1 ||
    pending.options[0]?.entityId !== token ||
    flow.selectedToken !== token
  ) {
    return null;
  }
  return flow.candidates.find((candidate) => candidate.token === token) ?? null;
}

function matchingRereadV2(
  appointment: UpcomingAppointment,
  candidate: CancellationCandidateV2
): { ok: true } | { ok: false; reason: CancelAppointmentV2AuthorizedResult['reason'] } {
  if (appointment.id !== candidate.appointmentId) {
    return { ok: false, reason: 'target_removed' };
  }
  if (appointment.startTime !== candidate.startTime) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  const fingerprint = cancellationFingerprintV2(appointment);
  if (fingerprint !== candidate.fingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  const disposition = effectiveCancellationDispositionV2(
    appointment.cancellationDisposition
  );
  if (disposition !== 'AUTO_CANCEL_ALLOWED') {
    return { ok: false, reason: 'disposition_denied' };
  }
  if (candidate.disposition !== 'AUTO_CANCEL_ALLOWED') {
    return { ok: false, reason: 'disposition_denied' };
  }
  return { ok: true };
}

/**
 * Write v2 de cancelamento. Telefone vem só do inbound autenticado. Não usa
 * cancellationIntentGate nem o cancelAppointment legado.
 */
export async function cancelAppointmentV2Authorized(input: {
  phone: string;
  config: TenantBotConfig;
  pending: PendingFrameSnapshotV2 | null;
  flow: CancellationFlowV2 | undefined;
  token: CancellationTargetTokenV2;
  deps?: Partial<CancelAppointmentV2AuthorizedDeps>;
  /** Recheck de corrida imediatamente antes do POST, após releitura autoritativa. */
  beforeCancelPost?: () => Promise<DeliveryPreemptionV2 | null>;
}): Promise<CancelAppointmentV2AuthorizedResult> {
  const deps: CancelAppointmentV2AuthorizedDeps = {
    ...defaultDeps,
    ...input.deps,
  };
  const phone = input.phone.trim();
  if (!phone) {
    return {
      success: false,
      posted: false,
      message: CANCEL_WRITE_FAILURE_COPY_V2,
      reason: 'pending_invalid',
    };
  }
  const candidate = selectedCandidateV2(input.pending, input.flow, input.token);
  if (!candidate) {
    return {
      success: false,
      posted: false,
      message: CANCEL_WRITE_FAILURE_COPY_V2,
      reason: 'pending_invalid',
    };
  }

  const upcoming = await deps.getUpcomingAppointments(phone, input.config);
  if (!upcoming.success) {
    return {
      success: false,
      posted: false,
      reason: upcoming.reason === 'customer_identity_ambiguous'
        ? 'customer_identity_ambiguous'
        : 'executor_error',
      message:
        upcoming.reason === 'customer_identity_ambiguous'
          ? CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
          : CANCEL_WRITE_FAILURE_COPY_V2,
    };
  }

  const appointments = upcoming.appointments ?? [];
  const reread = appointments.find(
    (appointment) => appointment.id === candidate.appointmentId
  );
  if (!reread) {
    return {
      success: false,
      posted: false,
      message: CANCEL_WRITE_FAILURE_COPY_V2,
      reason: 'target_removed',
    };
  }
  const identity = matchingRereadV2(reread, candidate);
  if (!identity.ok) {
    return {
      success: false,
      posted: false,
      message: CANCEL_WRITE_FAILURE_COPY_V2,
      reason: identity.reason,
    };
  }

  if (input.beforeCancelPost) {
    const preemption = await input.beforeCancelPost();
    if (preemption) {
      return {
        success: false,
        posted: false,
        message: CANCEL_WRITE_FAILURE_COPY_V2,
        reason: 'preempted',
        preemption,
      };
    }
  }

  try {
    await deps.postCancel({
      tenantSlug: input.config.tenantSlug,
      customerPhone: deps.normalizeCustomerPhone(phone),
      appointmentId: candidate.appointmentId,
    });
    return {
      success: true,
      posted: true,
      message: CANCEL_WRITE_SUCCESS_COPY_V2,
    };
  } catch (err) {
    const data = axios.isAxiosError(err)
      ? (err.response?.data as
          | { reason?: unknown; code?: unknown; error?: unknown }
          | undefined)
      : undefined;
    if (data?.reason === 'customer_identity_ambiguous') {
      return {
        success: false,
        posted: true,
        reason: 'customer_identity_ambiguous',
        message: CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
      };
    }
    if (
      axios.isAxiosError(err) &&
      err.response?.status === 422 &&
      data?.code === 'CANCEL_DISPOSITION_DENIED'
    ) {
      return {
        success: false,
        posted: true,
        reason: 'disposition_denied',
        message: CANCEL_WRITE_FAILURE_COPY_V2,
      };
    }
    console.error(
      `❌ Erro ao cancelar agendamento v2 no ERP | error=${runtimeErrorKind(err)} | status=${safeHttpStatus(err) ?? 'n/a'}`
    );
    return {
      success: false,
      posted: true,
      reason: 'executor_error',
      message: CANCEL_WRITE_FAILURE_COPY_V2,
    };
  }
}
