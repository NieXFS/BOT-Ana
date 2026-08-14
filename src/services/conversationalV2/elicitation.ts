export const ANA_CONVERSATIONAL_V2_ELICITATION_ENV =
  'ANA_CONVERSATIONAL_V2_ELICITATION';

export const ELICITATION_VARIANTS_V2 = ['v1', 'v2', 'v3', 'v4'] as const;
export type ElicitationVariantV2 = (typeof ELICITATION_VARIANTS_V2)[number];

export interface ElicitationPolicyV2 {
  variant: ElicitationVariantV2;
  primaryJsonObjectResponseFormat: boolean;
  primaryRequiresFlatEnvelope: boolean;
  regenJsonObjectResponseFormat: 'default_except_empty' | 'always';
  retryEmptyCompletionInsideLoop: boolean;
}

export function parseElicitationVariantV2(
  value: string | null | undefined
): ElicitationVariantV2 {
  const normalized = value?.trim().toLowerCase() || 'v1';
  if (
    (ELICITATION_VARIANTS_V2 as readonly string[]).includes(normalized)
  ) {
    return normalized as ElicitationVariantV2;
  }
  throw new Error(
    `${ANA_CONVERSATIONAL_V2_ELICITATION_ENV} deve ser v1, v2, v3 ou v4.`
  );
}

export function resolveElicitationVariantV2(
  override?: ElicitationVariantV2
): ElicitationVariantV2 {
  return override ?? parseElicitationVariantV2(
    process.env[ANA_CONVERSATIONAL_V2_ELICITATION_ENV]
  );
}

export function elicitationPolicyV2(
  variant: ElicitationVariantV2
): ElicitationPolicyV2 {
  switch (variant) {
    case 'v1':
      return {
        variant,
        primaryJsonObjectResponseFormat: true,
        primaryRequiresFlatEnvelope: true,
        regenJsonObjectResponseFormat: 'default_except_empty',
        retryEmptyCompletionInsideLoop: false,
      };
    case 'v2':
      return {
        variant,
        primaryJsonObjectResponseFormat: false,
        primaryRequiresFlatEnvelope: true,
        regenJsonObjectResponseFormat: 'always',
        retryEmptyCompletionInsideLoop: false,
      };
    case 'v3':
      return {
        variant,
        primaryJsonObjectResponseFormat: false,
        primaryRequiresFlatEnvelope: false,
        regenJsonObjectResponseFormat: 'always',
        retryEmptyCompletionInsideLoop: false,
      };
    case 'v4':
      return {
        variant,
        primaryJsonObjectResponseFormat: false,
        primaryRequiresFlatEnvelope: true,
        regenJsonObjectResponseFormat: 'always',
        retryEmptyCompletionInsideLoop: true,
      };
  }
}
