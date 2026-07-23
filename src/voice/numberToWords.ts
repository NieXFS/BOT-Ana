const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const TEENS = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

const SCALES = [
  null,
  { singular: 'mil', plural: 'mil' },
  { singular: 'milhão', plural: 'milhões' },
  { singular: 'bilhão', plural: 'bilhões' },
  { singular: 'trilhão', plural: 'trilhões' },
  { singular: 'quadrilhão', plural: 'quadrilhões' },
] as const;

function underOneThousand(n: number): string {
  if (n < 10) return UNITS[n];
  if (n < 20) return TEENS[n - 10];
  if (n < 100) {
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    return unit === 0 ? TENS[ten] : `${TENS[ten]} e ${UNITS[unit]}`;
  }
  if (n === 100) return 'cem';

  const hundred = Math.floor(n / 100);
  const remainder = n % 100;
  return remainder === 0
    ? HUNDREDS[hundred]
    : `${HUNDREDS[hundred]} e ${underOneThousand(remainder)}`;
}

interface SpokenGroup {
  value: number;
  text: string;
}

/**
 * Converte inteiros não negativos para o cardinal masculino em pt-BR.
 * Concordância feminina depende do substantivo e fica fora deste conversor.
 */
export function numberToPtWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('numberToPtWords expects a non-negative safe integer');
  }
  if (n === 0) return UNITS[0];

  const groups: SpokenGroup[] = [];
  let remaining = n;
  let scaleIndex = 0;

  while (remaining > 0) {
    const groupValue = remaining % 1000;
    if (groupValue > 0) {
      const scale = SCALES[scaleIndex];
      if (scaleIndex >= SCALES.length || scale === undefined) {
        throw new RangeError('numberToPtWords value is too large');
      }

      let groupText = underOneThousand(groupValue);
      if (scaleIndex === 1 && groupValue === 1) {
        groupText = 'mil';
      } else if (scale) {
        const scaleWord = groupValue === 1 ? scale.singular : scale.plural;
        groupText = `${groupText} ${scaleWord}`;
      }
      groups.unshift({ value: groupValue, text: groupText });
    }

    remaining = Math.floor(remaining / 1000);
    scaleIndex += 1;
  }

  return groups.reduce((spoken, group, index) => {
    if (index === 0) return group.text;
    const connector =
      group.value < 100 || group.value % 100 === 0 ? ' e ' : ' ';
    return `${spoken}${connector}${group.text}`;
  }, '');
}

const CURRENCY_RE =
  /R\$[ \t]*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![\d.,])/g;
const HOURS_RE =
  /(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{3})+|\d+)[ \t]*(?:h|horas?)(?![\p{L}\p{N}])/giu;
const MINUTES_RE =
  /(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{3})+|\d+)[ \t]*(?:min|minutos?)(?![\p{L}\p{N}])/giu;
const PERCENT_RE =
  /(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{3})+|\d+)[ \t]*%(?!\p{N})/gu;
const LOOSE_CARDINAL_RE =
  /(?<![\p{L}\p{N}.,/:\-])(\d{1,3}(?:\.\d{3})+|\d+)(?![\p{L}\p{N}.,/:\-])/gu;

function parseInteger(raw: string): number | null {
  const parsed = Number(raw.replace(/\./g, ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Normaliza somente os formatos numéricos seguros para fala. Cardinais sem
 * unidade acima de 999 permanecem em dígitos para preservar anos e CEPs.
 */
export function normalizeSpokenNumbers(text: string): string {
  return text
    .replace(CURRENCY_RE, (match, integerRaw: string, centsRaw?: string) => {
      const integer = parseInteger(integerRaw);
      if (integer === null) return match;

      const realUnit = integer === 1 ? 'real' : 'reais';
      let spoken = `${numberToPtWords(integer)} ${realUnit}`;
      if (centsRaw) {
        const cents = Number(centsRaw.padEnd(2, '0'));
        if (cents > 0) {
          const centsUnit = cents === 1 ? 'centavo' : 'centavos';
          spoken += ` e ${numberToPtWords(cents)} ${centsUnit}`;
        }
      }
      return spoken;
    })
    .replace(HOURS_RE, (match, integerRaw: string) => {
      const integer = parseInteger(integerRaw);
      if (integer === null) return match;
      return integer === 1
        ? 'uma hora'
        : `${numberToPtWords(integer)} horas`;
    })
    .replace(MINUTES_RE, (match, integerRaw: string) => {
      const integer = parseInteger(integerRaw);
      if (integer === null) return match;
      return `${numberToPtWords(integer)} ${
        integer === 1 ? 'minuto' : 'minutos'
      }`;
    })
    .replace(PERCENT_RE, (match, integerRaw: string) => {
      const integer = parseInteger(integerRaw);
      return integer === null
        ? match
        : `${numberToPtWords(integer)} por cento`;
    })
    .replace(LOOSE_CARDINAL_RE, (match, integerRaw: string) => {
      const integer = parseInteger(integerRaw);
      return integer !== null && integer <= 999
        ? numberToPtWords(integer)
        : match;
    });
}
