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
  PendingKindV2,
  PendingOptionV2,
  ResolutionProof,
  TurnFrameV2,
} from './contracts';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import { buildCanonicalBookingSummaryV2 } from './lifecycleReducer';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';
import { hasPositiveExplicitBookingVerbV2 } from './flowSession';
import type { CurrentDateResolutionV2 } from './currentDateResolution';

export type FastPathResultV2 =
  | { kind: 'continue_model'; reason: string }
  | {
      kind: 'resolved';
      result: ModelTurnResultV2;
      proof: ResolutionProof | null;
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

function pendingOrdinalPosition(
  value: string,
  pendingKind: PendingKindV2
): number | null {
  const text = normalize(value);
  // Em TIME, um inteiro nu sempre representa uma hora candidata. A posição
  // ordinal só existe quando a cliente diz explicitamente "opção N".
  if (pendingKind === 'TIME' && /^[1-9]\d*$/u.test(text)) return null;
  return strictOrdinal(value);
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
    frame.pending.flowId === frame.flowState.flowId &&
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

function typedControlOptionPositionV2(
  inboundText: string,
  frame: TurnFrameV2
): number | null {
  if (frame.pending?.kind !== 'CONFIRMATION') return null;
  const text = normalize(inboundText);
  const aliasId = /^(?:continuar|continuar esse agendamento)$/u.test(text)
    ? 'booking-reentry:continue'
    : /^(?:novo|marcar outro|outro agendamento)$/u.test(text)
      ? 'booking-reentry:new'
      : /^(?:outro atendimento|e outro atendimento|marcar outro atendimento)$/u.test(
            text
          )
        ? 'duplicate-resolution:keep-both'
        : null;
  if (!aliasId) return null;
  const matches = frame.pending.options.filter(
    (option) => option.entityId === aliasId
  );
  return matches.length === 1 ? matches[0]!.position : null;
}

function canonicalPendingEntityPosition(
  inboundText: string,
  frame: TurnFrameV2,
  catalog: ServicesResult | undefined
): number | null {
  if (
    !catalog ||
    !frame.pending ||
    !['SERVICE', 'PROFESSIONAL'].includes(frame.pending.kind)
  ) {
    return null;
  }
  const normalizedInbound = normalize(inboundText);
  // O degrau fuzzy nunca transforma negação em escolha positiva. Correções
  // compostas/ambíguas continuam no tradutor completo do modelo. Este caminho
  // novo é deliberadamente só para a resposta curta de um token ("denajem").
  if (
    !/^[a-z0-9]+$/u.test(normalizedInbound) ||
    /\b(?:nao|nunca)\b/u.test(normalizedInbound)
  ) {
    return null;
  }
  const allowedIds = new Set(
    frame.pending.options.map((option) => option.entityId)
  );
  const entities = (
    frame.pending.kind === 'SERVICE'
      ? catalog.services ?? []
      : catalog.professionals ?? []
  ).filter((entry) => allowedIds.has(entry.id));
  if (entities.length === 0) return null;

  // K2: um nome-pai exato não escolhe quando outra opção é seu filho.
  const parentOrExact = entities.filter((entry) => {
    const name = normalize(entry.name);
    return name === normalizedInbound || name.startsWith(`${normalizedInbound} `);
  });
  if (parentOrExact.length > 1) return null;

  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(
    inboundText,
    entities,
    {
      allowRestrictedDistanceTwo:
        ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
    }
  );
  if (resolution.kind !== 'resolved') return null;
  const matches = frame.pending.options.filter(
    (option) => option.entityId === resolution.entity.id
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
  | { kind: 'ambiguous'; options: readonly PendingOptionV2[] }
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
  return matches.length > 1
    ? { kind: 'ambiguous', options: matches }
    : { kind: 'no_match' };
}

function displayPendingTime(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return value;
  return match[2] === '00'
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
}

function buildBareHourDisambiguationV2(
  options: readonly PendingOptionV2[]
): string {
  const displayed = options.map((option) => displayPendingTime(option.entityId));
  if (displayed.length <= 1) return `${displayed[0] ?? 'Qual horário'}?`;
  return `${displayed.slice(0, -1).join(', ')} ou ${displayed.at(-1)}?`;
}

function activeHalfHourClarificationPositionV2(input: {
  inboundText: string;
  frame: TurnFrameV2;
  lastAcceptedAssistantText?: string;
}): number | null {
  const pending = input.frame.pending;
  if (pending?.kind !== 'TIME' || pending.options.length !== 2) return null;
  if (
    normalize(input.lastAcceptedAssistantText ?? '') !==
    normalize(buildBareHourDisambiguationV2(pending.options))
  ) {
    return null;
  }
  const parsed = pending.options.map((option) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(option.entityId);
    return match
      ? { option, hour: Number(match[1]), minute: Number(match[2]) }
      : null;
  });
  if (parsed.some((entry) => entry === null)) return null;
  const temporal = parsed as Array<{
    option: PendingOptionV2;
    hour: number;
    minute: number;
  }>;
  if (
    temporal[0]!.hour !== temporal[1]!.hour ||
    !temporal.some((entry) => entry.minute === 0) ||
    !temporal.some((entry) => entry.minute === 30)
  ) {
    return null;
  }
  const answer = normalize(input.inboundText);
  const wholeHour = temporal.find((entry) => entry.minute === 0)!;
  const halfHour = temporal.find((entry) => entry.minute === 30)!;
  if (answer === String(wholeHour.hour)) return wholeHour.option.position;
  if (['meia', 'e meia', '30'].includes(answer)) return halfHour.option.position;
  return null;
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
  catalog?: ServicesResult;
  lastAcceptedAssistantText?: string;
}): ResolutionProof | null {
  const { frame, inboundId, inboundText, now } = input;
  if (!frame.pending || !pendingFresh(frame, now)) return null;
  // Igualdade temporal normalizada é soberana: 17h = 17:00, portanto nunca
  // pode cair no comparador de "mesma hora" e casar também com 17:30.
  const exactTemporalPosition = temporalPendingPosition(inboundText, frame);
  const clarificationPosition = exactTemporalPosition === null
    ? activeHalfHourClarificationPositionV2({
        inboundText,
        frame,
        lastAcceptedAssistantText: input.lastAcceptedAssistantText,
      })
    : null;
  const bareHour = exactTemporalPosition === null && clarificationPosition === null
    ? barePendingHourPosition(inboundText, frame)
    : ({ kind: 'no_match' } as const);
  if (bareHour.kind === 'ambiguous') return null;
  const position =
    exactTemporalPosition ??
    clarificationPosition ??
    (bareHour.kind === 'resolved' ? bareHour.position : null) ??
    typedControlOptionPositionV2(inboundText, frame) ??
    pendingOrdinalPosition(inboundText, frame.pending.kind) ??
    exactPendingNamePosition(inboundText, frame) ??
    canonicalPendingEntityPosition(inboundText, frame, input.catalog) ??
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

export function buildTimeSelectionFollowUpV2(
  time: string,
  frame: TurnFrameV2,
  catalog: ServicesResult
): { result: ModelTurnResultV2; nextFlowState: FlowStateV2 } | null {
  const evidence = frame.flowState.slotEvidence;
  const serviceId = frame.flowState.fixedServiceId;
  if (
    frame.pending?.kind !== 'TIME' ||
    frame.pending.flowId !== frame.flowState.flowId ||
    !evidence ||
    !serviceId ||
    !evidence.turnId.trim() ||
    evidence.serviceId !== serviceId ||
    evidence.date !== frame.flowState.resolvedDate ||
    !frame.pending.options.some((option) => option.entityId === time) ||
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
  currentDateResolution?: CurrentDateResolutionV2;
  lastAcceptedAssistantText?: string;
}): FastPathResultV2 {
  const { frame, inboundId, inboundText, catalog, now } = input;
  const proofVersion = input.proofVersion ?? 1;
  if (frame.pending && !pendingFresh(frame, now)) {
    return { kind: 'continue_model', reason: 'pending_older_than_4h' };
  }
  if (frame.pending?.kind === 'TIME') {
    const dateResolution = input.currentDateResolution;
    if (
      dateResolution &&
      dateResolution.kind !== 'none' &&
      (dateResolution.kind !== 'resolved' ||
        dateResolution.date !== frame.flowState.slotEvidence?.date)
    ) {
      return {
        kind: 'continue_model',
        reason: 'current_date_correction_preempts_time_selection',
      };
    }
    const pendingProof = resolvePendingOptionProofV2({
      frame,
      inboundId,
      inboundText,
      now,
      proofVersion,
      catalog,
      lastAcceptedAssistantText: input.lastAcceptedAssistantText,
    });
    if (pendingProof?.kind !== 'pending_option') {
      const bareHour = barePendingHourPosition(inboundText, frame);
      if (bareHour.kind === 'ambiguous') {
        const reply = buildBareHourDisambiguationV2(bareHour.options);
        if (
          normalize(input.lastAcceptedAssistantText ?? '') === normalize(reply)
        ) {
          return {
            kind: 'continue_model',
            reason: 'repeated_time_clarification_requires_model',
          };
        }
        return {
          kind: 'resolved',
          proof: null,
          nextFlowState: frame.flowState,
          result: {
            schemaVersion: 2,
            reply,
            replyPurpose: 'CLARIFICATION',
            pendingTransitionCandidate: {
              kind: 'open',
              pendingKind: 'TIME',
              flowId: frame.pending.flowId,
              optionEntityIds: bareHour.options.map((option) => option.entityId),
              forceSupersede: 'time_disambiguation',
            },
            resolutionCandidate: null,
            unknownServiceEvidence: null,
          },
        };
      }
      return { kind: 'continue_model', reason: 'time_option_not_evidenced' };
    }
    const followUp = buildTimeSelectionFollowUpV2(
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
      catalog,
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
        catalog,
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
