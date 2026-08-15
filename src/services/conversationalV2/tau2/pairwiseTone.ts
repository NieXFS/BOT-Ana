import { evaluateVoiceFidelityV2 } from '../voice/fidelity';
import type { VoiceCopyIdV2 } from '../voice/types';

export const TAU2_PAIRWISE_LENGTH_BANDS_V2 = [
  'short',
  'medium',
  'long',
] as const;

export const TAU2_PAIRWISE_LENGTH_BAND_MAX_RELATIVE_DELTA_V2 = 0.35;

export type Tau2PairwiseLengthBandV2 =
  (typeof TAU2_PAIRWISE_LENGTH_BANDS_V2)[number];

export interface Tau2PairwiseJudgeSpecV2 {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
}

export interface Tau2PairwiseToneConfigV2 {
  readonly judges: readonly Tau2PairwiseJudgeSpecV2[];
  readonly generatorModels: readonly string[];
  readonly lengthBandMaxRelativeDelta: number;
}

export interface Tau2PairwiseToneItemV2 {
  readonly id: string;
  readonly copyId: VoiceCopyIdV2;
  readonly template: string;
  readonly variant: string;
  readonly catalog: {
    readonly services: readonly string[];
    readonly professionals: readonly string[];
  };
}

export type Tau2PairwisePreferenceV2 = 'template' | 'variant' | 'tie';

/** Preferência cega do juiz sobre o par apresentado, sem saber quem é o template. */
export type Tau2PairwiseSideV2 = 'left' | 'right' | 'tie';

export interface Tau2PairwiseToneReportV2 {
  readonly nComparisons: number;
  readonly nEligible: number;
  readonly nConsistent: number;
  readonly nExcludedFidelity: number;
  readonly nExcludedLength: number;
  readonly nInconsistent: number;
  readonly templateWins: number;
  readonly variantWins: number;
  /** Só preferência consistente. Fidelidade nunca entra nesta média. */
  readonly preferenceRate: number | null;
  readonly judges: readonly string[];
}

/** Falha de askJudge com contagens brutas até o ponto da quebra. Sem média. */
export class PairwiseToneAskFailedV2 extends Error {
  readonly partial: Tau2PairwiseToneReportV2;

  constructor(
    message: string,
    partial: Tau2PairwiseToneReportV2,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'PairwiseToneAskFailedV2';
    this.partial = partial;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function pairwiseLengthBandV2(text: string): Tau2PairwiseLengthBandV2 {
  const length = text.trim().length;
  if (length < 80) return 'short';
  if (length < 180) return 'medium';
  return 'long';
}

export function pairPassesLengthBandV2(
  left: string,
  right: string,
  maxRelativeDelta: number
): boolean {
  const a = Math.max(1, left.trim().length);
  const b = Math.max(1, right.trim().length);
  const delta = Math.abs(a - b) / Math.max(a, b);
  return delta <= maxRelativeDelta;
}

/**
 * O Flash não pode ser juiz único de uma variante gerada pelo próprio Flash.
 */
export function assertToneJudgePanelV2(
  config: Tau2PairwiseToneConfigV2
): void {
  if (config.judges.length === 0) {
    throw new Error('Juiz de tom pairwise exige pelo menos um juiz.');
  }
  const judgeModels = new Set(
    config.judges.map((judge) => judge.model.trim().toLowerCase())
  );
  const generatorModels = config.generatorModels.map((model) =>
    model.trim().toLowerCase()
  );
  if (config.judges.length === 1) {
    const sole = [...judgeModels][0];
    if (sole && generatorModels.includes(sole)) {
      throw new Error(
        `Juiz único ${config.judges[0]!.id} não pode julgar variante do próprio modelo ${sole}.`
      );
    }
  }
}

export function mapPairwiseSideToPreferenceV2(
  order: 'ab' | 'ba',
  side: Tau2PairwiseSideV2
): Tau2PairwisePreferenceV2 {
  if (side === 'tie') return 'tie';
  if (order === 'ab') return side === 'left' ? 'template' : 'variant';
  return side === 'left' ? 'variant' : 'template';
}

export function consistentPairwisePreferenceV2(
  ab: Tau2PairwisePreferenceV2,
  ba: Tau2PairwisePreferenceV2
): Tau2PairwisePreferenceV2 | null {
  if (ab === 'tie' || ba === 'tie') return null;
  return ab === ba ? ab : null;
}

export async function evaluatePairwiseToneV2(input: {
  items: readonly Tau2PairwiseToneItemV2[];
  config: Tau2PairwiseToneConfigV2;
  askJudge: (input: {
    judge: Tau2PairwiseJudgeSpecV2;
    left: string;
    right: string;
    order: 'ab' | 'ba';
    itemId: string;
  }) => Promise<Tau2PairwiseSideV2>;
}): Promise<Tau2PairwiseToneReportV2> {
  assertToneJudgePanelV2(input.config);
  let nComparisons = 0;
  let nEligible = 0;
  let nConsistent = 0;
  let nExcludedFidelity = 0;
  let nExcludedLength = 0;
  let nInconsistent = 0;
  let templateWins = 0;
  let variantWins = 0;

  for (const item of input.items) {
    const fidelity = evaluateVoiceFidelityV2({
      copyId: item.copyId,
      template: item.template,
      rewrite: item.variant,
      catalog: {
        services: [...item.catalog.services],
        professionals: [...item.catalog.professionals],
      },
    });
    if (!fidelity.safe) {
      nExcludedFidelity += 1;
      continue;
    }
    if (
      !pairPassesLengthBandV2(
        item.template,
        item.variant,
        input.config.lengthBandMaxRelativeDelta
      )
    ) {
      nExcludedLength += 1;
      continue;
    }
    nEligible += 1;
    const preferences: Tau2PairwisePreferenceV2[] = [];
    for (const judge of input.config.judges) {
      let abSide: Tau2PairwiseSideV2;
      let baSide: Tau2PairwiseSideV2;
      try {
        abSide = await input.askJudge({
          judge,
          left: item.template,
          right: item.variant,
          order: 'ab',
          itemId: item.id,
        });
        nComparisons += 1;
        baSide = await input.askJudge({
          judge,
          left: item.variant,
          right: item.template,
          order: 'ba',
          itemId: item.id,
        });
        nComparisons += 1;
      } catch (error) {
        if (error instanceof PairwiseToneAskFailedV2) {
          throw new PairwiseToneAskFailedV2(error.message, snapshotPartial(), {
            cause: error,
          });
        }
        throw error;
      }
      const consistent = consistentPairwisePreferenceV2(
        mapPairwiseSideToPreferenceV2('ab', abSide),
        mapPairwiseSideToPreferenceV2('ba', baSide)
      );
      if (!consistent) {
        nInconsistent += 1;
        continue;
      }
      nConsistent += 1;
      preferences.push(consistent);
      if (consistent === 'template') templateWins += 1;
      else variantWins += 1;
    }
    void preferences;
  }

  function snapshotPartial(): Tau2PairwiseToneReportV2 {
    return {
      nComparisons,
      nEligible,
      nConsistent,
      nExcludedFidelity,
      nExcludedLength,
      nInconsistent,
      templateWins,
      variantWins,
      preferenceRate: null,
      judges: input.config.judges.map((judge) => judge.id),
    };
  }

  return {
    nComparisons,
    nEligible,
    nConsistent,
    nExcludedFidelity,
    nExcludedLength,
    nInconsistent,
    templateWins,
    variantWins,
    preferenceRate:
      nConsistent === 0 ? null : variantWins / nConsistent,
    judges: input.config.judges.map((judge) => judge.id),
  };
}
