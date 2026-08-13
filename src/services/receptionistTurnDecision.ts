/**
 * Compositor do turno da recepcionista. Não é uma sexta guarda: concentra a
 * precedência entre pergunta operacional pendente da Ana, evidência social e
 * a política de SOCIAL_CONTEXT_DRIFT. As demais guardas (catálogo, agenda,
 * booking, identidade) continuam obrigatórias depois desta decisão.
 *
 * Pendências explícitas (não neste change):
 * - persistência durável do recibo (exigiria migration; hoje console + Sentry
 *   em supressão/reescrita);
 * - push "Ana precisa de você" (não há API/contrato idempotente);
 * - regeneração social via modelo / personalidade (fora de escopo).
 */
import { createHash } from 'crypto';
import { Sentry } from '../observability/sentry';
import { conversationHash, technicalHash } from '../observability/safeRuntime';
import type { ServicesResult } from './calendarService';
import {
  immediatePreviousAnaAssistantText,
  isHumanEchoContent,
  type StoredConversationMessage,
} from './humanConversationContext';
import {
  assistantAskedImmediateServiceChoice,
  classifyReceptionistTurnPermission,
  currentMessageMentionsCatalogService,
  hasNonTransactionalOperationalCue,
  hasPositiveSocialEvidence,
  hasCustomerRequestVerb,
  isSocialOnlyReceptionistMessage,
  looksLikeStandaloneServiceAttempt,
  uniqueExactCatalogServiceSelection,
  type ReceptionistTurnPermission,
} from './receptionistSocialSafety';
import { uniqueCatalogServiceFromCurrentMessage, buildServiceSelectedFollowUp } from './service-gate';

export type ExpectedSlot =
  | 'SERVICE'
  | 'TIME'
  | 'DATE'
  | 'DATETIME'
  | 'PROFESSIONAL'
  | 'CONFIRMATION';

export type PendingQuestionSource = 'ANA' | 'HUMAN' | 'none';

export type TurnDecisionAction =
  | 'continue_model'
  | 'follow_up_datetime'
  | 'confirm_once'
  | 'ask_repeat'
  | 'unknown_denial'
  | 'social_reply'
  | 'personal_ack'
  | 'silence_human';

export type TurnDecisionRoute =
  | 'social_template'
  | 'pending_follow_up'
  | 'pending_confirm'
  | 'pending_repeat'
  | 'personal_ack'
  | 'unknown_denial'
  | 'model'
  | 'silence_human'
  | 'service_question'
  | 'identity'
  | 'escalation';

export type OutboundReceiptAction = 'sent' | 'rewritten' | 'suppressed';

export interface PendingOperationalQuestion {
  source: PendingQuestionSource;
  expectedSlot?: ExpectedSlot;
  listedServiceNames: string[];
  listedProfessionalNames: string[];
  confirmationCandidate?: string;
  alreadyAskedConfirmation: boolean;
}

export interface SlotFillResult {
  kind: 'unequivocal' | 'ambiguous' | 'social' | 'personal' | 'unknown' | 'incompatible';
  serviceName?: string;
  professionalName?: string;
  candidates?: string[];
}

export interface ReceptionistTurnDecision {
  permission: ReceptionistTurnPermission;
  pending: PendingOperationalQuestion;
  fit: SlotFillResult;
  action: TurnDecisionAction;
  disableSocialContextDrift: boolean;
  reply?: string;
}

export interface ReceptionistTurnDecisionReceipt {
  kind: 'receptionist_turn_receipt';
  convHash: string;
  inboundMessageIdHash?: string;
  tenantSlug: string;
  tenantSlugHash: string;
  gate: 'turn_decision';
  decision: TurnDecisionAction;
  reasonCodes: string[];
  pendingQuestionSource: PendingQuestionSource;
  expectedSlot?: ExpectedSlot;
  modelCalled: boolean;
  toolNames: string[];
  outboundAction: OutboundReceiptAction;
  route: TurnDecisionRoute;
  socialRoute: 'social_template' | 'not_social';
  payloadHash?: string;
  payloadVariant?: string;
  latencyMs?: number;
}

export const SERVICE_CONFIRMATION_PREFIX = 'Só confirmando:';
export const SERVICE_REPEAT_PROMPT =
  'Pode me dizer qual serviço você quer, pelo nome?';
