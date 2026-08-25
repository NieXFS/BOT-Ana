/**
 * Classificação local de disponibilidade para a fronteira de saída.
 *
 * A unidade de licença é cada horário explícito, não a frase inteira. O
 * classificador é compartilhado por customerReplyGuard e
 * receptionistOutbound; nenhum deles deve manter uma lista lexical paralela.
 */

export const RESULT_LEADS = [
  'tenho',
  'tem',
  'temos',
  'ha',
  'encontrei',
  'achei',
  'localizei',
  'consegui encontrar',
  'consegui localizar',
] as const;

/**
 * Superfícies lexicais que podem denotar disponibilidade. A existência do
 * claim nasce desta superfície; `RESULT_LEADS` só fornece a polaridade quando
 * um lead conhecido também governa o mesmo grupo local.
 */
export const AVAILABILITY_SURFACES = [
  'horario',
  'horarios',
  'vaga',
  'vagas',
  'disponibilidade',
  'disponibilidades',
  'encaixe',
  'encaixes',
] as const;

export type AvailabilityTimeMentionDisposition =
  | 'positive_availability'
  | 'negative_availability'
  | 'non_availability_reference'
  | 'unknown';

export type AvailabilityTimeMentionSource =
  | 'predicate_before'
  | 'status_after'
  | 'coordinated_inheritance'
  | 'explicit_exclusion'
  | 'unclassified';

export type AvailabilityTimeMentionExclusionReason =
  | 'customer_constraint'
  | 'business_hours'
  | 'appointment_context'
  | 'other_typed_reference';

export type AvailabilityTimeMentionV2 = {
  time: string;
  span: { start: number; end: number };
  disposition: AvailabilityTimeMentionDisposition;
  source: AvailabilityTimeMentionSource;
  exclusionReason?: AvailabilityTimeMentionExclusionReason;
};

export type AvailabilityExistenceConstraintV2 =
  | { kind: 'after'; time: string }
  | { kind: 'at_or_after'; time: string }
  | { kind: 'before'; time: string }
  | { kind: 'at_or_before'; time: string }
  | { kind: 'between'; startTime: string; endTime: string };

/**
 * Claim de existência separado das menções de horário. Em “tenho horário
 * depois das 17:30”, 17:30 continua sendo somente o limite da restrição;
 * este claim exige a existência de algum slot posterior no trace.
 */
export type AvailabilityExistenceClaimV2 = {
  polarity: 'positive' | 'negative' | 'unknown';
  constraint?: AvailabilityExistenceConstraintV2;
};

/** @deprecated Use the explicit mention contract above. */
export type AvailabilityTimeClaimV2 = AvailabilityTimeMentionV2;

type TimeToken = {
  time: string;
  start: number;
  end: number;
  span: { start: number; end: number };
};

type LocalEvidence = {
  disposition: Exclude<
    AvailabilityTimeMentionDisposition,
    'non_availability_reference'
  >;
  source: Exclude<
    AvailabilityTimeMentionSource,
    'explicit_exclusion' | 'unclassified'
  >;
};

type NormalizedAvailabilityText = {
  value: string;
  originalStarts: number[];
  originalEnds: number[];
};

type InheritableAvailabilityMention = {
  time: string;
  span: { start: number; end: number };
  disposition: Exclude<
    AvailabilityTimeMentionDisposition,
    'non_availability_reference'
  >;
  source: AvailabilityTimeMentionSource;
};

