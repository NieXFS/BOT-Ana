/**
 * Smoke determinístico do conversor e normalizador de números falados.
 * Sem rede / DB / OpenAI.
 */
import {
  normalizeSpokenNumbers,
  numberToPtWords,
} from '../src/voice/numberToWords';

let assertions = 0;
let failures = 0;

function check(label: string, condition: boolean): void {
  assertions += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function throwsRangeError(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof RangeError;
  }
}

console.log('▶ numberToPtWords');
const cardinalCases: Array<[number, string]> = [
  [0, 'zero'],
  [2, 'dois'],
  [7, 'sete'],
  [24, 'vinte e quatro'],
  [30, 'trinta'],
  [97, 'noventa e sete'],
  [100, 'cem'],
  [101, 'cento e um'],
  [297, 'duzentos e noventa e sete'],
  [800, 'oitocentos'],
  [1000, 'mil'],
  [1800, 'mil e oitocentos'],
  [2000, 'dois mil'],
  [2500, 'dois mil e quinhentos'],
  [1234, 'mil duzentos e trinta e quatro'],
  [100000, 'cem mil'],
  [1000000, 'um milhão'],
];

for (const [input, expected] of cardinalCases) {
  check(`${input} → ${expected}`, numberToPtWords(input) === expected);
}

check('negativo lança RangeError', throwsRangeError(() => numberToPtWords(-1)));
check(
  'não-inteiro lança RangeError',
  throwsRangeError(() => numberToPtWords(1.5))
);

console.log('▶ normalizeSpokenNumbers');
const normalizationCases: Array<[string, string]> = [
  ['R$ 1.800', 'mil e oitocentos reais'],
  ['R$ 97', 'noventa e sete reais'],
  ['R$ 97,90', 'noventa e sete reais e noventa centavos'],
  ['R$ 2.500,00', 'dois mil e quinhentos reais'],
  ['24h', 'vinte e quatro horas'],
  ['24 horas', 'vinte e quatro horas'],
  ['1h', 'uma hora'],
  ['30min', 'trinta minutos'],
  ['20%', 'vinte por cento'],
  ['3 profissionais', 'três profissionais'],
  ['7 dias', 'sete dias'],
  ['2026', '2026'],
  ['Texto sem número.', 'Texto sem número.'],
];

for (const [input, expected] of normalizationCases) {
  check(
    `${JSON.stringify(input)} → ${JSON.stringify(expected)}`,
    normalizeSpokenNumbers(input) === expected
  );
}

if (failures > 0) {
  console.error(`\n❌ ${failures}/${assertions} asserção(ões) falharam.`);
} else {
  console.log(`\n✅ smoke-renata-number-words OK (${assertions} asserções)`);
}

process.exit(failures ? 1 : 0);
