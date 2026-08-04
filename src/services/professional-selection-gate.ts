/**
 * Guardrail D — seleção de profissional ancorada na mensagem do CLIENTE.
 *
 * Este módulo é propositalmente puro: recebe o snapshot já carregado de
 * serviços/profissionais e as mensagens do usuário, sem consultar calendário,
 * ERP ou histórico persistido. Ele é compartilhado pela produção e pelo
 * benchmark para que a proteção observada seja exatamente a proteção aplicada.
 *
 * A lista de profissionais ativos do snapshot é a fonte de verdade. Quando o
 * ERP informa `service.professionalIds`, a elegibilidade é a interseção desse
 * conjunto com a lista ativa; `undefined` é compatibilidade com ERP legado e
 * usa a lista global, enquanto `[]` significa explicitamente zero habilitados.
 */

import type {
  ProfessionalSummary,
  ServiceSummary,
  ServicesResult,
} from './calendarService';

const RECENT_USER_TURNS = 6;
const OPENER_SCAN_LIMIT = 16;

const INTENT_OPENER_RE =
  /\b(marcar|marca|agendar|agenda|agendamento|remarcar|remarca|reagendar|reagenda|book)\b/;
const CONFIRMATION_CONTINUATION_RE =
  /^(?:sim\b|isso\b|confirmo\b|confirmado\b|perfeito\b|beleza\b|ok\b|certo\b|tudo certo\b)/;
const RESCHEDULE_CONTINUATION_RE =
  /\b(?:remarcar|remarca|reagendar|reagenda)\b|\b(?:mudar|trocar)\s+(?:o\s+)?horario\b/;
const NEW_CHOICE_RE =
  /\b(?:(?:outr[oa]s?|nov[oa]s?)\s+(?:atendimentos?|servicos?|agendamentos?)|(?:marcar|agendar)\s+tambem|(?:marcar|agendar)\b.{0,30}\boutr[oa]s?)\b/;
// Não use "mudei de ideia"/"agora quero" isoladamente: esses termos também
// aparecem em correções de data e não podem apagar uma escolha de profissional.
const EXPLICIT_SERVICE_CHANGE_RE =
  /\b(?:(?:outro|novo)\s+servico|(?:trocar|mudar)\s+(?:de\s+)?(?:o\s+)?servico|quero\s+trocar\s+(?:de\s+)?servico)\b/;
const NAMED_SERVICE_CHANGE_CUE_RE =
  /\b(?:mudei\s+de\s+ideia|mudar\s+de\s+ideia|troquei(?:\s+de)?|em\s+vez\s+(?:disso|de)|agora\s+(?:eu\s+)?quero)\b/;

// Só as formas que de fato respondem à pergunta sobre PROFISSIONAL são
// inequívocas fora de uma resposta curta. "Qualquer horário" é temporal, não
// autoriza autoatribuição de profissional.
const EXPLICIT_ANY_PROFESSIONAL_RE =
  /\b(?:qualquer\s+profissional|quem\s+(?:estiver|tiver|puder)\s+disponivel)\b/;
const ANY_PREFERENCE_SIGNAL_RE =
  /\b(?:tanto\s+faz|qualquer(?:\s+(?:um|uma|profissional))?|sem\s+(?:nenhuma\s+)?preferencia|nao\s+tenho\s+preferencia|indiferente|quem\s+(?:estiver|tiver|puder)\s+disponivel)\b/;
const TEMPORAL_PREFERENCE_QUALIFIER_RE =
  /\b(?:horarios?|horas?|datas?|dias?|turnos?)\b/;
const SHORT_ANY_CORE_RE =
  /^(?:tanto\s+faz|qualquer(?:\s+(?:um|uma))?|sem\s+(?:nenhuma\s+)?preferencia|nao\s+tenho\s+preferencia|indiferente)$/;
const SIMPLE_COURTESY_PREFIX_RE =
  /^(?:(?:sim|isso|ok|ta|certo|beleza|perfeito|por\s+favor|por\s+gentileza|pra\s+mim|para\s+mim|por\s+mim|obrigad[oa]|valeu|entao)\s*(?:[,!.?…]\s*|\s+))+/;
const SIMPLE_COURTESY_SUFFIX_RE =
  /(?:(?:\s*[,!.?…]\s*|\s+)(?:por\s+favor|por\s+gentileza|pra\s+mim|para\s+mim|por\s+mim|obrigad[oa]|valeu|entao|mesmo|ok|ta|isso|sim))+$/;
