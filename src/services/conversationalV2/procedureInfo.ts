import type { ServicesResult } from '../calendarService';
import type { AuthoritativeOutboundCatalog } from '../receptionistOutbound';
import {
  locateLicensedCatalogSegmentsV2,
  type LicensedCatalogSegmentV2,
} from '../humanConversationContext';
import {
  LICENSED_SERVICE_DESCRIPTION_POLICY_V1,
  normalizeLicensedServiceDescriptionV2,
  validDescriptionTermAcceptanceV2,
  type DescriptionTermAcceptanceV2,
  type LicensedServiceDescriptionEvidenceV2,
  type LicensedServiceDescriptionFacetV2,
} from '../licensedServiceDescription';
import {
  resolveUniqueCatalogEntityFromCurrentMessage,
  uniqueCatalogServiceFromCurrentMessage,
} from '../service-gate';
import type { TurnFrameV2 } from './contracts';

export const PROCEDURE_INFO_MAX_EXACT_TEXT_CHARS_V2 = 700;
export const PROCEDURE_INFO_REASON_CODE_V2 = 'UNCADASTRED_INFO' as const;
export const PROCEDURE_INFO_TOPIC_CODE_V2 = 'PROCEDURE_INFO' as const;

export type ProcedureInfoDecisionV2 =
  | { kind: 'none' }
  | {
      kind: 'answer_from_license';
      serviceId: string;
      requestedFacets: LicensedServiceDescriptionFacetV2[];
      clauseIds: string[];
    }
  | {
      kind: 'escalate';
      reasonCode: typeof PROCEDURE_INFO_REASON_CODE_V2;
      topicCode: typeof PROCEDURE_INFO_TOPIC_CODE_V2;
      serviceId: string;
      requestedFacets: LicensedServiceDescriptionFacetV2[];
      uncoveredFacets: LicensedServiceDescriptionFacetV2[];
    };

export interface ProcedureInfoPlanV2 {
  decision: ProcedureInfoDecisionV2;
  /** Há pedido operacional adicional que precisa atravessar o pipeline normal. */
  requiresOperationalContinuation: boolean;
  /** Cortesia curta que pode ser reconhecida sem transformar o turno em social-only. */
  hasCourtesyAcknowledgement: boolean;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

const WHAT_IT_IS_RE = /\bo\s+que\s+(?:e|eh)\b/u;
const HOW_PERFORMED_RE =
  /\b(?:como\s+funciona|como\s+(?:e|eh)\s+(?:feit[oa]|aplicad[oa]|realizad[oa])|em\s+que\s+consiste)\b/u;
const PROCEDURAL_INTERROGATIVE_RE = new RegExp(
  `${WHAT_IT_IS_RE.source}|${HOW_PERFORMED_RE.source}`,
  'u'
);
const NEGATED_PROCEDURAL_RE =
  /\bnao\b(?:\s+\w+){0,4}\s+(?:o\s+que\s+(?:e|eh)|como\s+funciona|como\s+(?:e|eh)\s+(?:feit[oa]|aplicad[oa]|realizad[oa])|em\s+que\s+consiste)\b/u;
const OPERATIONAL_OBJECT_RE =
  /\b(?:o\s+que\s+(?:e|eh)|como\s+funciona|como\s+(?:e|eh)\s+(?:feit[oa]|aplicad[oa]|realizad[oa])|em\s+que\s+consiste)\s+(?:(?:o|a|os|as|um|uma|de|dos|das)\s+)?(?:agendamentos?|pagamentos?|pacotes?|cancelamentos?|remarcac(?:ao|oes)|horarios?|agendas?)\b/u;
const TEMPORAL_SESSION_OBJECT_RE =
  /\b(?:o\s+que\s+(?:e|eh)|como\s+funciona|como\s+(?:e|eh)\s+(?:feit[oa]|aplicad[oa]|realizad[oa])|em\s+que\s+consiste)\s+(?:(?:o|a)\s+)?sessao\s+(?:de\s+)?(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}[/-]\d{1,2})\b/u;
const ANAPHORIC_PROCEDURE_RE =
  /\b(?:esse|essa|este|esta|o|a)\s+(?:tratamento|procedimento|servico|sessao)\b/u;
const COURTESY_ACK_RE =
  /\b(?:muito\s+)?(?:obrigad[oa]|agradeco|valeu|vlw)\b/u;
const ADDITIONAL_OPERATIONAL_RE =
  /\b(?:tem\s+vaga|tem\s+horario|disponibilidade|agenda(?:r|mento)?|marcar|remarcar|cancelar|desmarcar|pagamento|pagar|pix|cartao|preco|valor|quanto\s+custa|profissional|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}(?::\d{2}|h\d{0,2})?)\b/u;

