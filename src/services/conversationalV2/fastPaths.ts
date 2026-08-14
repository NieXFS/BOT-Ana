import type { ServicesResult } from '../calendarService';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  buildServiceQuestion,
  resolveUniqueCatalogEntityFromCurrentMessage,
} from '../service-gate';
import type {
  BookingDraftV2,
  FlowStateV2,
  ModelTurnResultV2,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import { buildCanonicalBookingSummaryV2 } from './lifecycleReducer';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';

export type FastPathResultV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      proof: ResolutionProof;
      nextFlowState: FlowStateV2;
    };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strictOrdinal(value: string): number | null {
  const text = normalize(value);
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  const words: Record<string, number> = {
    primeira: 1,
    primeiro: 1,
    segunda: 2,
    segundo: 2,
    terceira: 3,
    terceiro: 3,
    quarta: 4,
    quarto: 4,
    quinta: 5,
    quinto: 5,
  };
  const match = text.match(
    /^(?:a )?(?:(primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]) opcao|opcao (?:numero )?([1-9]\d*|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]))(?: por favor)?$/
  );
  const token = match?.[1] ?? match?.[2];
  if (!token) return null;
  return /^\d+$/.test(token) ? Number(token) : words[token] ?? null;
}

function compactAffirmative(value: string): boolean {
  return /^(?:sim+|isso|ok+|certo|pode ser|fechado|combinado|confirmo|beleza|perfeito)(?: por favor)?$/.test(
    normalize(value)
  );
}

function pendingFresh(frame: TurnFrameV2, now: Date): boolean {
  if (!frame.pending) return false;
  const askedAt = Date.parse(frame.pending.askedAt);
  return (
    Number.isFinite(askedAt) &&
    now.getTime() - askedAt <= PENDING_FAST_PATH_MAX_AGE_MS
  );
}

function exactPendingNamePosition(
  inboundText: string,
  frame: TurnFrameV2
): number | null {
  if (!frame.pending) return null;
  const text = normalize(inboundText);
  const matches = frame.pending.options.filter(
    (option) => normalize(option.displayName) === text
  );
  return matches.length === 1 ? matches[0]!.position : null;
}

function temporalPendingPosition(
  inboundText: string,
  frame: TurnFrameV2
): number | null {
  if (frame.pending?.kind !== 'TIME') return null;
  const times = [
    ...new Set(
      normalizeTemporalAssertionsV2(inboundText)
        .filter((assertion) => assertion.kind === 'time')
        .map((assertion) => assertion.normalized)
    ),
  ];
  if (times.length !== 1) return null;
  const matches = frame.pending.options.filter(
    (option) => option.entityId === times[0]
  );
  return matches.length === 1 ? matches[0]!.position : null;
}

type BarePendingHourResolution =
  | { kind: 'no_match' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; position: number };

/**
 * Hora sem sufixo só existe dentro de TIME OPEN. O número é projetado contra
 * optionEntityIds autoritativos; nunca entra no normalizador global nem vira
 * fato temporal fora dessa pendência.
 */
function barePendingHourPosition(
  inboundText: string,
  frame: TurnFrameV2
): BarePendingHourResolution {
  if (frame.pending?.kind !== 'TIME') return { kind: 'no_match' };
  const match = /^(?:(?:pode ser|prefiro|quero)\s+)?(?:as\s+)?([01]?\d|2[0-3])(?:\s+(?:por favor|mesmo))?$/u.exec(
    normalize(inboundText)
  );
  if (!match?.[1]) return { kind: 'no_match' };
  const hour = Number(match[1]);
  const matches = frame.pending.options.filter((option) => {
    const optionMatch = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(option.entityId);
    return optionMatch !== null && Number(optionMatch[1]) === hour;
  });
  if (matches.length === 1) {
    return { kind: 'resolved', position: matches[0]!.position };
  }
  return matches.length > 1 ? { kind: 'ambiguous' } : { kind: 'no_match' };
}

/**
 * Produz proof apenas para uma opção OPEN/fresca evidenciada no inbound atual.
 * É reutilizado pelo fast-path de reads da duplicidade; flowId e versão vêm do
 * snapshot persistido, nunca do modelo.
 */
