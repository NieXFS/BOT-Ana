import type { ServicesResult } from '../calendarService';
import {
  findClauseMatchesV2,
  hasPositiveClauseMatchV2,
} from './polarity';
import { stripPowerZeroMetalinguisticAssignmentsV2 } from './powerZeroWitness';

export const SERVICE_LIST_MAX_NAMES_V2 = 8;
/** Teto do transporte WhatsApp Cloud API para `text.body`. */
export const SERVICE_LIST_TRANSPORT_CEILING_V2 = 4096;

const SERVICE_LIST_QUESTION_RE =
  /\b(?:quais\s+servicos|que\s+servicos(?:\s+voces)?(?:\s+(?:tem|fazem|oferecem|atendem))?|o\s+que\s+voces\s+(?:fazem|atendem|oferecem|tem)|lista\s+de\s+servicos)\b/u;
const COURTESY_ACK_RE =
  /\b(?:muito\s+)?(?:obrigad[oa]|agradeco|valeu|vlw)\b/u;
const ADDITIONAL_OPERATIONAL_RE =
  /\b(?:tem\s+vaga|tem\s+horario|disponibilidade|agenda(?:r|mento)?|marcar|remarcar|cancelar|desmarcar|pagamento|pagar|pix|cartao|preco|valor|quanto\s+custa|profissional|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}(?::\d{2}|h\d{0,2})?|endereco|localizacao|onde\s+ficam?|como\s+cheg(?:o|ar)|qual\s+(?:o\s+)?local|como\s+funciona|o\s+que\s+(?:e|eh))\b/u;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export type ServiceListDecisionV2 =
  | { kind: 'none'; reason: string }
  | { kind: 'answer'; text: string };

export interface ServiceListPlanV2 {
  decision: ServiceListDecisionV2;
  requiresOperationalContinuation: boolean;
  hasCourtesyAcknowledgement: boolean;
}

export function matchServiceListQuestionV2(value: string): {
  matched: boolean;
  requiresOperationalContinuation: boolean;
  hasCourtesyAcknowledgement: boolean;
} {
  const witnessed = stripPowerZeroMetalinguisticAssignmentsV2(value);
  const matched = findClauseMatchesV2(witnessed, SERVICE_LIST_QUESTION_RE).some(
    (entry) => entry.positive
  );
  return {
    matched,
    requiresOperationalContinuation: ADDITIONAL_OPERATIONAL_RE.test(
      normalize(witnessed)
    ),
    hasCourtesyAcknowledgement: COURTESY_ACK_RE.test(normalize(witnessed)),
  };
}

export type MaterializedServiceClarificationV2 = {
  text: string;
  visibleServiceIds: string[];
  omittedCount: number;
};

function joinVerbatimNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

function formatServiceListCopyV2(
  listed: readonly string[],
  total: number
): string {
  if (listed.length === 0) {
    const restLabel =
      total === 1 ? 'e mais 1 outro!' : `e mais ${total} outros!`;
    return `Por aqui: ${restLabel} Algum desses te interessa? Me fala o nome que eu vejo os detalhes.`;
  }
  const remaining = total - listed.length;
  if (remaining === 0) {
    return `Por aqui: ${joinVerbatimNames(listed)}. Algum desses te interessa?`;
  }
  const restLabel =
    remaining === 1 ? 'e mais 1 outro!' : `e mais ${remaining} outros!`;
  return `Por aqui: ${listed.join(', ')} ${restLabel} Algum desses te interessa? Me fala o nome que eu vejo os detalhes.`;
}

/**
 * Copy canônica: nomes VERBATIM na ordem do catálogo testemunhado. Sem
 * preço/duração anexados. Teto de 8 nomes inteiros; o restante vira contagem.
 * Nunca trunca um nome: para quando o próximo nome inteiro estouraria o
 * orçamento e recalcula a contagem omitida. IDs acompanham a seleção; não
 * são inferidos do texto depois.
 */
export function materializeServiceClarificationV2(
  services: ReadonlyArray<{ id: string; name: string }>,
  options?: { maxChars?: number }
): MaterializedServiceClarificationV2 | null {
  const entries = services.filter((entry) => entry.name.trim().length > 0);
  if (entries.length === 0) return null;
  const maxChars = options?.maxChars ?? SERVICE_LIST_TRANSPORT_CEILING_V2;
  const listed: Array<{ id: string; name: string }> = [];
  for (const entry of entries) {
    if (listed.length >= SERVICE_LIST_MAX_NAMES_V2) break;
    const candidate = [...listed, entry];
    if (
      formatServiceListCopyV2(
        candidate.map((item) => item.name),
        entries.length
      ).length > maxChars
    ) {
      break;
    }
    listed.push(entry);
  }
  if (listed.length === 0) {
    const omittedOnly = formatServiceListCopyV2([], entries.length);
    return omittedOnly.length <= maxChars
      ? {
          text: omittedOnly,
          visibleServiceIds: [],
          omittedCount: entries.length,
        }
      : null;
  }
  return {
    text: formatServiceListCopyV2(
      listed.map((item) => item.name),
      entries.length
    ),
    visibleServiceIds: listed.map((item) => item.id),
    omittedCount: entries.length - listed.length,
  };
}

export function selectCatalogServicesByIdsV2(
  catalog: ServicesResult,
  entityIds: readonly string[]
): Array<{ id: string; name: string }> {
  const allow = new Set(entityIds);
  return (catalog.services ?? []).filter((entry) => allow.has(entry.id));
}