export { buildServiceSelectedFollowUp };

const CONFIRMATION_AFFIRM_RE =
  /^(?:sim+|isso|ok+|certo|pode ser|fechado|combinado|confirmo|confirmado|beleza|perfeito)(?:\s+por favor)?$/u;
const CONFIRMATION_THUMB_RE = /(?:👍|✅|✔)/u;
const TIME_FILL_RE =
  /^(?:pode ser\s+)?(?:(?:as|depois das?|antes das?|a partir das?|por volta das?)\s+)?(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|\s+(?:[0-5]\d|horas?))?(?:\s+(?:mesmo|por favor))?$/u;
const DATE_FILL_RE =
  /^(?:(?:na|no|pra|para)\s+)?(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)(?:\s+(?:mesmo|por favor))?$/u;
const DURATION_RE = /\b(\d{2,3})\s*(?:min|minutos?)?\b/u;

let receiptsForTest: ReceptionistTurnDecisionReceipt[] = [];

export function buildAmbiguousServiceConfirmation(serviceName: string): string {
  return `${SERVICE_CONFIRMATION_PREFIX} você quer agendar ${serviceName}?`;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmojiOnly(value: string): boolean {
  if (!/\p{Extended_Pictographic}/u.test(value)) return false;
  const leftover = value
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\s\p{P}\uFE0F]/gu, '');
  return leftover.length === 0;
}

function isAffirmativeCompact(value: string): boolean {
  const stripped = value
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\uFE0F]/gu, ' ');
  const text = normalize(stripped).replace(/\b(?:por favor|pf)\b/g, '').trim();
  if (CONFIRMATION_AFFIRM_RE.test(text)) return true;
  if (isEmojiOnly(value) && CONFIRMATION_THUMB_RE.test(value)) return true;
  return false;
}

function listedCatalogNames(
  assistantText: string,
  names: readonly string[]
): string[] {
  const assistant = normalize(assistantText);
  return names.filter((name) => {
    const normalizedName = normalize(name);
    return normalizedName.length >= 3 && assistant.includes(normalizedName);
  });
}

function extractConfirmationCandidate(
  assistantText: string,
  serviceNames: readonly string[]
): string | undefined {
  const listed = listedCatalogNames(assistantText, serviceNames);
  if (listed.length === 1) return listed[0];
  return uniqueExactCatalogServiceSelection(
    assistantText.replace(/^[^:]*:\s*/u, ''),
    serviceNames
  ) ?? undefined;
}

export function resolvePendingOperationalQuestion(
  history: readonly StoredConversationMessage[],
  catalog: { services?: readonly { name: string }[]; professionals?: readonly { name: string }[] }
): PendingOperationalQuestion {
  const empty: PendingOperationalQuestion = {
    source: 'none',
    listedServiceNames: [],
    listedProfessionalNames: [],
    alreadyAskedConfirmation: false,
  };
  const lastAssistant = [...history]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!lastAssistant) return empty;
  if (isHumanEchoContent(lastAssistant.content)) {
    return { ...empty, source: 'HUMAN' };
  }

  const assistantText = immediatePreviousAnaAssistantText(history);
  if (!assistantText) return empty;

  const serviceNames = (catalog.services ?? []).map((service) => service.name);
  const professionalNames = (catalog.professionals ?? []).map(
    (professional) => professional.name
  );
  const listedServiceNames = listedCatalogNames(assistantText, serviceNames);
  const listedProfessionalNames = listedCatalogNames(
    assistantText,
    professionalNames
  );
  const assistant = normalize(assistantText);
  const alreadyAskedConfirmation = assistantText.startsWith(
    SERVICE_CONFIRMATION_PREFIX
  );

  let expectedSlot: ExpectedSlot | undefined;
  if (alreadyAskedConfirmation) {
    expectedSlot = 'CONFIRMATION';
  } else if (
    /\b(?:profissional especifico|tanto faz|qual profissional|qual atendente)\b/u.test(
      assistant
    )
  ) {
    expectedSlot = 'PROFESSIONAL';
  } else if (
    assistantAskedImmediateServiceChoice(assistantText, serviceNames) ||
    (listedServiceNames.length >= 2 &&
      /\b(?:qual|prefere|escolh(?:e|a|er|eu)|opcao)\b/u.test(assistant))
  ) {
    expectedSlot = 'SERVICE';
  } else if (/\bdia e horario\b/u.test(assistant)) {
    expectedSlot = 'DATETIME';
  } else if (/\b(?:horario|hora)\b/u.test(assistant) && /\b(?:qual|prefere|melhor)\b/u.test(assistant)) {
    expectedSlot = 'TIME';
  } else if (/\b(?:qual dia|qual data|que dia)\b/u.test(assistant)) {
    expectedSlot = 'DATE';
  } else if (
    /\bposso marcar\b/u.test(assistant) ||
    /\bconfirma\b/u.test(assistant)
  ) {
    expectedSlot = 'CONFIRMATION';
  }

  if (!expectedSlot) {
    return {
      source: 'none',
      listedServiceNames,
      listedProfessionalNames,
      alreadyAskedConfirmation,
    };
  }

  return {
    source: 'ANA',
    expectedSlot,
    listedServiceNames,
    listedProfessionalNames,
    confirmationCandidate: extractConfirmationCandidate(
      assistantText,
      serviceNames
    ),
    alreadyAskedConfirmation,
  };
}