export function resolvePendingOptionProofV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  now: Date;
  proofVersion?: number;
}): ResolutionProof | null {
  const { frame, inboundId, inboundText, now } = input;
  if (!frame.pending || !pendingFresh(frame, now)) return null;
  const bareHour = barePendingHourPosition(inboundText, frame);
  if (bareHour.kind === 'ambiguous') return null;
  const position =
    temporalPendingPosition(inboundText, frame) ??
    (bareHour.kind === 'resolved' ? bareHour.position : null) ??
    strictOrdinal(inboundText) ??
    exactPendingNamePosition(inboundText, frame) ??
    (frame.pending.options.length === 1 && compactAffirmative(inboundText)
      ? frame.pending.options[0]!.position
      : null);
  if (position === null) return null;
  const option = frame.pending.options.find(
    (entry) => entry.position === position
  );
  if (!option) return null;
  return {
    kind: 'pending_option',
    proofVersion: input.proofVersion ?? 1,
    flowId: frame.pending.flowId,
    questionId: frame.pending.questionId,
    pendingVersion: frame.pending.version,
    position,
    entityId: option.entityId,
    inboundId,
  };
}

export type InitialServiceQuestionFastPathV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      nextFlowState: FlowStateV2;
    };

function hasPositiveExplicitBookingVerbV2(inboundText: string): boolean {
  const text = normalize(inboundText);
  const matcher = /\b(?:agendar|marcar)\b/gu;
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    if (/\b(?:nao|nunca)\b(?:\s+[a-z0-9]+){0,3}\s*$/u.test(prefix)) {
      continue;
    }
    if (
      /\b(?:quero|queria|gostaria de|preciso|desejo|posso|podemos|pode|vamos|vou)\s*$/u.test(
        prefix
      ) ||
      /^(?:agendar|marcar)\b/u.test(text.slice(match.index ?? 0))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Abertura determinística de um novo agendamento sem serviço. É allow-only:
 * verbo explícito positivo + 2+ serviços + nenhuma resolução unívoca atual.
 * Pendência fresca continua soberana; pendência velha pode ser supersedida.
 */
export function resolveInitialServiceQuestionFastPathV2(input: {
  frame: TurnFrameV2;
  inboundText: string;
  catalog: ServicesResult;
  now: Date;
}): InitialServiceQuestionFastPathV2 {
  const services = input.catalog.services ?? [];
  if (!input.catalog.success || services.length < 2) {
    return { kind: 'continue_model', reason: 'catalog_without_multiple_services' };
  }
  if (input.frame.pending && pendingFresh(input.frame, input.now)) {
    return { kind: 'continue_model', reason: 'fresh_pending_is_authoritative' };
  }
  if (!hasPositiveExplicitBookingVerbV2(input.inboundText)) {
    return { kind: 'continue_model', reason: 'no_positive_booking_verb' };
  }
  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(
    input.inboundText,
    services,
    {
      allowRestrictedDistanceTwo:
        ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
    }
  );
  if (resolution.kind === 'resolved') {
    return { kind: 'continue_model', reason: 'service_already_resolved' };
  }
  return {
    kind: 'resolved',
    nextFlowState: input.frame.flowState,
    result: {
      schemaVersion: 2,
      reply: buildServiceQuestion(services),
      replyPurpose: 'SERVICE_QUESTION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'SERVICE',
        flowId: input.frame.flowState.flowId,
        optionEntityIds: services.map((service) => service.id),
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}

function exactCatalogMatch(
  inbound: string,
  catalog: ServicesResult
): { kind: 'service' | 'professional'; id: string; name: string } | null {
  const text = normalize(inbound);
  const matches = [
    ...(catalog.services ?? []).map((entry) => ({
      kind: 'service' as const,
      id: entry.id,
      name: entry.name,
    })),
    ...(catalog.professionals ?? []).map((entry) => ({
      kind: 'professional' as const,
      id: entry.id,
      name: entry.name,
    })),
  ].filter((entry) => normalize(entry.name) === text);
  return matches.length === 1 ? matches[0]! : null;
}

function serviceFollowUp(
  serviceId: string,
  frame: TurnFrameV2,
  catalog: ServicesResult
): { result: ModelTurnResultV2; nextFlowState: FlowStateV2 } {
  const service = catalog.services?.find((entry) => entry.id === serviceId);
  const active = catalog.professionals ?? [];
  const eligible = service?.professionalIds === undefined
    ? active
    : active.filter((entry) => service.professionalIds!.includes(entry.id));
  const fixedBase: FlowStateV2 = {
    flowId: frame.flowState.flowId,
    fixedServiceId: serviceId,
    fixedByProofVersion: {
      fixedServiceId: (frame.flowState.fixedByProofVersion.fixedServiceId ?? 0) + 1,
    },
  };
  if (eligible.length === 0) {
    const alternatives = (catalog.services ?? [])
      .filter((entry) => entry.id !== serviceId)
      .map((entry) => entry.id);
    return {
      nextFlowState: fixedBase,
      result: {
        schemaVersion: 2,
        reply:
          'Esse serviço está temporariamente sem profissional disponível. Qual outro serviço você prefere?',
        replyPurpose: 'SERVICE_QUESTION',
        pendingTransitionCandidate: alternatives.length > 0
          ? {
              kind: 'open',
              pendingKind: 'SERVICE',
              flowId: frame.flowState.flowId,
              optionEntityIds: alternatives,
            }
          : { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
    };
  }
  if (eligible.length === 1) {
    const nextFlowState: FlowStateV2 = {
      ...fixedBase,
      fixedProfessionalId: eligible[0]!.id,
      fixedByProofVersion: {
        ...fixedBase.fixedByProofVersion,
        fixedProfessionalId: fixedBase.fixedByProofVersion.fixedServiceId,
      },
    };
    return {
      nextFlowState,
      result: {
        schemaVersion: 2,
        reply: 'Perfeito. Qual dia você prefere?',
        replyPurpose: 'DATE_TIME_QUESTION',
        pendingTransitionCandidate: {
          kind: 'open',
          pendingKind: 'DATE',
          flowId: frame.flowState.flowId,
          optionEntityIds: ['date-freeform'],
        },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
    };
  }
  return {
    nextFlowState: fixedBase,
    result: {
      schemaVersion: 2,
      reply: `Você prefere ${eligible.map((entry) => entry.name).join(' ou ')} ou tanto faz?`,
      replyPurpose: 'PROFESSIONAL_QUESTION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'PROFESSIONAL',
        flowId: frame.flowState.flowId,
        optionEntityIds: eligible.map((entry) => entry.id),
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}

function timeFollowUp(
  time: string,
  frame: TurnFrameV2,
  catalog: ServicesResult
): { result: ModelTurnResultV2; nextFlowState: FlowStateV2 } | null {
  const evidence = frame.flowState.slotEvidence;
  const serviceId = frame.flowState.fixedServiceId;
  if (
    frame.pending?.kind !== 'TIME' ||
    !evidence ||
    !serviceId ||
    evidence.serviceId !== serviceId ||
    evidence.date !== frame.flowState.resolvedDate ||
    !evidence.slots.includes(time)
  ) {
    return null;
  }
  const professionalId = frame.flowState.fixedProfessionalId;
  if (
    evidence.professionalId !== undefined &&
    evidence.professionalId !== professionalId
  ) {
    return null;
  }
  const draft: BookingDraftV2 = {
    serviceId,
    ...(professionalId ? { professionalId } : {}),
    date: evidence.date,
    time,
    slotEvidenceTurnId: evidence.turnId,
  };
  const nextFlowState: FlowStateV2 = {
    ...frame.flowState,
    bookingDraft: draft,
  };
  return {
    nextFlowState,
    result: {
      schemaVersion: 2,
      reply: buildCanonicalBookingSummaryV2({ draft, services: catalog }),
      replyPurpose: 'WRITE_CONFIRMATION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'CONFIRMATION',
        flowId: frame.flowState.flowId,
        optionEntityIds: [`booking-confirmation:${frame.flowState.flowId}`],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}

function professionalFollowUp(
  professionalId: string,
  frame: TurnFrameV2,
  catalog: ServicesResult
): { result: ModelTurnResultV2; nextFlowState: FlowStateV2 } | null {
  const fixedService = catalog.services?.find(
    (entry) => entry.id === frame.flowState.fixedServiceId
  );
  if (!fixedService) return null;
  const eligible = fixedService.professionalIds === undefined
    ? (catalog.professionals ?? []).map((entry) => entry.id)
    : fixedService.professionalIds;
  if (!eligible.includes(professionalId)) return null;
  const changed = frame.flowState.fixedProfessionalId !== professionalId;
  const {
    bookingDraft: _bookingDraft,
    slotEvidence: _slotEvidence,
    resolvedDate: _resolvedDate,
    ...stateWithoutProfessionalDependentDraft
  } = frame.flowState;
  const base = changed
    ? stateWithoutProfessionalDependentDraft
    : frame.flowState;
  const fixedByProofVersion = {
    ...base.fixedByProofVersion,
    fixedProfessionalId:
      frame.flowState.fixedByProofVersion.fixedServiceId ?? 1,
  };
  if (changed) delete fixedByProofVersion.resolvedDate;
  const nextFlowState: FlowStateV2 = {
    ...base,
    fixedProfessionalId: professionalId,
    fixedByProofVersion,
  };
  return {
    nextFlowState,
    result: {
      schemaVersion: 2,
      reply: 'Perfeito. Qual dia você prefere?',
      replyPurpose: 'DATE_TIME_QUESTION',
      pendingTransitionCandidate: {
        kind: 'open',
        pendingKind: 'DATE',
        flowId: frame.flowState.flowId,
        optionEntityIds: ['date-freeform'],
      },
      resolutionCandidate: null,
      unknownServiceEvidence: null,
    },
  };
}

export function resolveSelectionFastPathV2(input: {
  frame: TurnFrameV2;
  inboundId: string;
  inboundText: string;
  catalog: ServicesResult;
  now: Date;
  proofVersion?: number;
}): FastPathResultV2 {
  const { frame, inboundId, inboundText, catalog, now } = input;
  const proofVersion = input.proofVersion ?? 1;
  if (frame.pending && !pendingFresh(frame, now)) {
    return { kind: 'continue_model', reason: 'pending_older_than_4h' };
  }
  if (frame.pending?.kind === 'TIME') {
    const pendingProof = resolvePendingOptionProofV2({
      frame,
      inboundId,
      inboundText,
      now,
      proofVersion,
    });
    if (pendingProof?.kind !== 'pending_option') {
      return { kind: 'continue_model', reason: 'time_option_not_evidenced' };
    }
    const followUp = timeFollowUp(
      pendingProof.entityId,
      frame,
      catalog
    );
    return followUp
      ? { kind: 'resolved', ...followUp, proof: pendingProof }
      : { kind: 'continue_model', reason: 'time_option_without_slot_evidence' };
  }

  const exact = exactCatalogMatch(inboundText, catalog);
  let selected:
    | { entityId: string; position: number | null; entityKind: 'service' | 'professional' }
    | null = exact
    ? { entityId: exact.id, position: null, entityKind: exact.kind }
    : null;

  if (!selected && frame.pending) {
    if (!['SERVICE', 'PROFESSIONAL'].includes(frame.pending.kind)) {
      return { kind: 'continue_model', reason: 'pending_kind_requires_model' };
    }
    const pendingProof = resolvePendingOptionProofV2({
      frame,
      inboundId,
      inboundText,
      now,
      proofVersion,
    });
    const option = pendingProof?.kind === 'pending_option'
      ? frame.pending.options.find(
          (entry) => entry.position === pendingProof.position
        ) ?? null
      : null;
    if (option && pendingProof?.kind === 'pending_option') {
      selected = {
        entityId: option.entityId,
        position: option.position,
        entityKind:
          frame.pending.kind === 'PROFESSIONAL' ? 'professional' : 'service',
      };
    }
  }
  if (!selected) return { kind: 'continue_model', reason: 'no_allowlisted_match' };

  const followUp = selected.entityKind === 'service'
    ? serviceFollowUp(selected.entityId, frame, catalog)
    : professionalFollowUp(selected.entityId, frame, catalog);
  if (!followUp) {
    return { kind: 'continue_model', reason: 'professional_state_mismatch' };
  }
  const proof: ResolutionProof = selected.position !== null && frame.pending
    ? resolvePendingOptionProofV2({
        frame,
        inboundId,
        inboundText,
        now,
        proofVersion,
      })!
    : {
        kind: 'catalog_entity',
        proofVersion,
        flowId: frame.flowState.flowId,
        entityKind: selected.entityKind,
        entityId: selected.entityId,
        inboundId,
        span: { start: 0, end: Array.from(inboundText).length },
      };
  return { kind: 'resolved', ...followUp, proof };
}

export const __strictOrdinalForSmokeV2 = strictOrdinal;
export const __barePendingHourPositionForSmokeV2 = barePendingHourPosition;
