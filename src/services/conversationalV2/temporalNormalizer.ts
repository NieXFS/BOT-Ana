export interface NormalizedTemporalAssertionV2 {
  kind: 'time' | 'date';
  normalized: string;
  raw: string;
}

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

  for (const match of text.matchAll(/\b(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)\b/gu)) {
    add({ kind: 'date', normalized: match[0].replace(/ feira$/u, ''), raw: match[0] });
  }
  return assertions;
}

export function hasTemporalAssertionV2(value: string): boolean {
  return normalizeTemporalAssertionsV2(value).length > 0;
}