function uniqueServiceByDuration(
  inbound: string,
  services: Array<{ name: string; durationMinutes?: number }>
): string | undefined {
  const match = normalize(inbound).match(DURATION_RE);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes)) return undefined;
  const hits = services.filter((service) => service.durationMinutes === minutes);
  return hits.length === 1 ? hits[0]!.name : undefined;
}

function uniqueProfessionalName(
  inbound: string,
  professionals: readonly { name: string }[]
): string | undefined {
  const text = normalize(inbound);
  const hits = professionals.filter((professional) => {
    const name = normalize(professional.name);
    if (name.length >= 3 && text.includes(name)) return true;
    const first = name.split(' ')[0] ?? '';
    if (first.length < 3 || !new RegExp(`\\b${first}\\b`, 'u').test(text)) {
      return false;
    }
    const sameFirst = professionals.filter(
      (other) => normalize(other.name).split(' ')[0] === first
    );
    return sameFirst.length === 1;
  });
  return hits.length === 1 ? hits[0]!.name : undefined;
}

function uniqueServiceWithSafeTypo(
  inbound: string,
  services: Array<{ id: string; name: string }>
): string | undefined {
  const exact = uniqueExactCatalogServiceSelection(
    inbound,
    services.map((service) => service.name)
  );
  if (exact) return exact;
  const compactSelection =
    looksLikeStandaloneServiceAttempt(inbound) ||
    /\b(?:pode ser|quero|prefiro|escolho)\b/u.test(normalize(inbound)) ||
    normalize(inbound).split(' ').filter(Boolean).length <= 4;
  if (compactSelection) {
    const unique = uniqueCatalogServiceFromCurrentMessage(inbound, services);
    if (unique) return unique.name;
  }
  const token = normalize(inbound).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!token || token.includes(' ') || token.length < 5) return undefined;
  const hits = services.filter((service) => {
    const distinctive = normalize(service.name)
      .split(' ')
      .filter((part) => part.length >= 5);
    return distinctive.some((part) => {
      if (part === token) return true;
      if (Math.abs(part.length - token.length) > 1) return false;
      let mismatches = 0;
      let left = 0;
      let right = 0;
      while (left < part.length && right < token.length) {
        if (part[left] === token[right]) {
          left += 1;
          right += 1;
          continue;
        }
        mismatches += 1;
        if (mismatches > 1) return false;
        if (part.length > token.length) left += 1;
        else if (token.length > part.length) right += 1;
        else {
          left += 1;
          right += 1;
        }
      }
      return mismatches <= 1;
    });
  });
  return hits.length === 1 ? hits[0]!.name : undefined;
}