function requestedFacets(text: string): LicensedServiceDescriptionFacetV2[] {
  const facets: LicensedServiceDescriptionFacetV2[] = [];
  if (WHAT_IT_IS_RE.test(text)) facets.push('WHAT_IT_IS');
  if (HOW_PERFORMED_RE.test(text)) facets.push('HOW_PERFORMED');
  return facets;
}

function flowAnchoredServiceId(
  text: string,
  frame: TurnFrameV2,
  servicesResult: ServicesResult
): string | null {
  if (!ANAPHORIC_PROCEDURE_RE.test(text)) return null;
  const fixedServiceId =
    frame.flowState.bookingDraft?.serviceId ?? frame.flowState.fixedServiceId;
  if (!fixedServiceId) return null;
  const anchoredByActiveFrame = Boolean(
    frame.flowState.bookingDraft?.serviceId === fixedServiceId ||
      (frame.pending &&
        frame.pending.flowId === frame.flowState.flowId &&
        frame.flowState.fixedServiceId === fixedServiceId)
  );
  if (!anchoredByActiveFrame) return null;
  return servicesResult.services?.some((service) => service.id === fixedServiceId)
    ? fixedServiceId
    : null;
}

function selectedClauseIdsWithinBudget(
  service: NonNullable<ServicesResult['services']>[number],
  facets: readonly LicensedServiceDescriptionFacetV2[]
): { clauseIds: string[]; covered: Set<LicensedServiceDescriptionFacetV2> } {
  const selected: string[] = [];
  const covered = new Set<LicensedServiceDescriptionFacetV2>();
  let chars = 0;
  for (const clause of service.licensedDescription?.clauses ?? []) {
    if (!facets.includes(clause.facet)) continue;
    const nextChars = chars + (selected.length > 0 ? 1 : 0) + clause.exactText.length;
    if (nextChars > PROCEDURE_INFO_MAX_EXACT_TEXT_CHARS_V2) break;
    selected.push(clause.clauseId);
    covered.add(clause.facet);
    chars = nextChars;
  }
  return { clauseIds: selected, covered };
}

/**
 * Anexa somente licenças válidas e somente quando o termo versionado está
 * aceito. O texto exato não deve ser serializado no prompt do modelo.
 */
export function hydrateLicensedServiceDescriptionsV2(input: {
  servicesResult: ServicesResult;
  authoritativeCatalog?: AuthoritativeOutboundCatalog;
  termAcceptance?: DescriptionTermAcceptanceV2 | null;
  contractVersion?: number;
}): ServicesResult {
  const acceptance =
    input.contractVersion === 2 &&
    validDescriptionTermAcceptanceV2(input.termAcceptance)
    ? input.termAcceptance
    : null;
  const authoritative = new Map(
    (input.authoritativeCatalog?.services ?? []).map((service) => [
      service.id,
      acceptance
        ? normalizeLicensedServiceDescriptionV2(service.licensedDescription)
        : null,
    ])
  );
  return {
    ...input.servicesResult,
    services: input.servicesResult.services?.map((service) => ({
      ...service,
      licensedDescription: authoritative.get(service.id) ?? null,
    })),
  };
}

/** Decisão de conteúdo após o catálogo estar carregado e o fluxo, hidratado. */
export function decideProcedureInfoV2(input: {
  inboundText: string;
  frame: TurnFrameV2;
  servicesResult: ServicesResult;
}): ProcedureInfoPlanV2 {
  const text = normalize(input.inboundText);
  const none: ProcedureInfoPlanV2 = {
    decision: { kind: 'none' },
    requiresOperationalContinuation: false,
    hasCourtesyAcknowledgement: false,
  };
  if (
    !PROCEDURAL_INTERROGATIVE_RE.test(text) ||
    NEGATED_PROCEDURAL_RE.test(text) ||
    OPERATIONAL_OBJECT_RE.test(text) ||
    TEMPORAL_SESSION_OBJECT_RE.test(text)
  ) {
    return none;
  }

  const services = input.servicesResult.services ?? [];
  const rawResolution = resolveUniqueCatalogEntityFromCurrentMessage(
    text,
    services
  );
  const anaphoric = ANAPHORIC_PROCEDURE_RE.test(text);
  const current =
    rawResolution.kind === 'resolved' &&
    (!anaphoric || rawResolution.matchKind === 'full')
      ? rawResolution.entity
      : uniqueCatalogServiceFromCurrentMessage(
          text.replace(ANAPHORIC_PROCEDURE_RE, ' '),
          services
        );
  const serviceId =
    current?.id ?? flowAnchoredServiceId(text, input.frame, input.servicesResult);
  if (!serviceId) return none;
  const service = services.find((entry) => entry.id === serviceId);
  if (!service) return none;

  const facets = requestedFacets(text);
  if (facets.length === 0) return none;
  const selection = selectedClauseIdsWithinBudget(service, facets);
  const uncovered = facets.filter((facet) => !selection.covered.has(facet));
  const decision: ProcedureInfoDecisionV2 =
    !service.licensedDescription || uncovered.length > 0
      ? {
          kind: 'escalate',
          reasonCode: PROCEDURE_INFO_REASON_CODE_V2,
          topicCode: PROCEDURE_INFO_TOPIC_CODE_V2,
          serviceId,
          requestedFacets: facets,
          uncoveredFacets: service.licensedDescription ? uncovered : [...facets],
        }
      : {
          kind: 'answer_from_license',
          serviceId,
          requestedFacets: facets,
          clauseIds: selection.clauseIds,
        };

  return {
    decision,
    requiresOperationalContinuation: ADDITIONAL_OPERATIONAL_RE.test(text),
    hasCourtesyAcknowledgement: COURTESY_ACK_RE.test(text),
  };
}

