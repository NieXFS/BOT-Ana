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
 * Tudo PURO/determinístico. Janela = msgs do USUÁRIO (nunca do assistant — senão
 * validaria a suposição do modelo), delimitada por max(abridor de intenção, teto
 * de 6). Os matches são avaliados POR MENSAGEM e em ordem: a escolha explícita
 * inequívoca mais recente substitui a anterior; duas escolhas na mesma mensagem
 * continuam ambíguas. Match em 3 camadas (nome completo > token distintivo >
 * anti-ambiguidade).
 */

export interface ServiceLike {
  id: string;
  name: string;
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

function normalizeServiceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokensOf(name: string): string[] {
  return normalizeServiceText(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function buildDistinctiveTokens(services: ServiceLike[]): Map<string, Set<string>> {
  const freq = new Map<string, number>();
  const perService = new Map<string, string[]>();
  for (const service of services) {
    const tokens = tokensOf(service.name);
    perService.set(service.id, tokens);
    for (const token of new Set(tokens)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }
  const distinctive = new Map<string, Set<string>>();
  for (const service of services) {
    distinctive.set(
      service.id,
      new Set((perService.get(service.id) ?? []).filter((token) => freq.get(token) === 1))
    );
  }
  return distinctive;
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

type MatchKind = 'full' | 'token';

/** Serviços citados na janela, com o tipo de match (nome completo vs token distintivo). */
function matchedServices(
  windowText: string,
  services: ServiceLike[]
): Array<{ id: string; kind: MatchKind }> {
  const distinctive = buildDistinctiveTokens(services);
  const out: Array<{ id: string; kind: MatchKind }> = [];
  for (const service of services) {
    const name = normalizeServiceText(service.name);
    if (name.length >= 3 && windowText.includes(name)) {
      out.push({ id: service.id, kind: 'full' });
      continue;
    }
    for (const token of distinctive.get(service.id) ?? []) {
      if (new RegExp(`\\b${escapeRegex(token)}\\b`).test(windowText)) {
        out.push({ id: service.id, kind: 'token' });
        break;
      }
    }
  }
  return out;
}

/**
 * Remove o falso match do nome-pai em nomes hierárquicos. Ex.: a mensagem
 * "Corte e Barba" casa também "Corte", mas representa uma única escolha: o
 * full-match mais específico. Matches disjuntos permanecem ambíguos.
 */
function collapseHierarchicalMatches(
  matches: Array<{ id: string; kind: MatchKind }>,
  services: ServiceLike[]
): Array<{ id: string; kind: MatchKind }> {
  const full = matches.filter((match) => match.kind === 'full');
  if (full.length <= 1) return matches;

  return matches.filter((candidate) => {
    const candidateService = services.find((service) => service.id === candidate.id);
    if (!candidateService) return true;
    const candidateName = normalizeServiceText(candidateService.name);
    return !full.some((other) => {
      if (other.id === candidate.id) return false;
      const otherService = services.find((service) => service.id === other.id);
      if (!otherService) return false;
      const otherName = normalizeServiceText(otherService.name);
      return otherName.length > candidateName.length && otherName.includes(candidateName);
    });
  });
}

const INFORMATIONAL_SERVICE_QUESTION_RE =
  /\b(?:qual|quais)\s+(?:e|eh|seria)\s+(?:o\s+)?melhor\b|\b(?:quanto\s+custa|qual\s+(?:o\s+)?preco|voces?\s+(?:faz|fazem|tem|t[eê]m)|tem\s+como)\b/;
const EXPLICIT_CHOICE_RE =
  /\b(?:quero|prefiro|escolho|vou\s+(?:de|querer)|pode\s+ser|troque\s+para|trocar\s+para|mude\s+para|agende|agenda|marque|marca)\b/;

type LatestSelection =
  | { kind: 'none' }
  | { kind: 'chosen'; serviceId: string }
  | { kind: 'ambiguous' };

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
  services: ServiceLike[]
): LatestSelection {
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
    if (matches.length === 0) continue;

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
export function buildServiceQuestion(services: ServiceLike[]): string {
  const names = services.map((s) => s.name);
  let list: string;
  if (names.length <= 1) {
    list = names[0] ?? '';
  } else {
    list = `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
  }
  return `Claro! Para qual serviço você gostaria de agendar? Temos ${list}. Qual você prefere?`;
}

/**
 * PROATIVA: novo pedido de agendamento (verbo de marcar/agendar) na janela SEM
 * nenhum serviço citado → o código deve perguntar o serviço antes do modelo rodar.
 */
export function shouldAskServiceUpfront(services: ServiceLike[], userMessages: string[]): boolean {
  if (!services || services.length < 2) return false;
  const { windowMessages, hasNewBooking } = computeWindow(userMessages);
  if (windowMessages.length === 0 || !hasNewBooking) return false;
  return latestServiceSelection(windowMessages, services).kind !== 'chosen';
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
  userMessages: string[]
): ServiceGateResult {
  if (!services || services.length < 2) return { ok: true };
  const chosen = resolveChosen(services, serviceId);
  if (!chosen) return { ok: true };
  const { windowMessages } = computeWindow(userMessages);
  if (windowMessages.length === 0) return { ok: true };

  const latest = latestServiceSelection(windowMessages, services);
  if (latest.kind === 'chosen' && latest.serviceId === chosen.id) return { ok: true };
  return { ok: false, hintMessage: buildServiceAmbiguationHint(services) };
}
