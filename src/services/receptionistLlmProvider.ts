import { createHash, createHmac } from 'crypto';
import OpenAI from 'openai';
import type {
  FunctionTool as ResponsesFunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
} from 'openai/resources/responses/responses';
import type { TenantBotConfig } from '../configProvider';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';
export const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash';
export const OPENAI_LUNA_MODEL = 'gpt-5.6-luna';
export const RECEPTIONIST_AI_TIMEOUT_MS = 30_000;
export const DEEPSEEK_PRODUCTION_APPROVAL_ENV =
  'DEEPSEEK_PRODUCTION_APPROVED';
const RECEPTIONIST_USER_ID_HMAC_SECRET_ENV =
  'RECEPTIONIST_USER_ID_HMAC_SECRET';

export type ReceptionistAiProvider = 'openai' | 'deepseek' | 'luna';
export type DeepSeekThinkingMode = 'disabled' | 'enabled';
export type ReceptionistAiTransport = 'chat_completions' | 'responses';

export interface ReceptionistAiRuntime {
  provider: ReceptionistAiProvider;
  model: string;
  baseURL?: string;
  apiKey: string;
  transport: ReceptionistAiTransport;
  /** Capability explícita; callers de texto puro continuam sem opt-in. */
  supportsJsonObjectResponseFormat: boolean;
  /** Capability explícita; só o DeepSeek troca para /beta quando há tools strict. */
  supportsStrictTools: boolean;
  strictToolsUseBetaEndpoint: boolean;
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
  /** Opt-in estrutural para completions JSON one-shot; nunca usado no social. */
  responseFormat?: 'json_object';
}

export interface AnaResumeClassifierCompletionInput {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  maxTokens?: number;
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

    return {
      provider: 'openai',
      model,
      apiKey,
      transport: 'chat_completions',
      supportsJsonObjectResponseFormat: true,
      supportsStrictTools: true,
      strictToolsUseBetaEndpoint: false,
    };
  }

  if (provider === 'luna') {
    const configuredModel = model || OPENAI_LUNA_MODEL;
    if (configuredModel !== OPENAI_LUNA_MODEL) {
      throw new Error(
        `Configuração incompatível: provider luna exige o modelo ${OPENAI_LUNA_MODEL}.`
      );
    }
    const apiKey =
      process.env.OPENAI_API_KEY_LUNA?.trim() ||
      config.openaiApiKey?.trim() ||
      process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY_LUNA não configurada para o braço Luna.');
    }
    return {
      provider: 'luna',
      model: configuredModel,
      apiKey,
      transport: 'responses',
      supportsJsonObjectResponseFormat: true,
      supportsStrictTools: true,
      strictToolsUseBetaEndpoint: false,
    };
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
      transport: 'chat_completions',
      supportsJsonObjectResponseFormat: true,
      supportsStrictTools: true,
      strictToolsUseBetaEndpoint: true,
    };
  }

  throw new Error(
    `Provider de IA não suportado para a Ana: ${provider || '(vazio)'}.`
  );
}

/** Provider fixo do gate de retomada, independente do motor principal do tenant. */
export function resolveAnaResumeClassifierRuntime(): ReceptionistAiRuntime {
  assertDeepSeekProductionApproved();
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY não configurada para o gate de retomada.');
  }
  return {
    provider: 'deepseek',
    model: DEEPSEEK_V4_FLASH_MODEL,
    baseURL: DEEPSEEK_BASE_URL,
    apiKey,
    transport: 'chat_completions',
    supportsJsonObjectResponseFormat: true,
    supportsStrictTools: false,
    strictToolsUseBetaEndpoint: false,
  };
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

function strictToolsEnabled(
  runtime: ReceptionistAiRuntime,
  tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[]
): boolean {
  return (
    runtime.supportsStrictTools &&
    tools.length > 0 &&
    tools.every((tool) => tool.function.strict === true)
  );
}

export function runtimeForStrictToolEndpoint(
  runtime: ReceptionistAiRuntime,
  tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[]
): ReceptionistAiRuntime {
  if (
    runtime.provider !== 'deepseek' ||
    !runtime.strictToolsUseBetaEndpoint ||
    !strictToolsEnabled(runtime, tools)
  ) {
    return runtime;
  }
  return { ...runtime, baseURL: DEEPSEEK_BETA_BASE_URL };
}

