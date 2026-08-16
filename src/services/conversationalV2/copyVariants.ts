import type { ModelTurnResultV2 } from './contracts';

export const COPY_VARIANTS_V2 = [
  'canonical',
  'service_question_1',
  'service_question_2',
  'service_question_3',
  'date_question_1',
  'date_question_2',
  'date_question_3',
  'slots_offer_1',
  'slots_offer_2',
  'slots_offer_3',
] as const;

export type CopyVariantIdV2 = (typeof COPY_VARIANTS_V2)[number];

function pick<T extends CopyVariantIdV2>(input: {
  variants: readonly T[];
  lastVariant: CopyVariantIdV2 | null | undefined;
  seed: number;
}): T {
  let index = Math.abs(input.seed) % input.variants.length;
  if (
    input.variants.length > 1 &&
    input.variants[index] === input.lastVariant
  ) {
    index = (index + 1) % input.variants.length;
  }
  return input.variants[index]!;
}

function replaceSlotsPrefix(reply: string, variant: CopyVariantIdV2): string {
  const match = /^(Obrigada! )?Encontrei horários para ([^:]+): ([\s\S]+)$/u.exec(reply);
  if (!match) return reply;
  const acknowledgement = match[1] ?? '';
  const date = match[2]!;
  const rest = match[3]!;
  if (variant === 'slots_offer_2') {
    return `${acknowledgement}Para ${date}, encontrei estes horários: ${rest}`;
  }
  if (variant === 'slots_offer_3') {
    return `${acknowledgement}Separei estes horários para ${date}: ${rest}`;
  }
  return reply;
}

/**
 * Só modifica copies server-owned fora de CONFIRMATION/duplicidade. A resposta
 * variada ainda atravessa a boundary completa antes da entrega.
 */
export function varyUnanchoredServerCopyV2(input: {
  result: ModelTurnResultV2;
  lastVariant?: CopyVariantIdV2 | null;
  seed: number;
}): { result: ModelTurnResultV2; variant: CopyVariantIdV2 } {
  const transition = input.result.pendingTransitionCandidate;
  if (
    input.result.replyPurpose === 'WRITE_CONFIRMATION' ||
    (transition.kind === 'open' &&
      (transition.pendingKind === 'CONFIRMATION' ||
        transition.pendingKind === 'CANCEL_CONFIRMATION' ||
        transition.pendingKind === 'CANCEL_TARGET'))
  ) {
    return { result: input.result, variant: 'canonical' };
  }

  if (
    input.result.replyPurpose === 'SERVICE_QUESTION' &&
    input.result.reply.startsWith('Claro! Para qual serviço você gostaria de agendar?')
  ) {
    const variant = pick({
      variants: ['service_question_1', 'service_question_2', 'service_question_3'],
      lastVariant: input.lastVariant,
      seed: input.seed,
    });
    const prefix =
      variant === 'service_question_2'
        ? 'Combinado!'
        : variant === 'service_question_3'
          ? 'Vamos lá!'
          : 'Claro!';
    return {
      result: {
        ...input.result,
        reply: input.result.reply.replace(/^Claro!/u, prefix),
      },
      variant,
    };
  }

  if (
    input.result.replyPurpose === 'DATE_TIME_QUESTION' &&
    /^(?:Perfeito|Ótimo|Combinado, então)\. Qual dia você prefere\?$/u.test(
      input.result.reply
    )
  ) {
    const variant = pick({
      variants: ['date_question_1', 'date_question_2', 'date_question_3'],
      lastVariant: input.lastVariant,
      seed: input.seed,
    });
    const prefix =
      variant === 'date_question_2'
        ? 'Ótimo.'
        : variant === 'date_question_3'
          ? 'Combinado, então.'
          : 'Perfeito.';
    return {
      result: { ...input.result, reply: `${prefix} Qual dia você prefere?` },
      variant,
    };
  }

  if (/^(?:Obrigada! )?Encontrei horários para /u.test(input.result.reply)) {
    const variant = pick({
      variants: ['slots_offer_1', 'slots_offer_2', 'slots_offer_3'],
      lastVariant: input.lastVariant,
      seed: input.seed,
    });
    return {
      result: {
        ...input.result,
        reply: replaceSlotsPrefix(input.result.reply, variant),
      },
      variant,
    };
  }

  return { result: input.result, variant: 'canonical' };
}