const RESULT_LEAD_PATTERN = RESULT_LEADS
  .slice()
  .sort((left, right) => right.length - left.length)
  .map((lead) => lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const RESULT_LEAD_RE = new RegExp(
  `(?<![\\p{L}])(?:(?<negative>nao)\\s+)?(?<lead>${RESULT_LEAD_PATTERN})(?![\\p{L}])`,
  'gu'
);
const RESULT_LEAD_TEST_RE = new RegExp(RESULT_LEAD_RE.source, 'u');
const AVAILABILITY_SURFACE_PATTERN = AVAILABILITY_SURFACES
  .slice()
  .sort((left, right) => right.length - left.length)
  .map((surface) => surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const AVAILABILITY_SURFACE_RE = new RegExp(
  `(?<![\\p{L}])(?:${AVAILABILITY_SURFACE_PATTERN})(?![\\p{L}])`,
  'gu'
);
const CUSTOMER_CONSTRAINT_REFERENCE_RE =
  /\b(?:pediu|pediram|solicitou|solicitaram|prefere|prefiro|preferiu|quer|queria|gostaria|procura|procuro|busca|busco|escolheu|escolher|prioriza|priorizou)\b/iu;

const APPOINTMENT_CONTEXT_BEFORE_RE =
  /\b(?:agendamentos?|agendad[oa]s?|agendei|agendamos|marcad[oa]s?|marquei|marcamos|confirmad[oa]s?|confirmei|confirmamos|cancelad[oa]s?|cancelei|cancelamos|remarcad[oa]s?|remarquei|remarcamos|reservad[oa]s?|reservei|reservamos|reservas?|consultas?|sess[aã]os?|procedimentos?)\b[^.!?\n]{0,50}(?:as?|para|em|no|na|e|:)\s*$/iu;
const APPOINTMENT_CONTEXT_AFTER_RE =
  /^\s*(?:ja\s+foi|passou|passad[oa]|da\s+(?:consulta|sess[aã]o)|do\s+(?:agendamento|procedimento))\b/iu;
const APPOINTMENT_CONTEXT_MARKER_RE =
  /\b(?:agendamentos?|agendad[oa]s?|agendei|agendamos|marcad[oa]s?|marquei|marcamos|confirmad[oa]s?|confirmei|confirmamos|cancelad[oa]s?|cancelei|cancelamos|remarcad[oa]s?|remarquei|remarcamos|reservad[oa]s?|reservei|reservamos|reservas?|consultas?|sess[aã]os?|procedimentos?)\b/iu;
const DATE_TIME_PREFIX_RE =
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b[^.!?\n]{0,20}(?:as?|h)\s*$/iu;
const OPERATING_HOURS_RE =
  /\b(?:hor[aá]rio\s+de\s+funcionamento|hor[aá]rio\s+comercial|hor[aá]rio\s+de\s+atendimento|expediente)\b/iu;
const OPERATING_PREDICATE_RE =
  /\b(?:funcionamos|funciona|atendemos|atendimento|abrimos|fechamos|aberto|aberta|fecha|abre)\b/iu;
const RESTRICTION_AFTER_RE =
  /^\s*(?:continua|segue|e)\s+(?:uma?\s+)?restri[cç][aã]o\b/iu;
const TIME_CONSTRAINT_BEFORE_RE =
  /\b(?:(?:depois|ap[oó]s|antes)\s+(?:de|das?|dos?|as?|a|o)|a\s+partir\s+(?:de|das?|dos?|as?|a|o)|at[eé](?:\s+(?:as?|das?|dos?))?)\s*$/iu;
const RANGE_START_BEFORE_RE = /\b(?:entre|das?)\s*$/iu;
const RANGE_CONTINUATION_BEFORE_RE =
  /\b(?:entre\s+[^.!?\n]{0,30}\s+e|das?\s+[^.!?\n]{0,30}\s+as?)\s*$/iu;
const STATUS_NUCLEI = ['esta', 'ta', 'fica', 'ficou'] as const;
const STATUS_RESULT_NUCLEI = ['tem'] as const;
const STATUS_WORDS = {
  positive: ['disponivel', 'livre', 'vaga', 'vagas'],
  negative: [
    'indisponivel',
    'ocupado',
    'ocupada',
    'ocupados',
    'ocupadas',
    'esgotado',
    'esgotada',
    'esgotados',
    'esgotadas',
    'lotado',
    'lotada',
    'lotados',
    'lotadas',
  ],
} as const;
const STATUS_NUCLEUS_PATTERN = [...STATUS_NUCLEI, ...STATUS_RESULT_NUCLEI]
  .slice()
  .sort((left, right) => right.length - left.length)
  .join('|');
const STATUS_ELLIPSIS_NUCLEI = new Set<string>(STATUS_NUCLEI);
const STATUS_WORD_PATTERN = Object.values(STATUS_WORDS)
  .flat()
  .slice()
  .sort((left, right) => right.length - left.length)
  .join('|');
const STATUS_NUCLEUS_GROUP = `(?:${STATUS_NUCLEUS_PATTERN})`;
const STATUS_WORD_GROUP = `(?:${STATUS_WORD_PATTERN})`;
const STATUS_NEGATION_PATTERN = '(?:ja\\s+)?nao\\s+';
const STATUS_NUCLEUS_PREFIX_PATTERN = `(?:${STATUS_NEGATION_PATTERN}|ja\\s+)?`;
const STATUS_EXPRESSION_PATTERN = `(?:${STATUS_NUCLEUS_PREFIX_PATTERN}${STATUS_NUCLEUS_GROUP}(?:\\s+${STATUS_WORD_GROUP})?|${STATUS_WORD_GROUP})`;
const STATUS_AFTER_RE = new RegExp(
  `^\\s*(?:(?:(?<negativePrefix>${STATUS_NEGATION_PATTERN})|(?<alreadyPrefix>ja\\s+))?(?<nucleus>${STATUS_NUCLEUS_GROUP})(?:\\s+(?<adjective>${STATUS_WORD_GROUP}))?|(?<standalone>${STATUS_WORD_GROUP}))\\b`,
  'iu'
);
const STATUS_AFTER_CLAUSE_RE = new RegExp(
  `^\\s*${STATUS_EXPRESSION_PATTERN}\\b`,
  'iu'
);
const STATUS_EXPLICIT_WORD_RE = new RegExp(
  `\\b${STATUS_WORD_GROUP}\\b`,
  'iu'
);
const STATUS_WORD_RE = new RegExp(
  `\\b(?:${STATUS_NUCLEUS_GROUP}|${STATUS_WORD_GROUP})\\b`,
  'iu'
);
const INTERVENING_PREDICATE_RE = new RegExp(
  `\\b(?:n[aã]o|quer|pediu|prefere|preferiu|marcou|agendou|cancelou|remarcou|reservou|pode|poderia|vai|${STATUS_NUCLEUS_GROUP}|fechou|abre|fecha)\\b`,
  'iu'
);

const HOUR_WORD_VALUES: Record<string, number> = {
  zero: 0,
  uma: 1,
  duas: 2,
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
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  'vinte e uma': 21,
  'vinte e duas': 22,
  'vinte e tres': 23,
};

const WORD_HOUR_PATTERN = Object.keys(HOUR_WORD_VALUES)
  .sort((left, right) => right.length - left.length)
  .join('|');

const NUMERIC_TIME_RE =
  /\b([01]?\d|2[0-3])(?:(?::)([0-5]\d)|h([0-5]\d)?)\b/gu;
const WORD_HOUR_RE = new RegExp(
  `\\b(?:as|para|pras?)\\s+(${WORD_HOUR_PATTERN})(?:\\s+horas?)?(?:\\s+e\\s+(meia|trinta|quinze|quarenta e cinco))?\\b`,
  'gu'
);

function normalizeAvailabilityTextWithMap(
  value: string
): NormalizedAvailabilityText {
  let normalized = '';
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];

  for (let index = 0; index < value.length; ) {
    const character = String.fromCodePoint(value.codePointAt(index)!);
    const originalEnd = index + character.length;
    const folded = character
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (/\s/u.test(character)) {
      if (normalized.length > 0 && !normalized.endsWith(' ')) {
        normalized += ' ';
        originalStarts.push(index);
        originalEnds.push(originalEnd);
      }
    } else {
      for (let unit = 0; unit < folded.length; unit += 1) {
        normalized += folded[unit];
        originalStarts.push(index);
        originalEnds.push(originalEnd);
      }
    }
    index = originalEnd;
  }

  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === ' ') start += 1;
  while (end > start && normalized[end - 1] === ' ') end -= 1;

  return {
    value: normalized.slice(start, end),
    originalStarts: originalStarts.slice(start, end),
    originalEnds: originalEnds.slice(start, end),
  };
}

