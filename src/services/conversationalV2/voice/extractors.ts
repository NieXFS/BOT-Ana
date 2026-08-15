import { normalizeTemporalAssertionsV2 } from '../temporalNormalizer';
import { normalizeVoiceTextV2 } from './normalize';
import type { VoiceHardFactsV2, VoiceWriteStateV2 } from './types';

const DATE_ABSOLUTE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gu;
const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const MONEY_RE =
  /(?:R\$\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s+reais?\b)/giu;
const DURATION_RE = /\b(\d{1,3})\s*(?:minutos?|mins?)\b/giu;
const RELATIVE_DATE_RE = /\b(hoje|amanha|depois de amanha|semana que vem)\b/gu;
const FORBIDDEN_MODIFIER_RE =
  /\b(?:so|somente|apenas|mais procurad[oa]|barat(?:o|a|inho|inha)|melhor|ranking|indicad[oa]|otim[oa] para|maravilhos[oa] para|perfeit[oa] para|clinico|diagnostico)\b/iu;
const NEW_CTA_RE =
  /\b(?:cpf|http|www\.|manda o link|te passo o link|vou te passar|vou avisar|ja encaminhei|ja transferi|falar com (?:a |o )?(?:equipe|dona|atendente))\b/iu;
const QUANTITY_RE = /\b(\d+)\s+(?:horarios?|vagas?|opcoes?)\b/giu;
const SPELLED_MONEY_RE =
  /\b((?:cento|cem|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos|mil|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|zero|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove)(?:\s+e\s+(?:cento|cem|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos|mil|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|zero|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove)){0,4})\s+reais?\b/giu;
const SPELLED_DURATION_RE =
  /\b((?:uma|duas|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|zero|um|dois|tres|quatro|cinco|seis|sete|oito|nove)(?:\s+e\s+(?:vinte|trinta|quarenta|cinquenta|sessenta|dez|onze|doze|treze|quatorze|catorze|quinze|cinco|um|uma|dois|duas|tres|quatro|seis|sete|oito|nove)){0,2})\s+(minutos?|mins?|horas?)\b/giu;
const SPELLED_NUMBER_HINT_RE =
  /\b(?:cento|duzentos|trezentos|quatrocentos|quinhentos|mil)\b/u;
const POSTFIX_NEGATION_RE =
  /\bnao\s+(?:e|esta|foi)\s+(?:oferecid[oa]|disponivel|atendid[oa]|realizad[oa])\b/u;

const ONES: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
};
const TEENS: Record<string, number> = {
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
};
const TENS: Record<string, number> = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};
const HUNDREDS: Record<string, number> = {
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDate(day: number, month: number, year: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function currencyToCents(raw: string): number | null {
  const normalized = raw.replace(/\./g, '').replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function uniqueSorted<T extends string | number>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) =>
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right))
  );
}

export function parseSpelledPtBrNumberV2(phrase: string): number | null {
  const tokens = normalizeVoiceTextV2(phrase)
    .split(/\s+/u)
    .filter((token) => token && token !== 'e');
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (token === 'mil') {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
      continue;
    }
    const hundred = HUNDREDS[token];
    if (hundred !== undefined) {
      current += hundred;
      continue;
    }
    const teen = TEENS[token];
    if (teen !== undefined) {
      current += teen;
      continue;
    }
    const ten = TENS[token];
    if (ten !== undefined) {
      current += ten;
      continue;
    }
    const one = ONES[token];
    if (one !== undefined) {
      current += one;
      continue;
    }
    return null;
  }
  return total + current;
}

export function extractOrderedLabelsV2(
  text: string,
  authorized: readonly string[]
): string[] {
  const normalized = normalizeVoiceTextV2(text);
  const ranked = [...authorized]
    .filter((label) => normalizeVoiceTextV2(label).length > 0)
    .sort(
      (left, right) =>
        normalizeVoiceTextV2(right).length - normalizeVoiceTextV2(left).length
    );
  const occupied: Array<{ start: number; end: number; label: string }> = [];
  for (const label of ranked) {
    const needle = normalizeVoiceTextV2(label);
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(needle, from);
      if (index < 0) break;
      const end = index + needle.length;
      const overlaps = occupied.some(
        (span) => index < span.end && end > span.start
      );
      if (!overlaps) {
        occupied.push({ start: index, end, label });
      }
      from = index + 1;
    }
  }
  occupied.sort((left, right) => left.start - right.start);
  return occupied.map((span) => span.label);
}

