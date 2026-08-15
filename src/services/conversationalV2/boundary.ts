import type { ServicesResult } from '../calendarService';
import {
  inspectCustomerReply,
  normalizeCustomerReplyStyle,
  type AppointmentTemporalContext,
  type CustomerReplyLeakReason,
  type ToolTraceLike,
} from '../customerReplyGuard';
import {
  buildReceptionistEnvelope,
  catalogFromServicesResult,
  containsInternalConversationMarker,
  containsUnlicensedHandoffPromise,
  licensedServiceDescriptionEvidenceValid,
  validateReceptionistOutbound,
  type AuthoritativeOutboundCatalog,
  type OutboundReasonCode,
  type ReceptionistOutboundEvidence,
  type ReceptionistOutboundSource,
} from '../receptionistOutbound';
import {
  classifyReceptionistTurnPermission,
  type ReceptionistTurnPermission,
} from '../receptionistSocialSafety';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  isClosedCatalogResidualForEntity,
  resolveUniqueCatalogEntityFromCurrentMessage,
  uniqueCatalogServiceFromCurrentMessage,
} from '../service-gate';
import type {
  BoundaryEvaluation,
  BoundaryReasonCodeV2,
  BoundaryStageEvaluationV2,
  FlowStateV2,
  InboundSpanV2,
  ModelReplyPurposeV2,
  PendingTransitionCandidate,
  PendingFrameSnapshotV2,
  UnknownServiceEvidenceV2,
} from './contracts';
import { codePointSliceV2 } from './modelResultParser';
import {
  clauseMatchHasPositivePolarityV2,
  findClauseMatchesV2,
  splitClausesV2,
} from './polarity';
import {
  hasTemporalAssertionV2,
  normalizeTemporalAssertionsV2,
} from './temporalNormalizer';
import { buildPendingQuestionV2 } from './pendingQuestion';

export const UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2 =
  'Esse procedimento não está disponível no momento. Posso te ajudar com outro serviço?';

export interface BoundaryEvaluationInputV2 {
  rawCandidate: string;
  servicesResult: ServicesResult;
  authoritativeCatalog?: AuthoritativeOutboundCatalog;
  forbiddenAppointmentIds?: string[];
  toolTrace?: ToolTraceLike[];
  sourceInboundText?: string;
  temporalContext?: AppointmentTemporalContext;
  flowState?: FlowStateV2;
  pendingTransitionCandidate?: PendingTransitionCandidate;
  unknownServiceEvidence?: UnknownServiceEvidenceV2 | null;
  socialTemporalEvidence?: InboundSpanV2 | null;
  recentAssistantReplies?: readonly string[];
  currentInboundIds?: readonly string[];
  inboundTextsById?: Readonly<Record<string, string>>;
  replyPurpose?: ModelReplyPurposeV2;
  source?: ReceptionistOutboundSource;
  actionRecorded?: boolean;
  outboundEvidence?: Omit<
    ReceptionistOutboundEvidence,
    'toolTrace' | 'sourceInboundText' | 'actionRecorded' | 'temporalContext'
  >;
  serviceRelistExempt?: boolean;
  /** Rota que invocou a boundary; social estrita usa sua blocklist própria. */
  route?: 'model' | 'social' | 'interpreter';
  /** Snapshot tipado: existe PendingFrame.OPEN originado pela Ana. */
  pendingAnaOpen?: boolean;
  pendingSnapshot?: PendingFrameSnapshotV2 | null;
}

const TECHNICAL_ID_RE =
  /\b(?:c[a-z0-9]{19,31}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/iu;
const MESSAGE_ID_RE = /\bwamid(?:\.[A-Za-z0-9_=-]+)?\b/iu;
const UNKNOWN_SERVICE_OFFER_RE =
  /\b(?:temos?|oferecemos?|fazemos?|realizamos?|trabalhamos\s+com)\s+(?:o\s+servico\s+de\s+|a\s+|o\s+)?([^.!?;]+)/gu;
const SERVICE_OFFER_VERB_SOURCE =
  '(?:temos?|oferecemos?|fazemos?|realizamos?|trabalhamos\\s+com)';
const UNAVAILABLE_DENIAL_RE =
  /\b(?:nao\s+(?:temos?|oferecemos?|fazemos?|realizamos?|trabalhamos\s+com|atendemos?)|nao\s+esta\s+disponivel|indisponivel)\b/iu;
const SOFT_AVAILABILITY_RE =
  /\b(?:(?:tem|temos)\s+(?:alguma\s+)?(?:vaga|horario|espaco)|te\s+encaix(?:o|amos)|(?:esta|ta)\s+(?:lotad[oa]|chei[oa])|agenda\s+(?:esta\s+)?(?:cheia|livre))\b/iu;
const OCCUPIED_AVAILABILITY_RE =
  /\b(?:(?:esta|ta)\s+(?:lotad[oa]|chei[oa])|agenda\s+(?:esta\s+)?cheia)\b/iu;
const IMPLICIT_COMMITMENT_RE = /\bte\s+(?:vejo|espero|aguardo)\b/iu;
const SOCIAL_OPERATIONAL_FACT_RE =
  /\b(?:servicos?|procedimentos?|tratamentos?|profissiona(?:l|is)|agenda|agendar|agendamento|marcar|remarcar|cancelar|horarios?|vagas?)\b/iu;
const SOCIAL_PRICE_FACT_RE =
  /(?:R\$\s*\d|\b\d{1,6}[.,]\d{2}\b|\b\d+(?:[.,]\d{1,2})?\s*(?:reais?|centavos?)\b|\b(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte|trinta|quarenta|cinquenta|cem|cento|mil)(?:\s+e\s+\w+)?\s+reais?\b|\b(?:fica|sai|e)\s+(?:\d{2,6}(?:[.,]\d{1,2})?|(?:dez|onze|doze|treze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos)(?:\s+e\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa))?)\b|\b(?:preco|valor|custa|custar|gratis|gratuito|barat(?:o|a|inho|inha))\b)/iu;
const SOCIAL_BUSINESS_HOURS_RE =
  /\b(?:funcionamos?|abrimos?|fechamos?|atendemos?|estamos\s+abert[oa]s?|horario\s+de\s+(?:funcionamento|atendimento)|atendimento\s+(?:e|vai)\s+(?:das?|de))\b/iu;
const SOCIAL_COMMERCE_RE =
  /\b(?:promocao|desconto|cupom|pacote|pagamento|pagar|pix|cartao|parcela|parcelamento|dinheiro)\b/iu;
const SOCIAL_ADDRESS_RE =
  /\b(?:endereco|localizacao|localizado|localizada|rua|avenida|av\.?|bairro|cep|mapa|como\s+chegar|ficamos?\s+(?:na|no|em))\b/iu;
const SOCIAL_CAPACITY_RE =
  /\b(?:lotad[oa]|chei[oa]|encaixe|disponibilidade|sem\s+vagas?|tem\s+espaco|agenda\s+(?:livre|cheia))\b/iu;
const SOCIAL_DURATION_RE =
  /(?:\b(?:dura|duracao|leva|demora)\b(?:\s+\w+){0,4}\s+\b(?:minutos?|horas?|dias?)\b|\b\d+\s+(?:minutos?|horas?|dias?)\b)/iu;
const SOCIAL_STAFF_RE =
  /\b(?:dona|gerente|recepcionista|secretaria|atendente|equipe|staff|esteticista|medic[oa]|doutor[ae]?)\b/iu;
const SOCIAL_PARALLEL_CHANNEL_RE =
  /\b(?:instagram|direct|telefone|ligar|ligacao|e-?mail|site|link|outro\s+whatsapp|chama\s+no)\b/iu;
const SOCIAL_CLINICAL_CLAIM_RE =
  /\b(?:cura|curar|diagnostico|garant(?:e|ido|ida)|resultado\s+garantido|sem\s+risco|seguro\s+para|indicado\s+para|contraindicacao|efeito\s+colateral|tratamento\s+resolve)\b/iu;
const SOCIAL_ATTENDANCE_INSTRUCTION_RE =
  /\b(?:cheg(?:ue|ar)\s+\d+\s+minutos?\s+antes|preparo|prepare-se|preparar-se|vestimenta|roupa\s+(?:leve|confortavel)|jejum|em\s+jejum)\b/iu;
const SOCIAL_PERSON_IDENTITY_FACT_RE =
  /\b(?:a\s+dona|o\s+dono|ela|ele|a\s+\p{L}[\p{L}'-]+|o\s+\p{L}[\p{L}'-]+)\s+(?:ja\s+)?(?:te\s+conhece|conhece\s+voce|e\s+|esta\s+|vai\s+|trabalha\s+)/iu;
const SOCIAL_HUMAN_RETURN_RE =
  /\b(?:alguem|a\s+equipe|o\s+atendente|a\s+recepcao|uma\s+pessoa)\b(?:\s+\w+){0,5}\s+\b(?:retorna|retornara|vai\s+retornar|responde|respondera|vai\s+responder|entra\s+em\s+contato)\b/iu;