// Só é usado junto de um sinal de preferência profissional. A exclusão torna
// a frase ambígua; o gate não escolhe o "resto" silenciosamente.
const PROFESSIONAL_EXCLUSION_RE =
  /\b(?:(?:menos|exceto|salvo|fora\s+de)\s+(?:a|o)?\s*[a-z]|nao\s+(?!tenho\s+(?:nenhuma\s+)?preferencia\b)(?:(?:quero|aceito|prefiro|com)\s+)?(?:a|o)?\s*[a-z]|sem\s+(?!(?:nenhuma\s+)?preferencia\b)(?:a|o)?\s*[a-z])/;
const PROFESSIONAL_CHANGE_REQUEST_RE =
  /\b(?:outr[ao]\s+profissional|profissional\s+diferente|(?:trocar|mudar)\s+(?:de\s+)?profissional)\b/;
const PROFESSIONAL_NAME_STOPWORDS = new Set([
  'da',
  'de',
  'do',
  'das',
  'dos',
  'e',
  'profissional',
]);

export type ProfessionalSelectionGateReason =
  | 'services_unavailable'
  | 'service_not_resolved'
  | 'no_eligible_professional'
  | 'single_professional_required'
  | 'preference_required'
  | 'any_preference_requires_omission'
  | 'named_professional_required'
  | 'ineligible_professional_requested';

export type ProfessionalSelectionGateResult =
  | {
      ok: true;
      /** ID canônico a passar à calendar I/O; a tentativa bruta não é reescrita. */
      effectiveProfessionalId?: string;
    }
  | {
      ok: false;
      reason: ProfessionalSelectionGateReason;
      hintMessage: string;
    };

export interface ProfessionalSelectionGateInput {
  serviceId: string;
  professionalId?: string;
  servicesResult: ServicesResult;
  /** Somente falas do cliente; texto do assistant nunca licencia uma escolha. */
  userMessages: string[];
}

type Preference =
  | { kind: 'any' }
  | { kind: 'named'; professional: ProfessionalSummary }
  | { kind: 'ineligible'; professional: ProfessionalSummary }
  | { kind: 'ambiguous' }
  | null;

type PreferenceEvent = Exclude<Preference, null> & { position: number };

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isConfirmationContinuation(message: string): boolean {
  const normalized = normalizeText(message);
  return (
    CONFIRMATION_CONTINUATION_RE.test(normalized) &&
    !NEW_CHOICE_RE.test(normalized)
  );
}

