/**
 * Remove somente atribuições metalinguísticas de opção usadas em injeção.
 * O restante do inbound permanece byte-posicionalmente equivalente (espaços),
 * para que todos os gates v2 avaliem a mesma testemunha lexical.
 */
export function stripPowerZeroMetalinguisticAssignmentsV2(
  value: string
): string {
  return value.replace(
    /\b(?:choice|option|opcao)\s*[:=]\s*["']?[a-z0-9_:-]+["']?/giu,
    (match) => ' '.repeat(match.length)
  );
}
