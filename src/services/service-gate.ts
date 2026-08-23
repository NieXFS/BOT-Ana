/**
 * GUARDRAIL B — desambiguação determinística de serviço (mata a "Falha 1": a Ana
 * assumir QUAL serviço o cliente quer puxando do HISTÓRICO).
 *
 * DUAS camadas (a regra A do prompt vira só backup):
 *  1. shouldAskServiceUpfront (PROATIVA, roda no getReply ANTES do modelo): num
 *     novo pedido de agendamento (verbo marcar/agendar) SEM serviço citado, o
 *     CÓDIGO pergunta o serviço — o modelo nem roda no turno, então não dá pra
 *     assumir nem em texto. É o que pega o caso real (modelo assumindo na fala).
 *  2. serviceSelectionGate (REATIVA, roda no executeFunction antes de
 *     getAvailableSlots/bookAppointment): backstop — se o modelo tentar consultar
 *     horários/agendar com um serviço NÃO escolhido pelo cliente, bloqueia.
 *
 * Tudo PURO/determinístico. Janela = msgs do USUÁRIO, delimitada por
 * max(abridor de intenção, teto de 6). O texto do assistant nunca vale como
 * escolha; a única exceção é contexto para uma resposta numérica do próprio
 * usuário, e ainda assim só quando a pergunta anterior contém 2+ nomes exatos
 * do catálogo atual. Os matches são avaliados POR MENSAGEM e em ordem: a
 * escolha explícita inequívoca mais recente substitui a anterior; duas escolhas
 * na mesma mensagem continuam ambíguas. Match em 4 camadas (nome completo >
 * token distintivo > plural regular/typo seguro > anti-ambiguidade).
 */

import {
  catalogFamilyHasPositiveWitnessV2,
  materializeServiceClarificationV2,
} from './conversationalV2/serviceList';

export interface ServiceLike {
  id: string;
  name: string;
}

export interface ServiceConversationMessage {
  role: string;
  content?: unknown;
}

export type ServiceGateResult = { ok: true } | { ok: false; hintMessage: string };

const RECENT_USER_TURNS = 6;
const OPENER_SCAN_LIMIT = 16;
// Abridores de intenção (delimitam a janela): inclui remarcar/reagendar.
const INTENT_OPENER_RE =
  /\b(marcar|marca|agendar|agenda|agendamento|remarcar|remarca|reagendar|reagenda|book)\b/;
// Abridores de NOVO agendamento (disparam a pergunta proativa) — NÃO inclui
// remarcar/reagendar (que são fluxo de agendamento EXISTENTE, não nova escolha).
const NEW_BOOKING_RE = /\b(marcar|marca|agendar|agenda|agendamento|book)\b/;
const CONFIRMATION_CONTINUATION_RE =
  /^(?:sim\b|isso\b|confirmo\b|confirmado\b|perfeito\b|beleza\b|ok\b|certo\b|tudo certo\b)/;
const RESCHEDULE_CONTINUATION_RE =
  /\b(?:remarcar|remarca|reagendar|reagenda)\b|\b(?:mudar|trocar)\s+(?:o\s+)?horario\b/;
const NEW_CHOICE_RE =
  /\b(?:(?:outr[oa]s?|nov[oa]s?)\s+(?:atendimentos?|servicos?|agendamentos?)|(?:marcar|agendar)\s+tambem|(?:marcar|agendar)\b.{0,30}\boutr[oa]s?)\b/;

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'com', 'em', 'para', 'por',
  'no', 'na', 'ao', 'as', 'os', 'sessao', 'servico', 'atendimento',
]);
const ROMAN_GRADE_VALUES: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
};
const SERVICE_CHOICE_QUESTION_RE =
  /\b(?:qual|prefere|escolh(?:e|a|er|eu)|opcao|interessa)\b/;
const NAKED_WEEKDAY_RE =
  /^(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:\s+feira)?$/;

function normalizeServiceText(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // Nomes de catálogo e respostas humanas podem representar o mesmo grau de
  // formas diferentes ("grau I" x "grau 1"). A equivalência fica limitada ao
  // contexto explícito de `grau` para não transformar letras soltas do texto.
  return normalized.replace(
    /\bgrau\s+(iii|ii|iv|v|i)\b/g,
    (_match, roman: string) => `grau ${ROMAN_GRADE_VALUES[roman]}`
  );
}

/**
 * "Sim, pode marcar" confirma a proposta imediatamente anterior; não abre uma
 * nova intenção e, portanto, não pode apagar da janela o serviço que o próprio
 * cliente escolheu. Já "pode marcar amanhã?" sem uma confirmação explícita e
 * pedidos por outro/novo atendimento continuam abrindo uma intenção nova.
 */