function isRescheduleContinuation(message: string): boolean {
  const normalized = normalizeText(message);
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

function uniqueActiveProfessionals(
  professionals: ProfessionalSummary[]
): ProfessionalSummary[] {
  const seen = new Set<string>();
  return professionals.filter((professional) => {
    if (!professional.id || seen.has(professional.id)) return false;
    seen.add(professional.id);
    return true;
  });
}

function resolveExactIdOrUniquePrefix<T extends { id: string }>(
  items: T[],
  rawId: string | undefined
): T | undefined {
  const id = rawId?.trim() ?? '';
  if (!id) return undefined;

  const exact = items.find((item) => item.id === id);
  if (exact) return exact;

  const prefixes = items.filter((item) => item.id.startsWith(id));
  return prefixes.length === 1 ? prefixes[0] : undefined;
}

function resolveSelectedService(
  services: ServiceSummary[],
  rawServiceId: string
): ServiceSummary | undefined {
  return resolveExactIdOrUniquePrefix(services, rawServiceId);
}

/**
 * `undefined` é a compatibilidade deliberada do ERP legado/misto: a Ana só
 * conhece a lista global de profissionais ativos e não deve transformar isso
 * em "nenhum". Já `[]` é informação positiva de indisponibilidade.
 */
export function eligibleProfessionalsForService(
  service: ServiceSummary,
  activeProfessionals: ProfessionalSummary[]
): ProfessionalSummary[] {
  if (service.professionalIds === undefined) {
    return activeProfessionals;
  }

  const eligibleIds = new Set(service.professionalIds.map(String));
  return activeProfessionals.filter((professional) =>
    eligibleIds.has(professional.id)
  );
}

function messageMentionsService(
  normalizedMessage: string,
  service: ServiceSummary
): boolean {
  const normalizedName = normalizeText(service.name);
  if (normalizedName.length < 3) return false;
  return new RegExp(`\\b${escapeRegex(normalizedName)}\\b`).test(
    normalizedMessage
  );
}

function hasEarlierDifferentService(
  messages: string[],
  start: number,
  endExclusive: number,
  selectedService: ServiceSummary,
  services: ServiceSummary[]
): boolean {
  for (let index = start; index < endExclusive; index += 1) {
    const normalized = normalizeText(messages[index]);
    if (
      services.some(
        (service) =>
          service.id !== selectedService.id &&
          messageMentionsService(normalized, service)
      )
    ) {
      return true;
    }
  }
  return false;
}

function messageMentionsDifferentService(
  normalizedMessage: string,
  selectedService: ServiceSummary,
  services: ServiceSummary[]
): boolean {
  return services.some(
    (service) =>
      service.id !== selectedService.id &&
      messageMentionsService(normalizedMessage, service)
  );
}

/**
 * Uma troca inferida precisa de evidência no texto do CLIENTE. A moldura
 * "mudei de ideia"/"agora quero" sem serviço pode ser só uma correção de data
 * e, por isso, preserva a escolha profissional anterior. Já "outro serviço",
 * "trocar o serviço" etc. é uma reinicialização explícita por si só.
 */
function changesServiceInCurrentMessage(
  normalizedMessage: string,
  messages: string[],
  lowerBound: number,
  index: number,
  selectedService: ServiceSummary,
  services: ServiceSummary[]
): boolean {
  if (EXPLICIT_SERVICE_CHANGE_RE.test(normalizedMessage)) {
    return true;
  }

  if (
    !NAMED_SERVICE_CHANGE_CUE_RE.test(normalizedMessage) ||
    !messageMentionsService(normalizedMessage, selectedService)
  ) {
    return false;
  }

  return (
    messageMentionsDifferentService(
      normalizedMessage,
      selectedService,
      services
    ) ||
    hasEarlierDifferentService(
      messages,
      lowerBound,
      index,
      selectedService,
      services
    )
  );
}

function latestIntentStart(
  messages: string[],
  selectedService: ServiceSummary,
  services: ServiceSummary[]
): number {
  if (messages.length === 0) return 0;

  const lastIndex = messages.length - 1;
  const lowerBound = Math.max(
    0,
    lastIndex - OPENER_SCAN_LIMIT,
    lastIndex - (RECENT_USER_TURNS - 1)
  );
  for (let index = lastIndex; index >= lowerBound; index -= 1) {
    const normalized = normalizeText(messages[index]);
    const explicitlyChangesService = changesServiceInCurrentMessage(
      normalized,
      messages,
      lowerBound,
      index,
      selectedService,
      services
    );
    const startsNewBooking =
      INTENT_OPENER_RE.test(normalized) &&
      !isFlowContinuation(normalized);
    const selectsDifferentServiceWithoutBooking =
      messageMentionsService(normalized, selectedService) &&
      /\b(?:quero|fazer|preciso|prefiro)\b/.test(normalized) &&
      hasEarlierDifferentService(
        messages,
        lowerBound,
        index,
        selectedService,
        services
      );
    if (
      explicitlyChangesService ||
      NEW_CHOICE_RE.test(normalized) ||
      startsNewBooking ||
      selectsDifferentServiceWithoutBooking
    ) {
      return index;
    }
  }

  return lowerBound;
}

function nameTokens(name: string): string[] {
  return normalizeText(name)
    .split(/[^a-z0-9]+/)
    .filter(
      (token) => token.length >= 2 && !PROFESSIONAL_NAME_STOPWORDS.has(token)
    );
}

function distinctiveNameTokens(
  professionals: ProfessionalSummary[]
): Map<string, string[]> {
  const frequency = new Map<string, number>();
  const perProfessional = new Map<string, string[]>();
  for (const professional of professionals) {
    const tokens = [...new Set(nameTokens(professional.name))];
    perProfessional.set(professional.id, tokens);
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return new Map(
    professionals.map((professional) => [
      professional.id,
      (perProfessional.get(professional.id) ?? []).filter(
        (token) => frequency.get(token) === 1
      ),
    ])
  );
}

function positionsForTerms(message: string, terms: string[]): number[] {
  const positions: number[] = [];
  for (const term of terms) {
    const expression = new RegExp(`\\b${escapeRegex(term)}\\b`, 'g');
    positions.push(
      ...[...message.matchAll(expression)].map((match) => match.index ?? 0)
    );
  }
  return positions;
}

function positionsForPattern(message: string, pattern: RegExp): number[] {
  const expression = new RegExp(pattern.source, 'g');
  return [...message.matchAll(expression)].map((match) => match.index ?? 0);
}

/**
 * "Tanto faz" só vira escolha de profissional quando a mensagem é uma resposta
 * curta e autônoma à pergunta de preferência. Termos temporais a tornam
 * ambígua ("tanto faz o horário"), portanto não licenciamos autoatribuição.
 */
function isAutonomousAnyPreference(message: string): boolean {
  if (TEMPORAL_PREFERENCE_QUALIFIER_RE.test(message)) return false;

  const withoutEdgePunctuation = message
    .replace(/^[\s,.!?…]+|[\s,.!?…]+$/g, '')
    .trim();
  const core = withoutEdgePunctuation
    .replace(SIMPLE_COURTESY_PREFIX_RE, '')
    .replace(SIMPLE_COURTESY_SUFFIX_RE, '')
    .replace(/^[\s,.!?…]+|[\s,.!?…]+$/g, '')
    .trim();

  return SHORT_ANY_CORE_RE.test(core);
}

function anyPreferenceEvents(message: string): PreferenceEvent[] {
  const hasAnySignal = ANY_PREFERENCE_SIGNAL_RE.test(message);

  // "Qualquer um menos Marina" não significa "pode escolher qualquer um".
  // Mantemos o bloco fail-closed para que a Ana peça uma escolha inequívoca.
  if (hasAnySignal && PROFESSIONAL_EXCLUSION_RE.test(message)) {
    return [{ kind: 'ambiguous', position: message.length + 1 }];
  }

  const explicitProfessionalPositions = positionsForPattern(
    message,
    EXPLICIT_ANY_PROFESSIONAL_RE
  );
  if (explicitProfessionalPositions.length > 0) {
    return explicitProfessionalPositions.map((position) => ({
      kind: 'any' as const,
      position,
    }));
  }

  return isAutonomousAnyPreference(message)
    ? [{ kind: 'any', position: message.length }]
    : [];
}

function namePositions(
  message: string,
  name: string,
  distinctTokens: string[]
): number[] {
  const normalizedName = normalizeText(name);
  if (normalizedName.length < 2) return [];
  return positionsForTerms(message, [normalizedName, ...distinctTokens]);
}

function explicitNamePositions(
  message: string,
  name: string,
  distinctTokens: string[]
): number[] {
  const normalizedName = normalizeText(name);
  if (normalizedName.length < 2) return [];
  const positions: number[] = [];
  for (const term of [normalizedName, ...distinctTokens]) {
    const expression = new RegExp(
      `\\b(?:com|pela|pelo|pra|para)\\s+(?:a|o)?\\s*${escapeRegex(
        term
      )}\\b`,
      'g'
    );
    positions.push(
      ...[...message.matchAll(expression)].map((match) => match.index ?? 0)
    );
  }
  return positions;
}

/**
 * Nome depois de "não quero", "menos", "exceto" etc. é uma REJEIÇÃO, não
 * uma escolha. Não basta o matcher normal encontrar o token: essa leitura
 * positiva faria a Ana insistir justamente na profissional recusada.
 */
function rejectedNamePositions(
  message: string,
  name: string,
  nameTerms: string[]
): number[] {
  const normalizedName = normalizeText(name);
  if (normalizedName.length < 2) return [];

  const positions: number[] = [];
  for (const term of [normalizedName, ...new Set(nameTerms)]) {
    const escapedTerm = escapeRegex(term);
    const prefixExpression = new RegExp(
      `\\b(?:nao\\s+(?:(?:quero|aceito|prefiro)(?:\\s+mais)?\\s+|com\\s+)?|nao\\s+pode\\s+ser\\s+|que\\s+nao\\s+seja\\s+|menos\\s+|exceto\\s+|salvo\\s+|fora\\s+de\\s+|sem\\s+)(?:a|o)?\\s*${escapedTerm}\\b`,
      'g'
    );
    const suffixExpression = new RegExp(
      `\\b${escapedTerm}\\s*(?:[,;—-]\\s*)?nao\\b`,
      'g'
    );
    positions.push(
      ...[...message.matchAll(prefixExpression)].map(
        (match) => match.index ?? 0
      ),
      ...[...message.matchAll(suffixExpression)].map(
        (match) => match.index ?? 0
      )
    );
  }
  return positions;
}

function preferenceEventsForMessage(
  rawMessage: string,
  activeProfessionals: ProfessionalSummary[]
): PreferenceEvent[] {
  const message = normalizeText(rawMessage);
  if (!message) return [];

  const events: PreferenceEvent[] = anyPreferenceEvents(message);

  const distinctTokens = distinctiveNameTokens(activeProfessionals);
  // Diferente do match positivo, a rejeição também considera primeiro nome
  // compartilhado. "Não quero a Marina" pode não identificar QUAL Marina,
  // mas nunca pode deixar a Marina anterior sobreviver como preferência.
  const hasNamedRejection = activeProfessionals.some(
    (professional) =>
      rejectedNamePositions(
        message,
        professional.name,
        nameTokens(professional.name)
      ).length > 0
  );
  const named = activeProfessionals
    .map((professional) => ({
      professional,
      positions: namePositions(
        message,
        professional.name,
        distinctTokens.get(professional.id) ?? []
      ),
      explicitPositions: explicitNamePositions(
        message,
        professional.name,
        distinctTokens.get(professional.id) ?? []
      ),
    }))
    .filter((candidate) => candidate.positions.length > 0);

  if (
    PROFESSIONAL_CHANGE_REQUEST_RE.test(message) ||
    hasNamedRejection
  ) {
    // A próxima mensagem inequívoca pode substituir este reset; nesta mensagem,
    // porém, nem o nome recusado nem um ID antigo podem atravessar para a I/O.
    events.push({ kind: 'ambiguous', position: message.length + 1 });
    return events;
  }

  const explicitNamed = named.filter(
    (candidate) => candidate.explicitPositions.length > 0
  );
  if (explicitNamed.length === 1) {
    const candidate = explicitNamed[0];
    events.push({
      kind: 'named',
      professional: candidate.professional,
      position: Math.max(...candidate.explicitPositions),
    });
  } else if (explicitNamed.length > 1) {
    events.push({
      kind: 'ambiguous',
      position: Math.max(
        ...explicitNamed.flatMap((candidate) =>
          candidate.explicitPositions
        )
      ),
    });
  } else if (named.length === 1) {
    const candidate = named[0];
    events.push({
      kind: 'named',
      professional: candidate.professional,
      position: Math.max(...candidate.positions),
    });
  } else if (named.length > 1) {
    events.push({
      kind: 'ambiguous',
      position: Math.max(
        ...named.flatMap((candidate) => candidate.positions)
      ),
    });
  }

  return events;
}

function inferLatestPreference(
  userMessages: string[],
  activeProfessionals: ProfessionalSummary[],
  eligibleProfessionals: ProfessionalSummary[],
  selectedService: ServiceSummary,
  services: ServiceSummary[]
): Preference {
  const messages = userMessages.filter(
    (message): message is string =>
      typeof message === 'string' && message.trim().length > 0
  );
  const window = messages.slice(
    latestIntentStart(messages, selectedService, services)
  );
  let latest: PreferenceEvent | null = null;

  for (let messageIndex = 0; messageIndex < window.length; messageIndex += 1) {
    const multiplier = 100_000;
    for (const event of preferenceEventsForMessage(
      window[messageIndex],
      activeProfessionals
    )) {
      const candidate = { ...event, position: messageIndex * multiplier + event.position };
      if (!latest || candidate.position >= latest.position) {
        latest = candidate;
      }
    }
  }

  if (!latest) return null;
  if (latest.kind !== 'named') return latest;

  return eligibleProfessionals.some(
    (professional) => professional.id === latest.professional.id
  )
    ? latest
    : { kind: 'ineligible', professional: latest.professional };
}

function noEligibleHint(service: ServiceSummary): string {
  return (
    `INTERNAL_HINT: ${service.name} está sem profissional habilitado e ativo no momento. ` +
    'NÃO consulte horários nem agende. Informe ao cliente a indisponibilidade do serviço e ofereça outro serviço; ' +
    'NÃO pergunte preferência de profissional nem escolha alguém por conta própria.'
  );
}

function singleProfessionalHint(
  professional: ProfessionalSummary
): string {
  return (
    'INTERNAL_HINT: este serviço tem exatamente um profissional habilitado. ' +
    `Refaça IMEDIATAMENTE a mesma chamada com professionalId: ${professional.id}. ` +
    'NÃO pergunte preferência ao cliente e NÃO escolha outro profissional.'
  );
}

function preferenceRequiredHint(): string {
  return (
    'INTERNAL_HINT: para este serviço há mais de um profissional habilitado e o cliente ainda não escolheu nesta intenção. ' +
    'NÃO consulte disponibilidade nem agende. Pergunte ao cliente: "Profissional específico ou tanto faz?".'
  );
}

function anyPreferenceHint(): string {
  return (
    'INTERNAL_HINT: a preferência mais recente do cliente é "tanto faz"/sem preferência. ' +
    'Refaça IMEDIATAMENTE a mesma chamada SEM professionalId. NÃO escolha um profissional e NÃO pergunte novamente.'
  );
}

function namedProfessionalHint(professional: ProfessionalSummary): string {
  return (
    `INTERNAL_HINT: o cliente escolheu ${professional.name}. ` +
    `Refaça IMEDIATAMENTE a mesma chamada com professionalId: ${professional.id}. ` +
    'NÃO troque de profissional, não omita o ID e não pergunte preferência novamente.'
  );
}

function ineligibleProfessionalHint(): string {
  return (
    'INTERNAL_HINT: o profissional indicado pelo cliente não está habilitado para este serviço. ' +
    'NÃO consulte disponibilidade nem agende com ele. Informe a indisponibilidade e peça ao cliente um profissional específico habilitado ou se tanto faz.'
  );
}

/**
 * Decide se getAvailableSlots/bookAppointment pode atingir o calendário.
 *
 * Sucesso com `effectiveProfessionalId` não modifica o argumento bruto do
 * modelo: o caller deve preservar o trace original e usar somente esse ID
 * canônico na I/O efetiva. Isso permite aceitar um prefixo globalmente unívoco
 * sem deixar a tool final depender de uma forma parcial/ambígua.
 */
export function professionalSelectionGate(
  input: ProfessionalSelectionGateInput
): ProfessionalSelectionGateResult {
  const services = input.servicesResult.services;
  const professionals = input.servicesResult.professionals;
  if (!input.servicesResult.success || !services || !professionals) {
    return {
      ok: false,
      reason: 'services_unavailable',
      hintMessage:
        'INTERNAL_HINT: não foi possível validar a elegibilidade de profissionais agora. NÃO consulte horários nem agende; informe que vai verificar novamente em instantes.',
    };
  }

  const selectedService = resolveSelectedService(services, input.serviceId);
  if (!selectedService) {
    return {
      ok: false,
      reason: 'service_not_resolved',
      hintMessage:
        'INTERNAL_HINT: o serviceId não corresponde a um serviço atual. Chame getServices se a lista puder ter mudado e refaça com o ID técnico correto; NÃO consulte horários nem agende antes disso.',
    };
  }

  const activeProfessionals = uniqueActiveProfessionals(professionals);
  const eligible = eligibleProfessionalsForService(
    selectedService,
    activeProfessionals
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_professional',
      hintMessage: noEligibleHint(selectedService),
    };
  }

  // Resolve no conjunto GLOBAL ativo, como calendarService. Assim um prefixo
  // que parece único só dentro da elegibilidade, mas é ambíguo no catálogo,
  // não atravessa a fronteira de I/O.
  const requested = resolveExactIdOrUniquePrefix(
    activeProfessionals,
    input.professionalId
  );

  if (eligible.length === 1) {
    const onlyProfessional = eligible[0];
    if (requested?.id !== onlyProfessional.id) {
      return {
        ok: false,
        reason: 'single_professional_required',
        hintMessage: singleProfessionalHint(onlyProfessional),
      };
    }
    return { ok: true, effectiveProfessionalId: onlyProfessional.id };
  }

  const preference = inferLatestPreference(
    input.userMessages,
    activeProfessionals,
    eligible,
    selectedService,
    services
  );
  if (!preference || preference.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'preference_required',
      hintMessage: preferenceRequiredHint(),
    };
  }

  if (preference.kind === 'any') {
    if (input.professionalId?.trim()) {
      return {
        ok: false,
        reason: 'any_preference_requires_omission',
        hintMessage: anyPreferenceHint(),
      };
    }
    return { ok: true };
  }

  if (preference.kind === 'ineligible') {
    return {
      ok: false,
      reason: 'ineligible_professional_requested',
      hintMessage: ineligibleProfessionalHint(),
    };
  }

  if (requested?.id !== preference.professional.id) {
    return {
      ok: false,
      reason: 'named_professional_required',
      hintMessage: namedProfessionalHint(preference.professional),
    };
  }

  return {
    ok: true,
    effectiveProfessionalId: preference.professional.id,
  };
}
