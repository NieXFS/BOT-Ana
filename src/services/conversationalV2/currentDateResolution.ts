import { resolveRelativeCalendarDate } from '../receptionistTurnGrounding';

export type CurrentDateResolutionV2 =
  | { kind: 'none'; mentions: readonly [] }
  | { kind: 'ambiguous'; mentions: readonly string[] }
  | { kind: 'resolved'; date: string; mentions: readonly string[] };

interface DateMentionV2 {
  date: string;
  inboundIndex: number;
  start: number;
  end: number;
  corrected: boolean;
}

const DATE_TOKEN_RE =
  /\b(?:depois\s+de\s+amanha|hoje|amanha|segunda(?:\s+feira)?|terca(?:\s+feira)?|quarta(?:\s+feira)?|quinta(?:\s+feira)?|sexta(?:\s+feira)?|sabado|domingo)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gu;
const CORRECTION_RE =
  /\b(?:nao|na\s+verdade|melhor|quer\s+dizer|corrigindo|pera(?:i)?|alias)\b/gu;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function civilToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
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

function absoluteDate(token: string, now: Date, timezone: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(token);
  if (iso) {
    return validCivilDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/u.exec(token);
  if (!br) return null;
  const currentYear = Number(civilToday(now, timezone).slice(0, 4));
  const rawYear = br[3];
  const year = rawYear
    ? rawYear.length === 2
      ? 2000 + Number(rawYear)
      : Number(rawYear)
    : currentYear;
  return validCivilDate(year, Number(br[2]), Number(br[1]));
}

function correctionBefore(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 48), start);
  return [...prefix.matchAll(CORRECTION_RE)].length > 0;
}

function mentionsForInbound(input: {
  text: string;
  inboundIndex: number;
  now: Date;
  timezone: string;
}): DateMentionV2[] {
  const normalized = normalize(input.text);
  const mentions: DateMentionV2[] = [];
  for (const match of normalized.matchAll(DATE_TOKEN_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    const date =
      absoluteDate(token, input.now, input.timezone) ??
      resolveRelativeCalendarDate(token, input.now, input.timezone);
    if (!date) continue;
    mentions.push({
      date,
      inboundIndex: input.inboundIndex,
      start,
      end: start + token.length,
      corrected: correctionBefore(normalized, start),
    });
  }
  return mentions;
}

/**
 * Resolve a data somente a partir do lote atual. Se houver duas datas, a última
 * só vence quando a própria oração traz um marcador conservador de correção.
 */
export function resolveCurrentInboundDateV2(input: {
  currentInboundIds: readonly string[];
  inboundTextsById: Readonly<Record<string, string>>;
  now: Date;
  timezone: string;
}): CurrentDateResolutionV2 {
  const mentions = input.currentInboundIds.flatMap((inboundId, inboundIndex) =>
    mentionsForInbound({
      text: input.inboundTextsById[inboundId] ?? '',
      inboundIndex,
      now: input.now,
      timezone: input.timezone,
    })
  );
  if (mentions.length === 0) return { kind: 'none', mentions: [] };
  const dates = [...new Set(mentions.map((mention) => mention.date))];
  if (dates.length === 1) {
    return { kind: 'resolved', date: dates[0]!, mentions: dates };
  }
  const last = mentions.at(-1)!;
  if (last.corrected) {
    return { kind: 'resolved', date: last.date, mentions: dates };
  }
  return { kind: 'ambiguous', mentions: dates };
}

export const __currentDateResolutionForSmokeV2 = {
  DATE_TOKEN_RE,
  CORRECTION_RE,
};