function isConfirmationContinuation(message: string): boolean {
  const normalized = normalizeServiceText(message);
  return (
    CONFIRMATION_CONTINUATION_RE.test(normalized) &&
    !NEW_CHOICE_RE.test(normalized)
  );
}

/**
 * Remarcar/mudar o horário continua o agendamento em curso e preserva o serviço
 * já escolhido. Outro serviço/atendimento ou novo agendamento abre outro fluxo.
 */
function isRescheduleContinuation(message: string): boolean {
  const normalized = normalizeServiceText(message);
  return (
    RESCHEDULE_CONTINUATION_RE.test(normalized) &&
    !NEW_CHOICE_RE.test(normalized)
  );
}

function isFlowContinuation(message: string): boolean {
  return (
    isConfirmationContinuation(message) ||
    isRescheduleContinuation(message)
  );
}

function tokensOf(name: string): string[] {
  return normalizeServiceText(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/**
 * Equivalência conservadora para o plural regular mais comum em nomes de
 * serviço ("calosidade" x "calosidades", "fissura" x "fissuras").
 *
 * A comparação continua sendo por token distintivo do catálogo: isto não cria
 * sinônimos nem permite que um termo compartilhado escolha um serviço. Limitamos
 * a remoção do `s` a palavras longas terminadas em vogal + `s`, evitando tratar
 * invariáveis frequentes como "lápis" e "vírus" como plurais.
 */
function simplePluralStem(token: string): string {
  return token.length >= 5 && /[aeo]s$/.test(token)
    ? token.slice(0, -1)
    : token;
}

/**
 * Distância conservadora de uma edição para token de catálogo. Substituição,
 * inserção, remoção e uma transposição adjacente contam como uma edição. Este
 * helper vive junto do matcher canônico para que boundary/parser não mantenham
 * implementações fuzzy paralelas.
 */
function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) mismatches.push(index);
      if (mismatches.length > 2) return false;
    }
    if (mismatches.length <= 1) return true;
    return (
      mismatches[1] === mismatches[0]! + 1 &&
      left[mismatches[0]!] === right[mismatches[1]!] &&
      left[mismatches[1]!] === right[mismatches[0]!]
    );
  }
  const [shorter, longer] =
    left.length < right.length ? [left, right] : [right, left];
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

/**
 * Regra canônica aprovada para typo de distância 2. Ela vive no matcher
 * compartilhado para que proof/gate/offer/denial/profissionais não mantenham
 * dialetos fuzzy diferentes. Callers que precisam provar a entidade-base sem
 * esse último degrau (C* do offer-check) fazem opt-out explícito.
 */
export const ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH = true;

function editDistanceAtMostTwo(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2) return false;
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0)
  );
  for (let row = 0; row <= left.length; row += 1) rows[row]![0] = row;
  for (let column = 0; column <= right.length; column += 1) {
    rows[0]![column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    let rowMinimum = Number.POSITIVE_INFINITY;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      let distance = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + substitution
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distance = Math.min(distance, rows[row - 2]![column - 2]! + 1);
      }
      rows[row]![column] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > 2) return false;
  }
  return rows[left.length]![right.length]! <= 2;
}

/**
 * Distância EXATAMENTE 2 com uma forma aprovada pelo consenso: duas operações
 * de inserção/remoção, ou uma inserção/remoção mais uma substituição. Duas
 * substituições são deliberadamente proibidas ("mensagem" não vira
 * "Massagem"). Transposição adjacente pura continua sendo o typo de distância
 * 1 já aceito pela casa.
 */
function hasAllowedTwoEditShape(left: string, right: string): boolean {
  if (editDistanceAtMostOne(left, right)) return false;
  if (Math.abs(left.length - right.length) > 2) return false;

  const seen = new Set<string>();
  const visit = (
    leftIndex: number,
    rightIndex: number,
    insertions: number,
    deletions: number,
    substitutions: number
  ): boolean => {
    const edits = insertions + deletions + substitutions;
    if (edits > 2) return false;
    const key = `${leftIndex}:${rightIndex}:${insertions}:${deletions}:${substitutions}`;
    if (seen.has(key)) return false;
    seen.add(key);

    if (leftIndex === left.length && rightIndex === right.length) {
      const indels = insertions + deletions;
      return (
        edits === 2 &&
        ((indels === 2 && substitutions === 0) ||
          (indels === 1 && substitutions === 1))
      );
    }
    if (
      leftIndex < left.length &&
      rightIndex < right.length &&
      left[leftIndex] === right[rightIndex] &&
      visit(
        leftIndex + 1,
        rightIndex + 1,
        insertions,
        deletions,
        substitutions
      )
    ) {
      return true;
    }
    if (
      leftIndex < left.length &&
      rightIndex < right.length &&
      left[leftIndex] !== right[rightIndex] &&
      visit(
        leftIndex + 1,
        rightIndex + 1,
        insertions,
        deletions,
        substitutions + 1
      )
    ) {
      return true;
    }
    if (
      leftIndex < left.length &&
      visit(
        leftIndex + 1,
        rightIndex,
        insertions,
        deletions + 1,
        substitutions
      )
    ) {
      return true;
    }
    return (
      rightIndex < right.length &&
      visit(
        leftIndex,
        rightIndex + 1,
        insertions + 1,
        deletions,
        substitutions
      )
    );
  };

  return visit(0, 0, 0, 0, 0);
}

