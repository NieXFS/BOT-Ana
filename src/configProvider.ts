import {
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from './botDefaults';

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const ERP_API_TOKEN = process.env.ERP_API_TOKEN ?? 'minha-chave-secreta-receps-123';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedConfig {
  data: TenantBotConfig;
  expiresAt: number;
}

const configCache = new Map<string, CachedConfig>();

export interface TenantBotConfig {
  tenantSlug: string;
  botName: string;
  systemPrompt: string;
  greetingMessage: string | null;
  fallbackMessage: string | null;
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  openaiApiKey: string | null;
  botActiveStart: string;
  botActiveEnd: string;
  timezone: string;
  waAccessToken: string;
  waApiVersion: string;
  phoneNumberId: string;
  isActive: boolean;
}

function parseNumber(
  value: string | undefined,
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  return {
    tenantSlug: process.env.ERP_TENANT_SLUG ?? 'clinica-bella',
    botName: process.env.BOT_NAME ?? DEFAULT_BOT_NAME,
    systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT,
    greetingMessage: process.env.GREETING_MESSAGE ?? DEFAULT_GREETING_MESSAGE,
    fallbackMessage: process.env.FALLBACK_MESSAGE ?? DEFAULT_FALLBACK_MESSAGE,
    aiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    aiTemperature: parseNumber(process.env.OPENAI_TEMPERATURE, 0.7),
    aiMaxTokens: parseNumber(process.env.OPENAI_MAX_TOKENS, 500),
    openaiApiKey: null,
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
      const data = (await response.json()) as TenantBotConfig;
      configCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return data;
    }
  } catch (error) {
    console.warn('⚠️ Não foi possível buscar a config multi-tenant no ERP:', error);
  }

  const legacyConfig = getLegacyConfig(phoneNumberId);

  if (legacyConfig) {
    configCache.set(cacheKey, {
      data: legacyConfig,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  return legacyConfig;
}