const PRE_BOOKING_CONFIRMATION_QUESTION_RE =
  /(?:\b(?:posso|podemos)\s+(?:marcar|agendar|confirmar)(?:\s+(?:o\s+)?agendamento)?\s*\?|\b(?:voce\s+)?confirma(?:\s+(?:o\s+)?agendamento)?\s*\?)/u;
const CONSUMMATED_APPOINTMENT_STATE_RE =
  /\b(?:esta|ta|ficou|foi|segue|ja\s+esta)\s+(?:(?:tudo|o\s+horario|o\s+agendamento)\s+)?(?:marcad[oa]|agendad[oa]|confirmad[oa]|reservad[oa])\b|\b(?:horario|agendamento|reserva)\s+(?:marcad[oa]|agendad[oa]|confirmad[oa]|reservad[oa])\b/u;
const APPOINTMENT_SERVICE_CLAIM_RE_V2 =
  /\b(?:para|pra)\s+(?:a|o)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,4})(?=[.!?,]|$)/gu;
const PROFESSIONAL_REFERENCE_PATTERNS_V2 = [
  /\b(?:com|pela?|profissional|especialista|dra?\.?|doutor(?:a)?)\s+(?:(?:a|o)\s+)?(?<name>[A-ZÀ-ÖØ-Þ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'-]+)?)/gu,
  /\b(?:a|o)\s+(?<name>[A-ZÀ-ÖØ-Þ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'-]+)?)\s+(?=atende|recebe|realiza|estar[aá]|ficar[aá]|vai\s+estar)/gu,
] as const;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveCatalogEntityV2(
  message: string,
  entities: Array<{ id: string; name: string }>
) {
  return resolveUniqueCatalogEntityFromCurrentMessage(message, entities, {
    allowRestrictedDistanceTwo:
      ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseToolResult(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolSucceeded(entry: ToolTraceLike): boolean {
  return parseToolResult(entry.result)?.success === true;
}

function hasCompatibleWriteOrRead(toolTrace: ToolTraceLike[]): boolean {
  return toolTrace.some((entry) => {
    const parsed = parseToolResult(entry.result);
    if (!parsed || parsed.success !== true) return false;
    if (entry.name === 'bookAppointment') return true;
    return (
      entry.name === 'getUpcomingAppointments' &&
      Array.isArray(parsed.appointments) &&
      parsed.appointments.length > 0
    );
  });
}

function availabilityEvidenceState(
  toolTrace: ToolTraceLike[]
): { known: boolean; hasAvailability: boolean } {
  let state = { known: false, hasAvailability: false };
  for (const entry of toolTrace) {
    const parsed = parseToolResult(entry.result);
    if (!parsed) continue;
    if (entry.name === 'getAvailableSlots') {
      if (parsed.success === true && Array.isArray(parsed.slots)) {
        state = { known: true, hasAvailability: parsed.slots.length > 0 };
      }
      continue;
    }
    if (entry.name === 'bookAppointment') {
      if (parsed.success === true) {
        state = { known: true, hasAvailability: true };
      } else if (
        parsed.success === false &&
        ['blocked', 'conflict', 'outside_hours'].includes(String(parsed.reason)) &&
        Array.isArray(parsed.availableSlots)
      ) {
        state = {
          known: true,
          hasAvailability: parsed.availableSlots.length > 0,
        };
      }
    }
  }
  return state;
}

function availabilityClaimLicensed(
  candidate: string,
  input: BoundaryEvaluationInputV2
): boolean {
  let evidence = availabilityEvidenceState(input.toolTrace ?? []);
  if (!evidence.known) {
    const pendingEvidence = pendingTimeSlotEvidenceV2(input);
    if (pendingEvidence) {
      evidence = {
        known: true,
        hasAvailability: pendingEvidence.slots.length > 0,
      };
    }
  }
  if (!evidence.known) return false;
  const occupiedClaim = OCCUPIED_AVAILABILITY_RE.test(normalize(candidate));
  return occupiedClaim ? !evidence.hasAvailability : evidence.hasAvailability;
}

function rawLeakReasons(input: BoundaryEvaluationInputV2): BoundaryReasonCodeV2[] {
  const reasons = new Set<BoundaryReasonCodeV2>();
  const raw = input.rawCandidate;
  if (!raw.trim()) reasons.add('EMPTY_PAYLOAD');
  if (/INTERNAL_HINT/iu.test(raw)) reasons.add('INTERNAL_HINT');
  if (
    containsUnlicensedHandoffPromise(raw, {
      actionRecorded: input.actionRecorded,
      authoritativeEscalationQuestionId:
        input.outboundEvidence?.authoritativeEscalationQuestionId,
    })
  ) {
    reasons.add('UNRECORDED_HANDOFF');
  }
  if (containsInternalConversationMarker(raw)) {
    reasons.add('INTERNAL_CONVERSATION_MARKER');
  }
  if (MESSAGE_ID_RE.test(raw)) reasons.add('MESSAGE_ID_LEAK');

  for (const service of input.servicesResult.services ?? []) {
    if (service.id && raw.includes(service.id)) {
      reasons.add('CATALOG_SERVICE_ID');
      break;
    }
  }
  for (const professional of input.servicesResult.professionals ?? []) {
    if (professional.id && raw.includes(professional.id)) {
      reasons.add('CATALOG_PROFESSIONAL_ID');
      break;
    }
  }
  for (const appointmentId of input.forbiddenAppointmentIds ?? []) {
    if (appointmentId && raw.includes(appointmentId)) {
      reasons.add('APPOINTMENT_ID');
      break;
    }
  }
  if (
    !reasons.has('CATALOG_SERVICE_ID') &&
    !reasons.has('CATALOG_PROFESSIONAL_ID') &&
    !reasons.has('APPOINTMENT_ID') &&
    TECHNICAL_ID_RE.test(raw)
  ) {
    reasons.add('TECHNICAL_ID');
  }
  return [...reasons];
}

function licensedBoundaryProjectionV2(
  candidate: string,
  input: BoundaryEvaluationInputV2,
  catalog: AuthoritativeOutboundCatalog
): {
  factCheckedCandidate: string;
  blocks: Array<{ source: ReceptionistOutboundSource; text: string }>;
} {
  const witness = input.outboundEvidence?.licensedServiceDescription;
  const source = input.source ?? 'GENERATED';
  if (!witness?.exactText) {
    return {
      factCheckedCandidate: candidate,
      blocks: [{ source, text: candidate }],
    };
  }
  const first = candidate.indexOf(witness.exactText);
  const unique = first >= 0 && candidate.indexOf(witness.exactText, first + 1) < 0;
  const licensedBlock = {
    source: 'LICENSED_SERVICE_DESCRIPTION' as const,
    text: witness.exactText,
  };
  if (
    !unique ||
    !licensedServiceDescriptionEvidenceValid(
      licensedBlock,
      input.outboundEvidence,
      catalog
    )
  ) {
    return {
      factCheckedCandidate: candidate,
      blocks: [{ source, text: candidate }, licensedBlock],
    };
  }
  const before = candidate.slice(0, first);
  const after = candidate.slice(first + witness.exactText.length);
  return {
    factCheckedCandidate: `${before}${after}`,
    blocks: [
      ...(before ? [{ source, text: before }] : []),
      licensedBlock,
      ...(after ? [{ source, text: after }] : []),
    ],
  };
}

const LICENSED_WRITE_CLAIM_RE =
  /\b(?:agendei|marquei|remarquei|cancelei|(?:agendamento|reserva|horario)\b(?:\s+[a-z0-9]+){0,5}\s+(?:confirmad[oa]|agendad[oa]|marcad[oa]|remarcad[oa]|cancelad[oa]))\b/u;
const LICENSED_AVAILABILITY_OBJECT_RE =
  /\b(?:vaga|horario|disponibilidade|disponivel|agenda)\b/u;
const LICENSED_EXISTING_APPOINTMENT_RE =
  /\b(?:(?:voce\s+tem|seu|sua)\b(?:\s+[a-z0-9]+){0,4}\s+(?:agendamento|reserva|sessao|horario)|(?:agendamento|reserva)\b(?:\s+[a-z0-9]+){0,5}\s+(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo))\b/u;

/**
 * O termo licencia conteúdo da descrição, nunca estado operacional. Mantemos
 * os detectores amplos no texto gerado e usamos objetos transacionais fechados
 * no bloco exato para não confundir "é realizada" com write de agenda.
 */
function licensedDescriptionHardGuardReasonsV2(
  candidate: string,
  input: BoundaryEvaluationInputV2,
  projection: ReturnType<typeof licensedBoundaryProjectionV2>,
  toolTrace: readonly ToolTraceLike[]
): CustomerReplyLeakReason[] {
  const licensedText = projection.blocks
    .filter((block) => block.source === 'LICENSED_SERVICE_DESCRIPTION')
    .map((block) => block.text)
    .join('\n');
  if (!licensedText) return [];
  const full = inspectCustomerReply(
    candidate,
    input.servicesResult,
    input.forbiddenAppointmentIds ?? [],
    [...toolTrace],
    input.sourceInboundText,
    input.temporalContext,
    pendingTimeSlotEvidenceV2(input)?.slots ?? []
  );
  const normalizedLicensed = normalize(licensedText);
  return full.reasons.filter((reason) => {
    if (
      reason === 'internal_hint' ||
      reason === 'service_id' ||
      reason === 'professional_id' ||
      reason === 'appointment_id' ||
      reason === 'technical_id'
    ) {
      return true;
    }
    if (reason === 'false_write_claim') {
      return LICENSED_WRITE_CLAIM_RE.test(normalizedLicensed);
    }
    if (reason === 'unverified_availability') {
      return LICENSED_AVAILABILITY_OBJECT_RE.test(normalizedLicensed);
    }
    if (reason === 'unverified_appointment_context') {
      return LICENSED_EXISTING_APPOINTMENT_RE.test(normalizedLicensed);
    }
    return false;
  });
}

function normalizeCandidatePreservingLicensedDescriptionV2(
  rawCandidate: string,
  input: BoundaryEvaluationInputV2,
  catalog: AuthoritativeOutboundCatalog
): string {
  const witness = input.outboundEvidence?.licensedServiceDescription;
  if (!witness?.exactText) return normalizeCustomerReplyStyle(rawCandidate);
  const first = rawCandidate.indexOf(witness.exactText);
  const unique =
    first >= 0 && rawCandidate.indexOf(witness.exactText, first + 1) < 0;
  if (
    !unique ||
    !licensedServiceDescriptionEvidenceValid(
      {
        source: 'LICENSED_SERVICE_DESCRIPTION',
        text: witness.exactText,
      },
      input.outboundEvidence,
      catalog
    )
  ) {
    return normalizeCustomerReplyStyle(rawCandidate);
  }
  const before = normalizeCustomerReplyStyle(rawCandidate.slice(0, first));
  const after = normalizeCustomerReplyStyle(
    rawCandidate.slice(first + witness.exactText.length)
  );
  return [before, witness.exactText, after].filter(Boolean).join('\n\n');
}

function customerGuardReason(reason: CustomerReplyLeakReason): BoundaryReasonCodeV2 {
  const mapping: Record<CustomerReplyLeakReason, BoundaryReasonCodeV2> = {
    internal_hint: 'INTERNAL_HINT',
    service_id: 'CATALOG_SERVICE_ID',
    professional_id: 'CATALOG_PROFESSIONAL_ID',
    appointment_id: 'APPOINTMENT_ID',
    technical_id: 'TECHNICAL_ID',
    false_write_claim: 'FALSE_WRITE_CLAIM',
    unverified_availability: 'UNVERIFIED_AVAILABILITY',
    unverified_appointment_context: 'UNVERIFIED_APPOINTMENT_CONTEXT',
  };
  return mapping[reason];
}

function hasCatalogSignal(
  text: string,
  servicesResult: ServicesResult
): boolean {
  return Boolean(
    uniqueCatalogServiceFromCurrentMessage(
      text,
      (servicesResult.services ?? []).map((service) => ({ id: service.id, name: service.name }))
    )
  );
}

const V2_ESTABLISHMENT_SUBJECT_RE =
  /^(?:(?:voces?|vcs?)|(?:a|o)\s+(?:clinica|estabelecimento|unidade|salao|loja))\s+/u;
const V2_BUSINESS_HOURS_VERB_RE =
  /\b(?:atend(?:e|em|er)|funcion(?:a|am|ar)|abr(?:e|em|ir)|fech(?:a|am|ar)|(?:tem|ter|tera)\s+expediente)\b/u;
const V2_BUSINESS_HOURS_TARGET_RE =
  /\b(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo|feriados?|horas?|horarios?|expediente)\b/u;
const V2_INTERROGATIVE_PREFIX_RE =
  /^(?:que\s+horas?|qual(?:\s+e)?\s+(?:o\s+)?(?:horario|expediente)|quais\s+horarios|quando)\b/u;
const V2_OMITTED_ESTABLISHMENT_SUBJECT_RE =
  /^(?:(?:vao|vai|costumam?|podem?)\s+)?(?:atend(?:e|em|er)|funcion(?:a|am|ar)|abr(?:e|em|ir)|fech(?:a|am|ar)|(?:tem|ter|tera)\s+expediente)\b/u;

/** Predicado estrito do overlay; não classifica perguntas de eficácia. */
export function isV2BusinessHoursInformationRequest(inbound: string): boolean {
  const normalized = normalize(inbound)
    .replace(/[^a-z0-9 ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const interrogative =
    inbound.includes('?') || V2_INTERROGATIVE_PREFIX_RE.test(normalized);
  if (!interrogative || !V2_BUSINESS_HOURS_TARGET_RE.test(normalized)) return false;

  const afterInterrogativePrefix = normalized
    .replace(V2_INTERROGATIVE_PREFIX_RE, '')
    .trim();
  const explicitEstablishment =
    V2_ESTABLISHMENT_SUBJECT_RE.test(normalized) ||
    V2_ESTABLISHMENT_SUBJECT_RE.test(afterInterrogativePrefix);
  const omittedEstablishment =
    V2_OMITTED_ESTABLISHMENT_SUBJECT_RE.test(normalized) ||
    (V2_INTERROGATIVE_PREFIX_RE.test(normalized) &&
      V2_OMITTED_ESTABLISHMENT_SUBJECT_RE.test(afterInterrogativePrefix));
  const scheduleNounQuestion =
    /^(?:qual(?:\s+e)?\s+(?:o\s+)?horario\s+de\s+(?:atendimento|funcionamento)|qual(?:\s+e)?\s+(?:o\s+)?expediente)(?:\s+(?:da|do)\s+(?:clinica|estabelecimento|unidade|salao|loja))?$/u.test(
      normalized
    );
  return (
    scheduleNounQuestion ||
    ((explicitEstablishment || omittedEstablishment) &&
      V2_BUSINESS_HOURS_VERB_RE.test(normalized))
  );
}

/**
 * Overlay exclusivo da rota v2. O classificador compartilhado não é alterado:
 * somente interrogativas inequívocas de atendimento/funcionamento que ele
 * deixou em NO_OPERATIONAL_INTENT ganham permissão informacional.
 */
export function classifyReceptionistTurnPermissionV2(
  inbound: string,
  servicesResult: ServicesResult
): ReceptionistTurnPermission {
  const shared = classifyReceptionistTurnPermission(inbound, {
    services: (servicesResult.services ?? []).map((service) => service.name),
    professionals: (servicesResult.professionals ?? []).map(
      (professional) => professional.name
    ),
  });
  if (shared !== 'NO_OPERATIONAL_INTENT') return shared;
  return isV2BusinessHoursInformationRequest(inbound)
    ? 'INFORMATION_REQUEST'
    : shared;
}

/**
 * Mitigação v2 do drift herdado: só conserva SOCIAL_CONTEXT_DRIFT no quadrante
 * pessoal/social classificado sobre o inbound completo e sem pergunta ANA
 * aberta. Entidade de catálogo não é mais cláusula de descarte (K4). O
 * avaliador v1 permanece byte-intacto; somente seu reason é filtrado aqui.
 */
export function shouldKeepInheritedSocialContextDriftV2(
  input: BoundaryEvaluationInputV2
): boolean {
  if ((input.route ?? 'model') !== 'model') return false;
  const inbound = input.sourceInboundText?.trim() ?? '';
  const permission = classifyReceptionistTurnPermissionV2(
    inbound,
    input.servicesResult
  );
  return (
    (permission === 'NO_OPERATIONAL_INTENT' || permission === 'SOCIAL_ONLY') &&
    input.pendingAnaOpen !== true
  );
}

function currentSpanText(
  evidence: UnknownServiceEvidenceV2 | InboundSpanV2 | null | undefined,
  input: BoundaryEvaluationInputV2
): string | null {
  if (!evidence || !input.inboundTextsById) return null;
  const inboundId = evidence.inboundId;
  if (!input.currentInboundIds?.includes(inboundId)) return null;
  const inbound = input.inboundTextsById[inboundId];
  if (typeof inbound !== 'string') return null;
  const span = 'span' in evidence ? evidence.span : evidence;
  return codePointSliceV2(inbound, span.start, span.end);
}

function containsConcreteUnknownProcedure(
  spanText: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  let remainder = normalize(spanText);
  for (const service of catalog.services) {
    remainder = remainder.replace(
      new RegExp(`\\b${escapeRegExp(normalize(service.name))}\\b`, 'gu'),
      ' '
    );
  }
  remainder = remainder
    .replace(
      /\b(?:quero|gostaria|preciso|pode|podem|marcar|marca|agendar|agenda|agendamento|remarcar|cancelar|retorno|encaixe|avaliacao|unidade|manha|tarde|noite|horario|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|servico|procedimento|atendimento|com|para|pra|de|da|do|das|dos|uma|um|o|a|e)\b/gu,
      ' '
    )
    .replace(/\b(?:[01]?\d|2[0-3])(?::[0-5]\d|h[0-5]?\d?)?\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return remainder.split(/\s+/u).some((token) => token.length >= 4);
}

export function unknownServiceDenialLicensedV2(
  input: BoundaryEvaluationInputV2,
  catalog = input.authoritativeCatalog ?? catalogFromServicesResult(input.servicesResult)
): boolean {
  const spanText = currentSpanText(input.unknownServiceEvidence, input);
  if (!spanText || !input.unknownServiceEvidence || !input.inboundTextsById) return false;
  const inbound = input.inboundTextsById[input.unknownServiceEvidence.inboundId];
  if (typeof inbound !== 'string') return false;
  if (
    hasCatalogSignal(inbound, input.servicesResult) ||
    hasCatalogSignal(spanText, input.servicesResult)
  ) {
    return false;
  }
  return containsConcreteUnknownProcedure(spanText, catalog);
}

function hasUnknownServiceOffer(
  candidate: string,
  catalog: AuthoritativeOutboundCatalog,
  toolTrace: ToolTraceLike[] = []
): boolean {
  const matches = findServiceOfferMatchesV2(candidate);
  return matches.some((match) => {
    if (!match.positive) return false;
    const offered = match.groups[0] ?? '';
    if (
      !/[a-z]/u.test(offered) ||
      isCapacityOnlyServiceOfferSpanV2(offered) ||
      isTemporalOnlyServiceOfferSpanV2(
        offered,
        currentTurnSlotEvidenceV2(toolTrace)
      )
    ) {
      return false;
    }
    return !isCatalogOnlyServiceOfferSpanV2(
      offered,
      catalog
    );
  });
}

/**
 * Para ofertas, vírgula normalmente separa itens da mesma enumeração e não
 * pode apagar os itens 2..N. Só vira fronteira de oração quando introduz um
 * novo verbo de oferta; adversativas e pontuação forte continuam separando a
 * polaridade como no matcher canônico de orações.
 */
function findServiceOfferMatchesV2(candidate: string): Array<{
  groups: string[];
  positive: boolean;
}> {
  const normalized = normalize(candidate)
    .replace(/\b(?:mas|porem|contudo|entretanto|so que)\b/gu, '.')
    .replace(
      new RegExp(
        `,\\s*(?=(?:nao\\s+|nunca\\s+)?${SERVICE_OFFER_VERB_SOURCE}\\b)`,
        'gu'
      ),
      '.'
    );
  const results: Array<{ groups: string[]; positive: boolean }> = [];
  for (const clause of normalized
    .split(/[.!?;:\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    for (const match of clause.matchAll(
      new RegExp(UNKNOWN_SERVICE_OFFER_RE.source, UNKNOWN_SERVICE_OFFER_RE.flags)
    )) {
      results.push({
        groups: match.slice(1).map((group) => group ?? ''),
        positive: clauseMatchHasPositivePolarityV2(clause, match.index ?? 0),
      });
    }
  }
  return results;
}

/**
 * Uma captura herdada de `temos ...` só é temporal quando todo o seu conteúdo
 * é consumido pelo normalizador temporal canônico e por vocabulário fechado de
 * agenda/lista. Qualquer token substantivo residual mantém o bloqueio.
 */
export function isTemporalOnlyServiceOfferSpanV2(
  span: string,
  evidencedSlots: ReadonlySet<string> = new Set()
): boolean {
  let remainder = normalize(span);
  const temporal = normalizeTemporalAssertionsV2(remainder);
  for (const assertion of [...temporal].sort(
    (left, right) => right.raw.length - left.raw.length
  )) {
    const raw = normalize(assertion.raw);
    if (!raw) continue;
    remainder = remainder.replace(new RegExp(escapeRegExp(raw), 'gu'), ' ');
  }
  const times = temporal.filter((assertion) => assertion.kind === 'time');
  const hadTemporalScheduleSignal = times.length > 0;
  remainder = remainder
    .replace(
      /\b(?:horarios?|horas?|vagas?|disponibilidades?|disponiv(?:el|eis)|agenda|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|feira|manha|tarde|noite|as|das|de|do|da|no|na|para|entre|ate|e|ou)\b/gu,
      ' '
    )
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return (
    hadTemporalScheduleSignal &&
    times.every((time) => evidencedSlots.has(time.normalized)) &&
    remainder === ''
  );
}

function isCapacityOnlyServiceOfferSpanV2(span: string): boolean {
  const remainder = normalize(span)
    .replace(
      /\b(?:horarios?|vagas?|disponibilidades?|disponiv(?:el|eis)|agenda|livre|cheia|lotada|espaco|hoje|amanha|de|do|da|no|na|para|e|ou)\b/gu,
      ' '
    )
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return remainder === '' && /\b(?:vagas?|disponibilidades?|agenda|espaco)\b/u.test(normalize(span));
}

export function isCatalogOnlyServiceOfferSpanV2(
  span: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  let remainder = normalize(span)
    .replace(
      /\b(?:e\s+)?(?:(?:se|caso)\s+(?:voce\s+)?(?:quiser|preferir)\s+)?(?:(?:podemos|posso)\s+(?:te\s+)?(?:ajudar\s+a\s+)?|(?:voce\s+)?(?:quer|deseja|gostaria\s+de)\s+)(?:agendar|marcar|verificar)(?:\s+(?:os?|um|uma)\s+)?(?:horarios?|dia|data)?\b[\s\S]*$/gu,
      ' '
    )
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(?:sim|claro|certamente|com certeza)$/u.test(remainder)) {
    // "Temos sim!" confirma a pergunta anterior; não contém uma entidade de
    // serviço e não pode converter "sim" em UNKNOWN_SERVICE_OFFER.
    return true;
  }
  const catalogEntities = catalog.services.map((service) => ({
    id: service.id,
    name: service.name,
  }));
  // Profissional é uma família tipada independente. Remove apenas a âncora
  // "com <nome>" quando o matcher canônico a resolve univocamente; nomes
  // ambíguos ou desconhecidos permanecem como resíduo e continuam fail-closed.
  remainder = remainder.replace(
    /\b(?:e\s+)?(?:e\s+)?com\s+(?:a|o)?\s*([a-z][a-z' -]{1,80})$/gu,
    (whole, claim: string) => {
      const professional = resolveCatalogEntityV2(
        claim.trim(),
        catalog.professionals
      );
      return professional.kind === 'resolved' ? ' ' : whole;
    }
  );
  remainder = remainder.replace(/\s+/gu, ' ').trim();
  const allowed = new Set([
    'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'ou',
    'servico', 'servicos', 'procedimento', 'procedimentos', 'sim', 'claro',
    'tambem', 'certamente', 'por', 'favor',
  ]);
  const stripTypedMetadataAfterResolution = (segment: string): string =>
    segment
      // Orações de duração. A entidade já foi resolvida antes deste limpador;
      // portanto estes fatos deixam de participar apenas do nome do serviço.
      .replace(
        /\s*,?\s*(?:que\s+)?(?:dura|leva|demora)\s+\d+(?:[.,]\d+)?\s*(?:min(?:uto)?s?|h|horas?)\b/gu,
        ' '
      )
      .replace(
        /\s*,?\s*(?:com\s+)?duracao\s+(?:de\s+)?\d+(?:[.,]\d+)?\s*(?:min(?:uto)?s?|h|horas?)\b/gu,
        ' '
      )
      // Orações de preço. UNKNOWN_PRICE continua validando o valor no
      // candidato integral; aqui só retiramos a cauda do span de serviço.
      .replace(
        /\s*,?\s*(?:e\s+)?(?:custa|sai\s+por)\s+(?:r\s*\$\s*)?\d+(?:[.,]\d{1,2})?(?:\s*reais?)?\b/gu,
        ' '
      )
      .replace(
        /\s*,?\s*(?:e\s+)?(?:por|a\s+partir\s+de)\s+r\s*\$\s*\d+(?:[.,]\d{1,2})?\b/gu,
        ' '
      )
      // Formas parentéticas/telegráficas já usadas nas copies canônicas.
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:min(?:uto)?s?|h|horas?)\b/gu, ' ')
      .replace(/\br\s*\$\s*\d+(?:[.,]\d{1,2})?\b/gu, ' ')
      .replace(/(?:^|\s)[,()]+|[,()]+(?:\s|$)/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  const isKnownSegment = (segment: string): boolean => {
    const canonical = resolveCatalogEntityV2(segment, catalogEntities);
    if (canonical.kind !== 'resolved') return false;
    const cleanedSegment = stripTypedMetadataAfterResolution(segment);
    const cleanedResolution = resolveCatalogEntityV2(
      cleanedSegment,
      catalogEntities
    );
    if (
      cleanedResolution.kind !== 'resolved' ||
      cleanedResolution.entity.id !== canonical.entity.id
    ) {
      return false;
    }
    const tokens = cleanedSegment.split(/[^a-z0-9]+/gu).filter(Boolean);
    const substantiveTokens = tokens.filter((token) => !allowed.has(token));
    if (substantiveTokens.length === 0) return false;

    const baseResolution = resolveUniqueCatalogEntityFromCurrentMessage(
      cleanedSegment,
      catalogEntities,
      { allowRestrictedDistanceTwo: false }
    );
    const canonicalTokens = new Set(
      normalize(canonical.entity.name)
        .split(/[^a-z0-9]+/gu)
        .filter(Boolean)
    );

    return tokens.every((token) => {
      if (allowed.has(token) || canonicalTokens.has(token)) return true;
      const baseToken = resolveUniqueCatalogEntityFromCurrentMessage(
        token,
        catalogEntities,
        { allowRestrictedDistanceTwo: false }
      );
      if (
        baseToken.kind === 'resolved' &&
        baseToken.entity.id === canonical.entity.id
      ) {
        return true;
      }
      const restrictedToken = resolveCatalogEntityV2(token, catalogEntities);
      if (
        restrictedToken.kind !== 'resolved' ||
        restrictedToken.entity.id !== canonical.entity.id
      ) {
        return false;
      }

      // D direto: o único token substantivo estabelece a entidade pelo
      // matcher canônico restrito (caso real "denajem" -> Drenagem).
      if (substantiveTokens.length === 1) return true;

      // C*: o resíduo só é perdoado quando ESTE segmento já resolvia E sem
      // distância 2 e nenhuma outra entidade toca a bola fechada do token.
      return (
        baseResolution.kind === 'resolved' &&
        baseResolution.entity.id === canonical.entity.id &&
        isClosedCatalogResidualForEntity(
          token,
          canonical.entity.id,
          catalogEntities
        )
      );
    });
  };

  if (isKnownSegment(remainder)) return true;

  // Uma enumeração é validada item a item. Ambiguidade do conjunto inteiro é
  // esperada, mas cada segmento entre vírgula/"e"/"ou" precisa resolver para
  // exatamente um serviço e não pode deixar modificador substantivo de fora
  // desse serviço ("drenagem a vapor" continua fail-closed).
  const segments = remainder
    .split(/\s*(?:,|\be\b|\bou\b)\s*/u)
    .map((segment) => segment.replace(/[^a-z0-9' -]+/gu, ' ').trim())
    .filter(Boolean);
  const everySegmentIsKnown =
    segments.length > 1 &&
    segments.every(isKnownSegment);
  if (everySegmentIsKnown) {
    return true;
  }

  return false;
}

function shouldDiscardTemporalOnlyUnknownServiceOfferV2(
  candidate: string,
  catalog: AuthoritativeOutboundCatalog,
  toolTrace: ToolTraceLike[]
): boolean {
  const positiveOffers = findServiceOfferMatchesV2(candidate).filter(
    (match) => match.positive
  );
  return (
    positiveOffers.length > 0 &&
    positiveOffers.every((match) =>
      isTemporalOnlyServiceOfferSpanV2(
        match.groups[0] ?? '',
        currentTurnSlotEvidenceV2(toolTrace)
      )
    ) &&
    !hasUnknownAppointmentServiceClaimV2(candidate, catalog)
  );
}

function hasUnknownAppointmentServiceClaimV2(
  candidate: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  return [
    ...normalize(candidate).matchAll(APPOINTMENT_SERVICE_CLAIM_RE_V2),
  ].some((match) => {
    const claim = match[1]?.trim() ?? '';
    return (
      claim.length > 0 &&
      !/^(?:equipe|cliente|recepcao|estabelecimento|clinica|sala)$/u.test(
        claim
      ) &&
      !isCatalogOnlyServiceOfferSpanV2(claim, catalog)
    );
  });
}

function currentTurnSlotEvidenceV2(toolTrace: ToolTraceLike[]): Set<string> {
  const turns = toolTrace
    .map((entry) => entry.userTurn)
    .filter((turn): turn is number => Number.isInteger(turn));
  const currentTurn = turns.length > 0 ? Math.max(...turns) : null;
  const slots = new Set<string>();
  for (const entry of toolTrace) {
    if (entry.name !== 'getAvailableSlots') continue;
    if (currentTurn !== null && entry.userTurn !== currentTurn) continue;
    const parsed = parseToolResult(entry.result);
    if (parsed?.success !== true || !Array.isArray(parsed.slots)) continue;
    const normalizedSlots: string[] = [];
    for (const rawSlot of parsed.slots) {
      if (typeof rawSlot !== 'string') {
        normalizedSlots.length = 0;
        break;
      }
      const times = normalizeTemporalAssertionsV2(rawSlot).filter(
        (assertion) => assertion.kind === 'time'
      );
      if (times.length !== 1) {
        normalizedSlots.length = 0;
        break;
      }
      normalizedSlots.push(times[0]!.normalized);
    }
    if (normalizedSlots.length !== parsed.slots.length) continue;
    for (const slot of normalizedSlots) slots.add(slot);
  }
  return slots;
}

/**
 * PendingFrame TIME OPEN é uma projeção entregue de uma leitura autoritativa.
 * Só reutiliza essa evidência em outro turno quando snapshot e FlowState ainda
 * descrevem exatamente o mesmo fluxo, data, serviço, profissional e slots.
 */
function pendingTimeSlotEvidenceV2(
  input: BoundaryEvaluationInputV2
): { date: string; slots: readonly string[] } | null {
  const pending = input.pendingSnapshot;
  const flow = input.flowState;
  const evidence = flow?.slotEvidence;
  if (
    input.pendingAnaOpen === false ||
    !pending ||
    pending.kind !== 'TIME' ||
    !flow ||
    !evidence ||
    pending.flowId !== flow.flowId ||
    flow.fixedServiceId !== evidence.serviceId ||
    flow.fixedProfessionalId !== evidence.professionalId ||
    flow.resolvedDate !== evidence.date ||
    !evidence.turnId.trim() ||
    pending.options.length === 0 ||
    !Number.isFinite(Date.parse(pending.askedAt))
  ) {
    return null;
  }
  const slots = pending.options.map((option) => option.entityId);
  if (
    new Set(slots).size !== slots.length ||
    pending.options.some((option, index) => option.position !== index + 1) ||
    slots.some(
      (slot) =>
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot) ||
        !evidence.slots.includes(slot)
    )
  ) {
    return null;
  }
  return { date: evidence.date, slots };
}

/**
 * Exceção v2 estrita para um resumo ainda não escrito. As quatro condições são
 * cumulativas; falha em qualquer uma preserva integralmente o reason herdado.
 */
export function isLicensedPreBookingSummaryV2(
  candidate: string,
  input: BoundaryEvaluationInputV2,
  catalog = input.authoritativeCatalog ??
    catalogFromServicesResult(input.servicesResult)
): boolean {
  const normalized = normalize(candidate);
  if (!PRE_BOOKING_CONFIRMATION_QUESTION_RE.test(normalized)) return false;
  if (/\bnao\s+(?:posso|podemos|confirma)\b/u.test(normalized)) return false;
  if (CONSUMMATED_APPOINTMENT_STATE_RE.test(normalized)) return false;

  const fixedServiceId = input.flowState?.fixedServiceId;
  if (!fixedServiceId) return false;
  const serviceResolution = resolveCatalogEntityV2(
    candidate,
    catalog.services
  );
  if (
    serviceResolution.kind !== 'resolved' ||
    serviceResolution.entity.id !== fixedServiceId
  ) {
    return false;
  }

  const licensedTimes = currentTurnSlotEvidenceV2(input.toolTrace ?? []);
  const pendingEvidence = pendingTimeSlotEvidenceV2(input);
  for (const slot of pendingEvidence?.slots ?? []) licensedTimes.add(slot);
  const draft = input.flowState?.bookingDraft;
  const slotEvidence = input.flowState?.slotEvidence;
  if (
    draft &&
    slotEvidence &&
    draft.slotEvidenceTurnId === slotEvidence.turnId &&
    draft.serviceId === slotEvidence.serviceId &&
    draft.date === slotEvidence.date &&
    slotEvidence.slots.includes(draft.time)
  ) {
    licensedTimes.add(draft.time);
  }
  const candidateTimes = normalizeTemporalAssertionsV2(candidate).filter(
    (assertion) => assertion.kind === 'time'
  );
  if (
    candidateTimes.length === 0 ||
    !candidateTimes.every((time) => licensedTimes.has(time.normalized))
  ) {
    return false;
  }
  const expectedDate =
    draft?.date ?? pendingEvidence?.date ?? input.flowState?.resolvedDate;
  if (!expectedDate || !candidateMentionsResolvedDateV2(candidate, expectedDate, input.temporalContext)) {
    return false;
  }
  const claims = professionalClaimsV2(candidate, catalog);
  return (
    claims.claimCount === 0 ||
    shouldDiscardUnknownProfessionalV2(candidate, input, catalog)
  );
}

function zonedCivilDate(now: Date, timezone: string): string | null {
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value])
    );
    return values.year && values.month && values.day
      ? `${values.year}-${values.month}-${values.day}`
      : null;
  } catch {
    return null;
  }
}

function plusCivilDays(iso: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days, 12));
  return date.toISOString().slice(0, 10);
}

function candidateMentionsResolvedDateV2(
  candidate: string,
  expectedDate: string,
  temporalContext?: AppointmentTemporalContext
): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(expectedDate);
  if (!match) return false;
  const normalized = normalize(candidate);
  const [, year, month, day] = match;
  const dayNumber = String(Number(day));
  const monthNumber = String(Number(month));
  if (
    [
      expectedDate,
      `${day}/${month}`,
      `${dayNumber}/${monthNumber}`,
      `${day}/${month}/${year}`,
      `${dayNumber}/${monthNumber}/${year}`,
    ].some((value) => normalized.includes(value))
  ) {
    return true;
  }
  const now = temporalContext
    ? temporalContext.now instanceof Date
      ? temporalContext.now
      : new Date(temporalContext.now)
    : null;
  const today =
    now && !Number.isNaN(now.getTime()) && temporalContext
      ? zonedCivilDate(now, temporalContext.timezone)
      : null;
  if (today === expectedDate && /\bhoje\b/u.test(normalized)) return true;
  if (today && plusCivilDays(today, 1) === expectedDate && /\bamanha\b/u.test(normalized)) return true;
  const weekday = [
    'domingo',
    'segunda',
    'terca',
    'quarta',
    'quinta',
    'sexta',
    'sabado',
  ][new Date(`${expectedDate}T12:00:00.000Z`).getUTCDay()];
  return Boolean(weekday && new RegExp(`\\b${weekday}(?: feira)?\\b`, 'u').test(normalized));
}

function hasIneligibleProfessionalForFlow(
  candidate: string,
  flowState: FlowStateV2 | undefined,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  if (!flowState?.fixedServiceId) return false;
  const service = catalog.services.find(
    (entry) => entry.id === flowState.fixedServiceId
  );
  if (!service?.professionalIds) return false;
  const normalizedCandidate = normalize(candidate);
  const fullNameIds = catalog.professionals
    .filter((professional) =>
      normalizedCandidate.includes(normalize(professional.name))
    )
    .map((professional) => professional.id);
  const partialNameIds = professionalClaimsV2(candidate, catalog).resolvedIds;
  return [...new Set([...fullNameIds, ...partialNameIds])].some(
    (professionalId) => !service.professionalIds!.includes(professionalId)
  );
}

function professionalClaimsV2(
  candidate: string,
  catalog: AuthoritativeOutboundCatalog
): {
  claimCount: number;
  resolvedIds: string[];
  allUniquelyResolved: boolean;
} {
  const claims = new Map<string, string>();
  for (const pattern of PROFESSIONAL_REFERENCE_PATTERNS_V2) {
    for (const match of candidate.matchAll(pattern)) {
      const claim = match.groups?.name?.trim();
      if (claim) claims.set(normalize(claim), claim);
    }
  }
  const resolvedIds: string[] = [];
  let allUniquelyResolved = claims.size > 0;
  for (const claim of claims.values()) {
    const resolution = resolveCatalogEntityV2(
      claim,
      catalog.professionals
    );
    if (resolution.kind !== 'resolved') {
      allUniquelyResolved = false;
      continue;
    }
    resolvedIds.push(resolution.entity.id);
  }
  return {
    claimCount: claims.size,
    resolvedIds: [...new Set(resolvedIds)],
    allUniquelyResolved,
  };
}

const PROFESSIONAL_STOPLIST_V2 = new Set([
  'ana',
  'atendente',
  'equipe',
  'recepcao',
  'recepcionista',
  'profissional',
  'especialista',
  'cliente',
  'dona',
  'dono',
]);

function inboundPositivelyResolvesProfessionalV2(
  inbound: string,
  professionalId: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  for (const clause of splitClausesV2(inbound)) {
    const resolution = resolveCatalogEntityV2(
      clause,
      catalog.professionals
    );
    if (resolution.kind !== 'resolved' || resolution.entity.id !== professionalId) continue;
    const name = normalize(resolution.entity.name);
    let index = clause.indexOf(name);
    if (index < 0) {
      for (const match of clause.matchAll(/\b[a-z0-9]+\b/gu)) {
        const tokenResolution = resolveCatalogEntityV2(
          match[0],
          catalog.professionals
        );
        if (
          tokenResolution.kind === 'resolved' &&
          tokenResolution.entity.id === professionalId
        ) {
          index = match.index ?? 0;
          break;
        }
      }
    }
    if (index < 0) continue;
    if (clauseMatchHasPositivePolarityV2(clause, index)) return true;
  }
  return false;
}

function toolTraceAnchorsProfessionalV2(
  toolTrace: ToolTraceLike[],
  professionalId: string
): boolean {
  return toolTrace.some((entry) => {
    const result = parseToolResult(entry.result);
    if (!result || result.professionalId !== professionalId) return false;
    if (entry.name === 'getAvailableSlots') return result.success === true;
    return (
      entry.name === 'bookAppointment' &&
      result.success === false &&
      ['blocked', 'conflict', 'outside_hours'].includes(String(result.reason))
    );
  });
}

function trustedFlowAnchorsProfessionalV2(
  input: BoundaryEvaluationInputV2,
  professionalId: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  const flow = input.flowState;
  if (
    flow?.fixedProfessionalId !== professionalId ||
    !flow.fixedServiceId ||
    flow.fixedByProofVersion.fixedProfessionalId !==
      flow.fixedByProofVersion.fixedServiceId
  ) {
    return false;
  }
  const service = catalog.services.find((entry) => entry.id === flow.fixedServiceId);
  return Boolean(
    service &&
      (service.professionalIds === undefined ||
        service.professionalIds.includes(professionalId))
  );
}

function uniqueEligibleProfessionalAnchorsV2(
  input: BoundaryEvaluationInputV2,
  professionalId: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  const serviceId = input.flowState?.fixedServiceId;
  if (!serviceId) return false;
  const service = catalog.services.find((entry) => entry.id === serviceId);
  if (!service) return false;
  const activeProfessionalIds = new Set(
    catalog.professionals.map((professional) => professional.id)
  );
  const eligibleIds = (service.professionalIds ?? [...activeProfessionalIds])
    .filter((id) => activeProfessionalIds.has(id));
  return eligibleIds.length === 1 && eligibleIds[0] === professionalId;
}

function shouldDiscardUnknownProfessionalV2(
  candidate: string,
  input: BoundaryEvaluationInputV2,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  const claims = professionalClaimsV2(candidate, catalog);
  if (!claims.allUniquelyResolved || claims.resolvedIds.length === 0) return false;
  const inbound = input.sourceInboundText ?? '';
  return claims.resolvedIds.every((professionalId) => {
    const professional = catalog.professionals.find(
      (entry) => entry.id === professionalId
    );
    if (!professional) return false;
    const tokens = normalize(professional.name).split(/\s+/u);
    if (tokens.some((token) => PROFESSIONAL_STOPLIST_V2.has(token))) return false;
    return (
      inboundPositivelyResolvesProfessionalV2(inbound, professionalId, catalog) ||
      toolTraceAnchorsProfessionalV2(input.toolTrace ?? [], professionalId) ||
      trustedFlowAnchorsProfessionalV2(input, professionalId, catalog) ||
      uniqueEligibleProfessionalAnchorsV2(input, professionalId, catalog)
    );
  });
}

export function shouldProhibitServiceRelistV2(
  flowState: FlowStateV2 | undefined,
  pendingTransitionCandidate: PendingTransitionCandidate | undefined
): boolean {
  return Boolean(
    flowState?.fixedServiceId &&
      !(
        pendingTransitionCandidate?.kind === 'open' &&
        pendingTransitionCandidate.pendingKind === 'SERVICE'
      )
  );
}

function looksLikeServiceRelist(
  candidate: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  const normalized = normalize(candidate);
  const mentioned = catalog.services.filter((service) =>
    normalized.includes(normalize(service.name))
  );
  return (
    mentioned.length >= 2 ||
    /\b(?:qual|quais)\s+(?:servico|procedimento)|qual\s+(?:servico|procedimento)\s+(?:voce\s+)?(?:prefere|quer)\b/iu.test(
      normalized
    )
  );
}

function socialTemporalEchoLicensed(
  candidate: string,
  input: BoundaryEvaluationInputV2
): boolean {
  const candidateTemporal = normalizeTemporalAssertionsV2(candidate);
  if (candidateTemporal.length === 0) return true;
  const spanText = currentSpanText(input.socialTemporalEvidence, input);
  if (!spanText) return false;
  const licensed = new Set(
    normalizeTemporalAssertionsV2(spanText).map(
      (assertion) => `${assertion.kind}:${assertion.normalized}`
    )
  );
  return candidateTemporal.every((assertion) =>
    licensed.has(`${assertion.kind}:${assertion.normalized}`)
  );
}

function socialRouteReasons(
  candidate: string,
  input: BoundaryEvaluationInputV2,
  catalog: AuthoritativeOutboundCatalog
): BoundaryReasonCodeV2[] {
  if (input.replyPurpose !== 'SOCIAL') return [];
  const reasons = new Set<BoundaryReasonCodeV2>();
  const normalized = normalize(candidate);
  const checks: Array<[RegExp, BoundaryReasonCodeV2]> = [
    [SOCIAL_BUSINESS_HOURS_RE, 'SOCIAL_BUSINESS_HOURS_FACT'],
    [SOCIAL_PRICE_FACT_RE, 'SOCIAL_PRICE_FACT'],
    [SOCIAL_COMMERCE_RE, 'SOCIAL_COMMERCE_FACT'],
    [SOCIAL_ADDRESS_RE, 'SOCIAL_ADDRESS_FACT'],
    [SOCIAL_CAPACITY_RE, 'SOCIAL_CAPACITY_FACT'],
    [SOCIAL_DURATION_RE, 'SOCIAL_DURATION_FACT'],
    [SOCIAL_STAFF_RE, 'SOCIAL_STAFF_FACT'],
    [SOCIAL_PARALLEL_CHANNEL_RE, 'SOCIAL_PARALLEL_CHANNEL'],
    [SOCIAL_CLINICAL_CLAIM_RE, 'SOCIAL_CLINICAL_CLAIM'],
    [SOCIAL_ATTENDANCE_INSTRUCTION_RE, 'SOCIAL_ATTENDANCE_INSTRUCTION'],
    [SOCIAL_PERSON_IDENTITY_FACT_RE, 'SOCIAL_PERSON_IDENTITY_FACT'],
    [SOCIAL_HUMAN_RETURN_RE, 'SOCIAL_HUMAN_RETURN_PROMISE'],
    [SOCIAL_OPERATIONAL_FACT_RE, 'SOCIAL_OPERATIONAL_FACT'],
  ];
  for (const [matcher, reason] of checks) {
    if (matcher.test(normalized)) reasons.add(reason);
  }
  if (
    catalog.services.some((service) =>
      normalized.includes(normalize(service.name))
    ) ||
    catalog.professionals.some((professional) =>
      normalized.includes(normalize(professional.name))
    )
  ) {
    reasons.add('SOCIAL_OPERATIONAL_FACT');
  }
  const recent = new Set(
    (input.recentAssistantReplies ?? []).map((reply) => normalize(reply))
  );
  if (normalized && recent.has(normalized)) {
    reasons.add('SOCIAL_RECENT_REPLY_REPETITION');
  }
  const sentenceCount = candidate
    .split(/[.!?]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length;
  const emojiCount =
    candidate.match(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu)
      ?.length ?? 0;
  if (sentenceCount < 1 || sentenceCount > 2 || emojiCount > 1) {
    reasons.add('SOCIAL_FORMAT_VIOLATION');
  }
  if (!socialTemporalEchoLicensed(candidate, input)) {
    reasons.add('UNLICENSED_SOCIAL_TEMPORAL_ECHO');
  }
  return [...reasons];
}

function v2FactReasons(
  normalizedCandidate: string,
  input: BoundaryEvaluationInputV2,
  catalog: AuthoritativeOutboundCatalog
): BoundaryReasonCodeV2[] {
  const reasons = new Set<BoundaryReasonCodeV2>();
  const toolTrace = input.toolTrace ?? [];
  const denialClaim = UNAVAILABLE_DENIAL_RE.test(normalize(normalizedCandidate));
  const denialLicensed = denialClaim && unknownServiceDenialLicensedV2(input, catalog);
  if (
    hasUnknownServiceOffer(
      normalizedCandidate,
      catalog,
      toolTrace
    ) ||
    hasUnknownAppointmentServiceClaimV2(normalizedCandidate, catalog)
  ) {
    reasons.add('UNKNOWN_SERVICE_OFFER');
  }
  if (
    denialClaim &&
    (!denialLicensed || normalizedCandidate.trim() !== UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2)
  ) {
    reasons.add('UNLICENSED_SERVICE_UNAVAILABLE_DENIAL');
  }
  if (
    SOFT_AVAILABILITY_RE.test(normalize(normalizedCandidate)) &&
    !availabilityClaimLicensed(normalizedCandidate, input)
  ) {
    reasons.add('UNVERIFIED_AVAILABILITY');
  }
  if (
    IMPLICIT_COMMITMENT_RE.test(normalize(normalizedCandidate)) &&
    hasTemporalAssertionV2(normalizedCandidate) &&
    !hasCompatibleWriteOrRead(toolTrace)
  ) {
    reasons.add('UNVERIFIED_IMPLICIT_COMMITMENT');
  }
  if (hasIneligibleProfessionalForFlow(normalizedCandidate, input.flowState, catalog)) {
    reasons.add('INELIGIBLE_PROFESSIONAL');
  }
  if (
    !input.serviceRelistExempt &&
    shouldProhibitServiceRelistV2(input.flowState, input.pendingTransitionCandidate) &&
    looksLikeServiceRelist(normalizedCandidate, catalog)
  ) {
    reasons.add('SERVICE_RELIST_AFTER_FIXED');
  }
  for (const reason of socialRouteReasons(input.rawCandidate, input, catalog)) {
    reasons.add(reason);
  }
  return [...reasons];
}

function repeatedClarificationReasonsV2(
  normalizedCandidate: string,
  input: BoundaryEvaluationInputV2
): BoundaryReasonCodeV2[] {
  const pending = input.pendingSnapshot;
  const recent = new Set(
    (input.recentAssistantReplies ?? []).map((reply) => normalize(reply))
  );
  if (!normalizedCandidate || !recent.has(normalize(normalizedCandidate))) {
    return [];
  }
  const canonicalPending = pending
    ? buildPendingQuestionV2({
        pending,
        flowState: input.flowState ?? {
          flowId: pending.flowId,
          fixedByProofVersion: {},
        },
        catalog: input.servicesResult,
      })
    : null;
  // Somente a copy normativa de CONFIRMATION (booking ou duplicidade) é
  // repetível: ela reancora gates de escrita. Outra clarificação repetida no
  // mesmo estado, inclusive sem PendingFrame, continua bloqueada.
  if (
    pending?.kind === 'CONFIRMATION' &&
    canonicalPending !== null &&
    normalize(canonicalPending) === normalize(normalizedCandidate)
  ) {
    return [];
  }
  const clarificationLike =
    input.replyPurpose === 'CLARIFICATION' ||
    (canonicalPending !== null &&
      normalize(canonicalPending) === normalize(normalizedCandidate));
  return clarificationLike ? ['REPEATED_CLARIFICATION'] : [];
}

function outboundReason(
  reason: OutboundReasonCode,
  input: BoundaryEvaluationInputV2,
  normalizedCandidate: string,
  catalog: AuthoritativeOutboundCatalog
): BoundaryReasonCodeV2 | null {
  if (reason === 'UNKNOWN_SERVICE') {
    const denialClaim = UNAVAILABLE_DENIAL_RE.test(normalize(normalizedCandidate));
    if (
      denialClaim &&
      normalizedCandidate.trim() === UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2 &&
      unknownServiceDenialLicensedV2(input, catalog)
    ) {
      return null;
    }
    return denialClaim
      ? 'UNLICENSED_SERVICE_UNAVAILABLE_DENIAL'
      : 'UNKNOWN_SERVICE_OFFER';
  }
  const mapping: Exclude<Record<OutboundReasonCode, BoundaryReasonCodeV2>, 'UNKNOWN_SERVICE'> &
    Record<string, BoundaryReasonCodeV2> = {
    PAYLOAD_BLOCK_MISMATCH: 'PAYLOAD_BLOCK_MISMATCH',
    MALFORMED_ENVELOPE: 'MALFORMED_ENVELOPE',
    UNSUPPORTED_CONTRACT: 'UNSUPPORTED_CONTRACT',
    EMPTY_PAYLOAD: 'EMPTY_PAYLOAD',
    UNKNOWN_PRICE: 'UNKNOWN_PRICE',
    UNKNOWN_SERVICE: 'UNKNOWN_SERVICE_OFFER',
    UNVERIFIED_AVAILABILITY: 'UNVERIFIED_AVAILABILITY',
    UNKNOWN_PROFESSIONAL: 'UNKNOWN_PROFESSIONAL',
    INELIGIBLE_PROFESSIONAL: 'INELIGIBLE_PROFESSIONAL',
    HUMAN_RESPONSE_DEADLINE: 'HUMAN_RESPONSE_DEADLINE',
    EXPLICIT_PII: 'EXPLICIT_PII',
    TOO_MANY_EMOJIS: 'TOO_MANY_EMOJIS',
    UNRECORDED_HANDOFF: 'UNRECORDED_HANDOFF',
    UNAUTHORIZED_CLINICAL_PROMISE: 'UNAUTHORIZED_CLINICAL_PROMISE',
    UNLICENSED_SERVICE_DESCRIPTION: 'UNLICENSED_SERVICE_DESCRIPTION',
    INTERNAL_CONVERSATION_MARKER: 'INTERNAL_CONVERSATION_MARKER',
    UNVERIFIED_APPOINTMENT_CONTEXT: 'UNVERIFIED_APPOINTMENT_CONTEXT',
    SOCIAL_CONTEXT_DRIFT: 'SOCIAL_CONTEXT_DRIFT',
    UNSAFE_CUSTOMER_IDENTITY_RESPONSE: 'UNSAFE_CUSTOMER_IDENTITY_RESPONSE',
  };
  return mapping[reason];
}

function stage(
  stageName: BoundaryStageEvaluationV2['stage'],
  reasons: BoundaryReasonCodeV2[]
): BoundaryStageEvaluationV2 {
  return { stage: stageName, safe: reasons.length === 0, reasonCodes: reasons };
}

export function evaluateBoundaryV2(
  input: BoundaryEvaluationInputV2
): BoundaryEvaluation {
  const catalog =
    input.authoritativeCatalog ?? catalogFromServicesResult(input.servicesResult);
  const toolTrace = input.toolTrace ?? [];
  const rawReasons = rawLeakReasons(input);
  const normalizedCandidate = normalizeCandidatePreservingLicensedDescriptionV2(
    input.rawCandidate,
    input,
    catalog
  );
  const normalizationReasons: BoundaryReasonCodeV2[] = normalizedCandidate.trim()
    ? []
    : ['EMPTY_PAYLOAD'];
  const licensedProjection = licensedBoundaryProjectionV2(
    normalizedCandidate,
    input,
    catalog
  );
  const factCheckedCandidate = licensedProjection.factCheckedCandidate;

  const inspection = inspectCustomerReply(
    factCheckedCandidate,
    input.servicesResult,
    input.forbiddenAppointmentIds ?? [],
    toolTrace,
    input.sourceInboundText,
    input.temporalContext,
    pendingTimeSlotEvidenceV2(input)?.slots ?? []
  );
  const discardedPreBookingAppointmentContext =
    inspection.reasons.includes('unverified_appointment_context') &&
    isLicensedPreBookingSummaryV2(normalizedCandidate, input, catalog);
  const effectiveInspectionReasons = discardedPreBookingAppointmentContext
    ? inspection.reasons.filter(
        (reason) => reason !== 'unverified_appointment_context'
      )
    : inspection.reasons;
  const licensedHardGuardReasons = licensedDescriptionHardGuardReasonsV2(
    normalizedCandidate,
    input,
    licensedProjection,
    toolTrace
  );
  const guardReasons = [
    ...effectiveInspectionReasons.map(customerGuardReason),
    ...licensedHardGuardReasons.map(customerGuardReason),
    ...v2FactReasons(factCheckedCandidate, input, catalog),
    ...repeatedClarificationReasonsV2(factCheckedCandidate, input),
  ];

  const outbound = validateReceptionistOutbound(
    buildReceptionistEnvelope({
      exactPayload: normalizedCandidate,
      purpose:
        input.replyPurpose === 'SERVICE_QUESTION' ? 'SERVICE_QUESTION' : 'REACTIVE',
      blocks: licensedProjection.blocks,
      authoritativeCatalog: catalog,
      evidence: {
        ...input.outboundEvidence,
        toolTrace,
        sourceInboundText: input.sourceInboundText,
        actionRecorded: input.actionRecorded,
        temporalContext: input.temporalContext,
        verifiedAvailabilitySlots:
          pendingTimeSlotEvidenceV2(input)?.slots ?? [],
        ...(input.replyPurpose === 'SOCIAL'
          ? { disableSocialContextDrift: true }
          : {}),
      },
    })
  );
  const mappedOutboundReasons = outbound.reasonCodes
    .map((reason) => outboundReason(reason, input, normalizedCandidate, catalog))
    .filter((reason): reason is BoundaryReasonCodeV2 => reason !== null);
  const discardedTemporalOnlyServiceOffer =
    mappedOutboundReasons.includes('UNKNOWN_SERVICE_OFFER') &&
    shouldDiscardTemporalOnlyUnknownServiceOfferV2(
      normalizedCandidate,
      catalog,
      toolTrace
    ) &&
    !hasUnknownServiceOffer(
      normalizedCandidate,
      catalog,
      toolTrace
    );
  const positiveCapacityOffers = findServiceOfferMatchesV2(
    normalizedCandidate
  ).filter((match) => match.positive);
  const discardedCapacityOnlyServiceOffer =
    mappedOutboundReasons.includes('UNKNOWN_SERVICE_OFFER') &&
    positiveCapacityOffers.length > 0 &&
    positiveCapacityOffers.every((match) =>
      isCapacityOnlyServiceOfferSpanV2(match.groups[0] ?? '')
    ) &&
    guardReasons.includes('UNVERIFIED_AVAILABILITY');
  const discardedCanonicalCatalogServiceOffer =
    mappedOutboundReasons.includes('UNKNOWN_SERVICE_OFFER') &&
    positiveCapacityOffers.length > 0 &&
    positiveCapacityOffers.every((match) =>
      isCatalogOnlyServiceOfferSpanV2(
        match.groups[0] ?? '',
        catalog
      )
    ) &&
    !hasUnknownAppointmentServiceClaimV2(normalizedCandidate, catalog);
  const temporalFilteredReasons =
    discardedTemporalOnlyServiceOffer ||
    discardedCapacityOnlyServiceOffer ||
    discardedCanonicalCatalogServiceOffer
    ? mappedOutboundReasons.filter(
        (reason) => reason !== 'UNKNOWN_SERVICE_OFFER'
      )
    : mappedOutboundReasons;
  const discardedOutboundPreBookingContext =
    temporalFilteredReasons.includes('UNVERIFIED_APPOINTMENT_CONTEXT') &&
    isLicensedPreBookingSummaryV2(normalizedCandidate, input, catalog);
  const appointmentFilteredReasons = discardedOutboundPreBookingContext
    ? temporalFilteredReasons.filter(
        (reason) => reason !== 'UNVERIFIED_APPOINTMENT_CONTEXT'
      )
    : temporalFilteredReasons;
  const discardedUniquePartialProfessional =
    appointmentFilteredReasons.includes('UNKNOWN_PROFESSIONAL') &&
    shouldDiscardUnknownProfessionalV2(normalizedCandidate, input, catalog);
  const professionalFilteredReasons = discardedUniquePartialProfessional
    ? appointmentFilteredReasons.filter(
        (reason) => reason !== 'UNKNOWN_PROFESSIONAL'
      )
    : appointmentFilteredReasons;
  const discardedInheritedDrift =
    professionalFilteredReasons.includes('SOCIAL_CONTEXT_DRIFT') &&
    !shouldKeepInheritedSocialContextDriftV2(input);
  const outboundReasons = discardedInheritedDrift
    ? professionalFilteredReasons.filter(
        (reason) => reason !== 'SOCIAL_CONTEXT_DRIFT'
      )
    : professionalFilteredReasons;

  const stages = [
    stage('raw_candidate_scan', [...new Set(rawReasons)]),
    stage('mechanical_normalization', [...new Set(normalizationReasons)]),
    stage('customer_reply_guard', [...new Set(guardReasons)]),
    stage('receptionist_outbound', [...new Set(outboundReasons)]),
  ];
  const reasonCodes = [
    ...new Set(stages.flatMap((entry) => entry.reasonCodes)),
  ];
  const safe = reasonCodes.length === 0 && effectiveInspectionReasons.length === 0;
  const originalAccepted =
    outboundReasons.length === 0 &&
    (outbound.originalAccepted ||
      discardedTemporalOnlyServiceOffer ||
      discardedCapacityOnlyServiceOffer ||
      discardedCanonicalCatalogServiceOffer ||
      discardedPreBookingAppointmentContext ||
      discardedOutboundPreBookingContext ||
      discardedInheritedDrift ||
      discardedUniquePartialProfessional);
  return {
    kind: 'boundary_evaluation_v2',
    safe,
    originalAccepted,
    acceptedPayload:
      safe && originalAccepted
        ? outbound.payload.trim() || normalizedCandidate
        : '',
    normalizedCandidate,
    reasonCodes,
    stages,
  };
}