function normalizeAvailabilityText(value: string): string {
  return normalizeAvailabilityTextWithMap(value).value;
}

function formatTime(hour: string, minute?: string): string {
  return `${String(Number(hour)).padStart(2, '0')}:${minute ?? '00'}`;
}

function spanForNormalizedRange(
  start: number,
  end: number,
  sourceMap?: NormalizedAvailabilityText
): { start: number; end: number } {
  if (!sourceMap || start >= sourceMap.originalStarts.length || end <= start) {
    return { start, end };
  }
  return {
    start: sourceMap.originalStarts[start] ?? start,
    end: sourceMap.originalEnds[end - 1] ?? end,
  };
}

function extractTimeTokens(
  normalized: string,
  sourceMap?: NormalizedAvailabilityText
): TimeToken[] {
  if (!normalized) return [];

  const tokens: TimeToken[] = [];
  for (const match of normalized.matchAll(NUMERIC_TIME_RE)) {
    tokens.push({
      time: formatTime(match[1]!, match[2] ?? match[3]),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      span: spanForNormalizedRange(
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
        sourceMap
      ),
    });
  }
  for (const match of normalized.matchAll(WORD_HOUR_RE)) {
    const hour = HOUR_WORD_VALUES[match[1] ?? ''];
    if (hour === undefined) continue;
    const minuteWord = match[2];
    const minute =
      minuteWord === 'meia' || minuteWord === 'trinta'
        ? '30'
        : minuteWord === 'quinze'
          ? '15'
          : minuteWord === 'quarenta e cinco'
            ? '45'
            : '00';
    const matchIndex = match.index ?? 0;
    const hourOffset = match[0].indexOf(match[1] ?? '');
    const start = matchIndex + Math.max(0, hourOffset);
    tokens.push({
      time: `${String(hour).padStart(2, '0')}:${minute}`,
      start,
      end: matchIndex + match[0].length,
      span: spanForNormalizedRange(
        start,
        matchIndex + match[0].length,
        sourceMap
      ),
    });
  }

  return tokens.sort((left, right) => left.start - right.start);
}

function sentenceBounds(value: string, start: number, end: number): {
  start: number;
  end: number;
} {
  const previousBoundary = Math.max(
    value.lastIndexOf('.', start - 1),
    value.lastIndexOf('!', start - 1),
    value.lastIndexOf('?', start - 1),
    value.lastIndexOf(';', start - 1),
    value.lastIndexOf('\n', start - 1)
  );
  const nextBoundaries = [
    value.indexOf('.', end),
    value.indexOf('!', end),
    value.indexOf('?', end),
    value.indexOf(';', end),
    value.indexOf('\n', end),
  ].filter((index) => index >= 0);
  return {
    start: previousBoundary + 1,
    end: nextBoundaries.length > 0 ? Math.min(...nextBoundaries) + 1 : value.length,
  };
}

