import { normalizeSpokenNumbers } from './numberToWords';

const ABBREVIATIONS = [
  'Sr.',
  'Sra.',
  'Srta.',
  'Dr.',
  'Dra.',
  'Prof.',
  'Profa.',
  'ex.',
  'etc.',
];

const ABBREVIATION_DOT = '\uE000';

function protectAbbreviations(text: string): string {
  return ABBREVIATIONS.reduce(
    (current, abbreviation) =>
      current.replace(
        new RegExp(
          abbreviation.replace('.', '\\.').replace(/[A-Za-z]/g, (ch) => `[${ch}${ch.toUpperCase()}]`),
          'g'
        ),
        abbreviation.replace('.', ABBREVIATION_DOT)
      ),
    text
  );
}

function restoreAbbreviations(text: string): string {
  return text.replace(new RegExp(ABBREVIATION_DOT, 'g'), '.');
}

function removeMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
}

function flattenLists(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const isListItem = /^\s*(?:[-–—•]|\d+[.)])\s+/.test(line);
      const cleaned = line
        .replace(/^\s*(?:[-–—•]|\d+[.)])\s+/, '')
        .trim();
      if (!isListItem || !cleaned || /[.!?]$/.test(cleaned)) return cleaned;
      return `${cleaned}.`;
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Prepara SOMENTE o input do TTS. O histórico, o fallback e o texto enviado
 * continuam usando a resposta original.
 */
export function applyProsody(text: string): string {
  const cleaned = normalizeSpokenNumbers(
    removeMarkdown(text.replace(/\r\n?/g, '\n'))
  );
  if (!cleaned) return '';

  const blocks = cleaned
    .split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const flattened = flattenLists(paragraph)
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (!flattened) return [];

      return protectAbbreviations(flattened)
        .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý<])/u)
        .map((block) => restoreAbbreviations(block.trim()))
        .filter(Boolean);
    });

  return blocks.join('\n\n');
}
