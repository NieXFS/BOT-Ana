import {
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from './botDefaults';
import { ERP_API_TOKEN } from './erpApiToken';
import {
  normalizeBookingMenuPayload,
  normalizePostBookingInstructionsPayload,
  normalizeStructuredPreferencesPayload,
} from './services/structuredPreferences';
import type {
  BookingMenuItem,
  PostBookingInstruction,
  StructuredLocationPolicy,
  StructuredPreferencesConfig,
} from './services/structuredPreferences';
import type { AuthoritativeOutboundCatalog } from './services/receptionistOutbound';
import type { DescriptionTermAcceptanceV2 } from './services/licensedServiceDescription';
import {
  observeTechnicalMaintenance,
  parseTechnicalMaintenanceSnapshot,
} from './services/technicalMaintenanceCache';

export type {
  BookingMenuItem,
  PostBookingInstruction,
  StructuredLocationPolicy,
  StructuredPreferencesConfig,
} from './services/structuredPreferences';

export type TenantDirectionsMode = StructuredLocationPolicy;

export interface TenantBusinessAddress {
  full: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

const DIRECTIONS_MODES = new Set<TenantDirectionsMode>([
  'ENDERECO_COMPLETO',
  'SO_CIDADE',
  'APOS_CONFIRMACAO',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableAddressField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Espelha o shape aditivo do ERP: ausente = runtime velho; presente pode ter nulls. */
export function normalizeBusinessAddressPayload(
  value: unknown
): TenantBusinessAddress | undefined {
  if (!isRecord(value)) return undefined;
  return {
    full: nullableAddressField(value.full),
    city: nullableAddressField(value.city),
    state: nullableAddressField(value.state),
    zipCode: nullableAddressField(value.zipCode),
  };
}

export function parseDirectionsModePayload(
  value: unknown
): TenantDirectionsMode | undefined {
  return typeof value === 'string' &&
    DIRECTIONS_MODES.has(value as TenantDirectionsMode)
    ? (value as TenantDirectionsMode)
    : undefined;
}

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_CONFIG_RETRY_TTL_MS = 30 * 1000;
export const MAX_AUTHORITATIVELY_REJECTED_CONFIGS = 1_000;

interface CachedConfig {
  data: TenantBotConfig;
  expiresAt: number;
  source: 'erp' | 'legacy';
}

const configCache = new Map<string, CachedConfig>();

export class BoundedLruSet<T> {
  private readonly entries = new Map<T, true>();

  constructor(readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error('BoundedLruSet maxSize deve ser um inteiro positivo.');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  add(value: T): this {
    this.entries.delete(value);
    this.entries.set(value, true);

    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    return this;
  }

  has(value: T): boolean {
    if (!this.entries.has(value)) return false;
    // Leitura também renova a recência; o bloqueio continua com a mesma
    // semântica, mas entradas rejeitadas que seguem ativas vencem a evicção.
    this.entries.delete(value);
    this.entries.set(value, true);
    return true;
  }

  delete(value: T): boolean {
    return this.entries.delete(value);
  }

  clear(): void {
    this.entries.clear();
  }
}

// Um 4xx/3xx do endpoint é autoritativo: a configuração não pode ser
// ressuscitada por cache stale nem pelo fallback legado numa falha posterior.
// Uma resposta 2xx futura remove o bloqueio. O LRU só limita a memória do
// processo; dentro do teto, a semântica autoritativa permanece idêntica.
const authoritativelyRejectedConfigs = new BoundedLruSet<string>(
  MAX_AUTHORITATIVELY_REJECTED_CONFIGS
);

export interface TenantBotConfig {
  contractVersion?: number;
  tenantSlug: string;
  botName: string;
  // Papel do brain (brain registry): "receptionist" (default, caminho atual) |
  // "sales" (Renata). Tenants antigos (payload sem o campo) → "receptionist".
  botRole: string;
  systemPrompt: string;
  greetingMessage: string | null;
  fallbackMessage: string | null;
  // Provider de IA: "openai" (default) | "deepseek" (Ana) | "anthropic"
  // (Renata). Payload sem o campo (ERP antigo) → "openai".
  aiProvider: string;
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  openaiApiKey: string | null;
  botIsAlwaysActive: boolean;
  botActiveStart: string;
  botActiveEnd: string;
  timezone: string;
  waAccessToken: string;
  waApiVersion: string;
  phoneNumberId: string;
  isActive: boolean;
  structuredConfig?: StructuredPreferencesConfig;
  bookingMenu?: BookingMenuItem[];
  postBookingInstructions?: PostBookingInstruction[];
  authoritativeCatalog?: AuthoritativeOutboundCatalog;
  descriptionTermAcceptance?: DescriptionTermAcceptanceV2 | null;
  escalationResponsibleName?: string | null;
  /**
   * Modo do card "Como chegar". Só preenchido quando o payload traz um enum
   * válido (`structuredConfig.directionsMode` ou `directionsMode` no topo).
   * Ausente/desconhecido é conservador no runtime de endereço (cidade/estado).
   */
  directionsMode?: TenantDirectionsMode;
  /** Contrato aditivo ERP-1. Parse preserva objeto todo-null; o runtime só arma com full/city. */
  businessAddress?: TenantBusinessAddress;
  technicalMaintenance?: {
    enabled: boolean;
    paused: boolean;
    exempt: boolean;
    exemptTenantId?: string | null;
    version?: number;
  };
}

function parseNumber(
  value: string | undefined,
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function getLegacyConfig(phoneNumberId: string): TenantBotConfig | null {
  const legacyPhoneNumberId = process.env.WA_PHONE_NUMBER_ID?.trim();
  const legacyAccessToken = process.env.WA_ACCESS_TOKEN?.trim();

  if (!legacyPhoneNumberId || !legacyAccessToken) {
    return null;
  }

  if (phoneNumberId && phoneNumberId !== legacyPhoneNumberId) {
    return null;
  }

  const aiProvider = (process.env.AI_PROVIDER ?? 'openai').trim().toLowerCase();
  const aiModel =
    aiProvider === 'deepseek'
      ? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
      : aiProvider === 'luna'
        ? 'gpt-5.6-luna'
      : process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  return {
    tenantSlug: process.env.ERP_TENANT_SLUG ?? 'clinica-bella',
    botName: process.env.BOT_NAME ?? DEFAULT_BOT_NAME,
    botRole: 'receptionist',
    systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT,
    greetingMessage: process.env.GREETING_MESSAGE ?? DEFAULT_GREETING_MESSAGE,
    fallbackMessage: process.env.FALLBACK_MESSAGE ?? DEFAULT_FALLBACK_MESSAGE,
    aiProvider,
    aiModel,
    aiTemperature: parseNumber(process.env.OPENAI_TEMPERATURE, 0.4),
    aiMaxTokens: parseNumber(process.env.OPENAI_MAX_TOKENS, 500),
    openaiApiKey: null,
    botIsAlwaysActive: parseBoolean(process.env.BOT_IS_ALWAYS_ACTIVE),
    botActiveStart: process.env.BOT_ACTIVE_START ?? '08:00',
    botActiveEnd: process.env.BOT_ACTIVE_END ?? '20:00',
    timezone: process.env.TIMEZONE ?? 'America/Sao_Paulo',
    waAccessToken: legacyAccessToken,
    waApiVersion: process.env.WA_API_VERSION ?? 'v21.0',
    phoneNumberId: legacyPhoneNumberId,
    isActive: true,
  };
}

export async function getTenantConfig(
  phoneNumberId: string
): Promise<TenantBotConfig | null> {
  const cacheKey = phoneNumberId || process.env.WA_PHONE_NUMBER_ID || 'legacy';
  const cached = configCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    const url = new URL('/api/v1/bot/config', ERP_BASE_URL);
    url.searchParams.set('phoneNumberId', phoneNumberId);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
      },
      cache: 'no-store',
    });

    if (response.ok) {
      const raw = (await response.json()) as Partial<TenantBotConfig> & {
        directionsMode?: unknown;
        businessAddress?: unknown;
      };
      // Fallbacks p/ tenants antigos cujo payload não traz os campos novos —
      // receptionist/openai = comportamento atual, 100% intocado.
      const aiProvider = raw.aiProvider ?? 'openai';
      const data: TenantBotConfig = {
        ...(raw as TenantBotConfig),
        botRole: raw.botRole ?? 'receptionist',
        aiProvider,
        aiModel:
          raw.aiModel ??
          (aiProvider === 'deepseek'
            ? 'deepseek-v4-flash'
            : aiProvider === 'luna'
              ? 'gpt-5.6-luna'
              : 'gpt-4o-mini'),
        contractVersion:
          typeof raw.contractVersion === 'number' ? raw.contractVersion : undefined,
        structuredConfig: normalizeStructuredPreferencesPayload(
          raw.structuredConfig && typeof raw.structuredConfig === 'object'
            ? {
                ...(raw.structuredConfig as unknown as Record<string, unknown>),
                directionsMode:
                  (raw.structuredConfig as unknown as Record<string, unknown>)
                    .directionsMode ?? raw.directionsMode,
              }
            : raw.structuredConfig
        ),
        bookingMenu: normalizeBookingMenuPayload(raw.bookingMenu),
        postBookingInstructions: normalizePostBookingInstructionsPayload(
          raw.postBookingInstructions
        ),
        directionsMode: parseDirectionsModePayload(
          (raw.structuredConfig && typeof raw.structuredConfig === 'object'
            ? (raw.structuredConfig as unknown as Record<string, unknown>)
                .directionsMode
            : undefined) ?? raw.directionsMode
        ),
        businessAddress: normalizeBusinessAddressPayload(raw.businessAddress),
        authoritativeCatalog:
          raw.authoritativeCatalog && typeof raw.authoritativeCatalog === 'object'
            ? raw.authoritativeCatalog
            : undefined,
        descriptionTermAcceptance:
          raw.descriptionTermAcceptance &&
          typeof raw.descriptionTermAcceptance === 'object'
            ? raw.descriptionTermAcceptance
            : null,
        escalationResponsibleName:
          typeof raw.escalationResponsibleName === 'string'
            ? raw.escalationResponsibleName
            : null,
        technicalMaintenance:
          parseTechnicalMaintenanceSnapshot(raw.technicalMaintenance) ??
          undefined,
      };
      observeTechnicalMaintenance({
        phoneNumberId: data.phoneNumberId,
        snapshot: data.technicalMaintenance,
        tenantSlug: data.tenantSlug,
      });
      configCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
        source: 'erp',
      });
      authoritativelyRejectedConfigs.delete(cacheKey);
      return data;
    }

    const transientFailure =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    console.warn(
      `⚠️ Config multi-tenant indisponível (HTTP ${response.status}).`
    );

    if (!transientFailure) {
      configCache.delete(cacheKey);
      authoritativelyRejectedConfigs.add(cacheKey);
      return null;
    }

    if (cached?.source === 'erp') {
      configCache.set(cacheKey, {
        ...cached,
        expiresAt: Date.now() + STALE_CONFIG_RETRY_TTL_MS,
      });
      return cached.data;
    }
  } catch (error) {
    console.warn(
      `⚠️ Não foi possível buscar a config multi-tenant no ERP (${
        error instanceof Error ? error.name : 'erro desconhecido'
      }).`
    );

    if (cached?.source === 'erp') {
      // Preserva exatamente provider/modelo já conhecidos. Nunca cai no
      // legado/OpenAI durante uma indisponibilidade transitória do Receps.
      configCache.set(cacheKey, {
        ...cached,
        expiresAt: Date.now() + STALE_CONFIG_RETRY_TTL_MS,
      });
      return cached.data;
    }
  }

  if (authoritativelyRejectedConfigs.has(cacheKey)) {
    return null;
  }

  const legacyConfig = getLegacyConfig(phoneNumberId);

  if (legacyConfig) {
    configCache.set(cacheKey, {
      data: legacyConfig,
      expiresAt: Date.now() + CACHE_TTL_MS,
      source: 'legacy',
    });
  }

  return legacyConfig;
}

export function peekCachedTenantSlug(phoneNumberId: string): string | null {
  const cacheKey = phoneNumberId || process.env.WA_PHONE_NUMBER_ID || 'legacy';
  return configCache.get(cacheKey)?.data.tenantSlug ?? null;
}

export function __resetTenantConfigCacheForTest(): void {
  configCache.clear();
  authoritativelyRejectedConfigs.clear();
}