function localGroupStart(value: string, start: number): number {
  const sentence = sentenceBounds(value, start, start);
  let groupStart = sentence.start;
  const adversativeRe = /\b(?:mas|porem|contudo|entretanto)\b/gu;
  for (const match of value.slice(sentence.start, start).matchAll(adversativeRe)) {
    groupStart = sentence.start + (match.index ?? 0) + match[0].length;
  }
  return groupStart;
}

type CueSpan = {
  start: number;
  end: number;
};

function latestCueSpan(
  value: string,
  start: number,
  end: number,
  pattern: RegExp
): CueSpan | null {
  const scoped = value.slice(start, end);
  const globalPattern = new RegExp(pattern.source, 'igu');
  let latest: CueSpan | null = null;
  for (const match of scoped.matchAll(globalPattern)) {
    const matchStart = start + (match.index ?? 0);
    latest = {
      start: matchStart,
      end: matchStart + match[0].length,
    };
  }
  return latest;
}

function hasTimeBefore(
  tokens: TimeToken[],
  from: number,
  to: number
): boolean {
  return tokens.some((candidate) => candidate.start >= from && candidate.start < to);
}

function hasTimeBetween(
  tokens: TimeToken[],
  start: number,
  end: number,
  sentenceStart: number
): boolean {
  return tokens.some(
    (candidate) =>
      candidate.start >= Math.max(start, sentenceStart) &&
      candidate.start < end
  );
}

function isRangeContinuationBefore(
  value: string,
  sentenceStart: number,
  tokenStart: number,
  tokens: TimeToken[]
): boolean {
  const before = value.slice(sentenceStart, tokenStart);
  const match = RANGE_CONTINUATION_BEFORE_RE.exec(before);
  if (!match) return false;
  const rangeStart = sentenceStart + (match.index ?? 0);
  const rangeTimes = tokens.filter(
    (candidate) =>
      candidate.start >= rangeStart && candidate.start < tokenStart
  );
  return rangeTimes.length === 1;
}

function isOperatingHoursTime(
  value: string,
  token: TimeToken,
  tokens: TimeToken[]
): boolean {
  const bounds = sentenceBounds(value, token.start, token.end);
  const before = value.slice(bounds.start, token.start);
  const after = value.slice(token.end, bounds.end);
  const operatingHoursCue = latestCueSpan(
    value,
    bounds.start,
    token.start,
    OPERATING_HOURS_RE
  );
  const operatingPredicateCue = latestCueSpan(
    value,
    bounds.start,
    token.start,
    OPERATING_PREDICATE_RE
  );
  const cue = [operatingHoursCue, operatingPredicateCue]
    .filter((candidate): candidate is CueSpan => candidate !== null)
    .sort((left, right) => right.end - left.end)[0];

  if (cue) {
    const rangeContinuation = isRangeContinuationBefore(
      value,
      bounds.start,
      token.start,
      tokens
    );
    // A business-hours cue governs its directly attached time. A second time
    // is in scope only when the text explicitly forms a range (das 08 às 18);
    // coordination (... 20 e 18) is not inheritance.
    if (
      hasTimeBetween(tokens, cue.end, token.start, bounds.start) &&
      !rangeContinuation
    ) {
      return false;
    }
    // Do not let a later result/status predicate be swallowed by the earlier
    // operating-hours cue (fechamos às 20 e tenho 18).
    if (hasInterveningPredicate(value.slice(cue.end, token.start))) {
      return false;
    }
    return true;
  }

  return (
    /^\s*(?:as?|e\s+as?)\s+\d/.test(after) &&
    /\b(?:funcionamento|expediente|fechamos|atendemos)\b/iu.test(before)
  );
}

function isTimeConstraint(
  value: string,
  token: TimeToken,
  tokens: TimeToken[]
): boolean {
  const bounds = sentenceBounds(value, token.start, token.end);
  const before = value.slice(bounds.start, token.start);
  const after = value.slice(token.end, bounds.end);
  if (TIME_CONSTRAINT_BEFORE_RE.test(before)) return true;
  if (RANGE_START_BEFORE_RE.test(before)) return true;
  if (
    isRangeContinuationBefore(
      value,
      bounds.start,
      token.start,
      tokens
    )
  ) {
    return true;
  }
  if (RESTRICTION_AFTER_RE.test(after)) return true;
  if (/^\s*(?:as?|e\s+as?)\s+\d/.test(after) && /\b(?:das?|entre)\b/iu.test(before)) {
    return true;
  }
  return false;
}

