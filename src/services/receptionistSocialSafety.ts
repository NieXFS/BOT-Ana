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
  catalog: ReceptionistTurnCatalog = {}
): ReceptionistTurnPermission {
  if (isSocialOnlyReceptionistMessage(value)) return 'SOCIAL_ONLY';

  const text = normalizeSocialMessage(value);
  if (!text) return 'NO_OPERATIONAL_INTENT';

  const normalizedCatalogNames = [
    ...(catalog.services ?? []),
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
    normalizedCatalogNames.some((name) => {
      const catalogTokens = name
        .split(' ')
        .filter((token) => !CATALOG_STOP_WORDS.has(token))
        .map(catalogTokenKey);
      return compactInputTokens.some((token) => {
        if (CATALOG_STOP_WORDS.has(token)) return false;
        const key = catalogTokenKey(token);
        return (
          catalogTokens.includes(key) &&
          (key.length >= 4 || ['pe', 'mao', 'unha'].includes(key))
        );
      });
    });
  const mentionsCatalogEntity = exactCatalogEntity || compactCatalogSelection;

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
    (mentionsCatalogEntity &&
      /\b(?:quero|queria|gostaria|preciso|desejo|prefiro|fazer)\b/u.test(text));
  const temporalWord =
    /\b(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)\b/u.test(
      text
    );
  const explicitClock =
    /\b(?:as|depois das?|a partir das?|por volta das?)\s+(?:[01]?\d|2[0-3])(?:\s+(?:[0-5]\d|horas?))?\b/u.test(
      text
    ) ||
    /\b(?:[01]?\d|2[0-3])h(?:[0-5]\d)?\b/u.test(text) ||
    /\b(?:[01]?\d|2[0-3])\s+[0-5]\d\b/u.test(text);
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
    compactTimeChoice
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
