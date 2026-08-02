import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { TenantBotConfig } from '../configProvider';
import {
  assertDeepSeekProductionApproved,
  DEEPSEEK_V4_FLASH_MODEL,
} from './receptionistLlmProvider';

export const DEEPSEEK_ANTHROPIC_BASE_URL =
  'https://api.deepseek.com/anthropic';
export const CLAUDE_SONNET_5_MODEL = 'claude-sonnet-5';
export const SONNET_SALES_MIN_MAX_TOKENS = 1200;

export type SalesAiProvider = 'anthropic' | 'deepseek';
export type SalesThinkingMode = 'production-default' | 'disabled';

export interface SalesAiRuntime {
  provider: SalesAiProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
}

const clientCache = new Map<string, Anthropic>();

function requireModel(config: TenantBotConfig): string {
  const model = config.aiModel?.trim();
  if (!model) throw new Error('Modelo de IA não configurado para a Renata.');
  return model;
}

/**
 * Registry do brain de vendas. Não existe fallback cruzado: provider, modelo e
 * credencial precisam casar, ou a conversa falha fechada e entra no recovery.
 */
export function resolveSalesAiRuntime(
  config: TenantBotConfig
): SalesAiRuntime {
  const provider = (config.aiProvider ?? '').trim().toLowerCase();
  const model = requireModel(config);

  if (provider === 'anthropic') {
    if (model !== CLAUDE_SONNET_5_MODEL) {
      throw new Error(
        `Configuração incompatível: provider anthropic exige ${CLAUDE_SONNET_5_MODEL}.`
      );
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY não configurada — necessária para o brain de vendas.'
      );
    }
    return { provider: 'anthropic', model, apiKey };
  }

  if (provider === 'deepseek') {
    assertDeepSeekProductionApproved();
    if (model !== DEEPSEEK_V4_FLASH_MODEL) {
      throw new Error(
        `Configuração incompatível: provider deepseek exige ${DEEPSEEK_V4_FLASH_MODEL}.`
      );
    }
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY não configurada no ambiente da Ana.');
    }
    return {
      provider: 'deepseek',
      model,
      apiKey,
      baseURL: DEEPSEEK_ANTHROPIC_BASE_URL,
    };
  }

  throw new Error(
    `Provider de IA não suportado para a Renata: ${provider || '(vazio)'}.`
  );
}

function cacheKey(runtime: SalesAiRuntime): string {
  return createHash('sha256')
    .update(runtime.provider)
    .update('\0')
    .update(runtime.baseURL ?? '')
    .update('\0')
    .update(runtime.apiKey)
    .digest('hex');
}

export function getSalesAiClient(runtime: SalesAiRuntime): Anthropic {
  const key = cacheKey(runtime);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = new Anthropic({
    apiKey: runtime.apiKey,
    ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}),
  });
  clientCache.set(key, client);
  return client;
}

export function buildSalesMessageRequest(input: {
  runtime: SalesAiRuntime;
  maxTokens: number;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  thinkingMode?: SalesThinkingMode;
}): Anthropic.MessageCreateParamsNonStreaming {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: input.runtime.model,
    max_tokens: resolveSalesMaxTokens(
      input.runtime.provider,
      input.maxTokens
    ),
    system: input.system,
    tools: input.tools,
    messages: input.messages,
  };

  const thinkingMode =
    input.thinkingMode ??
    (input.runtime.provider === 'deepseek'
      ? 'disabled'
      : 'production-default');
  if (thinkingMode === 'disabled') {
    request.thinking = { type: 'disabled' };
  }
  return request;
}

/**
 * O Sonnet com thinking adaptativo pode consumir um budget curto inteiro antes
 * de produzir texto. O piso vale apenas para Anthropic; o DeepSeek rápido
 * preserva o budget configurado. Cobrança continua sendo por tokens usados.
 */
export function resolveSalesMaxTokens(
  provider: SalesAiProvider,
  configured: number
): number {
  const sanitized = Number.isFinite(configured)
    ? Math.max(Math.round(configured), 100)
    : 500;
  return provider === 'anthropic'
    ? Math.max(sanitized, SONNET_SALES_MIN_MAX_TOKENS)
    : sanitized;
}

export function __resetSalesAiClientCacheForTest(): void {
  clientCache.clear();
}