export function extractOrderedTimesV2(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const assertion of normalizeTemporalAssertionsV2(text)) {
    if (assertion.kind !== 'time' || seen.has(assertion.normalized)) continue;
    seen.add(assertion.normalized);
    ordered.push(assertion.normalized);
  }
  return ordered;
}

export function extractVoiceHardFactsV2(text: string): VoiceHardFactsV2 {
  const normalized = normalizeVoiceTextV2(text);
  const dates: string[] = [];
  const uninterpretable: string[] = [];
  for (const match of text.matchAll(DATE_ABSOLUTE_RE)) {
    const iso = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) dates.push(iso);
  }
  for (const match of text.matchAll(DATE_ISO_RE)) {
    dates.push(`${match[1]}-${match[2]}-${match[3]}`);
  }
  const times = extractOrderedTimesV2(text);
  const moneyCents: number[] = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const raw = match[1] ?? match[2];
    const cents = raw ? currencyToCents(raw) : null;
    if (cents !== null) moneyCents.push(cents);
  }
  for (const match of normalized.matchAll(SPELLED_MONEY_RE)) {
    const parsed = parseSpelledPtBrNumberV2(match[1] ?? '');
    if (parsed === null) {
      uninterpretable.push(match[0]!);
      continue;
    }
    moneyCents.push(parsed * 100);
  }
  const durationMinutes: number[] = [];
  for (const match of normalized.matchAll(DURATION_RE)) {
    durationMinutes.push(Number(match[1]));
  }
  for (const match of normalized.matchAll(SPELLED_DURATION_RE)) {
    const parsed = parseSpelledPtBrNumberV2(match[1] ?? '');
    const unit = match[2] ?? '';
    if (parsed === null) {
      uninterpretable.push(match[0]!);
      continue;
    }
    durationMinutes.push(unit.startsWith('hora') ? parsed * 60 : parsed);
  }
  if (SPELLED_NUMBER_HINT_RE.test(normalized) && moneyCents.length === 0) {
    uninterpretable.push('spelled_number');
  }
  const quantities: number[] = [];
  for (const match of normalized.matchAll(QUANTITY_RE)) {
    quantities.push(Number(match[1]));
  }
  const relativeDateTokens = [...normalized.matchAll(RELATIVE_DATE_RE)].map(
    (match) => match[1]!
  );
  return {
    dates: uniqueSorted(dates),
    times: uniqueSorted(times),
    moneyCents: uniqueSorted(moneyCents),
    durationMinutes: uniqueSorted(durationMinutes),
    quantities: uniqueSorted(quantities),
    writeState: extractWriteStateV2(normalized),
    relativeDateTokens: uniqueSorted(relativeDateTokens),
    uninterpretable: uniqueSorted(uninterpretable),
  };
}

export function extractWriteStateV2(normalized: string): VoiceWriteStateV2 {
  if (
    /\b(?:confirmado com sucesso|ja marquei|ja agendei|foi confirmado|agendamento foi confirmado)\b/u.test(
      normalized
    )
  ) {
    return 'completed';
  }
  if (
    /\b(?:nao consegui confirmar|ainda nao consegui|nao consegui marcar)\b/u.test(
      normalized
    )
  ) {
    return 'failed';
  }
  if (/\b(?:posso marcar|confirmando:|voce confirma)\b/u.test(normalized)) {
    return 'pending_confirmation';
  }
  return 'not_started';
}

export function hasForbiddenVoiceModifierV2(text: string): boolean {
  return FORBIDDEN_MODIFIER_RE.test(normalizeVoiceTextV2(text));
}

export function hasNewVoiceCtaV2(text: string): boolean {
  return NEW_CTA_RE.test(normalizeVoiceTextV2(text));
}

export function hasPostfixNegationV2(text: string): boolean {
  return POSTFIX_NEGATION_RE.test(normalizeVoiceTextV2(text));
}

export function sequencesEqualV2<T>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

export function setsEqualV2<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}