function catalogNameTokensV2(name: string): string[] {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? []
  );
}

function escapeRegexTokenV2(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function catalogFamilyHasPositiveWitnessV2(
  inboundText: string,
  entityIds: readonly string[],
  services: ReadonlyArray<{ id: string; name: string }>
): boolean {
  const allow = new Set(entityIds);
  const tokens = new Set<string>();
  const normalizedInbound = inboundText
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  for (const service of services) {
    if (!allow.has(service.id)) continue;
    for (const token of catalogNameTokensV2(service.name)) {
      if (normalizedInbound.includes(token)) tokens.add(token);
    }
  }
  return [...tokens].some((token) =>
    hasPositiveClauseMatchV2(
      inboundText,
      new RegExp(`\\b${escapeRegexTokenV2(token)}\\b`, 'u')
    )
  );
}

/**
 * Copy canônica: nomes VERBATIM na ordem do catálogo testemunhado. Sem
 * preço/duração anexados. Teto de 8 nomes inteiros; o restante vira contagem.
 * Nunca trunca um nome: para quando o próximo nome inteiro estouraria o
 * orçamento e recalcula a contagem omitida.
 */
export function materializeServiceListCopyV2(
  services: ServicesResult,
  options?: { maxChars?: number }
): string | null {
  if (!services.success) return null;
  return materializeServiceClarificationV2(services.services ?? [], options)?.text ?? null;
}

export function composeServiceListNonListPartsV2(input: {
  baseText?: string | null;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): string[] {
  const parts: string[] = [];
  const greeting = input.socialGreeting?.trim();
  if (greeting) parts.push(greeting);
  const base = input.baseText?.trim();
  if (base && !parts.some((part) => part.includes(base))) parts.push(base);
  if (!base && !greeting && input.courtesyAcknowledgement) parts.push('Imagina!');
  return parts;
}

/** Orçamento do componente de lista: teto final − base − greeting − separadores. */
export function serviceListComponentBudgetV2(input: {
  ceiling?: number;
  baseText?: string | null;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): number {
  const ceiling = input.ceiling ?? SERVICE_LIST_TRANSPORT_CEILING_V2;
  const parts = composeServiceListNonListPartsV2(input);
  if (parts.length === 0) return ceiling;
  const reserved = parts.join('\n\n').length + '\n\n'.length;
  return Math.max(0, ceiling - reserved);
}

export function materializeServiceListCopyWithinBudgetV2(input: {
  servicesResult: ServicesResult;
  baseText?: string | null;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): string | null {
  return materializeServiceListCopyV2(input.servicesResult, {
    maxChars: serviceListComponentBudgetV2(input),
  });
}

export function decideServiceListV2(input: {
  inboundText: string;
  servicesResult: ServicesResult;
  maxChars?: number;
}): ServiceListPlanV2 {
  const match = matchServiceListQuestionV2(input.inboundText);
  if (!match.matched) {
    return {
      decision: { kind: 'none', reason: 'no_enumeration_question' },
      requiresOperationalContinuation: false,
      hasCourtesyAcknowledgement: false,
    };
  }
  const text = materializeServiceListCopyV2(input.servicesResult, {
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
  });
  if (!text) {
    return {
      decision: { kind: 'none', reason: 'catalog_unavailable' },
      requiresOperationalContinuation: false,
      hasCourtesyAcknowledgement: match.hasCourtesyAcknowledgement,
    };
  }
  return {
    decision: { kind: 'answer', text },
    requiresOperationalContinuation: match.requiresOperationalContinuation,
    hasCourtesyAcknowledgement: match.hasCourtesyAcknowledgement,
  };
}

export function composeServiceListComponentV2(input: {
  baseText?: string | null;
  componentText: string;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): string {
  const parts = composeServiceListNonListPartsV2(input);
  const component = input.componentText.trim();
  if (component && !parts.some((part) => part.includes(component))) {
    parts.push(component);
  }
  return parts.join('\n\n');
}

/**
 * Remove UMA ocorrência do texto canônico como segmento server-owned
 * (parágrafo separado por `\n\n`). Zero ou 2+ ocorrências não isentam.
 */
export function stripExactCanonicalServiceListSegmentV2(
  candidate: string,
  exactCanonicalServiceListText: string | null | undefined
): {
  remainder: string;
  occurrenceCount: number;
  stripped: boolean;
} {
  const exact = exactCanonicalServiceListText?.trim() ?? '';
  if (!exact) {
    return { remainder: candidate, occurrenceCount: 0, stripped: false };
  }
  const segments = candidate.split(/\n\n/u);
  const matchingIndexes = segments.flatMap((segment, index) =>
    segment.trim() === exact ? [index] : []
  );
  const occurrenceCount = matchingIndexes.length;
  if (occurrenceCount !== 1) {
    return { remainder: candidate, occurrenceCount, stripped: false };
  }
  const remainder = segments
    .filter((_, index) => index !== matchingIndexes[0])
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return { remainder, occurrenceCount, stripped: true };
}

export function serviceListModelInstructionV2(): string {
  return (
    'COMPONENTE DE CATÁLOGO SERVER-OWNED: não liste, resuma nem parafraseie ' +
    'os serviços; o servidor anexará a lista canônica com os nomes exatos.'
  );
}

export const __serviceListMatchersForSmokeV2 = {
  SERVICE_LIST_QUESTION_RE,
  ADDITIONAL_OPERATIONAL_RE,
  hasPositiveClauseMatchV2,
};
