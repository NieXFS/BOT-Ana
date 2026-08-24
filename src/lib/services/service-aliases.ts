/**
 * Normalização do contrato de aliases de serviço.
 *
 * Este módulo é deliberadamente pequeno e sem efeitos: o runtime usa a mesma
 * sequência do contrato ERP antes de comparar um alias recebido do cliente.
 * Aliases continuam sendo dados do catálogo; este helper nunca produz prompt,
 * histórico ou instrução executável.
 */

export const SERVICE_ALIAS_MAX_COUNT = 20;
export const SERVICE_ALIAS_MAX_LENGTH = 80;

const SERVICE_ALIAS_GRAMMAR = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_PATTERN = /(?:https?|ftp):\/\/|\bwww\./iu;
const HTML_PATTERN = /<[^>]*>|<|>/u;
const TEMPLATE_OR_DELIMITER_PATTERN = /\{\{|\}\}|\$\{|\[\[|\]\]|<<|>>|`|\{%|%\}/u;
const PROMPT_LIKE_TERM_PATTERN =
  /\b(?:assistant|comando|comandos|developer|desconsidere|execute|executar|ignore|ignorar|instruction|instructions|instrucao|instrucoes|jailbreak|override|prompt|system|sistema|user)\b/iu;

export function normalizeServiceAlias(value: string): string {
  return value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * Normaliza, limita e deduplica preservando a primeira ocorrência. Valores
 * não-string/vazios são descartados para que um payload antigo ou malformado
 * nunca altere a resolução.
 */
export function normalizeServiceAliases(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SERVICE_ALIAS_MAX_COUNT) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > SERVICE_ALIAS_MAX_LENGTH) {
      return [];
    }
    if (CONTROL_CHARACTER_PATTERN.test(candidate)) return [];
    const normalized = normalizeServiceAlias(candidate);
    if (
      !normalized ||
      normalized.length > SERVICE_ALIAS_MAX_LENGTH ||
      URL_PATTERN.test(normalized) ||
      HTML_PATTERN.test(normalized) ||
      TEMPLATE_OR_DELIMITER_PATTERN.test(normalized) ||
      PROMPT_LIKE_TERM_PATTERN.test(normalized) ||
      !SERVICE_ALIAS_GRAMMAR.test(normalized)
    ) {
      return [];
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Alias explícito para leituras de payloads antigos/importados. */
export const normalizeServiceAliasesForExposure = normalizeServiceAliases;
