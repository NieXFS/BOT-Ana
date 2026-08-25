import { createHash } from 'crypto';
import type { TenantBotConfig, TenantBusinessAddress } from '../configProvider';
import type { ServicesResult } from './calendarService';
import { canonicalBusinessAddressCopiesV2 } from './conversationalV2/businessAddress';
import { sendFreeformMessage } from '../whatsappCloudService';
import {
  HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE,
  HUMAN_ECHO_PREFIX,
  HUMAN_MODEL_CONTEXT_PREFIX,
  LICENSED_CATALOG_HISTORY_PREFIX,
  LICENSED_CATALOG_LLM_PLACEHOLDER_HEAD,
  LICENSED_CATALOG_MODEL_CONTEXT_PREFIX,
} from './humanConversationContext';
import {
  hasUnverifiedExistingAppointmentContext,
  type AppointmentTemporalContext,
} from './customerReplyGuard';
import { matchForbiddenPromiseInSpeech } from './promiseGuard';
import {
  CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE,
  toolTraceHasCustomerIdentityAmbiguity,
} from './customerIdentitySafety';
import { classifyReceptionistTurnPermission, hasPositiveSocialOrPersonalEvidence } from './receptionistSocialSafety';
import type { PendingOperationalQuestion } from './receptionistTurnDecision';
import type {
  LicensedServiceDescriptionEvidenceV2,
  LicensedServiceDescriptionV2,
} from './licensedServiceDescription';
import type { PreBookingSummaryEvidenceV2 } from './conversationalV2/contracts';
import {
  normalizeLicensedServiceDescriptionV2,
  validDescriptionTermAcceptanceV2,
} from './licensedServiceDescription';
import {
  classifyAvailabilityTimeClaims,
  type AvailabilityTimeMentionV2,
} from './availabilityClaimScope';

export { CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE } from './customerIdentitySafety';

/** @deprecated Rejeições da fronteira final agora são silenciosas e nunca enviam fallback. */
export const RECEPTIONIST_SAFE_FALLBACK =
  'Desculpe, não consegui responder com segurança agora. A equipe do estabelecimento pode ajudar por aqui.';

export const RECEPTIONIST_OUTBOUND_SOURCES = [
  'GENERATED',
  'GREETING',
  'POST_BOOKING',
  'APPROVED_RESPONSE',
  'TEAM_REPLY',
  'CANONICAL',
  'LICENSED_SERVICE_DESCRIPTION',
  'VOICE_REPHRASE',
] as const;

export type ReceptionistOutboundSource = (typeof RECEPTIONIST_OUTBOUND_SOURCES)[number];

export const GENERATED_RECEPTIONIST_OUTBOUND_SOURCES: readonly ReceptionistOutboundSource[] = [
  'GENERATED',
  'GREETING',
  'POST_BOOKING',
  'VOICE_REPHRASE',
];

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
  /** Contrato aditivo: aliases tenant-scoped, nunca materializados no prompt. */
  aliases?: string[];
  licensedDescription?: LicensedServiceDescriptionV2 | null;
}

export interface OutboundCatalogProfessional {
  id: string;
  name: string;
  active?: boolean;
}

export interface AuthoritativeOutboundCatalog {
  /** Dados autoritativos da unidade expostos pelo contrato v3 do Receps. */
  tenant?: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
  };
  services: OutboundCatalogService[];
  professionals: OutboundCatalogProfessional[];
  capturedAt?: string;
}