export function matchInboundToExpectedSlot(
  inbound: string,
  pending: PendingOperationalQuestion,
  catalog: ServicesResult
): SlotFillResult {
  if (pending.source === 'HUMAN') return { kind: 'incompatible' };
  if (isSocialOnlyReceptionistMessage(inbound) || hasPositiveSocialEvidence(inbound)) {
    if (
      pending.expectedSlot === 'CONFIRMATION' &&
      isAffirmativeCompact(inbound)
    ) {
      return pending.confirmationCandidate
        ? { kind: 'unequivocal', serviceName: pending.confirmationCandidate }
        : { kind: 'ambiguous', candidates: [] };
    }
    return { kind: 'social' };
  }

  const permission = classifyReceptionistTurnPermission(inbound, {
    services: (catalog.services ?? []).map((service) => service.name),
    professionals: (catalog.professionals ?? []).map(
      (professional) => professional.name
    ),
  });

  if (pending.source !== 'ANA' || !pending.expectedSlot) {
    if (
      permission === 'NO_OPERATIONAL_INTENT' &&
      hasNonTransactionalOperationalCue(inbound) &&
      !hasCustomerRequestVerb(inbound)
    ) {
      return { kind: 'personal' };
    }
    return { kind: 'incompatible' };
  }

  const services = catalog.services ?? [];
  const serviceNames = services.map((service) => service.name);
  const listed =
    pending.listedServiceNames.length > 0
      ? pending.listedServiceNames
      : serviceNames;

  if (pending.expectedSlot === 'CONFIRMATION') {
    if (isAffirmativeCompact(inbound) && pending.confirmationCandidate) {
      return { kind: 'unequivocal', serviceName: pending.confirmationCandidate };
    }
    const named = uniqueServiceWithSafeTypo(inbound, services);
    if (named && listed.includes(named)) {
      return { kind: 'unequivocal', serviceName: named };
    }
    return { kind: 'ambiguous', candidates: pending.confirmationCandidate ? [pending.confirmationCandidate] : [] };
  }

  if (pending.expectedSlot === 'TIME' || pending.expectedSlot === 'DATETIME') {
    const text = normalize(inbound);
    if (TIME_FILL_RE.test(text) || DATE_FILL_RE.test(text) || isAffirmativeCompact(inbound)) {
      return { kind: 'unequivocal' };
    }
  }

  if (pending.expectedSlot === 'DATE') {
    if (DATE_FILL_RE.test(normalize(inbound))) return { kind: 'unequivocal' };
  }

  if (pending.expectedSlot === 'PROFESSIONAL') {
    const professional = uniqueProfessionalName(
      inbound,
      catalog.professionals ?? []
    );
    if (professional) return { kind: 'unequivocal', professionalName: professional };
    if (/\b(?:tanto faz|qualquer(?: um| uma)?|sem preferencia)\b/u.test(normalize(inbound))) {
      return { kind: 'unequivocal' };
    }
    return { kind: 'ambiguous', candidates: [] };
  }

  if (pending.expectedSlot === 'SERVICE') {
    const named = uniqueServiceWithSafeTypo(inbound, services);
    if (named && listed.includes(named)) {
      return { kind: 'unequivocal', serviceName: named };
    }
    const byDuration = uniqueServiceByDuration(inbound, services);
    if (byDuration && listed.includes(byDuration)) {
      return { kind: 'unequivocal', serviceName: byDuration };
    }
    if (isAffirmativeCompact(inbound)) {
      if (listed.length === 1) {
        return { kind: 'unequivocal', serviceName: listed[0] };
      }
      return { kind: 'ambiguous', candidates: listed.length === 1 ? listed : [] };
    }
    const professional = uniqueProfessionalName(
      inbound,
      catalog.professionals ?? []
    );
    if (professional) {
      return { kind: 'ambiguous', candidates: [] };
    }
    if (
      looksLikeStandaloneServiceAttempt(inbound) &&
      !currentMessageMentionsCatalogService(inbound, serviceNames)
    ) {
      return { kind: 'unknown' };
    }
    if (currentMessageMentionsCatalogService(inbound, serviceNames)) {
      return { kind: 'ambiguous', candidates: [] };
    }
    return { kind: 'incompatible' };
  }

  return { kind: 'incompatible' };
}

