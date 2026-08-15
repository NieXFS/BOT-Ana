/**
 * Canário linguístico pt-BR permanente. Vendor não cobre o português falado;
 * estes fixtures não saem da suíte.
 */
export const LINGUISTIC_CANARY_FIXTURES_V2 = [
  {
    id: 'pra',
    inbound: 'quero peeling pra amanhã',
    kind: 'colloquial_preposition',
  },
  {
    id: 'ta',
    inbound: 'tá',
    kind: 'colloquial_affirmative',
  },
  {
    id: 'ellipsis',
    inbound: 'pode ser o das 15...',
    kind: 'ellipsis',
  },
  {
    id: 'pode_ser_as_15_q',
    inbound: 'pode ser às 15?',
    kind: 'bare_hour_question',
  },
  {
    id: 'depois_das_tres',
    inbound: 'depois das três',
    kind: 'after_time',
  },
  {
    id: 'time_correction',
    inbound: 'não, peraí, às 16h',
    kind: 'time_correction',
  },
] as const;

export type LinguisticCanaryIdV2 =
  (typeof LINGUISTIC_CANARY_FIXTURES_V2)[number]['id'];

export function linguisticCanaryByIdV2(
  id: LinguisticCanaryIdV2
): (typeof LINGUISTIC_CANARY_FIXTURES_V2)[number] {
  const found = LINGUISTIC_CANARY_FIXTURES_V2.find((entry) => entry.id === id);
  if (!found) throw new Error(`Canário linguístico desconhecido: ${id}`);
  return found;
}

export function stripColloquialInboundTailV2(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[?!.…]+$/u, '')
    .replace(/\.{2,}$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