export class StrictToolSchemaError extends Error {
  readonly status = 400;
  readonly code = 'STRICT_TOOL_SCHEMA_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StrictToolSchemaError';
  }
}

function schemaTypeIncludesNull(value: unknown): boolean {
  return Array.isArray(value) && value.includes('null');
}

/** Validação local equivalente ao fail-fast 400 do endpoint strict. */
export function assertStrictToolSchemas(
  tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[]
): void {
  for (const tool of tools) {
    const fn = tool.function;
    const schema = fn.parameters as {
      type?: unknown;
      properties?: unknown;
      required?: unknown;
      additionalProperties?: unknown;
    };
    if (fn.strict !== true) {
      throw new StrictToolSchemaError(`${fn.name}: strict deve ser true.`);
    }
    if (
      schema?.type !== 'object' ||
      !schema.properties ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties) ||
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required)
    ) {
      throw new StrictToolSchemaError(
        `${fn.name}: schema strict exige object, required e additionalProperties:false.`
      );
    }
    const required = schema.required as string[];
    const propertyNames = Object.keys(schema.properties as Record<string, unknown>);
    if (
      propertyNames.length !== required.length ||
      propertyNames.some((name) => !required.includes(name))
    ) {
      throw new StrictToolSchemaError(
        `${fn.name}: required deve conter todas as propriedades.`
      );
    }
    const inspect = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'minLength' || key === 'maxItems') {
          throw new StrictToolSchemaError(`${fn.name}: ${path}.${key} não permitido.`);
        }
        inspect(child, `${path}.${key}`);
      }
    };
    inspect(schema, '$');

    for (const [name, property] of Object.entries(
      schema.properties as Record<string, { type?: unknown }>
    )) {
      if (
        required.includes(name) &&
        (name === 'professionalId' || name === 'confirmedDuplicate') &&
        !schemaTypeIncludesNull(property.type)
      ) {
        throw new StrictToolSchemaError(
          `${fn.name}.${name}: propriedade opcional required-all deve aceitar null.`
        );
      }
    }
  }
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
  if (runtime.transport !== 'chat_completions') {
    throw new Error('Runtime Responses não pode montar payload Chat Completions.');
  }
  if (strictToolsEnabled(runtime, input.tools)) {
    assertStrictToolSchemas(input.tools);
  }
  const base: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: runtime.model,
    messages: input.messages,
    tools: input.tools,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    ...(input.responseFormat === 'json_object'
      ? { response_format: { type: 'json_object' as const } }
      : {}),
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

function chatContentAsText(
  content: OpenAI.Chat.Completions.ChatCompletionMessageParam['content']
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const raw = part as { type?: unknown; text?: unknown };
      return raw.type === 'text' && typeof raw.text === 'string' ? raw.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function convertChatMessagesToResponsesInput(
  messages: readonly OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: chatContentAsText(message.content),
      });
      continue;
    }
    if (message.role === 'function') {
      throw new Error('Mensagem function legada não é suportada no adapter Luna.');
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const assistantText = chatContentAsText(message.content);
      if (assistantText.trim()) {
        input.push({ role: 'assistant', content: assistantText });
      }
      for (const call of message.tool_calls) {
        if (call.type !== 'function') continue;
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    const role = message.role;
    if (
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'system' &&
      role !== 'developer'
    ) {
      throw new Error(`Papel não suportado pelo adapter Luna: ${String(role)}.`);
    }
    input.push({ role, content: chatContentAsText(message.content) });
  }
  return input;
}

export function convertChatToolsToResponsesTools(
  tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[]
): ResponsesFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
    strict: tool.function.strict === true,
  }));
}