export function resolveReceptionistTurnDecision(input: {
  inbound: string;
  history: readonly StoredConversationMessage[];
  catalog: ServicesResult;
}): ReceptionistTurnDecision {
  const pending = resolvePendingOperationalQuestion(input.history, {
    services: input.catalog.services,
    professionals: input.catalog.professionals,
  });
  const permission = classifyReceptionistTurnPermission(input.inbound, {
    services: (input.catalog.services ?? []).map((service) => service.name),
    professionals: (input.catalog.professionals ?? []).map(
      (professional) => professional.name
    ),
  });
  const fit = matchInboundToExpectedSlot(input.inbound, pending, input.catalog);
  const disableSocialContextDrift =
    pending.source === 'ANA' &&
    fit.kind !== 'social' &&
    fit.kind !== 'personal';

  if (pending.source === 'HUMAN') {
    return {
      permission,
      pending,
      fit,
      action: 'silence_human',
      disableSocialContextDrift: false,
    };
  }

  // SOCIAL_ONLY continua no template determinístico já aprovado no E2E.
  // kkk/elogio, com ou sem pergunta pendente, segue o caminho atual (modelo).
  // Não ampliar short-circuit social nem regenerar copy via modelo.
  if (permission === 'SOCIAL_ONLY') {
    return {
      permission,
      pending,
      fit,
      action: 'social_reply',
      disableSocialContextDrift: false,
    };
  }

  if (fit.kind === 'personal') {
    return {
      permission,
      pending,
      fit,
      action: 'personal_ack',
      disableSocialContextDrift: false,
    };
  }

  if (pending.source === 'ANA' && pending.expectedSlot === 'SERVICE') {
    if (fit.kind === 'unequivocal' && fit.serviceName) {
      return {
        permission,
        pending,
        fit,
        action: 'follow_up_datetime',
        disableSocialContextDrift,
        reply: buildServiceSelectedFollowUp(fit.serviceName),
      };
    }
    if (fit.kind === 'unknown') {
      return {
        permission,
        pending,
        fit,
        action: 'unknown_denial',
        disableSocialContextDrift,
      };
    }
    if (fit.kind === 'ambiguous') {
      const candidate = fit.candidates?.[0] ?? pending.confirmationCandidate;
      if (candidate) {
        return {
          permission,
          pending,
          fit,
          action: 'confirm_once',
          disableSocialContextDrift,
          reply: buildAmbiguousServiceConfirmation(candidate),
        };
      }
      if (isAffirmativeCompact(input.inbound)) {
        return {
          permission,
          pending,
          fit,
          action: 'ask_repeat',
          disableSocialContextDrift,
          reply: SERVICE_REPEAT_PROMPT,
        };
      }
      // Menção fraca/parcial sem entidade única: o modelo atual já resolve
      // (ex.: "pé"). Não silenciar e não inventar confirmação sem candidato.
    }
  }

  if (
    pending.source === 'ANA' &&
    pending.expectedSlot === 'CONFIRMATION' &&
    pending.alreadyAskedConfirmation
  ) {
    if (fit.kind === 'unequivocal' && fit.serviceName) {
      return {
        permission,
        pending,
        fit,
        action: 'follow_up_datetime',
        disableSocialContextDrift,
        reply: buildServiceSelectedFollowUp(fit.serviceName),
      };
    }
    return {
      permission,
      pending,
      fit,
      action: 'ask_repeat',
      disableSocialContextDrift,
      reply: SERVICE_REPEAT_PROMPT,
    };
  }

  return {
    permission,
    pending,
    fit,
    action: 'continue_model',
    disableSocialContextDrift,
  };
}

export function turnDecisionRoute(
  action: TurnDecisionAction,
  purpose?: string
): TurnDecisionRoute {
  if (purpose === 'SERVICE_QUESTION') return 'service_question';
  if (purpose === 'ESCALATION') return 'escalation';
  switch (action) {
    case 'social_reply':
      return 'social_template';
    case 'follow_up_datetime':
      return 'pending_follow_up';
    case 'confirm_once':
      return 'pending_confirm';
    case 'ask_repeat':
      return 'pending_repeat';
    case 'personal_ack':
      return 'personal_ack';
    case 'unknown_denial':
      return 'unknown_denial';
    case 'silence_human':
      return 'silence_human';
    default:
      return 'model';
  }
}

export function socialTemplateVariant(payload: string): string {
  const text = payload.trim();
  if (text.startsWith('Bom dia')) return 'greeting_bom_dia';
  if (text.startsWith('Boa tarde')) return 'greeting_boa_tarde';
  if (text.startsWith('Boa noite')) return 'greeting_boa_noite';
  if (text.startsWith('Oi')) return 'greeting_oi';
  return 'template_other';
}

