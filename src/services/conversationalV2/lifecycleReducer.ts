import { buildSafeWriteConfirmation, type ToolTraceLike } from '../customerReplyGuard';
import type { ServicesResult } from '../calendarService';
import type { ReceptionistToolTraceEntry } from '../brainService';
import type {
  BookingDraftV2,
  FlowStateV2,
  ModelTurnResultV2,
  PendingTransitionCandidate,
  TurnFrameV2,
} from './contracts';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';

interface ParsedToolResult {
  success?: unknown;
  slots?: unknown;
  professionalId?: unknown;
}

function parseResult(value: string): ParsedToolResult | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ParsedToolResult)
      : null;
  } catch {
    return null;
  }
}

function normalizedSlot(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const times = normalizeTemporalAssertionsV2(value).filter(
    (assertion) => assertion.kind === 'time'
  );
  return times.length === 1 ? times[0]!.normalized : null;
}

function displayTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return value;
  return match[2] === '00'
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
}

function joinedTimes(slots: readonly string[]): string {
  const displayed = slots.map(displayTime);
  if (displayed.length <= 1) return displayed[0] ?? '';
  return `${displayed.slice(0, -1).join(', ')} e ${displayed.at(-1)}`;
}

/**
 * Copy viva da oferta de slots. Os dois produtores de disponibilidade (o
 * reducer normal e o consumo de disponibilidade adiada) precisam compartilhar
 * o elicitor que o contrato matcher testa. `rawSlots` preserva os bytes do
 * caminho legado de serviceContext, que historicamente transporta HH:MM;
 * o reducer usa a forma humana (18h/18h30).
 */
export function buildSlotOfferCopyV2(input: {
  date: string;
  slots: readonly string[];
  courtesyAcknowledgement?: boolean;
  rawSlots?: boolean;
}): string {
  const slotText = input.rawSlots
    ? input.slots.join(', ')
    : joinedTimes(input.slots);
  const courtesy = input.courtesyAcknowledgement ? 'Obrigada! ' : '';
  return `${courtesy}Encontrei horários para ${displayDateV2(input.date)}: ${slotText}. Qual você prefere?`;
}

