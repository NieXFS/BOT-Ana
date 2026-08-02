import { createHash, createHmac } from 'crypto';
import OpenAI from 'openai';
import type { TenantBotConfig } from '../configProvider';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash';
export const RECEPTIONIST_AI_TIMEOUT_MS = 30_000;
export const DEEPSEEK_PRODUCTION_APPROVAL_ENV =
  'DEEPSEEK_PRODUCTION_APPROVED';
const RECEPTIONIST_USER_ID_HMAC_SECRET_ENV =
  'RECEPTIONIST_USER_ID_HMAC_SECRET';

export type ReceptionistAiProvider = 'openai' | 'deepseek';
export type DeepSeekThinkingMode = 'disabled' | 'enabled';

export interface ReceptionistAiRuntime {
  provider: ReceptionistAiProvider;
  model: string;
  baseURL?: string;
  apiKey: string;
}

export interface ReceptionistCompletionInput {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature: number;
  maxTokens: number;
  /**
   * Identificador opaco e sem PII. No DeepSeek ele isola KV cache, safety e
   * scheduling. Nunca envie telefone, nome ou conversationKey em claro.
   */
  userId?: string;
  /**
   * O A/B de produção começa em non-thinking. "enabled" existe somente para um
   * braço experimental explícito, que precisa preservar reasoning_content.
   */
  thinkingMode?: DeepSeekThinkingMode;
}

type DeepSeekChatCompletionParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  'reasoning_effort'
> & {
    thinking: { type: DeepSeekThinkingMode };
    reasoning_effort?: 'high';
    user_id?: string;
  };

const clientCache = new Map<string, OpenAI>();

function normalizedProvider(value: string | null | undefined): string {
  return (value ?? 'openai').trim().toLowerCase();
}

function requireModel(config: TenantBotConfig): string {
  const model = config.aiModel?.trim();
  if (!model) {
    throw new Error('Modelo de IA não configurado para a Ana.');
  }
  return model;
}

export function assertDeepSeekProductionApproved(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const approved =
    process.env[DEEPSEEK_PRODUCTION_APPROVAL_ENV]?.trim().toLowerCase() ===
    'true';
  if (!approved) {
    throw new Error(
      `DeepSeek bloqueado em produção: ${DEEPSEEK_PRODUCTION_APPROVAL_ENV}=true só pode ser definido após aprovação de governança/LGPD e atualização dos subprocessadores.`
    );
  }
}

/**
 * Resolve provider, modelo e credencial sem fallback cruzado. Se um tenant foi
 * configurado como DeepSeek, uma falha de chave/modelo nunca pode cair
 * silenciosamente na OpenAI e contaminar o experimento.
 */
export function resolveReceptionistAiRuntime(
  config: TenantBotConfig
): ReceptionistAiRuntime {
  const provider = normalizedProvider(config.aiProvider);
  const model = requireModel(config);

  if (provider === 'openai') {
    if (model.startsWith('deepseek-')) {
      throw new Error(
        `Configuração incompatível: provider openai não pode usar o modelo ${model}.`
      );
    }

    const apiKey = config.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY não configurada para o tenant nem no ambiente global.'
      );
    }

    return { provider: 'openai', model, apiKey };
  }

  if (provider === 'deepseek') {
    assertDeepSeekProductionApproved();

    if (model !== DEEPSEEK_V4_FLASH_MODEL) {
      throw new Error(
        `Configuração incompatível: provider deepseek exige o modelo ${DEEPSEEK_V4_FLASH_MODEL}.`
      );
    }

    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY não configurada no ambiente da Ana.');
    }

    return {
      provider: 'deepseek',
      model,
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
    };
  }

  throw new Error(
    `Provider de IA não suportado para a Ana: ${provider || '(vazio)'}.`
  );
}

function clientCacheKey(runtime: ReceptionistAiRuntime): string {
  return createHash('sha256')
    .update(runtime.provider)
    .update('\0')
    .update(runtime.baseURL ?? '')
    .update('\0')
    .update(runtime.apiKey)
    .digest('hex');
}

export function buildReceptionistClientOptions(
  runtime: ReceptionistAiRuntime
): ConstructorParameters<typeof OpenAI>[0] {
  return {
    apiKey: runtime.apiKey,
    ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}),
    // A política de retry é única e provider-aware em callAiWithRetry. Manter
    // o retry interno do SDK multiplicaria tentativas, custo e latência.
    maxRetries: 0,
    timeout: RECEPTIONIST_AI_TIMEOUT_MS,
  };
}

function getClient(runtime: ReceptionistAiRuntime): OpenAI {
  const cacheKey = clientCacheKey(runtime);
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = new OpenAI(buildReceptionistClientOptions(runtime));
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Monta o payload por provider. O DeepSeek V4 liga thinking por default, então
 * o braço principal sempre envia "disabled" explicitamente. tool_choice é
 * omitido no DeepSeek: com tools presentes, auto já é o default oficial.
 */
export function buildReceptionistCompletionRequest(
  runtime: ReceptionistAiRuntime,
  input: ReceptionistCompletionInput
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const base: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: runtime.model,
    messages: input.messages,
    tools: input.tools,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  };

  if (runtime.provider === 'openai') {
    return {
      ...base,
      tool_choice: 'auto',
    };
  }

  // Defesa em profundidade: um runtime DeepSeek construído manualmente ou
  // resolvido antes da inicialização completa do ambiente também não pode
  // montar uma chamada produtiva sem o gate de governança.
  assertDeepSeekProductionApproved();

  const thinkingMode = input.thinkingMode ?? 'disabled';
  if (thinkingMode === 'enabled' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'Thinking mode do DeepSeek está bloqueado em produção até o transcript completo de tool calls ser persistido.'
    );
  }
  const { reasoning_effort: _unusedReasoningEffort, ...deepSeekBase } = base;
  const deepSeekRequest: DeepSeekChatCompletionParams = {
    ...deepSeekBase,
    thinking: { type: thinkingMode },
    ...(input.userId ? { user_id: input.userId } : {}),
  };

  if (thinkingMode === 'enabled') {
    // O DeepSeek ignora temperature em thinking mode. Omitimos para o request
    // representar fielmente o contrato e evitar métricas enganosas.
    delete deepSeekRequest.temperature;
    deepSeekRequest.reasoning_effort = 'high';
  }

  return deepSeekRequest;
}

export async function createReceptionistChatCompletion(
  runtime: ReceptionistAiRuntime,
  input: ReceptionistCompletionInput
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const request = buildReceptionistCompletionRequest(runtime, input);
  return getClient(runtime).chat.completions.create(request);
}

/**
 * Em produção não enviamos user_id derivado do telefone ao provider. Fora de
 * produção, benchmarks/smokes podem pedir um identificador estável, mas somente
 * por HMAC com segredo explícito; hash simples de telefone tem baixa entropia e
 * é enumerável.
 */
export function buildOpaqueConversationUserId(
  config: TenantBotConfig,
  phone: string
): string | undefined {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }

  const secret = process.env[RECEPTIONIST_USER_ID_HMAC_SECRET_ENV]?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      `${RECEPTIONIST_USER_ID_HMAC_SECRET_ENV} deve ter pelo menos 32 caracteres fora de produção.`
    );
  }

  return createHmac('sha256', secret)
    .update(config.tenantSlug)
    .update('\0')
    .update(config.phoneNumberId)
    .update('\0')
    .update(phone)
    .digest('hex');
}

export function __resetReceptionistClientCacheForTest(): void {
  clientCache.clear();
}
