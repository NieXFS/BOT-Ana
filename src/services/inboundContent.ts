export const W1_MAX_CONTENT_UTF16_UNITS = 4_000;

export interface TruncatedW1Content {
  text: string;
  originalLength: number;
  truncated: boolean;
}

/**
 * Recorta exatamente por unidades UTF-16, que é a unidade de `String.length`
 * usada no contrato W1. Se o corte cair depois da metade alta de um surrogate
 * pair, recua uma unidade para nunca transmitir um high surrogate órfão.
 */
export function truncateForW1(text: string): TruncatedW1Content {
  const originalLength = text.length;
  if (originalLength <= W1_MAX_CONTENT_UTF16_UNITS) {
    return { text, originalLength, truncated: false };
  }

  let end = W1_MAX_CONTENT_UTF16_UNITS;
  const lastUnit = text.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    end -= 1;
  }

  return {
    text: text.slice(0, end),
    originalLength,
    truncated: true,
  };
}