export interface CatalogEntityMatchOptions {
  /** Opt-out local usado apenas para provar a entidade-base do predicado C*. */
  allowRestrictedDistanceTwo?: boolean;
}

type TokenMatchKind = 'token' | 'typo1' | 'typo2';

function tokenMatchKind(
  candidate: string,
  catalogToken: string,
  options: CatalogEntityMatchOptions = {}
): TokenMatchKind | null {
  const left = simplePluralStem(candidate);
  const right = simplePluralStem(catalogToken);
  if (left === right) return 'token';
  if (left.length < 5 || right.length < 5) return null;
  if (editDistanceAtMostOne(left, right)) return 'typo1';
  return (
    ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH &&
    options.allowRestrictedDistanceTwo !== false &&
    candidate.length >= 6 &&
    catalogToken.length >= 8 &&
    hasAllowedTwoEditShape(left, right)
  )
    ? 'typo2'
    : null;
}

function entityIdsWithinRawDistanceTwo(
  candidate: string,
  entities: ServiceLike[]
): Set<string> {
  const normalizedCandidate = simplePluralStem(normalizeServiceText(candidate));
  const ids = new Set<string>();
  if (!normalizedCandidate) return ids;
  for (const entity of entities) {
    if (
      tokensOf(entity.name).some((catalogToken) =>
        editDistanceAtMostTwo(
          normalizedCandidate,
          simplePluralStem(catalogToken)
        )
      )
    ) {
      ids.add(entity.id);
    }
  }
  return ids;
}

/**
 * C*: perdão local de UM token residual depois que o mesmo segmento já provou
 * a entidade-base sem distância 2. A bola fechada considera qualquer token de
 * outra entidade a distância <=2, inclusive formas que seriam proibidas como
 * match (por exemplo, duas substituições).
 */
export function isClosedCatalogResidualForEntity(
  residualToken: string,
  entityId: string,
  entities: ServiceLike[]
): boolean {
  const candidate = normalizeServiceText(residualToken);
  if (!candidate || /[^a-z0-9]/u.test(candidate)) return false;
  const entity = entities.find((entry) => entry.id === entityId);
  if (!entity) return false;
  const left = simplePluralStem(candidate);
  const matchesTarget = tokensOf(entity.name).some((catalogToken) => {
    if (catalogToken.length < 8) return false;
    const right = simplePluralStem(catalogToken);
    return (
      editDistanceAtMostOne(left, right) ||
      hasAllowedTwoEditShape(left, right)
    );
  });
  if (!matchesTarget) return false;
  const nearbyEntityIds = entityIdsWithinRawDistanceTwo(candidate, entities);
  return nearbyEntityIds.size === 1 && nearbyEntityIds.has(entityId);
}

/** Janela de intenção sobre as msgs do usuário + se contém abridor de NOVO agendamento. */
function computeWindow(userMessages: string[]): {
  windowMessages: string[];
  hasNewBooking: boolean;
} {
  const messages = (userMessages ?? []).filter((m) => typeof m === 'string' && m.trim().length > 0);
  if (messages.length === 0) return { windowMessages: [], hasNewBooking: false };
  const lastIdx = messages.length - 1;
  let openerIdx = -1;
  for (let i = lastIdx; i >= Math.max(0, lastIdx - OPENER_SCAN_LIMIT); i--) {
    const normalized = normalizeServiceText(messages[i]);
    if (
      NEW_CHOICE_RE.test(normalized) ||
      (INTENT_OPENER_RE.test(normalized) &&
        !isFlowContinuation(normalized))
    ) {
      openerIdx = i;
      break;
    }
  }
  // max(0, ...) OBRIGATÓRIO: sem o clamp, poucas msgs sem abridor dão windowStart
  // negativo e slice(-1) pegaria só a última (janela pequena → falso-bloqueio).
  const windowStart = Math.max(0, openerIdx, lastIdx - (RECENT_USER_TURNS - 1));
  const windowMsgs = messages.slice(windowStart);
  const hasNewBooking = windowMsgs.some((message) => {
    const normalized = normalizeServiceText(message);
    return (
      NEW_CHOICE_RE.test(normalized) ||
      (NEW_BOOKING_RE.test(normalized) && !isFlowContinuation(normalized))
    );
  });
  return { windowMessages: windowMsgs, hasNewBooking };
}

