import {
  BOUNDARY_REASON_CODES_V2,
  type BoundaryReasonCodeV2,
} from './contracts';
import type { RecoveryFallbackIntentV2 } from './recoveryFallbackIntent';

export const UNDERSTANDING_FAILURE_KIND = 'UNDERSTANDING_FAILURE' as const;
export const UNDERSTANDING_FAILURE_STAGE = 'AFTER_INTERNAL_REGENERATION' as const;
export const DIVERGENCE_SCHEMA_VERSION = 1 as const;
export const DIVERGENCE_REASON_CODE_LIMIT = 16;

const BOUNDARY_REASON_CODE_SET = new Set<string>(BOUNDARY_REASON_CODES_V2);

export const RECOVERY_FALLBACK_INTENTS_V2 = [
  'ANSWER_TO_PENDING',
  'INFORMATION_QUESTION',
  'TRANSACTION_REQUEST',
  'OTHER',
] as const satisfies readonly RecoveryFallbackIntentV2[];

export type UnderstandingFailureDivergenceV2 = {
  schemaVersion: typeof DIVERGENCE_SCHEMA_VERSION;
  kind: typeof UNDERSTANDING_FAILURE_KIND;
  stage: typeof UNDERSTANDING_FAILURE_STAGE;
  fallbackIntent: RecoveryFallbackIntentV2;
  primaryReasonCodes: BoundaryReasonCodeV2[];
  regenerationReasonCodes: BoundaryReasonCodeV2[];
  turnReceiptHash: string;
};

export function isBoundaryReasonCodeV2(
  value: unknown
): value is BoundaryReasonCodeV2 {
  return typeof value === 'string' && BOUNDARY_REASON_CODE_SET.has(value);
}

export function isRecoveryFallbackIntentV2(
  value: unknown
): value is RecoveryFallbackIntentV2 {
  return (
    typeof value === 'string' &&
    (RECOVERY_FALLBACK_INTENTS_V2 as readonly string[]).includes(value)
  );
}

export function closedReasonCodesV2(
  codes: readonly unknown[]
): BoundaryReasonCodeV2[] {
  const unique: BoundaryReasonCodeV2[] = [];
  const seen = new Set<BoundaryReasonCodeV2>();
  for (const code of codes) {
    if (!isBoundaryReasonCodeV2(code) || seen.has(code)) continue;
    seen.add(code);
    unique.push(code);
    if (unique.length >= DIVERGENCE_REASON_CODE_LIMIT) break;
  }
  return unique;
}

const TURN_RECEIPT_HASH_RE = /^[a-f0-9]{64}$/;

export function isTurnReceiptHashV2(value: unknown): value is string {
  return typeof value === 'string' && TURN_RECEIPT_HASH_RE.test(value);
}

export function buildUnderstandingFailureDivergenceV2(input: {
  fallbackIntent: RecoveryFallbackIntentV2;
  primaryReasonCodes: readonly unknown[];
  regenerationReasonCodes: readonly unknown[];
  turnReceiptHash: string;
}): UnderstandingFailureDivergenceV2 {
  if (!isTurnReceiptHashV2(input.turnReceiptHash)) {
    throw new Error('turnReceiptHash da divergência deve ser SHA-256 hex.');
  }
  return {
    schemaVersion: DIVERGENCE_SCHEMA_VERSION,
    kind: UNDERSTANDING_FAILURE_KIND,
    stage: UNDERSTANDING_FAILURE_STAGE,
    fallbackIntent: input.fallbackIntent,
    primaryReasonCodes: closedReasonCodesV2(input.primaryReasonCodes),
    regenerationReasonCodes: closedReasonCodesV2(input.regenerationReasonCodes),
    turnReceiptHash: input.turnReceiptHash,
  };
}