export function materializeProcedureInfoAnswerV2(input: {
  decision: Extract<ProcedureInfoDecisionV2, { kind: 'answer_from_license' }>;
  servicesResult: ServicesResult;
  termAcceptance?: DescriptionTermAcceptanceV2 | null;
}): {
  text: string;
  evidence: LicensedServiceDescriptionEvidenceV2;
  facets: LicensedServiceDescriptionFacetV2[];
} | null {
  if (!validDescriptionTermAcceptanceV2(input.termAcceptance)) return null;
  const service = input.servicesResult.services?.find(
    (entry) => entry.id === input.decision.serviceId
  );
  const licensed = service?.licensedDescription;
  if (!service || !licensed) return null;
  const byId = new Map(licensed.clauses.map((clause) => [clause.clauseId, clause]));
  const selected = input.decision.clauseIds.map((clauseId) => byId.get(clauseId));
  if (
    selected.some((clause) => !clause) ||
    selected.some(
      (clause) =>
        clause && !input.decision.requestedFacets.includes(clause.facet)
    )
  ) {
    return null;
  }
  const exactText = selected
    .map((clause) => clause!.exactText)
    .join(' ')
    .trim();
  if (!exactText || exactText.length > PROCEDURE_INFO_MAX_EXACT_TEXT_CHARS_V2) {
    return null;
  }
  const facets: LicensedServiceDescriptionFacetV2[] = [];
  for (const clause of selected) {
    if (clause && !facets.includes(clause.facet)) facets.push(clause.facet);
  }
  return {
    text: exactText,
    evidence: {
      serviceId: service.id,
      sourceHash: licensed.sourceHash,
      policyVersion: LICENSED_SERVICE_DESCRIPTION_POLICY_V1,
      clauseIds: [...input.decision.clauseIds],
      exactText,
      termAcceptance: {
        clauseVersion: input.termAcceptance.clauseVersion,
        acceptedAt: input.termAcceptance.acceptedAt,
      },
    },
    facets,
  };
}

export function licensedCatalogSegmentsForAcceptedPayloadV2(input: {
  payload: string;
  answer: {
    evidence: LicensedServiceDescriptionEvidenceV2;
    facets: readonly LicensedServiceDescriptionFacetV2[];
  };
  serviceName: string;
}): LicensedCatalogSegmentV2[] {
  const segments = locateLicensedCatalogSegmentsV2({
    visibleText: input.payload,
    serviceId: input.answer.evidence.serviceId,
    serviceName: input.serviceName,
    sourceHash: input.answer.evidence.sourceHash,
    clauseIds: input.answer.evidence.clauseIds,
    facets: input.answer.facets,
    exactText: input.answer.evidence.exactText,
  });
  if (!segments) {
    throw new Error('Payload aceito sem segmento de catálogo localizável.');
  }
  return segments;
}

export function composeProcedureInfoComponentV2(input: {
  baseText?: string | null;
  componentText: string;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): string {
  const parts: string[] = [];
  const greeting = input.socialGreeting?.trim();
  if (greeting) parts.push(greeting);
  const base = input.baseText?.trim();
  if (base && !parts.some((part) => part.includes(base))) parts.push(base);
  if (!base && !greeting && input.courtesyAcknowledgement) parts.push('Imagina!');
  const component = input.componentText.trim();
  if (component && !parts.some((part) => part.includes(component))) {
    parts.push(component);
  }
  return parts.join('\n\n');
}

export function procedureInfoModelInstructionV2(
  decision: Exclude<ProcedureInfoDecisionV2, { kind: 'none' }>
): string {
  return decision.kind === 'answer_from_license'
    ? 'COMPONENTE PROCEDURAL SERVER-OWNED: responda somente aos outros componentes do lote. Não explique, resuma nem parafraseie o procedimento; o servidor anexará cláusulas licenciadas exatas depois da sua resposta.'
    : 'COMPONENTE PROCEDURAL SERVER-OWNED: responda somente aos outros componentes do lote e não execute nenhuma escrita. O servidor registrará a pergunta procedural e anexará a confirmação somente depois das leituras autorizadas.';
}