type MatchKind = 'full' | 'token' | 'typo';

type CatalogMatchSpan = { start: number; end: number };

type SpannedCatalogMatch = {
  id: string;
  kind: MatchKind;
  span: CatalogMatchSpan;
};

const MATCH_KIND_RANK: Record<MatchKind, number> = {
  full: 3,
  token: 2,
  typo: 1,
};

function locateSubstringSpans(haystack: string, needle: string): CatalogMatchSpan[] {
  const spans: CatalogMatchSpan[] = [];
  if (needle.length < 3) return spans;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    spans.push({ start, end: start + needle.length });
    from = start + 1;
  }
  return spans;
}

function inboundTokenSpans(
  text: string
): Array<{ token: string; span: CatalogMatchSpan }> {
  const out: Array<{ token: string; span: CatalogMatchSpan }> = [];
  for (const match of text.matchAll(/[a-z0-9]+/g)) {
    const token = match[0]!;
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    const start = match.index ?? 0;
    out.push({ token, span: { start, end: start + token.length } });
  }
  return out;
}

function spanFullyContains(
  outer: CatalogMatchSpan,
  inner: CatalogMatchSpan
): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function uniqueMatchesById(
  matches: Array<{ id: string; kind: MatchKind }>
): Array<{ id: string; kind: MatchKind }> {
  const byId = new Map<string, MatchKind>();
  for (const match of matches) {
    const previous = byId.get(match.id);
    if (!previous || MATCH_KIND_RANK[match.kind] > MATCH_KIND_RANK[previous]) {
      byId.set(match.id, match.kind);
    }
  }
  return [...byId.entries()].map(([id, kind]) => ({ id, kind }));
}

/**
 * Matcher canônico com proveniência/posição. Cada match carrega o span no
 * texto normalizado: nome completo ou o token inbound que casou.
 */
function matchedServicesWithSpans(
  windowText: string,
  services: ServiceLike[],
  options: CatalogEntityMatchOptions = {}
): SpannedCatalogMatch[] {
  const inbound = inboundTokenSpans(windowText);
  const out: SpannedCatalogMatch[] = [];
  const forcedDistanceTwoAmbiguity = new Map<string, CatalogMatchSpan>();
  for (const service of services) {
    const name = normalizeServiceText(service.name);
    const fullSpans =
      name.length >= 3 ? locateSubstringSpans(windowText, name) : [];
    if (fullSpans.length > 0) {
      for (const span of fullSpans) {
        out.push({ id: service.id, kind: 'full', span });
      }
      continue;
    }
    const catalogTokens = tokensOf(service.name);
    for (const inboundToken of inbound) {
      let best: Exclude<MatchKind, 'full'> | null = null;
      for (const catalogToken of catalogTokens) {
        const kind = tokenMatchKind(inboundToken.token, catalogToken, options);
        if (kind === 'token') {
          best = 'token';
          break;
        }
        if (kind === 'typo1') best ??= 'typo';
        if (kind === 'typo2') {
          best ??= 'typo';
          const nearby = entityIdsWithinRawDistanceTwo(
            inboundToken.token,
            services
          );
          if (nearby.size > 1) {
            for (const entityId of nearby) {
              if (!forcedDistanceTwoAmbiguity.has(entityId)) {
                forcedDistanceTwoAmbiguity.set(entityId, inboundToken.span);
              }
            }
          }
        }
      }
      if (best) {
        out.push({
          id: service.id,
          kind: best,
          span: inboundToken.span,
        });
      }
    }
  }
  for (const [entityId, span] of forcedDistanceTwoAmbiguity) {
    if (!out.some((match) => match.id === entityId)) {
      out.push({ id: entityId, kind: 'typo', span });
    }
  }
  return out;
}

/** Serviços citados na janela, com o tipo de match (nome completo vs token distintivo). */
function matchedServices(
  windowText: string,
  services: ServiceLike[],
  options: CatalogEntityMatchOptions = {}
): Array<{ id: string; kind: MatchKind }> {
  return uniqueMatchesById(
    matchedServicesWithSpans(windowText, services, options)
  );
}

/**
 * F1 leitura: com match de nome completo, descarta só o token do irmão cujo
 * span está inteiramente contido no span desse nome. Fuzzy/token independente
 * (fora do span) permanece.
 */
function discardSiblingTokensContainedInFullNameSpans(
  matches: SpannedCatalogMatch[]
): SpannedCatalogMatch[] {
  const full = matches.filter((match) => match.kind === 'full');
  if (full.length === 0) return matches;
  return matches.filter((candidate) => {
    if (candidate.kind !== 'token') return true;
    return !full.some(
      (fullMatch) =>
        fullMatch.id !== candidate.id &&
        spanFullyContains(fullMatch.span, candidate.span)
    );
  });
}