function latestSuccessfulSlots(input: {
  toolTrace: readonly ReceptionistToolTraceEntry[];
  services: ServicesResult;
}): {
  serviceId: string;
  professionalId?: string;
  date: string;
  slots: string[];
} | null {
  for (const entry of [...input.toolTrace].reverse()) {
    if (entry.name !== 'getAvailableSlots') continue;
    const parsed = parseResult(entry.result);
    if (parsed?.success !== true || !Array.isArray(parsed.slots)) continue;
    const slots = parsed.slots.map(normalizedSlot);
    if (slots.length === 0 || slots.some((slot) => slot === null)) continue;
    const serviceId =
      typeof entry.args.serviceId === 'string' ? entry.args.serviceId : '';
    const date = typeof entry.args.date === 'string' ? entry.args.date : '';
    const requestedProfessionalId =
      typeof entry.args.professionalId === 'string'
        ? entry.args.professionalId
        : undefined;
    const resultProfessionalId =
      typeof parsed.professionalId === 'string'
        ? parsed.professionalId
        : undefined;
    if (
      requestedProfessionalId &&
      resultProfessionalId &&
      requestedProfessionalId !== resultProfessionalId
    ) {
      continue;
    }
    const service = input.services.services?.find(
      (candidate) => candidate.id === serviceId
    );
    if (!service || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    const active = new Set(
      (input.services.professionals ?? []).map((professional) => professional.id)
    );
    const eligible = service.professionalIds === undefined
      ? [...active]
      : service.professionalIds.filter((id) => active.has(id));
    const professionalId =
      resultProfessionalId ??
      requestedProfessionalId ??
      (eligible.length === 1 ? eligible[0] : undefined);
    if (professionalId && !eligible.includes(professionalId)) continue;
    return {
      serviceId,
      ...(professionalId ? { professionalId } : {}),
      date,
      slots: slots as string[],
    };
  }
  return null;
}

function fixedStateForSlots(
  frame: TurnFrameV2,
  evidence: NonNullable<ReturnType<typeof latestSuccessfulSlots>>,
  preserveDeferredAvailability = false
): FlowStateV2 {
  const serviceChanged = frame.flowState.fixedServiceId !== evidence.serviceId;
  const serviceVersion = serviceChanged
    ? (frame.flowState.fixedByProofVersion.fixedServiceId ?? 0) + 1
    : frame.flowState.fixedByProofVersion.fixedServiceId ?? 1;
  return {
    flowId: frame.flowState.flowId,
    fixedServiceId: evidence.serviceId,
    ...(evidence.professionalId
      ? { fixedProfessionalId: evidence.professionalId }
      : {}),
    resolvedDate: evidence.date,
    slotEvidence: {
      turnId: frame.turnId,
      serviceId: evidence.serviceId,
      ...(evidence.professionalId
        ? { professionalId: evidence.professionalId }
        : {}),
      date: evidence.date,
      slots: evidence.slots,
    },
    fixedByProofVersion: {
      fixedServiceId: serviceVersion,
      ...(evidence.professionalId
        ? { fixedProfessionalId: serviceVersion }
        : {}),
      resolvedDate:
        (frame.flowState.fixedByProofVersion.resolvedDate ?? 0) + 1,
    },
    ...(preserveDeferredAvailability && frame.flowState.deferredAvailability
      ? { deferredAvailability: frame.flowState.deferredAvailability }
      : {}),
  };
}

function resolveCurrentPending(frame: TurnFrameV2): PendingTransitionCandidate {
  return frame.pending
    ? { kind: 'resolve', questionId: frame.pending.questionId }
    : { kind: 'preserve' };
}

export interface LifecycleOverrideV2 {
  result: ModelTurnResultV2;
  nextFlowState: FlowStateV2;
  kind: 'canonical_write' | 'canonical_slots';
}

/**
 * Reducers silenciosos: nenhum deles interpreta a copy. Cada mudança de estado
 * vem de toolTrace tipado e substitui a fala por copy canônica correspondente.
 */
export function reduceToolLifecycleV2(input: {
  frame: TurnFrameV2;
  toolTrace: readonly ReceptionistToolTraceEntry[];
  services: ServicesResult;
  sourceInboundText?: string;
  preserveDeferredAvailability?: boolean;
}): LifecycleOverrideV2 | null {
  const writeConfirmation = buildSafeWriteConfirmation(
    [...input.toolTrace] as ToolTraceLike[]
  );
  if (writeConfirmation) {
    const {
      bookingDraft: _draft,
      slotEvidence: _slots,
      duplicatePreflightClearance: _duplicatePreflightClearance,
      duplicateResolution: _duplicateResolution,
      deferredAvailability: _deferredAvailability,
      ...rest
    } = input.frame.flowState;
    return {
      kind: 'canonical_write',
      nextFlowState: rest,
      result: {
        schemaVersion: 2,
        reply: writeConfirmation,
        replyPurpose: 'WRITE_CONFIRMATION',
        pendingTransitionCandidate: resolveCurrentPending(input.frame),
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
    };
  }

  const evidence = latestSuccessfulSlots(input);
  if (!evidence) return null;
  const nextFlowState = fixedStateForSlots(
    input.frame,
    evidence,
    input.preserveDeferredAvailability === true
  );
  const inboundTimes = inboundTimesFromText(input.sourceInboundText);
  const matchingTime =
    inboundTimes.length === 1 && evidence.slots.includes(inboundTimes[0]!)
      ? inboundTimes[0]!
      : null;
  if (matchingTime) {
    const professionalId = nextFlowState.fixedProfessionalId;
    if (
      evidence.professionalId === undefined ||
      evidence.professionalId === professionalId
    ) {
      const draft: BookingDraftV2 = {
        serviceId: evidence.serviceId,
        ...(professionalId ? { professionalId } : {}),
        date: evidence.date,
        time: matchingTime,
        slotEvidenceTurnId: nextFlowState.slotEvidence!.turnId,
      };
      return {
        kind: 'canonical_slots',
        nextFlowState: { ...nextFlowState, bookingDraft: draft },
        result: {
          schemaVersion: 2,
          reply: buildCanonicalBookingSummaryV2({
            draft,
            services: input.services,
          }),
          replyPurpose: 'WRITE_CONFIRMATION',
          pendingTransitionCandidate: {
            kind: 'open',
            pendingKind: 'CONFIRMATION',
            flowId: input.frame.flowState.flowId,
            optionEntityIds: [
              `booking-confirmation:${input.frame.flowState.flowId}`,
            ],
          },
          resolutionCandidate: null,
          unknownServiceEvidence: null,
        },
      };
    }
  }
  const socialAcknowledgement = /\bobrigad[ao]s?\b/iu.test(
    input.sourceInboundText ?? ''
  )
    ? true
    : false;
  return {
    kind: 'canonical_slots',
    nextFlowState,
    result: {
      schemaVersion: 2,
      reply: buildSlotOfferCopyV2({
        date: evidence.date,
        slots: evidence.slots,
        courtesyAcknowledgement: socialAcknowledgement,
      }),
      replyPurpose: 'DATE_TIME_QUESTION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'TIME',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: evidence.slots,
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}

function inboundTimesFromText(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      normalizeTemporalAssertionsV2(value)
        .filter((assertion) => assertion.kind === 'time')
        .map((assertion) => assertion.normalized)
    ),
  ];
}

export function displayDateV2(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : date;
}

export function buildCanonicalBookingSummaryV2(input: {
  draft: BookingDraftV2;
  services: {
    services?: readonly { id: string; name: string }[];
    professionals?: readonly { id: string; name: string }[];
  };
}): string {
  const service = input.services.services?.find(
    (entry) => entry.id === input.draft.serviceId
  );
  const professional = input.draft.professionalId
    ? input.services.professionals?.find(
        (entry) => entry.id === input.draft.professionalId
      )
    : null;
  const professionalPart = professional ? `, com ${professional.name}` : '';
  return `Confirmando: ${service?.name ?? 'o serviço escolhido'}, em ${displayDateV2(
    input.draft.date
  )}, às ${displayTime(input.draft.time)}${professionalPart}. Posso marcar?`;
}