export interface ReceptionistOutboundEvidence {
  toolTrace?: Array<{ name: string; result: string; round?: number }>;
  /** Falha de identidade detectada pelo ERP; nunca depende de paráfrase do modelo. */
  customerIdentityAmbiguous?: boolean;
  actionRecorded?: boolean;
  /**
   * questionId autoritativo da escalada recém-registrada. É a licença da
   * copy de handoff ("vou avisar…"); boolean sozinho não atravessa o
   * validador final se este campo for o que o turno preparou.
   */
  authoritativeEscalationQuestionId?: string;
  clinicalAuthorization?: ClinicalAuthorization;
  teamReplyAuthorization?: TeamReplyAuthorization;
  sourceInboundMessageId?: string;
  /** Texto do inbound atual, somente em memória, para impedir fatos adicionados. */
  sourceInboundText?: string;
  /** Fala imediatamente anterior da Ana; não incluir echo humano. */
  previousAssistantText?: string;
  pendingQuestion?: PendingOperationalQuestion;
  disableSocialContextDrift?: boolean;
  /** Instante e fuso do turno usados para validar hoje/amanhã deterministicamente. */
  temporalContext?: AppointmentTemporalContext;
  /** Slots tipados já entregues em PendingFrame TIME; rota v2 somente. */
  verifiedAvailabilitySlots?: readonly string[];
  /** Bloco exato materializado de cláusulas licenciadas do catálogo. */
  licensedServiceDescription?: LicensedServiceDescriptionEvidenceV2;
  /** Endereço operacional testemunhado do payload `businessAddress`. */
  businessAddress?: TenantBusinessAddress;
  /**
   * Prova exclusiva da copy canônica de proposta ainda não escrita. Nunca é
   * colocada no contexto global de regen/modelo; só a rota CANONICAL pode
   * carregá-la até a boundary.
   */
  preBookingSummary?: PreBookingSummaryEvidenceV2;
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
  | 'UNLICENSED_SERVICE_DESCRIPTION'
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
const HUMAN_DEADLINE_RE = /\b(?:equipe|atendente|profissional|respons[aá]vel)\b[^.!?\n]{0,80}\b(?:em|dentro de|at[eé])\s+\d+\s*(?:minutos?|horas?|dias?)\b/iu;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/u;
const PHONE_RE = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/u;
const RECORD_RE = /\b(?:prontu[aá]rio|paciente|cliente)\s*(?:n[ºo°.]?|id|:)?\s*[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\p{L}'-]+)+/iu;
const HANDOFF_RE = new RegExp(
  String.raw`\b(?:vou|vamos|irei|iremos)\s+(?:te\s+)?(?:transf\u0065rir|enc\u0061minhar|passar|acionar|chamar)\b|\b(?:enc\u0061minhei|transf\u0065ri|acionei|chamei)\b`,
  'iu'
);
/** Família canônica `vou/iremos/irei avisar <alvo humano>` — nome arbitrário, sem lista fechada. */
const AVISAR_NOMINAL_HANDOFF_RE = new RegExp(
  String.raw`\b(?:vou|iremos|irei|vamos)\s+avisar\s+(?:(?:a|o|as|os)\s+)?[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?`,
  'iu'
);
const CLINICAL_RE = /\b(?:diagn[oó]stic[oa]|diagnosticamos|cura|curamos|elimina|resolve|garante|garantimos|n[aã]o\s+d[oó]i|sem\s+dor|resultado\s+garantido|adequad[oa]\s+para|indicad[oa]\s+para|seguro\s+para|eficaz)\b/iu;

function zipDigits(value: string): string {
  return value.replace(/\D/gu, '');
}

interface LicensedZipForms {
  raw: string;
  digits: string;
  hyphenated: string;
}

function licensedZipForms(
  address: TenantBusinessAddress | null | undefined
): LicensedZipForms | null {
  const raw = typeof address?.zipCode === 'string' ? address.zipCode.trim() : '';
  const digits = zipDigits(raw);
  if (digits.length < 8) return null;
  return {
    raw,
    digits,
    hyphenated: `${digits.slice(0, 5)}-${digits.slice(5)}`,
  };
}

function stripLicensedZipForms(text: string, forms: LicensedZipForms): string {
  return text
    .split(forms.raw)
    .join(' ')
    .split(forms.digits)
    .join(' ')
    .split(forms.hyphenated)
    .join(' ');
}

function hasRawExplicitPii(text: string): boolean {
  return CPF_RE.test(text) || PHONE_RE.test(text) || RECORD_RE.test(text);
}

function remainderHasLicensedZip(text: string, forms: LicensedZipForms): boolean {
  const pattern = new RegExp(
    `\\b(?:${escapeRegExp(forms.digits)}|${escapeRegExp(forms.hyphenated)})\\b`,
    'u'
  );
  return pattern.test(text);
}

/**
 * CEP brasileiro tem 8 dígitos e casa o PHONE_RE (4+4). A isenção não é
 * lexical/global: só o trecho da copy canônica de endereço materializada pelo
 * servidor ignora o CEP testemunhado. Todo o restante — inclusive bloco de
 * origem modelo — é reinspecionado com PHONE_RE cru. O formato 5-3
 * (`01310-930`) não casa o detector 4-4; leftover do zip no restante também
 * conta como PII explícita.
 */
function segmentHasUnlicensedPii(
  text: string,
  address: TenantBusinessAddress | null | undefined
): boolean {
  const forms = licensedZipForms(address);
  const copies = canonicalBusinessAddressCopiesV2(address);
  let remaining = text;
  for (const copy of copies) {
    let index = remaining.indexOf(copy);
    while (index >= 0) {
      const licensedSpan = forms ? stripLicensedZipForms(copy, forms) : copy;
      if (hasRawExplicitPii(licensedSpan)) return true;
      remaining = `${remaining.slice(0, index)}${remaining.slice(index + copy.length)}`;
      index = remaining.indexOf(copy);
    }
  }
  remaining = remaining.replace(/\n{3,}/gu, '\n\n').trim();
  if (hasRawExplicitPii(remaining)) return true;
  return forms ? remainderHasLicensedZip(remaining, forms) : false;
}

function hasExplicitPii(
  text: string,
  address: TenantBusinessAddress | null | undefined,
  blocks: readonly ReceptionistOutboundBlock[]
): boolean {
  if (segmentHasUnlicensedPii(text, address)) return true;
  for (const block of blocks) {
    if (!GENERATED_RECEPTIONIST_OUTBOUND_SOURCES.includes(block.source)) {
      continue;
    }
    if (segmentHasUnlicensedPii(block.text, address)) return true;
  }
  return false;
}

export function hasAuthoritativeHandoffLicense(
  evidence?: ReceptionistOutboundEvidence
): boolean {
  const questionId = evidence?.authoritativeEscalationQuestionId?.trim();
  if (questionId) return true;
  return evidence?.actionRecorded === true;
}

/** Promessa de transferência humana sem questionId/ação autoritativa. */
export function containsUnlicensedHandoffPromise(
  text: string,
  evidence?: ReceptionistOutboundEvidence
): boolean {
  const promisesHandoff =
    Boolean(matchForbiddenPromiseInSpeech(text)) ||
    HANDOFF_RE.test(text) ||
    AVISAR_NOMINAL_HANDOFF_RE.test(text);
  return promisesHandoff && !hasAuthoritativeHandoffLicense(evidence);
}

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
    normalizedCompact.includes(normalize(LICENSED_CATALOG_HISTORY_PREFIX.trim())) ||
    normalizedCompact.includes(
      normalize(LICENSED_CATALOG_MODEL_CONTEXT_PREFIX.trim())
    ) ||
    normalizedCompact.includes(
      normalize(LICENSED_CATALOG_LLM_PLACEHOLDER_HEAD)
    ) ||
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
      aliases: service.aliases,
      licensedDescription: service.licensedDescription,
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
  for (const slot of evidence?.verifiedAvailabilitySlots ?? []) {
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)) slots.add(slot);
  }
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

