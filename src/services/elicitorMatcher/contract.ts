export interface ElicitorMatcherContractRow {
  nome: string;
  elicitor: string;
  respostasNaturais: readonly string[];
  negacoes: readonly string[];
  interrogativas: readonly string[];
  matcher: (reply: string) => boolean;
  respostasNaturaisAutorizam?: boolean;
}

const QUOTED_ELICITOR_ANSWERS_RE = /"([^"]+)"|“([^”]+)”/gu;

export function extractQuotedElicitorAnswers(elicitor: string): string[] {
  const answers: string[] = [];
  for (const match of elicitor.matchAll(QUOTED_ELICITOR_ANSWERS_RE)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value) answers.push(value);
  }
  return answers;
}

function failContract(
  row: ElicitorMatcherContractRow,
  classe: string,
  sample: string,
  expected: boolean,
  actual: boolean
): never {
  throw new Error(
    `elicitor×matcher: linha "${row.nome}", classe ${classe}, string ${JSON.stringify(
      sample
    )} — esperado ${expected}, obtido ${actual}`
  );
}

function assertMatcher(
  row: ElicitorMatcherContractRow,
  classe: string,
  sample: string,
  expected: boolean
): void {
  const actual = row.matcher(sample);
  if (actual !== expected) {
    failContract(row, classe, sample, expected, actual);
  }
}

export function assertElicitorMatcherContract(
  rows: readonly ElicitorMatcherContractRow[]
): void {
  for (const row of rows) {
    for (const quoted of extractQuotedElicitorAnswers(row.elicitor)) {
      assertMatcher(row, 'elicitor_quoted', quoted, true);
    }

    if (row.respostasNaturaisAutorizam !== false) {
      for (const reply of row.respostasNaturais) {
        assertMatcher(row, 'respostas_naturais', reply, true);
      }
    }

    for (const reply of row.negacoes) {
      assertMatcher(row, 'negacoes', reply, false);
    }

    for (const reply of row.interrogativas) {
      assertMatcher(row, 'interrogativas', reply, false);
    }
  }
}
