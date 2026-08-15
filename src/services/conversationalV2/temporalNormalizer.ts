export interface NormalizedTemporalAssertionV2 {
  kind: 'time' | 'date';
  normalized: string;
  raw: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

const WEEKDAY_CORE_PATTERN =
  '(?:segunda|terca|quarta|quinta|sexta)(?:[\\s-]+feira)?|sabado|domingo';
const WEEKDAY_WITH_MODIFIER_PATTERN = `(?:proxim[oa]\\s+)?(?:${WEEKDAY_CORE_PATTERN})(?:\\s+que\\s+vem)?`;
const RELATIVE_DATE_PATTERN = `depois\\s+de\\s+amanha|hoje|amanha|${WEEKDAY_WITH_MODIFIER_PATTERN}`;

/** Token civil único: relativo, weekday (com hífen/feira/que vem) ou data absoluta. */
export const CIVIL_DATE_TOKEN_RE = new RegExp(
  `\\b(?:${RELATIVE_DATE_PATTERN})\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b`,
  'gu'
);

export function matchCivilDateTokensV2(text: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(CIVIL_DATE_TOKEN_RE.source, 'gu'))];
}

const DATE_CONTRAST_RE = new RegExp(
  `\\b(${RELATIVE_DATE_PATTERN}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\s*(?:,|e)?\\s+nao\\s+(?:e\\s+)?(${RELATIVE_DATE_PATTERN}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\b`,
  'u'
);
const DATE_CONTRAST_LEADING_NEGATION_RE = new RegExp(
  `\\bnao\\s+(${RELATIVE_DATE_PATTERN}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\s*,\\s+(${RELATIVE_DATE_PATTERN}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\b`,
  'u'
);

