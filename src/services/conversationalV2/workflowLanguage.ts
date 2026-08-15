/**
 * Linguagem de workflow proibida em copies canônicas NÃO-âncora.
 * Âncoras byte-fixas (resumo, write, duplicidade, clarificador, denial,
 * cancel, identidade, re-ask de CONFIRMATION) ficam fora desta varredura.
 */
export const WORKFLOW_LANGUAGE_DENYLIST_V2 = [
  'opção selecionada',
  'opcao selecionada',
  'prosseguiremos',
  'informe uma das opções',
  'informe uma das opcoes',
  'Combinado.',
] as const;

export function findWorkflowLanguageV2(text: string): string[] {
  const hits: string[] = [];
  for (const phrase of WORKFLOW_LANGUAGE_DENYLIST_V2) {
    if (phrase === 'Combinado.') {
      if (/(^|[.!?]\s*)Combinado\.(?:\s|$)/u.test(text) && !text.includes('Combinado, então.')) {
        hits.push(phrase);
      }
      continue;
    }
    const haystack = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const needle = phrase
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (haystack.includes(needle)) hits.push(phrase);
  }
  return hits;
}
