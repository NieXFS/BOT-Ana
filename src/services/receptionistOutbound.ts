import { createHash } from 'crypto';
import type { TenantBotConfig } from '../configProvider';
import type { ServicesResult } from './calendarService';
import { sendFreeformMessage } from '../whatsappCloudService';

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
  actionRecorded?: boolean;
  clinicalAuthorization?: ClinicalAuthorization;
  teamReplyAuthorization?: TeamReplyAuthorization;
  sourceInboundMessageId?: string;
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
  | 'UNAUTHORIZED_CLINICAL_PROMISE';

export interface ValidatedReceptionistOutbound {
  readonly kind: 'validated_receptionist_outbound';
  payload: string;
  originalAccepted: boolean;
  reasonCodes: OutboundReasonCode[];
  purpose: ReceptionistOutboundPurpose;
  sources: ReceptionistOutboundSource[];
}

const MONEY_RE = /R\$\s*(\d{1,6}(?:[.,]\d{1,2})?)/giu;
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

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
  const prices = knownPrices(catalog);
  for (const match of text.matchAll(MONEY_RE)) {
    const cents = Math.round(Number(match[1]!.replace('.', '').replace(',', '.')) * 100);
    if (!prices.has(cents)) reasons.add('UNKNOWN_PRICE');
  }

  const normalizedText = normalize(text);
  const mentionedServices = catalog.services.filter((service) => normalizedText.includes(normalize(service.name)));
  const serviceOffer = text.match(/\b(?:temos|oferecemos|fazemos|realizamos)\s+(?:o\s+servi[cç]o\s+de\s+|a\s+)?([^.!?\n]+)/iu)?.[1];
  if (
    serviceOffer &&
    /\p{L}/u.test(serviceOffer) &&
    !/\b(?:hor[aá]rio|vaga|disponibilidade|dispon[ií]ve(?:l|is)|agenda)\b/iu.test(serviceOffer) &&
    !catalog.services.some((service) =>
      normalize(serviceOffer).includes(normalize(service.name))
    )
  ) reasons.add('UNKNOWN_SERVICE');

  const slots = offeredSlots(envelope.evidence);
  for (const match of text.matchAll(TIME_OFFER_RE)) {
    const slot = `${String(match[1]).padStart(2, '0')}:${match[2]}`;
    if (!slots.has(slot)) reasons.add('UNVERIFIED_AVAILABILITY');
  }

  const mentionedProfessionals = catalog.professionals.filter((professional) => normalizedText.includes(normalize(professional.name)));
  if (/\b(?:com|profissional|especialista|dra?\.?|doutor(?:a)?)\s+[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+/u.test(text) && mentionedProfessionals.length === 0) reasons.add('UNKNOWN_PROFESSIONAL');
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
    payload: reasonCodes.length === 0 ? text : RECEPTIONIST_SAFE_FALLBACK,
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
): Promise<void> {
  await send(to, outbound.payload, config);
}