function isCatalogParentOfFullMatch(
  candidate: { id: string },
  full: Array<{ id: string }>,
  services: ServiceLike[]
): boolean {
  const candidateService = services.find((service) => service.id === candidate.id);
  if (!candidateService) return false;
  const candidateName = normalizeServiceText(candidateService.name);
  return full.some((other) => {
    if (other.id === candidate.id) return false;
    const otherService = services.find((service) => service.id === other.id);
    if (!otherService) return false;
    const otherName = normalizeServiceText(otherService.name);
    return otherName.length > candidateName.length && otherName.includes(candidateName);
  });
}

/**
 * Remove o falso match do nome-pai em nomes hierárquicos. Ex.: a mensagem
 * "Corte e Barba" casa também "Corte", mas representa uma única escolha: o
 * full-match mais específico. Matches disjuntos permanecem ambíguos.
 *
 * WRITE-only: um full único descarta fuzzy/token irmãos (typo-distance). O
 * resolvedor F1 de leitura não usa este early-return.
 */
function collapseHierarchicalMatches(
  matches: Array<{ id: string; kind: MatchKind }>,
  services: ServiceLike[]
): Array<{ id: string; kind: MatchKind }> {
  const full = matches.filter((match) => match.kind === 'full');
  if (full.length === 1) return full;
  if (full.length === 0) {
    const token = matches.filter((match) => match.kind === 'token');
    return token.length > 0 ? token : matches;
  }
  return matches.filter(
    (candidate) => !isCatalogParentOfFullMatch(candidate, full, services)
  );
}

/**
 * F1 leitura: depois da absorção por span, só colapsa pai→filho quando o
 * nome do catálogo do pai é substring real do filho ("Drenagem" ⊂
 * "Drenagem Linfática" / "Corte" ⊂ "Corte e Barba").
 */
function collapseHierarchicalMatchesForRead(
  matches: Array<{ id: string; kind: MatchKind }>,
  services: ServiceLike[]
): Array<{ id: string; kind: MatchKind }> {
  const full = matches.filter((match) => match.kind === 'full');
  if (full.length === 0) return matches;
  return matches.filter(
    (candidate) => !isCatalogParentOfFullMatch(candidate, full, services)
  );
}

function catalogEntityResolutionFromMatches(
  matches: Array<{ id: string; kind: MatchKind }>,
  entities: ServiceLike[]
): CatalogEntityResolution {
  if (matches.length === 0) return { kind: 'no_match', reason: 'none' };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      entityIds: matches.map((match) => match.id),
    };
  }
  const match = matches[0]!;
  const entity = entities.find((candidate) => candidate.id === match.id);
  return entity
    ? { kind: 'resolved', entity, matchKind: match.kind }
    : { kind: 'no_match', reason: 'none' };
}

export type CatalogEntityResolution =
  | { kind: 'resolved'; entity: ServiceLike; matchKind: MatchKind }
  | { kind: 'ambiguous'; entityIds: string[] }
  | { kind: 'no_match'; reason: 'empty' | 'naked_weekday' | 'none' };

export type CatalogEntityMatchKind = MatchKind;

export type CatalogEntityMatchV2 = {
  id: string;
  kind: CatalogEntityMatchKind;
};

/**
 * Lista colapsada do matcher canônico. Não escolhe; só expõe os IDs testemunhados
 * no inbound atual para polaridade/correção server-owned.
 */
export function listCatalogEntityMatchesFromCurrentMessage(
  message: string,
  entities: ServiceLike[],
  options: CatalogEntityMatchOptions = {}
): CatalogEntityMatchV2[] {
  const normalized = normalizeServiceText(message);
  if (!normalized || entities.length === 0) return [];
  if (NAKED_WEEKDAY_RE.test(normalized)) return [];
  return collapseHierarchicalMatches(
    matchedServices(normalized, entities, options),
    entities
  );
}

function resolveCatalogEntityFromCurrentMessage(
  message: string,
  entities: ServiceLike[],
  options: CatalogEntityMatchOptions,
  collapse: (
    matches: Array<{ id: string; kind: MatchKind }>,
    services: ServiceLike[]
  ) => Array<{ id: string; kind: MatchKind }>
): CatalogEntityResolution {
  const normalized = normalizeServiceText(message);
  if (!normalized || entities.length === 0) {
    return { kind: 'no_match', reason: 'empty' };
  }
  if (NAKED_WEEKDAY_RE.test(normalized)) {
    return { kind: 'no_match', reason: 'naked_weekday' };
  }
  return catalogEntityResolutionFromMatches(
    collapse(matchedServices(normalized, entities, options), entities),
    entities
  );
}

/**
 * Resolução detalhada pelo matcher canônico da casa. O retorno preserva a
 * distinção entre ambiguidade e ausência de evidência para os validadores v2.
 */
