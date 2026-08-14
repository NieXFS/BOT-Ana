import { createHash } from 'crypto';
import type {
  PendingTransitionCandidate,
  RedactedPendingTransitionCandidateV2,
  TurnDeliveryReceiptV2,
  TurnPlanReceiptV2,
} from './contracts';

export interface ReceiptRedactionContextV2 {
  forbiddenCatalogEntityIds?: readonly string[];
  forbiddenPlaintextFragments?: readonly string[];
  forbiddenMessageIds?: readonly string[];
  forbiddenPhoneValues?: readonly string[];
}

export function opaqueReceiptHashV2(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function redactPendingTransitionCandidateV2(
  candidate: PendingTransitionCandidate
): RedactedPendingTransitionCandidateV2 {
  switch (candidate.kind) {
    case 'preserve':
      return { kind: 'preserve' };
    case 'resolve':
      return {
        kind: 'resolve',
        questionIdHash: opaqueReceiptHashV2(candidate.questionId),
      };
    case 'invalidate':
      return {
        kind: 'invalidate',
        questionIdHash: opaqueReceiptHashV2(candidate.questionId),
        reasonCodeHash: opaqueReceiptHashV2(candidate.reason),
      };
    case 'open':
      return {
        kind: 'open',
        pendingKind: candidate.pendingKind,
        flowIdHash: opaqueReceiptHashV2(candidate.flowId),
        optionCount: candidate.optionEntityIds.length,
      };
  }
}

const FORBIDDEN_KEY_FRAGMENT_RE =
  /(?:text|content|message|reply|payload|phone|displayname|entityid|args|arguments|toolresult|wamid)/i;
const PHONE_VALUE_RE = /(?:^|\D)\+?\d{10,15}(?:\D|$)/u;
const WAMID_VALUE_RE = /\bwamid\b|wamid\./iu;

function assertRedactedValue(
  value: unknown,
  path: string,
  context: ReceiptRedactionContextV2,
  seen: Set<object>
): void {
  if (typeof value === 'string') {
    const leaf = path.split('.').at(-1) ?? '';
    const hashField = /hash$/i.test(leaf);
    const hashLike = hashField && /^[a-f0-9]{64}$/i.test(value);
    if (hashField && !hashLike) {
      throw new Error(`Receipt v2 contém hash fora do formato SHA-256 em ${path}.`);
    }
    if (!hashLike && (PHONE_VALUE_RE.test(value) || WAMID_VALUE_RE.test(value))) {
      throw new Error(`Receipt v2 contém identificador de mensagem/telefone em ${path}.`);
    }
    if (
      context.forbiddenCatalogEntityIds?.some(
        (entityId) => entityId.length > 0 && value.includes(entityId)
      )
    ) {
      throw new Error(`Receipt v2 contém entityId de catálogo em ${path}.`);
    }
    const forbiddenSensitiveValues = [
      ...(context.forbiddenPlaintextFragments ?? []),
      ...(context.forbiddenMessageIds ?? []),
      ...(context.forbiddenPhoneValues ?? []),
    ].filter((entry) => entry.trim().length >= 3);
    if (
      !hashLike &&
      forbiddenSensitiveValues.some((entry) => value.includes(entry))
    ) {
      throw new Error(`Receipt v2 contém valor sensível em ${path}.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Receipt v2 contém ciclo em ${path}.`);
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertRedactedValue(entry, `${path}[${index}]`, context, seen)
    );
    seen.delete(value);
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryPath = `${path}.${key}`;
    if (
      /hash$/i.test(key) &&
      (typeof entry !== 'string' || !/^[a-f0-9]{64}$/i.test(entry))
    ) {
      throw new Error(`Receipt v2 contém hash fora do formato SHA-256 em ${entryPath}.`);
    }
    const allowedHashedMessageId = key === 'providerMessageIdHash';
    if (FORBIDDEN_KEY_FRAGMENT_RE.test(key) && !allowedHashedMessageId) {
      throw new Error(`Receipt v2 contém campo proibido em ${entryPath}.`);
    }
    if (/result/i.test(key)) {
      // O único `result` normativo é o resultado terminal do plano. Resultados
      // de tool continuam proibidos em qualquer objeto aninhado.
      if (!(key === 'result' && path === '$')) {
        throw new Error(`Receipt v2 contém campo proibido em ${entryPath}.`);
      }
    }
    assertRedactedValue(entry, entryPath, context, seen);
  }
  seen.delete(value);
}

export function assertReceiptRedactedV2(
  receipt: TurnPlanReceiptV2 | TurnDeliveryReceiptV2,
  context: ReceiptRedactionContextV2 = {}
): void {
  assertRedactedValue(receipt, '$', context, new Set<object>());
}

export function serializeTurnPlanReceiptV2(
  receipt: TurnPlanReceiptV2,
  context: ReceiptRedactionContextV2 = {}
): string {
  if (receipt.schemaVersion !== 2 || receipt.result !== 'accepted_for_delivery') {
    throw new Error('TurnPlanReceiptV2 inválido.');
  }
  assertReceiptRedactedV2(receipt, context);
  return JSON.stringify(receipt);
}

export function serializeTurnDeliveryReceiptV2(
  receipt: TurnDeliveryReceiptV2,
  context: ReceiptRedactionContextV2 = {}
): string {
  if (receipt.schemaVersion !== 2) {
    throw new Error('TurnDeliveryReceiptV2 inválido.');
  }
  if (receipt.transportOutcome === 'superseded' && !receipt.successorTurnId?.trim()) {
    throw new Error('Entrega superseded exige successorTurnId duravelmente persistido.');
  }
  assertReceiptRedactedV2(receipt, context);
  return JSON.stringify(receipt);
}