export function classifyReceptionistOutboundAvailabilityClaims(
  text: string
): AvailabilityTimeMentionV2[] {
  return classifyAvailabilityTimeClaims(text);
}

function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

export function licensedServiceDescriptionEvidenceValid(
  block: ReceptionistOutboundBlock,
  evidence: ReceptionistOutboundEvidence | undefined,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  if (block.source !== 'LICENSED_SERVICE_DESCRIPTION') return false;
  const witness = evidence?.licensedServiceDescription;
  if (
    !witness ||
    !validDescriptionTermAcceptanceV2(witness.termAcceptance) ||
    block.text !== witness.exactText ||
    witness.policyVersion !== 'licensed-service-description-v1'
  ) {
    return false;
  }
  const service = catalog.services.find((entry) => entry.id === witness.serviceId);
  const licensed = normalizeLicensedServiceDescriptionV2(
    service?.licensedDescription
  );
  if (
    !licensed ||
    licensed.sourceHash !== witness.sourceHash.toLowerCase() ||
    licensed.policyVersion !== witness.policyVersion ||
    witness.clauseIds.length === 0 ||
    new Set(witness.clauseIds).size !== witness.clauseIds.length
  ) {
    return false;
  }
  const byId = new Map(
    licensed.clauses.map((clause, index) => [clause.clauseId, { clause, index }])
  );
  const selected = witness.clauseIds.map((clauseId) => byId.get(clauseId));
  if (selected.some((entry) => !entry)) return false;
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1]!.index >= selected[index]!.index) return false;
  }
  return (
    selected.map((entry) => entry!.clause.exactText).join(' ') ===
    witness.exactText
  );
}