function isAppointmentTime(
  value: string,
  token: TimeToken,
  tokens: TimeToken[]
): boolean {
  const bounds = sentenceBounds(value, token.start, token.end);
  const before = value.slice(bounds.start, token.start);
  const after = value.slice(token.end, bounds.end);
  const appointmentCue = latestCueSpan(
    value,
    bounds.start,
    token.start,
    APPOINTMENT_CONTEXT_MARKER_RE
  );
  const rangeContinuation = isRangeContinuationBefore(
    value,
    bounds.start,
    token.start,
    tokens
  );
  const cueIsLocal =
    appointmentCue === null ||
    !hasTimeBetween(
      tokens,
      appointmentCue.end,
      token.start,
      bounds.start
    ) ||
    rangeContinuation;

  return (
    (APPOINTMENT_CONTEXT_BEFORE_RE.test(before) && cueIsLocal) ||
    APPOINTMENT_CONTEXT_AFTER_RE.test(after) ||
    (DATE_TIME_PREFIX_RE.test(before) &&
      appointmentCue !== null)
  );
}

function statusWordPolarity(
  word: string | undefined
): 'positive' | 'negative' | null {
  if (!word) return null;
  for (const polarity of ['positive', 'negative'] as const) {
    if ((STATUS_WORDS[polarity] as readonly string[]).includes(word)) {
      return polarity;
    }
  }
  return null;
}

function statusAfter(value: string, token: TimeToken): LocalEvidence | null {
  const after = value.slice(token.end);
  const match = STATUS_AFTER_RE.exec(after);
  if (!match) return null;

  const explicitWord = match.groups?.adjective ?? match.groups?.standalone;
  const explicitPolarity = statusWordPolarity(explicitWord);
  if (match.groups?.negativePrefix) {
    return { disposition: 'negative_availability', source: 'status_after' };
  }
  if (explicitPolarity) {
    return {
      disposition:
        explicitPolarity === 'positive'
          ? 'positive_availability'
          : 'negative_availability',
      source: 'status_after',
    };
  }

  // A bare positive nucleus is local evidence only after the same local group
  // has established the state adjective. Otherwise it remains unknown and
  // cannot accidentally inherit the previous claim's polarity.
  if (
    match.groups?.nucleus &&
    STATUS_ELLIPSIS_NUCLEI.has(match.groups.nucleus) &&
    STATUS_EXPLICIT_WORD_RE.test(
      value.slice(localGroupStart(value, token.start), token.start)
    )
  ) {
    return { disposition: 'positive_availability', source: 'status_after' };
  }
  return null;
}

