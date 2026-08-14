import { canonicalConversationKey } from './conversationOrder';

export interface EscalationSnapshot {
  active: boolean;
  questionId: string | null;
  version: number;
}

interface CachedEscalation extends EscalationSnapshot {
  refreshAfter: number;
}

const ESCALATION_REFRESH_MS = 25_000;
const escalationCache = new Map<string, CachedEscalation>();

function normalizeVersion(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function parseEscalationSnapshot(value: unknown): EscalationSnapshot {
  if (!value || typeof value !== 'object') {
    return { active: false, questionId: null, version: 0 };
  }
  const raw = value as {
    active?: unknown;
    questionId?: unknown;
    version?: unknown;
  };
  const active = raw.active === true;
  const questionId =
    active && typeof raw.questionId === 'string' && raw.questionId.trim()
      ? raw.questionId.trim()
      : null;
  return {
    active,
    questionId,
    version: normalizeVersion(raw.version),
  };
}

/**
 * Parser fail-closed do pause-ack. `undefined` é ausência (tratada pelo
 * caller). Qualquer valor presente — null, primitivo, array ou objeto com
 * `active`/`questionId`/`version` inválidos ou incompletos — devolve null.
 */
export function parseStrictEscalationSnapshot(
  value: unknown
): EscalationSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(raw, 'active') ||
    !Object.prototype.hasOwnProperty.call(raw, 'questionId') ||
    !Object.prototype.hasOwnProperty.call(raw, 'version')
  ) {
    return null;
  }
  if (raw.active !== true && raw.active !== false) {
    return null;
  }
  if (
    typeof raw.version !== 'number' ||
    !Number.isFinite(raw.version) ||
    raw.version < 0
  ) {
    return null;
  }
  if (raw.active === true) {
    if (typeof raw.questionId !== 'string' || !raw.questionId.trim()) {
      return null;
    }
    return {
      active: true,
      questionId: raw.questionId.trim(),
      version: Math.floor(raw.version),
    };
  }
  if (raw.questionId !== null) {
    return null;
  }
  return {
    active: false,
    questionId: null,
    version: Math.floor(raw.version),
  };
}

/**
 * Atualização versionada vinda de escalate/inbound. Snapshot mais antigo nunca
 * regride o cache. `force` é reservado ao pause-state: por contrato, campo
 * `escalation` AUSENTE significa inactive durante a implantação paralela.
 */
export function updateEscalationCache(
  phoneNumberId: string,
  customerPhone: string,
  snapshot: EscalationSnapshot,
  nowMs: number = Date.now(),
  force = false
): void {
  const key = canonicalConversationKey(phoneNumberId, customerPhone);
  const current = escalationCache.get(key);
  if (!force && current && snapshot.version < current.version) return;
  escalationCache.set(key, {
    ...snapshot,
    refreshAfter: nowMs + ESCALATION_REFRESH_MS,
  });
}

export function updateEscalationFromPauseState(
  phoneNumberId: string,
  customerPhone: string,
  rawEscalation: unknown,
  nowMs: number = Date.now()
): EscalationSnapshot {
  const snapshot = parseEscalationSnapshot(rawEscalation);
  updateEscalationCache(phoneNumberId, customerPhone, snapshot, nowMs, true);
  return snapshot;
}

export function getEscalationSnapshot(
  phoneNumberId: string,
  customerPhone: string
): EscalationSnapshot | null {
  const cached = escalationCache.get(
    canonicalConversationKey(phoneNumberId, customerPhone)
  );
  if (!cached) return null;
  return {
    active: cached.active,
    questionId: cached.questionId,
    version: cached.version,
  };
}

export function isEscalationKnownActive(
  phoneNumberId: string,
  customerPhone: string
): boolean {
  return getEscalationSnapshot(phoneNumberId, customerPhone)?.active === true;
}

export function escalationCacheNeedsRefresh(
  phoneNumberId: string,
  customerPhone: string,
  nowMs: number = Date.now()
): boolean {
  const cached = escalationCache.get(
    canonicalConversationKey(phoneNumberId, customerPhone)
  );
  return !cached || cached.refreshAfter <= nowMs;
}

export function clearEscalationCacheForConversation(
  phoneNumberId: string,
  customerPhone: string
): void {
  escalationCache.delete(canonicalConversationKey(phoneNumberId, customerPhone));
}

export function __resetEscalationCacheForTest(): void {
  escalationCache.clear();
}
