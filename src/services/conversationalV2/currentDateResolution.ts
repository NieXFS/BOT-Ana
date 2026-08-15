import {
  CIVIL_DATE_TOKEN_RE,
  contrastWinningCivilDateV2,
  matchCivilDateTokensV2,
  resolveCivilDateTokenV2,
} from './temporalNormalizer';

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

const CORRECTION_RE =
  /\b(?:nao|na\s+verdade|melhor|quer\s+dizer|corrigindo|pera(?:i)?|alias)\b/gu;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
  // "segunda opção" pertence ao domínio ordinal. O token explícito opção veta
  // TODA leitura civil deste inbound para impedir que weekday ganhe precedência
  // sobre a escolha ancorada no PendingFrame.
  if (/\bopcao\b/u.test(normalized)) return [];
  const mentions: DateMentionV2[] = [];
  for (const match of matchCivilDateTokensV2(normalized)) {
    const token = match[0];
    const start = match.index ?? 0;
    const date = resolveCivilDateTokenV2(token, input.now, input.timezone);
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
 * Resolve a data somente a partir do lote atual. "X, não Y" / "X e não Y"
 * elege X e descarta Y. "não X, Y" (vírgula) elege Y. Sem contraste, duas
 * datas só se resolvem quando a última oração traz um marcador conservador
 * de correção.
 */
export function resolveCurrentInboundDateV2(input: {
  currentInboundIds: readonly string[];
  inboundTextsById: Readonly<Record<string, string>>;
  now: Date;
  timezone: string;
}): CurrentDateResolutionV2 {
  let mentions = input.currentInboundIds.flatMap((inboundId, inboundIndex) =>
    mentionsForInbound({
      text: input.inboundTextsById[inboundId] ?? '',
      inboundIndex,
      now: input.now,
      timezone: input.timezone,
    })
  );
  const joined = input.currentInboundIds
    .map((inboundId) => input.inboundTextsById[inboundId] ?? '')
    .filter(Boolean)
    .join(' ');
  const contrastWinner = contrastWinningCivilDateV2(
    joined,
    input.now,
    input.timezone
  );
  if (contrastWinner) {
    const contrasted = mentions.filter(
      (mention) => mention.date === contrastWinner
    );
    if (contrasted.length > 0) mentions = contrasted;
  }
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
  DATE_TOKEN_RE: CIVIL_DATE_TOKEN_RE,
  CORRECTION_RE,
};