export function shouldDisableSocialContextDrift(
  decision: Pick<ReceptionistTurnDecision, 'disableSocialContextDrift'>
): boolean {
  return decision.disableSocialContextDrift;
}

export function emitReceptionistTurnReceipt(
  receipt: ReceptionistTurnDecisionReceipt
): void {
  receiptsForTest.push(receipt);
  console.log(
    `[receptionist-turn] route=${receipt.route} socialRoute=${receipt.socialRoute} decision=${receipt.decision} pending=${receipt.pendingQuestionSource} slot=${receipt.expectedSlot ?? 'none'} outbound=${receipt.outboundAction} convHash=${receipt.convHash} reasons=${receipt.reasonCodes.join(',') || 'none'}`
  );
  const critical =
    receipt.outboundAction !== 'sent' ||
    receipt.decision === 'silence_human' ||
    receipt.reasonCodes.length > 0;
  if (!critical) return;
  Sentry.captureMessage('Recepcionista turn decision', {
    level: 'warning',
    tags: {
      service: 'receptionist_turn',
      operation: 'turn_decision_receipt',
      tenantSlug: receipt.tenantSlug,
      convHash: receipt.convHash,
      gate: receipt.gate,
      decision: receipt.decision,
      route: receipt.route,
      social_route: receipt.socialRoute,
      pending_source: receipt.pendingQuestionSource,
      expected_slot: receipt.expectedSlot ?? 'none',
      outbound_action: receipt.outboundAction,
      model_called: String(receipt.modelCalled),
      reason_codes: receipt.reasonCodes.join(',') || 'none',
    },
    contexts: {
      receptionist_turn: {
        convHash: receipt.convHash,
        inboundMessageIdHash: receipt.inboundMessageIdHash ?? null,
        tenantSlugHash: receipt.tenantSlugHash,
        decision: receipt.decision,
        route: receipt.route,
        socialRoute: receipt.socialRoute,
        pendingQuestionSource: receipt.pendingQuestionSource,
        expectedSlot: receipt.expectedSlot ?? null,
        modelCalled: receipt.modelCalled,
        toolNames: receipt.toolNames,
        outboundAction: receipt.outboundAction,
        payloadHash: receipt.payloadHash ?? null,
        payloadVariant: receipt.payloadVariant ?? null,
        latencyMs: receipt.latencyMs ?? null,
      },
    },
  });
}

export function buildTurnDecisionReceipt(input: {
  phoneNumberId: string;
  customerPhone: string;
  tenantSlug: string;
  inboundMessageId?: string;
  decision: ReceptionistTurnDecision;
  modelCalled: boolean;
  toolNames: string[];
  outboundAction: OutboundReceiptAction;
  payload?: string;
  reasonCodes?: string[];
  latencyMs?: number;
  purpose?: string;
}): ReceptionistTurnDecisionReceipt {
  const route = turnDecisionRoute(input.decision.action, input.purpose);
  return {
    kind: 'receptionist_turn_receipt',
    convHash: conversationHash(input.phoneNumberId, input.customerPhone),
    inboundMessageIdHash: input.inboundMessageId
      ? technicalHash(input.inboundMessageId)
      : undefined,
    tenantSlug: input.tenantSlug,
    tenantSlugHash: technicalHash(input.tenantSlug),
    gate: 'turn_decision',
    decision: input.decision.action,
    reasonCodes: input.reasonCodes ?? [],
    pendingQuestionSource: input.decision.pending.source,
    expectedSlot: input.decision.pending.expectedSlot,
    modelCalled: input.modelCalled,
    toolNames: input.toolNames,
    outboundAction: input.outboundAction,
    route,
    socialRoute: route === 'social_template' ? 'social_template' : 'not_social',
    payloadHash: input.payload
      ? createHash('sha256').update(input.payload).digest('hex').slice(0, 16)
      : undefined,
    payloadVariant:
      route === 'social_template' && input.payload
        ? socialTemplateVariant(input.payload)
        : undefined,
    latencyMs: input.latencyMs,
  };
}

export function __getTurnDecisionReceiptsForTest(): ReceptionistTurnDecisionReceipt[] {
  return [...receiptsForTest];
}

export function __resetTurnDecisionReceiptsForTest(): void {
  receiptsForTest = [];
}