export function resolveUniqueCatalogEntityFromCurrentMessage(
  message: string,
  entities: ServiceLike[],
  options: CatalogEntityMatchOptions = {}
): CatalogEntityResolution {
  return resolveCatalogEntityFromCurrentMessage(
    message,
    entities,
    options,
    collapseHierarchicalMatches
  );
}

/**
 * Resolvedor F1 de LEITURA. Preserva proveniência/posição. Nome completo
 * absorve só o token de irmão contido no próprio span; fuzzy/token fora do
 * span permanece. 2+ candidatos restantes ⇒ `ambiguous` (pré-F1: sem
 * grounding, sem tool). Write continua no early-return de full único.
 */
export function resolveUniqueCatalogEntityFromCurrentMessageForRead(
  message: string,
  entities: ServiceLike[],
  options: CatalogEntityMatchOptions = {}
): CatalogEntityResolution {
  const normalized = normalizeServiceText(message);
  if (!normalized || entities.length === 0) {
    return { kind: 'no_match', reason: 'empty' };
  }
  if (NAKED_WEEKDAY_RE.test(normalized)) {
    return { kind: 'no_match', reason: 'naked_weekday' };
  }
  const surviving = discardSiblingTokensContainedInFullNameSpans(
    matchedServicesWithSpans(normalized, entities, options)
  );
  return catalogEntityResolutionFromMatches(
    collapseHierarchicalMatchesForRead(
      uniqueMatchesById(surviving),
      entities
    ),
    entities
  );
}

const INFORMATIONAL_SERVICE_QUESTION_RE =
  /\b(?:qual|quais)\s+(?:e|eh|seria)\s+(?:o\s+)?melhor\b|\b(?:quanto\s+custa|qual\s+(?:o\s+)?preco|voces?\s+(?:faz|fazem|tem|t[eê]m)|tem\s+como)\b/;
const EXPLICIT_CHOICE_RE =
  /\b(?:quero|prefiro|escolho|vou\s+(?:de|querer)|pode\s+ser|troque\s+para|trocar\s+para|mude\s+para|agende|agenda|marque|marca)\b/;

type LatestSelection =
  | { kind: 'none' }
  | { kind: 'chosen'; serviceId: string }
  | { kind: 'ambiguous' };

function parseShortGradeReply(message: string): number | null {
  const normalized = normalizeServiceText(message);
  const match = normalized.match(
    /^(?:(?:opcao|grau)\s+)?([1-9])(?:[º°])?$/
  );
  return match?.[1] ? Number(match[1]) : null;
}

function serviceGradeNumbers(service: ServiceLike): Set<number> {
  const normalized = normalizeServiceText(service.name);
  const numbers = new Set<number>();
  for (const match of normalized.matchAll(
    /\bgrau\s+([1-9])(?:\s+(?:e|a|-)\s+([1-9]))?/g
  )) {
    if (match[1]) numbers.add(Number(match[1]));
    if (match[2]) numbers.add(Number(match[2]));
  }
  return numbers;
}

/**
 * Uma resposta curta como "1" só vale como escolha quando a mensagem
 * imediatamente anterior da Ana contém pelo menos dois nomes EXATOS do
 * catálogo atual e o número identifica um único serviço por seu `grau`.
 *
 * Assim preservamos o caso humano "grau I" → "1" sem transformar qualquer
 * número solto (dia, horário, quantidade) em serviço e sem confiar numa
 * afirmação livre da assistente: os candidatos precisam existir no snapshot
 * autoritativo recebido do Receps.
 */
function anchoredGradeSelections(
  windowMessages: string[],
  services: ServiceLike[],
  conversationMessages: ServiceConversationMessage[]
): Array<string | null> {
  const selections = windowMessages.map(() => null as string | null);
  if (windowMessages.length === 0 || conversationMessages.length === 0) {
    return selections;
  }

  const userEntries: Array<{ messageIndex: number; content: string }> = [];
  for (let index = 0; index < conversationMessages.length; index += 1) {
    const message = conversationMessages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      userEntries.push({ messageIndex: index, content: message.content });
    }
  }

  const scopedEntries = userEntries.slice(-windowMessages.length);
  const windowOffset = windowMessages.length - scopedEntries.length;
  for (let scopedIndex = 0; scopedIndex < scopedEntries.length; scopedIndex += 1) {
    const entry = scopedEntries[scopedIndex]!;
    const windowIndex = windowOffset + scopedIndex;
    if (
      normalizeServiceText(entry.content) !==
      normalizeServiceText(windowMessages[windowIndex] ?? '')
    ) {
      continue;
    }

    const grade = parseShortGradeReply(entry.content);
    if (grade === null) continue;

    const previous = conversationMessages[entry.messageIndex - 1];
    if (previous?.role !== 'assistant' || typeof previous.content !== 'string') {
      continue;
    }

    const normalizedAssistant = normalizeServiceText(previous.content);
    if (!SERVICE_CHOICE_QUESTION_RE.test(normalizedAssistant)) continue;
    const mentionedServices = services.filter((service) => {
      const normalizedName = normalizeServiceText(service.name);
      return normalizedName.length >= 3 && normalizedAssistant.includes(normalizedName);
    });
    if (mentionedServices.length < 2) continue;

    const gradeCandidates = mentionedServices.filter((service) =>
      serviceGradeNumbers(service).has(grade)
    );
    if (gradeCandidates.length === 1) {
      selections[windowIndex] = gradeCandidates[0]!.id;
    }
  }

  return selections;
}