const HOUR_WORDS: Record<string, number> = {
  zero: 0,
  uma: 1,
  um: 1,
  duas: 2,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezassete: 17,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  'vinte e uma': 21,
  'vinte e duas': 22,
  'vinte e tres': 23,
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function formatHour(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function civilTodayV2(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addCivilDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

function weekdayInTimezone(now: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

function validCivilDate(year: number, month: number, day: number): string | null {
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function absoluteCivilDate(
  token: string,
  now: Date,
  timezone: string
): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(token);
  if (iso) {
    return validCivilDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/u.exec(token);
  if (!br) return null;
  const currentYear = Number(civilTodayV2(now, timezone).slice(0, 4));
  const rawYear = br[3];
  const year = rawYear
    ? rawYear.length === 2
      ? 2000 + Number(rawYear)
      : Number(rawYear)
    : currentYear;
  return validCivilDate(year, Number(br[2]), Number(br[1]));
}

function parseWeekdayToken(
  token: string
): { index: number; nextWeek: boolean } | null {
  const text = normalize(token);
  const nextWeek =
    /^(?:proxim[oa]\s+)/u.test(text) || /\s+que\s+vem$/u.test(text);
  const core = text
    .replace(/^(?:proxim[oa]\s+)/u, '')
    .replace(/\s+que\s+vem$/u, '')
    .replace(/[\s-]+feira$/u, '');
  const index = WEEKDAY_INDEX[core];
  if (index === undefined) return null;
  return { index, nextWeek };
}

/**
 * Ponto único de resolução civil: weekday por extenso (com/sem acento, com/sem
 * "-feira"), "X que vem"/"próximo X" (hoje=X ⇒ +7) e hoje/amanhã. Sempre no
 * fuso informado, nunca weekday UTC cru.
 */
export function resolveCivilDateTokenV2(
  token: string,
  now: Date,
  timezone: string
): string | null {
  const text = normalize(token);
  if (!text) return null;
  const today = civilTodayV2(now, timezone);
  if (text === 'hoje') return today;
  if (text === 'depois de amanha') return addCivilDays(today, 2);
  if (text === 'amanha') return addCivilDays(today, 1);
  const absolute = absoluteCivilDate(text, now, timezone);
  if (absolute) return absolute;
  const weekday = parseWeekdayToken(text);
  if (!weekday) return null;
  const current = weekdayInTimezone(now, timezone);
  let delta = (weekday.index - current + 7) % 7;
  if (weekday.nextWeek && delta === 0) delta = 7;
  return addCivilDays(today, delta);
}

/**
 * "X, não Y" / "X e não Y": X vence e Y é descartado. "não X, Y" (vírgula)
 * elege Y. "não, sexta" (marcador sem X à esquerda) não casa. Ausente o
 * padrão, null.
 */
export function contrastWinningCivilDateV2(
  value: string,
  now: Date,
  timezone: string
): string | null {
  const text = normalize(value);
  const forward = DATE_CONTRAST_RE.exec(text);
  if (forward?.[1]) return resolveCivilDateTokenV2(forward[1], now, timezone);
  const leadingNegation = DATE_CONTRAST_LEADING_NEGATION_RE.exec(text);
  if (leadingNegation?.[2]) {
    return resolveCivilDateTokenV2(leadingNegation[2], now, timezone);
  }
  return null;
}

export function normalizeTemporalAssertionsV2(
  value: string
): NormalizedTemporalAssertionV2[] {
  const text = normalize(value);
  const assertions: NormalizedTemporalAssertionV2[] = [];
  const seen = new Set<string>();
  const add = (assertion: NormalizedTemporalAssertionV2) => {
    const key = `${assertion.kind}:${assertion.normalized}:${assertion.raw}`;
    if (!seen.has(key)) {
      seen.add(key);
      assertions.push(assertion);
    }
  };

  for (const match of text.matchAll(
    /\bdas?\s+([01]?\d|2[0-3])\s+(?:as|a)\s+([01]?\d|2[0-3])\b/gu
  )) {
    add({ kind: 'time', normalized: formatHour(Number(match[1])), raw: match[0] });
    add({ kind: 'time', normalized: formatHour(Number(match[2])), raw: match[0] });
  }

  // Forma coloquial exata. Deve nascer antes das famílias mais permissivas:
  // "17 e meia" é 17:30, nunca um match por prefixo da hora 17.
  for (const match of text.matchAll(
    /\b([01]?\d|2[0-3])\s+e\s+meia\b/gu
  )) {
    add({
      kind: 'time',
      normalized: formatHour(Number(match[1]), 30),
      raw: match[0],
    });
  }

  for (const match of text.matchAll(/\b(?:as|das|de)?\s*([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)?\s*horas?\b|\b([01]?\d|2[0-3])\s*horas?\b/gu)) {
    const hour = Number(match[1] ?? match[4]);
    const minute = Number(match[2] ?? match[3] ?? 0);
    add({ kind: 'time', normalized: formatHour(hour, minute), raw: match[0].trim() });
  }
  for (const match of text.matchAll(/\b(?:as|das|de)?\s*([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/gu)) {
    add({
      kind: 'time',
      normalized: formatHour(Number(match[1]), Number(match[2] ?? match[3] ?? 0)),
      raw: match[0].trim(),
    });
  }

  const wordAlternation = Object.keys(HOUR_WORDS)
    .sort((left, right) => right.length - left.length)
    .join('|');
  const wordMatcher = new RegExp(
    `\\b(?:(?:as|das|de)\\s+(${wordAlternation})(?:\\s+horas?)?(?:\\s+da\\s+(manha|tarde|noite))?|(${wordAlternation})\\s+horas?|(${wordAlternation})\\s+da\\s+(manha|tarde|noite))\\b`,
    'gu'
  );
  for (const match of text.matchAll(wordMatcher)) {
    const hourWord = match[1] ?? match[3] ?? match[4];
    if (!hourWord) continue;
    let hour = HOUR_WORDS[hourWord]!;
    const period = match[2] ?? match[5];
    if (period === 'tarde' && hour >= 1 && hour < 12) hour += 12;
    if (period === 'noite' && hour >= 1 && hour < 12) hour += 12;
    if (period === 'manha' && hour === 12) hour = 0;
    add({ kind: 'time', normalized: formatHour(hour), raw: match[0].trim() });
  }

  const dateMatcher = new RegExp(`\\b(?:${RELATIVE_DATE_PATTERN})\\b`, 'gu');
  for (const match of text.matchAll(dateMatcher)) {
    const normalizedDate = match[0]
      .replace(/^(?:proxim[oa]\s+)/u, '')
      .replace(/\s+que\s+vem$/u, '')
      .replace(/[\s-]+feira$/u, '');
    add({ kind: 'date', normalized: normalizedDate, raw: match[0] });
  }
  return assertions;
}

export function hasTemporalAssertionV2(value: string): boolean {
  return normalizeTemporalAssertionsV2(value).length > 0;
}
