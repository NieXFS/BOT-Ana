import { createHash } from 'crypto';
import type { TenantBotConfig } from '../configProvider';
import type { ServicesResult } from './calendarService';
import { sendFreeformMessage } from '../whatsappCloudService';
import {
  HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE,
  HUMAN_ECHO_PREFIX,
  HUMAN_MODEL_CONTEXT_PREFIX,
} from './humanConversationContext';
import {
  hasUnverifiedExistingAppointmentContext,
  type AppointmentTemporalContext,
} from './customerReplyGuard';
import {
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
  toolTraceHasCustomerIdentityAmbiguity,
} from './customerIdentitySafety';
import { classifyReceptionistTurnPermission } from './receptionistSocialSafety';

export { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from './customerIdentitySafety';

/** @deprecated Rejeições da fronteira final agora são silenciosas e nunca enviam fallback. */
export const RECEPTIONIST_SAFE_FALLBACK =
  'Desculpe, não consegui responder com segurança agora. A equipe do estabelecimento pode ajudar por aqui.';

export type ReceptionistOutboundSource =
  | 'GENERATED'
  | 'GREETING'
  | 'POST_BOOKING'
  | 'APPROVED_RESPONSE'
  | 'TEAM_REPLY'
  | 'CANONICAL';

export type ReceptionistOutboundPurpose =
  | 'REACTIVE'
  | 'SERVICE_QUESTION'
  | 'ESCALATION'
  | 'RECOVERY'
  | 'FLUSH_FALLBACK'
  | 'OUTSIDE_HOURS'
  | 'TRANSCRIPTION_FALLBACK'
  | 'OPT_OUT'
  | 'TEAM_REPLY';

export interface ReceptionistOutboundBlock {
  source: ReceptionistOutboundSource;
  text: string;
}

export interface ClinicalAuthorization {
  blockHash: string;
  acceptedAt: string;
  acceptedBy: string;
  detectedAssertions: string[];
  clinicalCapability: boolean;
}

export interface TeamReplyAuthorization {
  authoredAt: string;
  authoredBy: string;
  questionId: string;
  clinicalCapability: boolean;
}

export interface OutboundCatalogService {
  id: string;
  name: string;
  price?: number | null;
  priceCents?: number | null;
  durationMinutes?: number | null;
  professionalIds?: string[];
}

export interface OutboundCatalogProfessional {
  id: string;
  name: string;
  active?: boolean;
}

export interface AuthoritativeOutboundCatalog {
  services: OutboundCatalogService[];
  professionals: OutboundCatalogProfessional[];
  capturedAt?: string;
}

export interface ReceptionistOutboundEvidence {
  toolTrace?: Array<{ name: string; result: string; round?: number }>;
  /** Falha de identidade detectada pelo ERP; nunca depende de paráfrase do modelo. */
  customerIdentityAmbiguous?: boolean;
  actionRecorded?: boolean;
  clinicalAuthorization?: ClinicalAuthorization;
  teamReplyAuthorization?: TeamReplyAuthorization;
  sourceInboundMessageId?: string;
  /** Texto do inbound atual, somente em memória, para impedir fatos adicionados. */
  sourceInboundText?: string;
  /** Instante e fuso do turno usados para validar hoje/amanhã deterministicamente. */
  temporalContext?: AppointmentTemporalContext;
}

export interface ReceptionistOutboundEnvelope {
  contractVersion: 1;
  exactPayload: string;
  blocks: ReceptionistOutboundBlock[];
  purpose: ReceptionistOutboundPurpose;
  authoritativeCatalog: AuthoritativeOutboundCatalog;
  evidence?: ReceptionistOutboundEvidence;
}

export type OutboundReasonCode =
  | 'PAYLOAD_BLOCK_MISMATCH'
  | 'MALFORMED_ENVELOPE'
  | 'UNSUPPORTED_CONTRACT'
  | 'EMPTY_PAYLOAD'
  | 'UNKNOWN_PRICE'
  | 'UNKNOWN_SERVICE'
  | 'UNVERIFIED_AVAILABILITY'
  | 'UNKNOWN_PROFESSIONAL'
  | 'INELIGIBLE_PROFESSIONAL'
  | 'HUMAN_RESPONSE_DEADLINE'
  | 'EXPLICIT_PII'
  | 'TOO_MANY_EMOJIS'
  | 'UNRECORDED_HANDOFF'
  | 'UNAUTHORIZED_CLINICAL_PROMISE'
  | 'INTERNAL_CONVERSATION_MARKER'
  | 'UNVERIFIED_APPOINTMENT_CONTEXT'
  | 'SOCIAL_CONTEXT_DRIFT'
  | 'UNSAFE_CUSTOMER_IDENTITY_RESPONSE';

export interface ValidatedReceptionistOutbound {
  readonly kind: 'validated_receptionist_outbound';
  payload: string;
  originalAccepted: boolean;
  reasonCodes: OutboundReasonCode[];
  purpose: ReceptionistOutboundPurpose;
  sources: ReceptionistOutboundSource[];
}

const MONEY_RE = /(?:R\$\s*(?<prefixed>\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(?<worded>\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*reais?\b)/giu;
const TIME_OFFER_RE = /\b(?:temos?|dispon[ií]ve(?:l|is)|hor[aá]rios?)\b[^.!?\n]{0,60}\b([01]?\d|2[0-3])(?:[:h]([0-5]\d))\b/giu;
const HUMAN_DEADLINE_RE = /\b(?:equipe|atendente|profissional|respons[aá]vel)\b[^.!?\n]{0,80}\b(?:em|dentro de|at[eé])\s+\d+\s*(?:minutos?|horas?|dias?)\b/iu;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/u;
const PHONE_RE = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/u;
const RECORD_RE = /\b(?:prontu[aá]rio|paciente|cliente)\s*(?:n[ºo°.]?|id|:)?\s*[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+)+/iu;
const HANDOFF_RE = new RegExp(
  String.raw`\b(?:vou|vamos|irei|iremos)\s+(?:te\s+)?(?:transf\u0065rir|enc\u0061minhar|passar|acionar|chamar)\b|\b(?:enc\u0061minhei|transf\u0065ri|acionei|chamei)\b`,
  'iu'
);
const CLINICAL_RE = /\b(?:diagn[oó]stic[oa]|diagnosticamos|cura|curamos|elimina|resolve|garante|garantimos|n[aã]o\s+d[oó]i|sem\s+dor|resultado\s+garantido|adequad[oa]\s+para|indicad[oa]\s+para|seguro\s+para|eficaz)\b/iu;

export function containsInternalConversationMarker(text: string): boolean {
  const compact = text.trim();
  const normalizedCompact = normalize(compact).replace(/\s+/g, ' ');
  const normalizedFormerFallback = normalize(RECEPTIONIST_SAFE_FALLBACK)
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '');
  return (
    normalizedCompact.includes(normalize(HUMAN_ECHO_PREFIX.trim())) ||
    normalizedCompact.includes(normalize(HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE)) ||
    normalizedCompact.includes(normalize(HUMAN_MODEL_CONTEXT_PREFIX.trim())) ||
    normalizedCompact.includes('conteudo serializado:') ||
    /\b(?:a\s+)?atendente\s+(?:humana\s+)?(?:enviou|mandou)\s+(?:um|uma)\s+(?:audio|mensagem de voz)\b/.test(
      normalizedCompact
    ) ||
    normalizedCompact.replace(/[.!?\p{Extended_Pictographic}\uFE0F\s]+$/gu, '') ===
      normalizedFormerFallback
  );
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function traceHasCustomerIdentityAmbiguity(
  evidence?: ReceptionistOutboundEvidence
): boolean {
  if (evidence?.customerIdentityAmbiguous) return true;
  return toolTraceHasCustomerIdentityAmbiguity(evidence?.toolTrace);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textWithoutKnownServiceNames(
  text: string,
  catalog: AuthoritativeOutboundCatalog
): string {
  return [...catalog.services]
    .sort((left, right) => right.name.length - left.name.length)
    .reduce(
      (remaining, service) =>
        remaining.replace(new RegExp(escapeRegExp(service.name), 'giu'), ' '),
      text
    );
}

function introducesCatalogInformation(
  normalizedText: string,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  return (
    catalog.services.some((service) =>
      normalizedText.includes(normalize(service.name))
    ) ||
    catalog.professionals.some((professional) =>
      normalizedText.includes(normalize(professional.name))
    )
  );
}

function introducesAppointmentStateOrAvailability(normalizedText: string): boolean {
  return (
    /\b(?:agend\w*|marc\w*|remarc\w*|reagend\w*|cancel\w*|desmarc\w*|horario|retorno|vaga|disponibilidade|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|estara a sua espera|ficara a sua espera|te aguarda)\b/u.test(
      normalizedText
    ) ||
    /\b(?:[01]?\d|2[0-3])(?::\d{2}|h(?:\d{2})?)\b/u.test(
      normalizedText
    ) ||
    /\b(?:as|para|pras?)\s+(?:zero|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|quinze|vinte)\b/u.test(
      normalizedText
    )
  );
}

export function outboundBlockHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function catalogFromServicesResult(result: ServicesResult): AuthoritativeOutboundCatalog {
  return {
    services: (result.services ?? []).map((service) => ({
      id: service.id,
      name: service.name,
      price: service.price,
      durationMinutes: service.durationMinutes,
      professionalIds: service.professionalIds,
    })),
    professionals: (result.professionals ?? []).map((professional) => ({
      id: professional.id,
      name: professional.name,
      active: true,
    })),
  };
}

export function catalogFromConfig(config: TenantBotConfig): AuthoritativeOutboundCatalog {
  return config.authoritativeCatalog ?? { services: [], professionals: [] };
}

export function buildReceptionistEnvelope(input: Omit<ReceptionistOutboundEnvelope, 'contractVersion' | 'exactPayload'> & { exactPayload?: string }): ReceptionistOutboundEnvelope {
  return {
    contractVersion: 1,
    ...input,
    exactPayload: input.exactPayload ?? input.blocks.map((block) => block.text).join(''),
  };
}

function knownPrices(catalog: AuthoritativeOutboundCatalog): Set<number> {
  const prices = new Set<number>();
  for (const service of catalog.services) {
    if (typeof service.priceCents === 'number') prices.add(Math.round(service.priceCents));
    if (typeof service.price === 'number') prices.add(Math.round(service.price * 100));
  }
  return prices;
}

function currencyTextToCents(raw: string): number | null {
  const compact = raw.replace(/\s+/g, '');
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? /\./g : /,/g;
    normalized = compact.replace(groupingSeparator, '').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    const dotCount = (compact.match(/\./g) ?? []).length;
    const trailingDigits = compact.length - lastDot - 1;
    normalized = dotCount > 1 || trailingDigits === 3
      ? compact.replace(/\./g, '')
      : compact;
  } else {
    normalized = compact;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function offeredSlots(evidence?: ReceptionistOutboundEvidence): Set<string> {
  const slots = new Set<string>();
  for (const entry of evidence?.toolTrace ?? []) {
    if (entry.name !== 'getAvailableSlots' && entry.name !== 'bookAppointment') continue;
    try {
      const parsed = JSON.parse(entry.result) as { success?: unknown; slots?: unknown; reason?: unknown; availableSlots?: unknown };
      const values = entry.name === 'getAvailableSlots' && parsed.success === true
        ? parsed.slots
        : parsed.success === false && ['blocked', 'conflict', 'outside_hours'].includes(String(parsed.reason))
          ? parsed.availableSlots
          : [];
      if (Array.isArray(values)) for (const slot of values) if (typeof slot === 'string') slots.add(slot);
    } catch { /* invalid trace is not evidence */ }
  }
  return slots;
}

function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

function clinicalAuthorized(block: ReceptionistOutboundBlock, evidence?: ReceptionistOutboundEvidence): boolean {
  if (block.source === 'TEAM_REPLY') {
    const team = evidence?.teamReplyAuthorization;
    return Boolean(
      team?.clinicalCapability &&
      team.authoredBy.trim() &&
      team.questionId.trim() &&
      !Number.isNaN(Date.parse(team.authoredAt))
    );
  }
  if (block.source !== 'APPROVED_RESPONSE') return false;
  const auth = evidence?.clinicalAuthorization;
  return Boolean(
    auth?.clinicalCapability &&
    auth.acceptedBy.trim() &&
    !Number.isNaN(Date.parse(auth.acceptedAt)) &&
    auth.detectedAssertions.length > 0 &&
    auth.blockHash === outboundBlockHash(block.text)
  );
}

export function validateReceptionistOutbound(envelope: ReceptionistOutboundEnvelope): ValidatedReceptionistOutbound {
  const reasons = new Set<OutboundReasonCode>();
  if (envelope.contractVersion !== 1) reasons.add('UNSUPPORTED_CONTRACT');
  const rawBlocks = Array.isArray(envelope.blocks) ? envelope.blocks : [];
  const blocks = rawBlocks.filter(
    (block): block is ReceptionistOutboundBlock =>
      Boolean(
        block &&
        typeof block.text === 'string' &&
        ['GENERATED', 'GREETING', 'POST_BOOKING', 'APPROVED_RESPONSE', 'TEAM_REPLY', 'CANONICAL'].includes(block.source)
      )
  );
  if (blocks.length !== rawBlocks.length || blocks.length === 0) {
    reasons.add('MALFORMED_ENVELOPE');
  }
  const catalog: AuthoritativeOutboundCatalog = {
    services: Array.isArray(envelope.authoritativeCatalog?.services)
      ? envelope.authoritativeCatalog.services.filter(
          (service) =>
            Boolean(
              service &&
              typeof service.id === 'string' &&
              typeof service.name === 'string'
            )
        )
      : [],
    professionals: Array.isArray(envelope.authoritativeCatalog?.professionals)
      ? envelope.authoritativeCatalog.professionals.filter(
          (professional) =>
            Boolean(
              professional &&
              typeof professional.id === 'string' &&
              typeof professional.name === 'string'
            )
        )
      : [],
    capturedAt: envelope.authoritativeCatalog?.capturedAt,
  };
  const joined = blocks.map((block) => block.text).join('');
  if (typeof envelope.exactPayload !== 'string' || !envelope.exactPayload.trim()) reasons.add('EMPTY_PAYLOAD');
  if (joined !== envelope.exactPayload) reasons.add('PAYLOAD_BLOCK_MISMATCH');

  const text = typeof envelope.exactPayload === 'string' ? envelope.exactPayload : '';
  if (
    traceHasCustomerIdentityAmbiguity(envelope.evidence) &&
    text.trim() !== CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
  ) {
    reasons.add('UNSAFE_CUSTOMER_IDENTITY_RESPONSE');
  }
  const prices = knownPrices(catalog);
  for (const match of text.matchAll(MONEY_RE)) {
    const rawValue = match.groups?.prefixed ?? match.groups?.worded;
    const cents = rawValue ? currencyTextToCents(rawValue) : null;
    if (cents === null || !prices.has(cents)) reasons.add('UNKNOWN_PRICE');
  }

  const normalizedText = normalize(text);
  if (containsInternalConversationMarker(text)) {
    reasons.add('INTERNAL_CONVERSATION_MARKER');
  }
  const generatedSources = blocks.some((block) =>
    ['GENERATED', 'GREETING', 'POST_BOOKING'].includes(block.source)
  );
  const sourceInboundText = envelope.evidence?.sourceInboundText?.trim() ?? '';
  const turnPermission = sourceInboundText
    ? classifyReceptionistTurnPermission(sourceInboundText, {
        services: catalog.services.map((service) => service.name),
        professionals: catalog.professionals.map(
          (professional) => professional.name
        ),
      })
    : null;
  if (
    generatedSources &&
    turnPermission !== null &&
    ((turnPermission === 'SOCIAL_ONLY' ||
      turnPermission === 'NO_OPERATIONAL_INTENT') &&
      (introducesCatalogInformation(normalizedText, catalog) ||
        introducesAppointmentStateOrAvailability(normalizedText)) ||
      turnPermission === 'INFORMATION_REQUEST' &&
        introducesAppointmentStateOrAvailability(normalizedText))
  ) {
    reasons.add('SOCIAL_CONTEXT_DRIFT');
  }
  if (
    generatedSources &&
    hasUnverifiedExistingAppointmentContext(
      text,
      envelope.evidence?.toolTrace ?? [],
      envelope.evidence?.sourceInboundText,
      envelope.evidence?.temporalContext
    )
  ) {
    reasons.add('UNVERIFIED_APPOINTMENT_CONTEXT');
  }
  const mentionedServices = catalog.services.filter((service) => normalizedText.includes(normalize(service.name)));
  const serviceOffer = text.match(/\b(?:temos|oferecemos|fazemos|realizamos|trabalhamos\s+com)\s+(?:o\s+servi[cç]o\s+de\s+|a\s+)?([^.!?\n]+)/iu)?.[1];
  if (
    serviceOffer &&
    mentionedServices.length === 0 &&
    /\p{L}/u.test(serviceOffer) &&
    !/\b(?:hor[aá]rio|vaga|disponibilidade|dispon[ií]ve(?:l|is)|agenda)\b/iu.test(serviceOffer) &&
    !catalog.services.some((service) =>
      normalize(serviceOffer).includes(normalize(service.name))
    )
  ) reasons.add('UNKNOWN_SERVICE');
  const appointmentServiceClaim = text.match(
    /\b(?:para|pra)\s+(?:a|o)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,4})(?=[.!?,]|$)/iu
  )?.[1];
  if (
    appointmentServiceClaim &&
    introducesAppointmentStateOrAvailability(normalizedText) &&
    !/^(?:equipe|cliente|recepcao|estabelecimento|clinica|sala)$/u.test(
      normalize(appointmentServiceClaim)
    ) &&
    !catalog.services.some((service) =>
      normalize(appointmentServiceClaim).includes(normalize(service.name))
    )
  ) reasons.add('UNKNOWN_SERVICE');

  const slots = offeredSlots(envelope.evidence);
  for (const match of text.matchAll(TIME_OFFER_RE)) {
    const slot = `${String(match[1]).padStart(2, '0')}:${match[2]}`;
    if (!slots.has(slot)) reasons.add('UNVERIFIED_AVAILABILITY');
  }

  const mentionedProfessionals = catalog.professionals.filter((professional) => normalizedText.includes(normalize(professional.name)));
  const textWithoutServices = textWithoutKnownServiceNames(text, catalog);
  if (/\b(?:com|pela?|profissional|especialista|dra?\.?|doutor(?:a)?)\s+(?:(?:a|o)\s+)?[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+/u.test(textWithoutServices) && mentionedProfessionals.length === 0) reasons.add('UNKNOWN_PROFESSIONAL');
  const leadingProfessionalClaim = textWithoutServices.match(
    /\b(?:a|o)\s+([A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+)?)\s+(?:atende|recebe|realiza|estar[aá]|ficar[aá]|vai\s+estar)(?=\s|[.,!?]|$)/iu
  )?.[1];
  if (
    leadingProfessionalClaim &&
    !catalog.professionals.some(
      (professional) =>
        normalize(professional.name) === normalize(leadingProfessionalClaim)
    )
  ) reasons.add('UNKNOWN_PROFESSIONAL');
  if (mentionedServices.length === 1 && mentionedProfessionals.length > 0) {
    const eligible = mentionedServices[0]!.professionalIds;
    if (eligible && mentionedProfessionals.some((professional) => !eligible.includes(professional.id))) reasons.add('INELIGIBLE_PROFESSIONAL');
  }

  if (HUMAN_DEADLINE_RE.test(text)) reasons.add('HUMAN_RESPONSE_DEADLINE');
  if (CPF_RE.test(text) || PHONE_RE.test(text) || RECORD_RE.test(text)) reasons.add('EXPLICIT_PII');
  if (emojiCount(text) > 1) reasons.add('TOO_MANY_EMOJIS');
  if (HANDOFF_RE.test(text) && !envelope.evidence?.actionRecorded) reasons.add('UNRECORDED_HANDOFF');
  for (const block of blocks) {
    if (CLINICAL_RE.test(block.text) && !clinicalAuthorized(block, envelope.evidence)) reasons.add('UNAUTHORIZED_CLINICAL_PROMISE');
  }

  const reasonCodes = [...reasons];
  return {
    kind: 'validated_receptionist_outbound',
    payload: reasonCodes.length === 0 ? text : '',
    originalAccepted: reasonCodes.length === 0,
    reasonCodes,
    purpose: envelope.purpose,
    sources: [...new Set(blocks.map((block) => block.source))],
  };
}

export function canonicalReceptionistOutbound(
  purpose: ReceptionistOutboundPurpose,
  text: string,
  config: TenantBotConfig
): ValidatedReceptionistOutbound {
  return validateReceptionistOutbound(buildReceptionistEnvelope({
    purpose,
    blocks: [{ source: 'CANONICAL', text }],
    authoritativeCatalog: catalogFromConfig(config),
  }));
}

export function isSafeOwnerControlledText(
  text: string,
  source: Extract<ReceptionistOutboundSource, 'GREETING' | 'POST_BOOKING' | 'GENERATED'>,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  return validateReceptionistOutbound(buildReceptionistEnvelope({
    purpose: 'REACTIVE',
    blocks: [{ source, text }],
    authoritativeCatalog: catalog,
  })).originalAccepted;
}

export async function deliverValidatedReceptionistText(
  to: string,
  outbound: ValidatedReceptionistOutbound,
  config: TenantBotConfig,
  send: typeof sendFreeformMessage = sendFreeformMessage
): Promise<boolean> {
  if (!outbound.originalAccepted || !outbound.payload.trim()) return false;
  await send(to, outbound.payload, config);
  return true;
}