function decisiveChoiceTarget(
  normalizedMessage: string,
  services: ServiceLike[]
): string | null {
  const targetPatterns = [
    /\b(?:quero|prefiro|escolho|troque\s+para|mude\s+para)\s+(.+?)(?=\s+(?:em\s+vez\s+de|ao\s+inves\s+de|e\s+nao)\b|$)/,
    /\btroque\s+de\b.+\bpara\s+(.+)$/,
  ];
  for (const pattern of targetPatterns) {
    const target = normalizedMessage.match(pattern)?.[1];
    if (!target) continue;
    const targetMatches = collapseHierarchicalMatches(
      matchedServices(target, services),
      services
    );
    if (targetMatches.length === 1) return targetMatches[0]!.id;
  }
  return null;
}

/**
 * Resolve a escolha do fim para o começo. Uma menção informativa isolada não
 * troca o serviço em curso; respostas curtas como "o Peeling" continuam sendo
 * escolhas válidas quando contêm exatamente um match.
 */
function latestServiceSelection(
  windowMessages: string[],
  services: ServiceLike[],
  conversationMessages: ServiceConversationMessage[] = []
): LatestSelection {
  const anchoredGrades = anchoredGradeSelections(
    windowMessages,
    services,
    conversationMessages
  );
  for (let index = windowMessages.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeServiceText(windowMessages[index] ?? '');
    const matches = collapseHierarchicalMatches(
      matchedServices(normalized, services),
      services
    );
    if (matches.length >= 2) {
      const decisiveTarget = decisiveChoiceTarget(normalized, services);
      return decisiveTarget
        ? { kind: 'chosen', serviceId: decisiveTarget }
        : { kind: 'ambiguous' };
    }
    if (matches.length === 0) {
      const anchoredServiceId = anchoredGrades[index];
      if (anchoredServiceId) {
        return { kind: 'chosen', serviceId: anchoredServiceId };
      }
      continue;
    }

    const isInformationalQuestion = INFORMATIONAL_SERVICE_QUESTION_RE.test(normalized);
    const isExplicitChoice = EXPLICIT_CHOICE_RE.test(normalized);
    const isTerseAnswer =
      !/[?]/.test(normalized) &&
      normalized.split(/\s+/).length <= 6;
    if (!isInformationalQuestion && (isExplicitChoice || isTerseAnswer)) {
      return { kind: 'chosen', serviceId: matches[0]!.id };
    }
  }
  return { kind: 'none' };
}

export const SERVICE_SELECTION_HINT_PREFIX =
  'INTERNAL_HINT: o cliente ainda não escolheu o serviço nesta intenção de agendamento.';

export function buildServiceAmbiguationHint(services: ServiceLike[]): string {
  return (
    `${SERVICE_SELECTION_HINT_PREFIX} ` +
    'NÃO assuma o serviço pelo histórico nem por agendamentos anteriores. NÃO consulte horários nem agende ainda. ' +
    'Liste de forma NEUTRA estes serviços e pergunte qual o cliente quer: ' +
    services.map((service) => service.name).join(', ') +
    '. Quando ele escolher, refaça a chamada com o serviceId correto.'
  );
}

export const SERVICE_SELECTION_INTERNAL_HINT_SAMPLE =
  buildServiceAmbiguationHint([
    { id: 'service-smoke-a', name: 'Serviço Smoke A' },
    { id: 'service-smoke-b', name: 'Serviço Smoke B' },
  ]);

/** Pergunta amigável (vai DIRETO ao cliente) listando os serviços de forma neutra. */
export function buildServiceQuestion(
  services: ServiceLike[],
  inboundText?: string
): string {
  const selected = servicesForClarificationQuestion(services, inboundText);
  const materialized = materializeServiceClarificationV2(selected);
  if (materialized?.text) return materialized.text;
  return 'Por aqui: Algum desses te interessa?';
}