export function buildLunaResponsesRequest(
  runtime: ReceptionistAiRuntime,
  input: ReceptionistCompletionInput
): ResponseCreateParamsNonStreaming {
  if (runtime.provider !== 'luna' || runtime.transport !== 'responses') {
    throw new Error('Adapter Responses é exclusivo do provider Luna.');
  }
  if (strictToolsEnabled(runtime, input.tools)) {
    assertStrictToolSchemas(input.tools);
  }
  const tools = convertChatToolsToResponsesTools(input.tools);
  return {
    model: runtime.model,
    input: convertChatMessagesToResponsesInput(input.messages),
    ...(tools.length > 0
      ? {
          tools,
          tool_choice: 'auto' as const,
          parallel_tool_calls: true,
        }
      : {}),
    max_output_tokens: input.maxTokens,
    store: false,
    ...(input.userId ? { user: input.userId } : {}),
    ...(input.responseFormat === 'json_object'
      ? { text: { format: { type: 'json_object' } } }
      : {}),
  };
}

function responseOutputText(response: OpenAIResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }
  return response.output
    .flatMap((item) =>
      item.type === 'message'
        ? item.content.flatMap((part) =>
            part.type === 'output_text' ? [part.text] : []
          )
        : []
    )
    .join('');
}

/** Normalização semântica Responses -> contrato único consumido pelo loop v1/v2. */
export function normalizeLunaResponseToChatCompletion(
  response: OpenAIResponse
): OpenAI.Chat.Completions.ChatCompletion {
  const functionCalls = response.output.filter(
    (item): item is Extract<OpenAIResponse['output'][number], { type: 'function_call' }> =>
      item.type === 'function_call'
  );
  const text = responseOutputText(response);
  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] =
    response.status === 'incomplete'
      ? response.incomplete_details?.reason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : functionCalls.length > 0
        ? 'tool_calls'
        : 'stop';
  const usage = response.usage;
  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: String(response.model),
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: 'assistant',
          content: text,
          refusal: null,
          ...(functionCalls.length > 0
            ? {
                tool_calls: functionCalls.map((call) => ({
                  id: call.call_id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: call.arguments,
                  },
                })),
              }
            : {}),
        },
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens,
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details.cached_tokens,
            audio_tokens: 0,
          },
          completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
            audio_tokens: 0,
            accepted_prediction_tokens: 0,
            rejected_prediction_tokens: 0,
          },
        }
      : undefined,
  };
}

export async function createReceptionistChatCompletion(
  runtime: ReceptionistAiRuntime,
  input: ReceptionistCompletionInput
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (runtime.transport === 'responses') {
    const response = await getClient(runtime).responses.create(
      buildLunaResponsesRequest(runtime, input)
    );
    return normalizeLunaResponseToChatCompletion(response);
  }
  const request = buildReceptionistCompletionRequest(runtime, input);
  return getClient(runtimeForStrictToolEndpoint(runtime, input.tools))
    .chat.completions.create(request);
}

/**
 * Request dedicado ao gate de retomada. É deliberadamente one-shot, sem tools,
 * sem texto para cliente e com JSON obrigatório. Por não existir um segundo
 * turno/tool-call, `reasoning_content` não precisa ser reenviado nem persistido.
 */
export function buildAnaResumeClassifierRequest(
  runtime: ReceptionistAiRuntime,
  input: AnaResumeClassifierCompletionInput
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  if (runtime.provider !== 'deepseek' || runtime.model !== DEEPSEEK_V4_FLASH_MODEL) {
    throw new Error('O classificador de retomada exige deepseek-v4-flash.');
  }
  assertDeepSeekProductionApproved();

  const request = {
    model: runtime.model,
    messages: input.messages,
    // Thinking consome parte do mesmo budget antes do JSON final. 500 e 1.200
    // tokens ainda produziram respostas reasoning-only no harness; 4.096 é teto,
    // não consumo obrigatório, e deixa o modelo encerrar com o JSON de 2 chaves.
    max_tokens: input.maxTokens ?? 4_096,
    response_format: { type: 'json_object' as const },
    thinking: { type: 'enabled' as const },
  };
  return request as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

export async function createAnaResumeClassifierCompletion(
  runtime: ReceptionistAiRuntime,
  input: AnaResumeClassifierCompletionInput
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  return getClient(runtime).chat.completions.create(
    buildAnaResumeClassifierRequest(runtime, input)
  );
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