function directPredicateBefore(
  value: string,
  token: TimeToken,
  tokens: TimeToken[],
  groupStart: number
): LocalEvidence | null {
  const before = value.slice(groupStart, token.start);
  const matches = [...before.matchAll(RESULT_LEAD_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const relativeStart = match.index ?? 0;
    const leadStart = groupStart + relativeStart;
    const leadEnd = groupStart + relativeStart + match[0].length;
    if (hasTimeBefore(tokens, leadEnd, token.start)) continue;

    const complement = value.slice(leadEnd, token.start);
    if (/\b(?:que|nada|agendamento|agendad[oa]|marcad[oa]|confirmad[oa]|cancelad[oa]|remarcad[oa]|reservad[oa]|reserva|consulta|sess[aã]o|procedimento)\b/iu.test(complement)) {
      continue;
    }
    if (APPOINTMENT_CONTEXT_MARKER_RE.test(complement)) continue;
    if (hasInterveningPredicate(complement)) continue;
    if (/\b(?:e|mas|porem|contudo|entretanto)\s+(?:o|a|um|uma)\s*$/iu.test(complement)) {
      continue;
    }
    if (/(?:,|\b(?:e|mas|porem|contudo|entretanto)\b)\s*$/iu.test(complement)) {
      continue;
    }
    if (
      TIME_CONSTRAINT_BEFORE_RE.test(complement) ||
      RANGE_START_BEFORE_RE.test(complement)
    ) {
      continue;
    }
    if (leadStart < groupStart) continue;

    return {
      disposition: match.groups?.negative
        ? 'negative_availability'
        : 'positive_availability',
      source: 'predicate_before',
    };
  }
  return null;
}

function hasInterveningPredicate(between: string): boolean {
  return (
    RESULT_LEAD_TEST_RE.test(between) ||
    INTERVENING_PREDICATE_RE.test(between) ||
    STATUS_WORD_RE.test(between) ||
    OPERATING_PREDICATE_RE.test(between)
  );
}

function canInherit(
  value: string,
  previous: TimeToken,
  current: TimeToken
): boolean {
  let between = value.slice(previous.end, current.start);
  if (statusAfter(value, previous)) {
    between = between.replace(STATUS_AFTER_CLAUSE_RE, '');
  }
  if (!between.trim()) return true;
  if (hasInterveningPredicate(between)) return false;
  return /^(?:\s|[,;]|e|nem|tamb[eé]m|tambem|hoje|amanh[aã]|depois|antes|para|pra|as?|os?|um|uma|uns|umas|dos?|das?)*$/iu.test(
    between
  );
}

type LocatedAvailabilityExistenceConstraintV2 = {
  constraint: AvailabilityExistenceConstraintV2;
  firstTimeStart: number;
};

function singleExistenceConstraintKindV2(
  beforeTime: string
): Exclude<AvailabilityExistenceConstraintV2['kind'], 'between'> | null {
  if (/\ba\s+partir\s+(?:de|das?|dos?|as?|a|o)\s*$/u.test(beforeTime)) {
    return 'at_or_after';
  }
  if (/\b(?:depois|apos)\s+(?:de|das?|dos?|as?|a|o)\s*$/u.test(beforeTime)) {
    return 'after';
  }
  if (/\bantes\s+(?:de|das?|dos?|as?|a|o)\s*$/u.test(beforeTime)) {
    return 'before';
  }
  if (/\bate\s+(?:(?:as?|das?|dos?)\s*)?$/u.test(beforeTime)) {
    return 'at_or_before';
  }
  return null;
}

function locateAvailabilityExistenceConstraintV2(
  value: string,
  surfaceEnd: number,
  scopeEnd: number,
  tokens: TimeToken[]
): LocatedAvailabilityExistenceConstraintV2 | null {
  const scopedTokens = tokens.filter(
    (token) => token.start >= surfaceEnd && token.end <= scopeEnd
  );
  for (let index = 0; index < scopedTokens.length; index += 1) {
    const token = scopedTokens[index]!;
    const beforeTime = value.slice(surfaceEnd, token.start);
    if (/\bentre\s*$/u.test(beforeTime)) {
      const endToken = scopedTokens[index + 1];
      if (
        endToken &&
        /^\s*e\s*$/u.test(value.slice(token.end, endToken.start))
      ) {
        return {
          constraint: {
            kind: 'between',
            startTime: token.time,
            endTime: endToken.time,
          },
          firstTimeStart: token.start,
        };
      }
    }

    const kind = singleExistenceConstraintKindV2(beforeTime);
    if (kind) {
      return {
        constraint: { kind, time: token.time },
        firstTimeStart: token.start,
      };
    }
  }
  return null;
}

function localExistenceReferenceGroupStart(
  value: string,
  start: number
): number {
  const bounds = sentenceBounds(value, start, start);
  let groupStart = bounds.start;
  const boundaryRe = /,|\b(?:e|mas|porem|contudo|entretanto)\b/gu;
  for (const match of value
    .slice(bounds.start, start)
    .matchAll(boundaryRe)) {
    groupStart = bounds.start + (match.index ?? 0) + match[0].length;
  }
  return groupStart;
}

type ExistenceResultLeadV2 = {
  polarity: 'positive' | 'negative';
};

function findExistenceResultLeadV2(
  value: string,
  groupStart: number,
  firstTimeStart: number,
  tokens: TimeToken[]
): ExistenceResultLeadV2 | null {
  const matches = [...value.matchAll(RESULT_LEAD_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const relativeStart = match.index ?? 0;
    const start = relativeStart;
    const end = start + match[0].length;
    if (start < groupStart || start >= firstTimeStart) continue;
    if (hasTimeBefore(tokens, end, firstTimeStart)) continue;

    const between = value.slice(end, firstTimeStart);
    if (hasInterveningPredicate(between)) continue;

    return {
      polarity: match.groups?.negative ? 'negative' : 'positive',
    };
  }
  return null;
}

function existenceReferenceExclusionReasonV2(
  value: string,
  token: TimeToken,
  tokens: TimeToken[],
  referenceStart: number,
  bounds: { start: number; end: number }
): AvailabilityTimeMentionExclusionReason | null {
  const localReference = value.slice(referenceStart, token.start);
  // These exclusions are deliberately checked before any result lead is
  // allowed to determine the claim polarity. A request for a time is not a
  // statement that the time exists.
  if (CUSTOMER_CONSTRAINT_REFERENCE_RE.test(localReference)) {
    return 'customer_constraint';
  }
  if (
    OPERATING_HOURS_RE.test(localReference) ||
    isOperatingHoursTime(value, token, tokens)
  ) {
    return 'business_hours';
  }
  if (
    APPOINTMENT_CONTEXT_MARKER_RE.test(localReference) ||
    isAppointmentTime(value, token, tokens)
  ) {
    return 'appointment_context';
  }
  if (value.slice(bounds.start, bounds.end).trim().endsWith('?')) {
    return 'other_typed_reference';
  }
  return null;
}

/**
 * Extrai claims de existência cujo horário explícito é um limite, não um slot
 * ofertado. A descoberta começa pela superfície de disponibilidade. Um lead
 * conhecido pode classificar a polaridade, mas sua ausência nunca apaga o
 * claim: nesse caso a polaridade é `unknown` e a evidência continua exigida.
 */
export function classifyAvailabilityExistenceClaimsV2(
  value: string
): AvailabilityExistenceClaimV2[] {
  const normalized = normalizeAvailabilityText(value);
  if (!normalized) return [];
  const tokens = extractTimeTokens(normalized);
  const surfaces = [...normalized.matchAll(AVAILABILITY_SURFACE_RE)];
  const claims: AvailabilityExistenceClaimV2[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = surfaces[index]!;
    const surfaceStart = surface.index ?? 0;
    const surfaceEnd = surfaceStart + surface[0].length;
    const bounds = sentenceBounds(normalized, surfaceStart, surfaceEnd);
    const nextSurfaceStart = surfaces[index + 1]?.index;
    const scopeEnd =
      nextSurfaceStart !== undefined && nextSurfaceStart < bounds.end
        ? nextSurfaceStart
        : bounds.end;
    const located = locateAvailabilityExistenceConstraintV2(
      normalized,
      surfaceEnd,
      scopeEnd,
      tokens
    );
    if (!located) continue;
    const firstTimeToken = tokens.find(
      (token) => token.start === located.firstTimeStart
    );
    if (!firstTimeToken) continue;

    const referenceStart = localExistenceReferenceGroupStart(
      normalized,
      surfaceStart
    );
    if (
      existenceReferenceExclusionReasonV2(
        normalized,
        firstTimeToken,
        tokens,
        referenceStart,
        bounds
      )
    ) {
      continue;
    }

    const lead = findExistenceResultLeadV2(
      normalized,
      localGroupStart(normalized, surfaceStart),
      located.firstTimeStart,
      tokens
    );

    const claim: AvailabilityExistenceClaimV2 = {
      polarity: lead?.polarity ?? 'unknown',
      constraint: located.constraint,
    };
    const key = JSON.stringify(claim);
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(claim);
    }
  }
  return claims;
}

function clockMinutesV2(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function hasSlotSatisfyingAvailabilityExistenceClaimV2(
  claim: AvailabilityExistenceClaimV2,
  slots: Iterable<string>
): boolean {
  // Negative é a única polaridade que não exige prova. Positive e unknown
  // percorrem exatamente a mesma verificação de existência autoritativa.
  switch (claim.polarity) {
    case 'negative':
      return true;
    case 'positive':
    case 'unknown':
      break;
  }
  const slotMinutes = [...slots]
    .map(clockMinutesV2)
    .filter((minutes): minutes is number => minutes !== null);
  const constraint = claim.constraint;
  if (!constraint) return slotMinutes.length > 0;

  if (constraint.kind === 'between') {
    const start = clockMinutesV2(constraint.startTime);
    const end = clockMinutesV2(constraint.endTime);
    return (
      start !== null &&
      end !== null &&
      start <= end &&
      slotMinutes.some((minutes) => minutes >= start && minutes <= end)
    );
  }

  const boundary = clockMinutesV2(constraint.time);
  if (boundary === null) return false;
  switch (constraint.kind) {
    case 'after':
      return slotMinutes.some((minutes) => minutes > boundary);
    case 'at_or_after':
      return slotMinutes.some((minutes) => minutes >= boundary);
    case 'before':
      return slotMinutes.some((minutes) => minutes < boundary);
    case 'at_or_before':
      return slotMinutes.some((minutes) => minutes <= boundary);
  }
}

function classifyNormalizedAvailabilityTimeClaims(
  normalized: string,
  sourceMap?: NormalizedAvailabilityText
): AvailabilityTimeMentionV2[] {
  const tokens = extractTimeTokens(normalized, sourceMap);
  const mentions: AvailabilityTimeMentionV2[] = [];
  let previousClaim: {
    token: TimeToken;
    claim: InheritableAvailabilityMention;
    groupStart: number;
  } | null = null;

  for (const token of tokens) {
    const bounds = sentenceBounds(normalized, token.start, token.end);
    const sentence = normalized.slice(bounds.start, bounds.end).trim();
    if (!sentence) {
      mentions.push({
        time: token.time,
        span: token.span,
        disposition: 'unknown',
        source: 'unclassified',
      });
      previousClaim = null;
      continue;
    }

    const groupStart = localGroupStart(normalized, token.start);
    const afterEvidence = statusAfter(normalized, token);
    const beforeEvidence = directPredicateBefore(normalized, token, tokens, groupStart);
    let evidence: LocalEvidence | null = afterEvidence ?? beforeEvidence;

    if (
      afterEvidence &&
      beforeEvidence &&
      afterEvidence.disposition !== beforeEvidence.disposition
    ) {
      evidence = { disposition: 'unknown', source: 'status_after' };
    }

    // Precedence is intentionally local: a predicate/status attached to this
    // time wins the typed exclusion cue; only then may an exclusion win over
    // coordinated inheritance.
    if (!evidence) {
      let exclusionReason:
        | AvailabilityTimeMentionExclusionReason
        | undefined;
      if (isOperatingHoursTime(normalized, token, tokens)) {
        exclusionReason = 'business_hours';
      } else if (isTimeConstraint(normalized, token, tokens)) {
        exclusionReason = 'customer_constraint';
      } else if (isAppointmentTime(normalized, token, tokens)) {
        exclusionReason = 'appointment_context';
      } else if (
        sentence.endsWith('?') &&
        !hasTimeBetween(tokens, bounds.start, token.start, bounds.start)
      ) {
        exclusionReason = 'other_typed_reference';
      }
      if (exclusionReason) {
        mentions.push({
          time: token.time,
          span: token.span,
          disposition: 'non_availability_reference',
          source: 'explicit_exclusion',
          exclusionReason,
        });
        previousClaim = null;
        continue;
      }
    }

    if (
      !evidence &&
      previousClaim &&
      previousClaim.groupStart === groupStart &&
      canInherit(normalized, previousClaim.token, token)
    ) {
      evidence = {
        disposition: previousClaim.claim.disposition,
        source: 'coordinated_inheritance',
      };
    }

    const disposition: InheritableAvailabilityMention['disposition'] =
      evidence?.disposition ?? 'unknown';
    const source: AvailabilityTimeMentionSource =
      evidence?.source ?? 'unclassified';
    const claim: AvailabilityTimeMentionV2 = {
      time: token.time,
      span: token.span,
      disposition,
      source,
    };
    mentions.push(claim);
    previousClaim = {
      token,
      claim: { time: token.time, span: token.span, disposition, source },
      groupStart,
    };
  }

  return mentions;
}

/**
 * Classifica cada horário explícito, inclusive os que não puderam ser
 * associados a um predicado conhecido. `unknown` é deliberadamente
 * preservado: as barreiras o tratam como `evidence_required`, nunca como
 * ausência de oferta.
 */
export function classifyAvailabilityTimeClaims(
  value: string
): AvailabilityTimeMentionV2[] {
  const normalized = normalizeAvailabilityTextWithMap(value);
  return normalized.value
    ? classifyNormalizedAvailabilityTimeClaims(normalized.value, normalized)
    : [];
}

/**
 * Compatibilidade lexical para callers antigos. Não é a autoridade usada nas
 * barreiras; a autoridade é `classifyAvailabilityTimeClaims` por horário.
 */
export function hasNegativeAvailabilityCue(value: string): boolean {
  return classifyAvailabilityTimeClaims(value).some(
    (claim) => claim.disposition === 'negative_availability'
  );
}

/**
 * Compatibilidade lexical para callers antigos. Não é a autoridade usada nas
 * barreiras; a autoridade é `classifyAvailabilityTimeClaims` por horário.
 */
export function hasPositiveAvailabilityCue(value: string): boolean {
  return classifyAvailabilityTimeClaims(value).some(
    (claim) => claim.disposition === 'positive_availability'
  );
}

export function hasOperatingHoursCue(value: string): boolean {
  const normalized = normalizeAvailabilityText(value);
  return OPERATING_HOURS_RE.test(normalized) || OPERATING_PREDICATE_RE.test(normalized);
}

function startsIndependentPositiveAvailabilityClaim(value: string): boolean {
  const normalized = normalizeAvailabilityText(value);
  if (
    new RegExp(`^(?:${RESULT_LEAD_PATTERN})(?:\\s+|$)`, 'u').test(normalized)
  ) {
    return true;
  }
  const status = STATUS_AFTER_RE.exec(normalized);
  if (!status || status.groups?.negativePrefix) return false;
  return (
    statusWordPolarity(status.groups?.adjective ?? status.groups?.standalone) ===
    'positive'
  );
}

/**
 * Delimita spans somente para compatibilidade de callers e para inspeção
 * humana. A função não decide a polaridade: uma negação em um span não pode
 * suprimir um horário positivo que esteja em outro claim local.
 */
export function splitAvailabilityClaimScopes(value: string): string[] {
  const normalized = normalizeAvailabilityText(value);
  if (!normalized) return [];

  const scopes: string[] = [];
  let scopeStart = 0;
  const boundaryRe = /\b(?:mas|porem|contudo|entretanto)\b|,|\be\b/gu;

  for (const match of normalized.matchAll(boundaryRe)) {
    const separator = match[0];
    const matchIndex = match.index ?? 0;
    const rightHandSide = normalized
      .slice(matchIndex + separator.length)
      .trimStart();
    const isAdversative = /^(?:mas|porem|contudo|entretanto)$/u.test(separator);
    const opensIndependentClaim =
      (separator === ',' || separator === 'e') &&
      startsIndependentPositiveAvailabilityClaim(rightHandSide);

    if (!isAdversative && !opensIndependentClaim) continue;

    const scope = normalized.slice(scopeStart, matchIndex).trim();
    if (scope) scopes.push(scope);
    scopeStart = matchIndex + separator.length;
  }

  const lastScope = normalized.slice(scopeStart).trim();
  if (lastScope) scopes.push(lastScope);
  return scopes;
}
