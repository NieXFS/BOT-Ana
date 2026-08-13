function normalizeSocialMessage(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ReceptionistTurnPermission =
  | 'SOCIAL_ONLY'
  | 'INFORMATION_REQUEST'
  | 'TRANSACTION_REQUEST'
  | 'NO_OPERATIONAL_INTENT';

export interface ReceptionistTurnCatalog {
  services?: readonly string[];
  professionals?: readonly string[];
}

export interface ReceptionistTurnPermissionContext {
  /** Texto imediatamente anterior da Ana; echo humano não deve ser passado. */
  previousAssistantText?: string;
}

const SERVICE_CHOICE_QUESTION_RE =
  /\b(?:qual|prefere|escolh(?:e|a|er|eu)|opcao)\b/u;
const EXACT_SELECTION_ARTICLE_PREFIX_RE = /^(?:a|o|um|uma|esse|essa|este|esta)\s+/u;
const EXACT_SELECTION_COURTESY_SUFFIX_RE =
  /\s+(?:por favor|pfv|pf|please)$/u;

const CATALOG_STOP_WORDS = new Set([
  'a',
  'as',
  'com',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'o',
  'os',
  'para',
  'por',
]);

function catalogTokenKey(value: string): string {
  if (value === 'pes') return 'pe';
  if (value === 'maos') return 'mao';
  if (value === 'unhas') return 'unha';
  if (value.length >= 5 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  if (left.length === right.length) {
    let mismatches = 0;
    let firstMismatch = -1;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) continue;
      if (firstMismatch === -1) firstMismatch = index;
      mismatches += 1;
      if (mismatches > 2) return false;
    }
    if (mismatches <= 1) return true;
    // Damerau: uma transposição adjacente comum de teclado/celular conta como
    // uma edição (`dai`↔`dia`, `bmo`↔`bom`).
    return (
      firstMismatch >= 0 &&
      left[firstMismatch] === right[firstMismatch + 1] &&
      left[firstMismatch + 1] === right[firstMismatch]
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

function isAdjacentTransposition(left: string, right: string): boolean {
  if (left.length !== right.length || left === right) return false;
  const mismatches: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) mismatches.push(index);
  }
  return (
    mismatches.length === 2 &&
    mismatches[1] === mismatches[0]! + 1 &&
    left[mismatches[0]!] === right[mismatches[1]!] &&
    left[mismatches[1]!] === right[mismatches[0]!]
  );
}

const FUZZY_SOCIAL_TOKENS = [
  'oi',
  'ola',
  'bom',
  'boa',
  'dia',
  'tarde',
  'noite',
  'tudo',
  'bem',
  'certo',
  'como',
  'voce',
  'esta',
  'vai',
  'joia',
  'otimo',
  'tranquilo',
] as const;

function normalizeConservativeSocialTypos(value: string): string {
  return value
    .split(' ')
    .map((token) => {
      if (token.length < 3 || /^\d+$/u.test(token)) return token;
      const transpositions = FUZZY_SOCIAL_TOKENS.filter((known) =>
        isAdjacentTransposition(token, known)
      );
      if (transpositions.length === 1) return transpositions[0];
      const candidates = FUZZY_SOCIAL_TOKENS.filter((known) =>
        editDistanceAtMostOne(token, known)
      );
      return candidates.length === 1 ? candidates[0] : token;
    })
    .join(' ');
}

/**
 * Entrada puramente social nunca reabre fluxo operacional antigo nem consulta
 * agenda. A tolerância de uma edição cobre digitação real de celular, mas só
 * para vocabulário social; qualquer termo operacional restante impede o atalho.
 */
export function isSocialOnlyReceptionistMessage(value: string): boolean {
  let text = normalizeSocialMessage(value);
  if (!text || text.length > 80) return false;

  text = text.replace(/\bana\b/g, ' ').replace(/\s+/g, ' ').trim();
  text = normalizeConservativeSocialTypos(text);
  text = text.replace(/^bom dia+a*\b/, 'bom dia');
  text = text.replace(/^bim dia\b/, 'bom dia');
  text = text.replace(/^bom di\b/, 'bom dia');
  text = text.replace(/^b(?:ia|oua) tarde\b/, 'boa tarde');
  text = text.replace(/^boa tarde+\b/, 'boa tarde');
  text = text.replace(/^boa noite+\b/, 'boa noite');

  let consumed = false;
  const fragments = [
    /^(?:oi+e*|ola+|opa|e ai)\b\s*/,
    /^(?:bom dia|boa tarde|boa noite)\b\s*/,
    /^(?:tudo|td)\s+(?:bem|bom|certo)(?:\s+(?:com\s+)?(?:voce|vc))?\b\s*/,
    /^(?:como (?:voce|vc) (?:esta|ta|vai)|como vai)\b\s*/,
    /^(?:tudo (?:joia|otimo|tranquilo))\b\s*/,
    /^(?:por ai)\b\s*/,
    /^(?:e\s+)?(?:voce|vc)\b\s*/,
  ];

  while (text) {
    const previous = text;
    for (const fragment of fragments) {
      const next = text.replace(fragment, '').trim();
      if (next !== text) {
        text = next;
        consumed = true;
        break;
      }
    }
    if (previous === text) break;
  }

  return consumed && text.length === 0;
}

const WEEKDAY_OR_RELATIVE_DAY_RE =
  /\b(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)\b/u;
const CLOCK_CUE_RE =
  /(?:\b(?:as|depois das?|a partir das?|por volta das?)\s+(?:[01]?\d|2[0-3])(?:\s+(?:[0-5]\d|horas?))?\b|\b(?:[01]?\d|2[0-3])h(?:[0-5]\d)?\b|\b(?:[01]?\d|2[0-3])(?:[:\s][0-5]\d)\b)/u;
const SERVICE_OR_PROFESSIONAL_WORD_RE =
  /\b(?:servicos?|procedimentos?|tratamentos?|profissiona(?:l|is))\b/u;
const CUSTOMER_REQUEST_VERB_RE =
  /\b(?:quero|queria|gostaria|preciso|desejo|prefiro|fazer)\b/u;

/**
 * Seleção compacta pelo nome completo do catálogo, depois de acento/caixa.
 * Token parcial ("Drenagem") e substantivo pessoal não passam.
 */
export function uniqueExactCatalogServiceSelection(
  value: string,
  catalogNames: readonly string[]
): string | null {
  if (/[?]/.test(value)) return null;
  let text = normalizeSocialMessage(value);
  if (!text) return null;
  text = text.replace(EXACT_SELECTION_ARTICLE_PREFIX_RE, '').trim();
  text = text.replace(EXACT_SELECTION_COURTESY_SUFFIX_RE, '').trim();
  if (!text) return null;

  const matches = catalogNames.filter(
    (name) => normalizeSocialMessage(name) === text
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * A fala imediatamente anterior da Ana foi uma pergunta de serviço que listou
 * o nome completo escolhido e pelo menos outro serviço do snapshot atual.
 */
export function assistantAskedImmediateServiceChoice(
  assistantText: string | undefined,
  catalogNames: readonly string[],
  selectedServiceName?: string
): boolean {
  const assistant = normalizeSocialMessage(assistantText ?? '');
  if (!assistant || !SERVICE_CHOICE_QUESTION_RE.test(assistant)) return false;

  const listed = catalogNames.filter((name) => {
    const normalizedName = normalizeSocialMessage(name);
    return normalizedName.length >= 3 && assistant.includes(normalizedName);
  });
  if (listed.length < 2) return false;
  if (!selectedServiceName) return true;
  const selected = normalizeSocialMessage(selectedServiceName);
  return listed.some((name) => normalizeSocialMessage(name) === selected);
}

export function looksLikeStandaloneServiceAttempt(value: string): boolean {
  if (/[?]/.test(value)) return false;
  const text = normalizeSocialMessage(value);
  if (!text) return false;
  if (isSocialOnlyReceptionistMessage(value)) return false;
  if (WEEKDAY_OR_RELATIVE_DAY_RE.test(text) || CLOCK_CUE_RE.test(text)) {
    return false;
  }
  if (/\b\d+\b/u.test(text)) return false;
  if (
    /^(?:sim|nao|ok|certo|obrigad[ao]|por favor|pf|pode ser|fechado|combinado)(?:\s+por favor)?$/u.test(
      text
    )
  ) {
    return false;
  }
  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  return tokens.every(
    (token) => CATALOG_STOP_WORDS.has(token) || /^[a-z]+$/u.test(token)
  );
}

export function currentMessageMentionsCatalogService(
  value: string,
  catalogNames: readonly string[]
): boolean {
  if (uniqueExactCatalogServiceSelection(value, catalogNames)) return true;
  const text = normalizeSocialMessage(value);
  if (!text) return false;
  return messageMentionsCatalogToken(
    text,
    catalogNames.map(normalizeSocialMessage).filter(Boolean)
  );
}

function messageMentionsCatalogToken(
  text: string,
  catalogNames: readonly string[]
): boolean {
  const inputTokens = text.split(' ').filter(Boolean);
  return catalogNames.some((name) => {
    const catalogTokens = name
      .split(' ')
      .filter((token) => !CATALOG_STOP_WORDS.has(token))
      .map(catalogTokenKey);
    return inputTokens.some((token) => {
      if (CATALOG_STOP_WORDS.has(token)) return false;
      const key = catalogTokenKey(token);
      return (
        catalogTokens.includes(key) &&
        (key.length >= 4 || ['pe', 'mao', 'unha'].includes(key))
      );
    });
  });
}

/**
 * Sinal de dia/data/hora/número/serviço/profissional no turno atual. Sozinho
 * não autoriza agenda: o classificador ainda exige pedido transacional ou
 * informacional. Serve para o grounding não mandar conversa pessoal com esses
 * tokens ao modelo — e para não engolir um "sim"/"ok" de confirmação.
 */
export function hasNonTransactionalOperationalCue(value: string): boolean {
  const text = normalizeSocialMessage(value);
  if (!text) return false;
  return (
    WEEKDAY_OR_RELATIVE_DAY_RE.test(text) ||
    CLOCK_CUE_RE.test(text) ||
    /\b\d+\b/u.test(text) ||
    SERVICE_OR_PROFESSIONAL_WORD_RE.test(text)
  );
}

export function hasCustomerRequestVerb(value: string): boolean {
  return CUSTOMER_REQUEST_VERB_RE.test(normalizeSocialMessage(value));
}

const POSITIVE_SOCIAL_TOKEN_RE =
  /\b(?:kkk+|rs+|haha+|hehe+|obrigad[ao]|valeu|vlw|tchau|ate mais|beijo|beijos|tmj|flw|saudacoes)\b/u;

export function hasPositiveSocialEvidence(value: string): boolean {
  if (isSocialOnlyReceptionistMessage(value)) return true;
  const text = normalizeSocialMessage(value);
  if (POSITIVE_SOCIAL_TOKEN_RE.test(text)) return true;
  if (
    !text &&
    /\p{Extended_Pictographic}/u.test(value) &&
    !/\bsim\b/i.test(value)
  ) {
    return true;
  }
  return false;
}

/**
 * Evidência positiva de conversa social/pessoal. Ausência de verbo operacional
 * sozinha não conta: precisa de saudação, risada, agradecimento, despedida ou
 * narrativa pessoal com dia/hora/número.
 */
export function hasPositiveSocialOrPersonalEvidence(value: string): boolean {
  if (hasPositiveSocialEvidence(value)) return true;
  return (
    classifyReceptionistTurnPermission(value) === 'NO_OPERATIONAL_INTENT' &&
    hasNonTransactionalOperationalCue(value)
  );
}

/**
 * Permissão estrutural do turno atual para a fronteira de saída. Ela é
 * propositalmente separada do atalho de saudação: uma entrada vaga como
 * "saudações" não precisa ser reconhecida como greeting para continuar
 * proibida de reabrir agenda/histórico. Já uma pergunta geral pode receber
 * informação factual do catálogo, sem ganhar licença para inventar estado de
 * agendamento ou disponibilidade.
 */
export function classifyReceptionistTurnPermission(
  value: string,
  catalog: ReceptionistTurnCatalog = {},
  _context: ReceptionistTurnPermissionContext = {}
): ReceptionistTurnPermission {
  if (isSocialOnlyReceptionistMessage(value)) return 'SOCIAL_ONLY';

  const text = normalizeSocialMessage(value);
  if (!text) return 'NO_OPERATIONAL_INTENT';

  const serviceNames = catalog.services ?? [];
  const normalizedCatalogNames = [
    ...serviceNames,
    ...(catalog.professionals ?? []),
  ]
    .map(normalizeSocialMessage)
    .filter(Boolean);
  const exactCatalogEntity = normalizedCatalogNames.some(
    (name) => text === name || text.includes(` ${name} `) || text.startsWith(`${name} `) || text.endsWith(` ${name}`)
  );
  const compactInputTokens = text.split(' ').filter(Boolean);
  const compactCatalogSelection =
    compactInputTokens.length <= 3 &&
    messageMentionsCatalogToken(text, normalizedCatalogNames);
  const mentionsCatalogEntity = exactCatalogEntity || compactCatalogSelection;
  const catalogTokenWithRequest =
    CUSTOMER_REQUEST_VERB_RE.test(text) &&
    messageMentionsCatalogToken(text, normalizedCatalogNames);

  // Só uma ação inequívoca do turno atual concede licença transacional. Raízes
  // amplas (qualquer número, dia da semana, "serviço" ou "profissional")
  // confundiam conversa pessoal com pedido de agenda — justamente a classe do
  // incidente. Formas no passado como "marquei" também ficam de fora.
  const explicitSchedulingAction =
    /\b(?:agendar|agende|agenda|marcar|marque|marca|remarcar|remarque|remarca|reagendar|reagende|reagenda|cancelar|cancele|cancela|desmarcar|desmarque|desmarca|confirmar|confirme|confirma)\b/u.test(
      text
    );
  const asksAvailability =
    /\b(?:tem|teria|ha|consegue|consigo|pode|poderia|qual|quais|quando)\b(?:\s+\w+){0,6}\s+\b(?:horario|horarios|vaga|vagas|disponibilidade|agenda)\b/u.test(
      text
    ) ||
    /\b(?:horario|horarios|vaga|vagas|disponibilidade)\b(?:\s+\w+){0,6}\s+\b(?:tem|teria|ha|consegue|pode|qual|quais|quando)\b/u.test(
      text
    );
  const requestWithOperationalObject =
    /\b(?:quero|queria|gostaria|preciso|desejo|prefiro)\b(?:\s+\w+){0,8}\s+\b(?:agendamento|horario|vaga|retorno|consulta|sessao|procedimento|atendimento)\b/u.test(
      text
    ) ||
    (mentionsCatalogEntity && CUSTOMER_REQUEST_VERB_RE.test(text));
  const temporalWord = WEEKDAY_OR_RELATIVE_DAY_RE.test(text);
  const statesScheduleAvailability =
    (temporalWord &&
      /\b(?:livre|folga|disponivel|posso|consigo|saio do (?:servico|trabalho)|depois do (?:servico|trabalho))\b/u.test(
        text
      )) ||
    /\b(?:estou|fico|estarei|vou estar)\s+(?:livre|de folga|disponivel)\b/u.test(
      text
    );
  const compactTemporalChoice =
    /^(?:(?:na|no|pra|para)\s+)?(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)(?:\s+(?:mesmo|por favor))?$/u.test(
      text
    );
  const compactDateTimeChoice =
    /^(?:(?:na|no|pra|para)\s+)?(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)(?:\s+(?:depois|antes)\s+do\s+(?:almoco|servico|trabalho))?(?:\s+(?:(?:as|depois das?|antes das?|a partir das?|por volta das?)\s+)?(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|\s+(?:[0-5]\d|horas?)))?(?:\s+(?:mesmo|por favor))?$/u.test(
      text
    );
  const compactConfirmation =
    /^(?:pode ser|fechado|combinado|esse|essa|este|esta)(?:\s+(?:horario|dia|mesmo))?(?:\s+por favor)?$/u.test(
      text
    );
  const compactTimeChoice =
    /^(?:pode ser\s+)?(?:(?:as|depois das?|antes das?|a partir das?|por volta das?)\s+)?(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|\s+(?:[0-5]\d|horas?))?(?:\s+(?:mesmo|por favor))?$/u.test(
      text
    );

  if (
    explicitSchedulingAction ||
    asksAvailability ||
    requestWithOperationalObject ||
    compactDateTimeChoice ||
    statesScheduleAvailability ||
    compactTemporalChoice ||
    compactConfirmation ||
    compactTimeChoice ||
    catalogTokenWithRequest
  ) {
    return 'TRANSACTION_REQUEST';
  }

  const asksCatalogInformation =
    /\b(?:o que (?:voces?|vcs?) (?:fazem|oferecem)|quais? (?:servicos?|procedimentos?|tratamentos?|profissionais?)|quem (?:atende|trabalha)|como funciona|quanto custa|qual (?:e )?o valor|qual (?:e )?o preco|voces? (?:fazem|oferecem|tem|trabalham com))\b/u.test(
      text
    ) ||
    /\b(?:servicos?|procedimentos?|tratamentos?|profissionais?|precos?|valores?)\b/u.test(
      text
    ) && /\b(?:qual|quais|quem|quanto|como|explica|explique|fale|fala)\b/u.test(text);
  const asksForExplanation =
    /\b(?:pode (?:me )?explicar melhor|me explica melhor|explique melhor|me fale mais|fala (?:pra|para) mim|gostaria de saber|queria saber)\b/u.test(
      text
    );
  const genericServiceOrProfession =
    /\b(?:podolog[ao]|manicure|pedicure|esteticista|cabeleireir[ao]|barbeir[ao]|dentista)\b/u.test(
      text
    );
  if (
    asksCatalogInformation ||
    asksForExplanation ||
    mentionsCatalogEntity ||
    genericServiceOrProfession
  ) {
    return 'INFORMATION_REQUEST';
  }

  return 'NO_OPERATIONAL_INTENT';
}

export function buildSocialReceptionistReply(value: string): string {
  const text = normalizeConservativeSocialTypos(normalizeSocialMessage(value));
  const greeting = /\bbom\s+di(?:a+)?\b/u.test(text)
    ? 'Bom dia'
    : /\bb(?:oa|ia|oua)\s+tarde\b/u.test(text)
      ? 'Boa tarde'
      : /\bboa\s+noite\b/u.test(text)
        ? 'Boa noite'
        : 'Oi';
  const asksHowThingsAre =
    /\b(?:tudo|td)\s+(?:bem|bom|certo)\b/.test(text) ||
    /\bcomo (?:voce|vc) (?:esta|ta|vai)\b|\bcomo vai\b/.test(text);
  return asksHowThingsAre
    ? `${greeting}! Tudo bem sim, e com você?`
    : `${greeting}! Como posso ajudar?`;
}
