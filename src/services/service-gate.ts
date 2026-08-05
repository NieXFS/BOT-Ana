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
 * de 6). Match em 3 camadas (nome completo > token distintivo > anti-ambiguidade).
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
function computeWindow(userMessages: string[]): { windowText: string; hasNewBooking: boolean } {
  const messages = (userMessages ?? []).filter((m) => typeof m === 'string' && m.trim().length > 0);
  if (messages.length === 0) return { windowText: '', hasNewBooking: false };
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
  const windowText = windowMsgs.map((m) => normalizeServiceText(m)).join(' \n ');
  const hasNewBooking = windowMsgs.some((message) => {
    const normalized = normalizeServiceText(message);
    return (
      NEW_CHOICE_RE.test(normalized) ||
      (NEW_BOOKING_RE.test(normalized) && !isFlowContinuation(normalized))
    );
  });
  return { windowText, hasNewBooking };
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

export function buildServiceAmbiguationHint(services: ServiceLike[]): string {
  return (
    'INTERNAL_HINT: o cliente ainda não escolheu o serviço nesta intenção de agendamento. ' +
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
  const { windowText, hasNewBooking } = computeWindow(userMessages);
  if (!windowText || !hasNewBooking) return false;
  return matchedServices(windowText, services).length === 0;
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
  const { windowText } = computeWindow(userMessages);
  if (!windowText) return { ok: true };

  const matches = matchedServices(windowText, services);
  const chosenMatch = matches.find((match) => match.id === chosen.id);
  if (chosenMatch) {
    if (matches.length === 1) return { ok: true };
    // Nomes hierárquicos (ex.: "Corte" ⊂ "Corte e Barba"): quando o cliente diz o
    // nome mais específico, AMBOS casam como 'full'. Libera se o escolhido é o
    // full-match MAIS ESPECÍFICO (nome mais longo), sem outro full igual/maior.
    if (chosenMatch.kind === 'full') {
      const chosenLen = normalizeServiceText(chosen.name).length;
      const otherFullAtLeastAsLong = matches.some((m) => {
        if (m.id === chosen.id || m.kind !== 'full') return false;
        const other = services.find((s) => s.id === m.id);
        return other ? normalizeServiceText(other.name).length >= chosenLen : false;
      });
      if (!otherFullAtLeastAsLong) return { ok: true };
    }
  }
  return { ok: false, hintMessage: buildServiceAmbiguationHint(services) };
}