function clinicalAuthorized(
  block: ReceptionistOutboundBlock,
  evidence: ReceptionistOutboundEvidence | undefined,
  catalog: AuthoritativeOutboundCatalog
): boolean {
  if (block.source === 'LICENSED_SERVICE_DESCRIPTION') {
    return licensedServiceDescriptionEvidenceValid(block, evidence, catalog);
  }
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
        (RECEPTIONIST_OUTBOUND_SOURCES as readonly string[]).includes(block.source)
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
  const factCheckedText = blocks
    .filter((block) => block.source !== 'LICENSED_SERVICE_DESCRIPTION')
    .map((block) => block.text)
    .join('');
  for (const block of blocks) {
    if (
      block.source === 'LICENSED_SERVICE_DESCRIPTION' &&
      !licensedServiceDescriptionEvidenceValid(block, envelope.evidence, catalog)
    ) {
      reasons.add('UNLICENSED_SERVICE_DESCRIPTION');
    }
  }
  if (
    traceHasCustomerIdentityAmbiguity(envelope.evidence) &&
    text.trim() !== CUSTOMER_IDENTITY_SAFE_CUSTOMER_MESSAGE
  ) {
    reasons.add('UNSAFE_CUSTOMER_IDENTITY_RESPONSE');
  }
  const prices = knownPrices(catalog);
  for (const match of factCheckedText.matchAll(MONEY_RE)) {
    const rawValue = match.groups?.prefixed ?? match.groups?.worded;
    const cents = rawValue ? currencyTextToCents(rawValue) : null;
    if (cents === null || !prices.has(cents)) reasons.add('UNKNOWN_PRICE');
  }

  const normalizedText = normalize(factCheckedText);
  if (containsInternalConversationMarker(text)) {
    reasons.add('INTERNAL_CONVERSATION_MARKER');
  }
  const generatedSources = blocks.some((block) =>
    GENERATED_RECEPTIONIST_OUTBOUND_SOURCES.includes(block.source)
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
  const pendingAnaQuestion =
    envelope.evidence?.pendingQuestion?.source === 'ANA';
  const disableSocialContextDrift = Boolean(
    envelope.evidence?.disableSocialContextDrift || pendingAnaQuestion
  );
  const positiveSocialOrPersonal = sourceInboundText
    ? hasPositiveSocialOrPersonalEvidence(sourceInboundText)
    : false;
  if (
    generatedSources &&
    turnPermission !== null &&
    !(disableSocialContextDrift && !positiveSocialOrPersonal) &&
    positiveSocialOrPersonal &&
    (introducesCatalogInformation(normalizedText, catalog) ||
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
  const availabilityClaims = classifyReceptionistOutboundAvailabilityClaims(
    factCheckedText
  );
  const mentionedServices = catalog.services.filter((service) => normalizedText.includes(normalize(service.name)));
  const serviceOffer = factCheckedText.match(/\b(?:temos|oferecemos|fazemos|realizamos|trabalhamos\s+com)\s+(?:o\s+servi[cç]o\s+de\s+|a\s+)?([^.!?\n]+)/iu)?.[1];
  if (
    serviceOffer &&
    mentionedServices.length === 0 &&
    /\p{L}/u.test(serviceOffer) &&
    availabilityClaims.length === 0 &&
    !/\b(?:hor[aá]rio|vaga|disponibilidade|dispon[ií]ve(?:l|is)|agenda)\b/iu.test(serviceOffer) &&
    !catalog.services.some((service) =>
      normalize(serviceOffer).includes(normalize(service.name))
    )
  ) reasons.add('UNKNOWN_SERVICE');
  const appointmentServiceClaim = factCheckedText.match(
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
  for (const claim of availabilityClaims) {
    if (
      claim.disposition !== 'positive_availability' &&
      claim.disposition !== 'unknown'
    ) {
      continue;
    }
    if (!slots.has(claim.time)) {
      // `unknown` é tratado como evidence_required, nunca como no_offer.
      reasons.add('UNVERIFIED_AVAILABILITY');
    }
  }

  const mentionedProfessionals = catalog.professionals.filter((professional) => normalizedText.includes(normalize(professional.name)));
  const textWithoutServices = textWithoutKnownServiceNames(factCheckedText, catalog);
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
  if (hasExplicitPii(text, envelope.evidence?.businessAddress, blocks)) {
    reasons.add('EXPLICIT_PII');
  }
  if (emojiCount(text) > 1) reasons.add('TOO_MANY_EMOJIS');
  if (containsUnlicensedHandoffPromise(text, envelope.evidence)) {
    reasons.add('UNRECORDED_HANDOFF');
  }
  for (const block of blocks) {
    if (CLINICAL_RE.test(block.text) && !clinicalAuthorized(block, envelope.evidence, catalog)) reasons.add('UNAUTHORIZED_CLINICAL_PROMISE');
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