function servicesForClarificationQuestion(
  services: ServiceLike[],
  inboundText?: string
): ServiceLike[] {
  const trimmed = inboundText?.trim();
  if (!trimmed) return services;
  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(trimmed, services, {
    allowRestrictedDistanceTwo: ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  });
  if (
    resolution.kind === 'ambiguous' &&
    catalogFamilyHasPositiveWitnessV2(trimmed, resolution.entityIds, services)
  ) {
    const allow = new Set(resolution.entityIds);
    return services.filter((service) => allow.has(service.id));
  }
  return services;
}

/**
 * Continuação segura depois de uma escolha inequívoca de serviço: pede o
 * próximo dado (dia/horário) sem repetir o catálogo e sem inventar agenda.
 */
export function buildServiceSelectedFollowUp(serviceName: string): string {
  const name = serviceName.trim();
  return `Perfeito, ${name}. Qual dia e horário você prefere?`;
}

/**
 * PROATIVA: novo pedido de agendamento (verbo de marcar/agendar) na janela SEM
 * nenhum serviço citado → o código deve perguntar o serviço antes do modelo rodar.
 */
export function shouldAskServiceUpfront(
  services: ServiceLike[],
  userMessages: string[],
  conversationMessages: ServiceConversationMessage[] = []
): boolean {
  if (!services || services.length < 2) return false;
  const { windowMessages, hasNewBooking } = computeWindow(userMessages);
  if (windowMessages.length === 0 || !hasNewBooking) return false;
  if (
    latestServiceSelection(windowMessages, services, conversationMessages).kind ===
    'chosen'
  ) {
    return false;
  }
  const lastAssistant = [...conversationMessages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' && typeof message.content === 'string'
    );
  if (
    lastAssistant &&
    typeof lastAssistant.content === 'string' &&
    !lastAssistant.content.trimStart().toLowerCase().startsWith('[atendente] ')
  ) {
    const normalizedAssistant = normalizeServiceText(lastAssistant.content);
    if (SERVICE_CHOICE_QUESTION_RE.test(normalizedAssistant)) {
      const listed = services.filter((service) => {
        const name = normalizeServiceText(service.name);
        return name.length >= 3 && normalizedAssistant.includes(name);
      });
      if (listed.length >= 2) return false;
    }
  }
  return true;
}

/** Serviço único e inequívoco citado na mensagem ATUAL, mesmo em pergunta. */
export function uniqueCatalogServiceFromCurrentMessage(
  message: string,
  services: ServiceLike[]
): ServiceLike | undefined {
  const resolution = resolveUniqueCatalogEntityFromCurrentMessage(
    message,
    services
  );
  return resolution.kind === 'resolved' ? resolution.entity : undefined;
}

/**
 * Grounding allow-only para LEITURAS: menção canônica unívoca (0 ou 2+
 * permanece fail-closed) ancora getAvailableSlots/preço/duração. Writes
 * continuam exigindo o fluxo completo via serviceSelectionGate.
 */
export function uniqueCanonicalMentionGroundsReadSelection(
  serviceId: string,
  services: ServiceLike[],
  currentMessage: string
): boolean {
  const unique = resolveUniqueCatalogEntityFromCurrentMessageForRead(
    currentMessage,
    services,
    {
      allowRestrictedDistanceTwo: ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
    }
  );
  const chosen = resolveChosen(services, serviceId);
  return Boolean(
    unique.kind === 'resolved' && chosen && unique.entity.id === chosen.id
  );
}

/**
 * Resolve o serviço escolhido pelo MESMO critério do calendarService
 * (findByExactIdOrUniquePrefix): igualdade exata OU prefixo único. Sem isso, um
 * serviceId truncado/parcial (que o book resolve por prefixo) faria o gate não
 * achar `chosen` → fail-open → BYPASS do guardrail (achado da revisão).
 */
function resolveChosen(services: ServiceLike[], serviceId: string): ServiceLike | undefined {
  const id = (serviceId ?? '').trim();
  if (!id) return undefined;
  const exact = services.find((service) => service.id === id);
  if (exact) return exact;
  const prefix = services.filter((service) => service.id.startsWith(id));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/**
 * REATIVA (backstop): o serviceId escolhido está ancorado numa escolha explícita
 * recente do cliente? Se não, {ok:false} pra forçar desambiguação.
 */
export function serviceSelectionGate(
  serviceId: string,
  services: ServiceLike[],
  userMessages: string[],
  conversationMessages: ServiceConversationMessage[] = []
): ServiceGateResult {
  if (!services || services.length < 2) return { ok: true };
  const chosen = resolveChosen(services, serviceId);
  if (!chosen) return { ok: true };
  const { windowMessages } = computeWindow(userMessages);
  if (windowMessages.length === 0) return { ok: true };

  const latest = latestServiceSelection(
    windowMessages,
    services,
    conversationMessages
  );
  if (latest.kind === 'chosen' && latest.serviceId === chosen.id) return { ok: true };
  return { ok: false, hintMessage: buildServiceAmbiguationHint(services) };
}
