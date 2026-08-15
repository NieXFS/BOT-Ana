import {
  VOICE_FIDELITY_VERSION_V2,
  VOICE_POOL_SCHEMA_VERSION_V2,
  VOICE_TEMPLATE_VERSION_V2,
  type CompiledVoicePoolV2,
  type VoiceCopyIdV2,
} from './types';

const POOL_NOTE = 'PENDENTE-PAINEL' as const;

function pool(
  copyId: VoiceCopyIdV2,
  poolId: string,
  connectives: readonly string[]
): CompiledVoicePoolV2 {
  return {
    schemaVersion: VOICE_POOL_SCHEMA_VERSION_V2,
    poolId,
    copyId,
    templateVersion: VOICE_TEMPLATE_VERSION_V2,
    reviewStatus: 'PENDENTE-PAINEL',
    provenance: {
      generator: 'mock_fixture',
      generatedAt: '2026-08-14T00:00:00.000Z',
      conferenceVersion: VOICE_FIDELITY_VERSION_V2,
      note: POOL_NOTE,
    },
    variants: connectives.map((connective, index) => ({
      variantId: `${poolId}_${index + 1}`,
      connective,
    })),
  };
}

/**
 * Pools compilados. Nesta fase são fixtures de mock, marcadas PENDENTE-PAINEL.
 * O runtime só aplica variante quando `reviewStatus === 'aprovado'`.
 */
export const COMPILED_VOICE_POOLS_V2: readonly CompiledVoicePoolV2[] = [
  pool('availability_slots_offer', 'slots_offer_v1', [
    'Encontrei horários para {date}: {slots}. Qual você prefere?',
    'Para {date}, encontrei estes horários: {slots}. Qual você prefere?',
    'Separei estes horários para {date}: {slots}. Qual você prefere?',
    'Separei esses horários para {date}: {slots}. Qual você prefere?',
    'Encontrei horários em {date}: {slots}. Qual você prefere?',
    'Encontrei estes horários para {date}: {slots}. Qual você prefere?',
    'Separei estes horários em {date}: {slots}. Qual você prefere?',
    'Encontrei os horários de {date}: {slots}. Qual você prefere?',
    'Para {date}, separei estes horários: {slots}. Qual você prefere?',
    'Encontrei horários para o dia {date}: {slots}. Qual você prefere?',
    'Separei estes horários do dia {date}: {slots}. Qual você prefere?',
    'Para {date}, encontrei os horários: {slots}. Qual você prefere?',
  ]),
  pool('booking_reentry_question', 'booking_reentry_v1', [
    'A gente estava marcando {service} para {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'Estávamos marcando {service} para {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'Você estava agendando {service} para {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'A gente ia de {service} em {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'Havia um {service} em {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'O {service} de {date}{timePart} ainda está aberto — quer continuar esse agendamento ou marcar outro?',
    'Antes a gente ia de {service} em {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'A gente ainda estava no {service} de {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
    'Sobre o {service} em {date}{timePart}: quer continuar esse agendamento ou marcar outro?',
    'Voltando ao {service} de {date}{timePart} — quer continuar esse agendamento ou marcar outro?',
  ]),
];

export function compiledVoicePoolByCopyIdV2(
  copyId: VoiceCopyIdV2
): CompiledVoicePoolV2 | null {
  return COMPILED_VOICE_POOLS_V2.find((entry) => entry.copyId === copyId) ?? null;
}

export function selectCompiledPoolVariantV2(input: {
  copyId: VoiceCopyIdV2;
  lastVariantId?: string | null;
  seed: number;
}): { variantId: string; connective: string } | null {
  return selectCompiledPoolVariantInternalV2({
    copyId: input.copyId,
    lastVariantId: input.lastVariantId,
    seed: input.seed,
  });
}

/** Bypass só para fixture de conferência. Produção não exporta override. */
export function selectCompiledPoolVariantForTestV2(input: {
  copyId: VoiceCopyIdV2;
  lastVariantId?: string | null;
  seed: number;
  reviewOverride: 'aprovado';
}): { variantId: string; connective: string } | null {
  return selectCompiledPoolVariantInternalV2({
    copyId: input.copyId,
    lastVariantId: input.lastVariantId,
    seed: input.seed,
    reviewOverride: input.reviewOverride,
  });
}

function selectCompiledPoolVariantInternalV2(input: {
  copyId: VoiceCopyIdV2;
  lastVariantId?: string | null;
  seed: number;
  reviewOverride?: CompiledVoicePoolV2['reviewStatus'];
}): { variantId: string; connective: string } | null {
  const found = compiledVoicePoolByCopyIdV2(input.copyId);
  if (!found || found.variants.length === 0) return null;
  const status = input.reviewOverride ?? found.reviewStatus;
  if (status !== 'aprovado') return null;
  const variants = found.variants;
  let index = Math.abs(input.seed) % variants.length;
  if (variants.length > 1 && variants[index]?.variantId === input.lastVariantId) {
    index = (index + 1) % variants.length;
  }
  const chosen = variants[index]!;
  return { variantId: chosen.variantId, connective: chosen.connective };
}

export function renderCompiledPoolConnectiveV2(
  connective: string,
  slots: {
    date?: string;
    slots?: string;
    service?: string;
    timePart?: string;
  }
): string {
  return connective
    .split('{date}').join(slots.date ?? '')
    .split('{slots}').join(slots.slots ?? '')
    .split('{service}').join(slots.service ?? '')
    .split('{timePart}').join(slots.timePart ?? '');
}
