/**
 * Observação sticky do modo técnico da Ana.
 *
 * Depois que o runtime vê `enabled=true` para um tenant não isento, uma
 * falha temporária do ERP NÃO pode reabrir a Ana (fail-closed). O canário
 * Vitin (`studio-viti` / exempt=true) permanece ativo.
 */

export const ANA_TECHNICAL_MAINTENANCE_CANARY_SLUG = 'studio-viti';

export type TechnicalMaintenanceSnapshot = {
  enabled: boolean;
  paused: boolean;
  exempt: boolean;
  exemptTenantId?: string | null;
  version?: number;
};

type PhoneObservation = {
  paused: boolean;
  exempt: boolean;
  tenantSlug: string | null;
};

let globalEnabled = false;
let globalExemptTenantId: string | null = null;
const perPhone = new Map<string, PhoneObservation>();

export function parseTechnicalMaintenanceSnapshot(
  value: unknown
): TechnicalMaintenanceSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean' || typeof raw.paused !== 'boolean') {
    return null;
  }
  return {
    enabled: raw.enabled,
    paused: raw.paused,
    exempt: raw.exempt === true,
    exemptTenantId:
      typeof raw.exemptTenantId === 'string' ? raw.exemptTenantId : null,
    version: typeof raw.version === 'number' ? raw.version : undefined,
  };
}

export function observeTechnicalMaintenance(input: {
  phoneNumberId: string;
  snapshot: TechnicalMaintenanceSnapshot | null | undefined;
  tenantSlug?: string | null;
}): void {
  if (!input.snapshot) return;
  if (input.snapshot.enabled) {
    globalEnabled = true;
    if (input.snapshot.exemptTenantId) {
      globalExemptTenantId = input.snapshot.exemptTenantId;
    }
  } else {
    globalEnabled = false;
  }
  perPhone.set(input.phoneNumberId, {
    paused: input.snapshot.paused,
    exempt: input.snapshot.exempt,
    tenantSlug: input.tenantSlug ?? null,
  });
}

export function shouldFailClosedForTechnicalMaintenance(input: {
  phoneNumberId: string;
  tenantSlug?: string | null;
}): boolean {
  const observed = perPhone.get(input.phoneNumberId);
  if (observed?.exempt) return false;
  if (observed?.paused) return true;
  const slug = input.tenantSlug ?? observed?.tenantSlug;
  if (slug === ANA_TECHNICAL_MAINTENANCE_CANARY_SLUG) return false;
  return globalEnabled;
}

export function __resetTechnicalMaintenanceCacheForTest(): void {
  globalEnabled = false;
  globalExemptTenantId = null;
  perPhone.clear();
}

export function __getTechnicalMaintenanceCacheForTest() {
  return {
    globalEnabled,
    globalExemptTenantId,
    phones: Array.from(perPhone.entries()),
  };
}
