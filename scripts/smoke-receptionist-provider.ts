import assert from 'node:assert/strict';
import OpenAI from 'openai';
import {
  __resetTenantConfigCacheForTest,
  getTenantConfig,
  type TenantBotConfig,
} from '../src/configProvider';
import {
  buildOpaqueConversationUserId,
  buildAnaResumeClassifierRequest,
  buildReceptionistClientOptions,
  buildReceptionistCompletionRequest,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PRODUCTION_APPROVAL_ENV,
  DEEPSEEK_V4_FLASH_MODEL,
  RECEPTIONIST_AI_TIMEOUT_MS,
  resolveReceptionistAiRuntime,
  resolveAnaResumeClassifierRuntime,
} from '../src/services/receptionistLlmProvider';
import { isRetryableAiError } from '../src/utils/openaiRetry';

process.env.OPENAI_API_KEY = 'sk-openai-smoke';
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-smoke';
process.env.NODE_ENV = 'test';
delete process.env[DEEPSEEK_PRODUCTION_APPROVAL_ENV];
process.env.RECEPTIONIST_USER_ID_HMAC_SECRET =
  'smoke-secret-with-at-least-32-characters';

function config(
  overrides: Partial<TenantBotConfig> = {}
): TenantBotConfig {
  return {
    tenantSlug: 'tenant-smoke',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'Prompt suficientemente longo para o smoke do provider.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '08:00',
    botActiveEnd: '20:00',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'wa-smoke',
    waApiVersion: 'v21.0',
    phoneNumberId: 'phone-number-id-smoke',
    isActive: true,
    ...overrides,
  };
}

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'noop',
      parameters: { type: 'object', properties: {} },
    },
  },
];
const messages = [{ role: 'user' as const, content: 'Oi' }];

const openaiRuntime = resolveReceptionistAiRuntime(config());
assert.equal(openaiRuntime.provider, 'openai');
assert.equal(openaiRuntime.model, 'gpt-4o-mini');
assert.equal(openaiRuntime.baseURL, undefined);
assert.equal(openaiRuntime.apiKey, 'sk-openai-smoke');
assert.equal(openaiRuntime.supportsJsonObjectResponseFormat, true);

const openaiRequest = buildReceptionistCompletionRequest(openaiRuntime, {
  messages,
  tools,
  temperature: 0.4,
  maxTokens: 500,
});
assert.equal(openaiRequest.tool_choice, 'auto');
assert.equal(openaiRequest.temperature, 0.4);
assert.equal('thinking' in openaiRequest, false);
assert.equal('response_format' in openaiRequest, false, 'caller v1/texto puro não ganha JSON mode');

const deepseekConfig = config({
  aiProvider: 'deepseek',
  aiModel: DEEPSEEK_V4_FLASH_MODEL,
  // Nunca pode ser reutilizada como chave do DeepSeek.
  openaiApiKey: 'sk-tenant-openai-override',
});
const deepseekRuntime = resolveReceptionistAiRuntime(deepseekConfig);
assert.equal(deepseekRuntime.provider, 'deepseek');
assert.equal(deepseekRuntime.model, DEEPSEEK_V4_FLASH_MODEL);
assert.equal(deepseekRuntime.baseURL, DEEPSEEK_BASE_URL);
assert.equal(deepseekRuntime.apiKey, 'sk-deepseek-smoke');
assert.equal(deepseekRuntime.supportsJsonObjectResponseFormat, true);

const jsonRequest = buildReceptionistCompletionRequest(deepseekRuntime, {
  messages,
  tools: [],
  temperature: 0.2,
  maxTokens: 1_200,
  responseFormat: 'json_object',
});
assert.deepEqual(
  (jsonRequest as unknown as { response_format: unknown }).response_format,
  { type: 'json_object' },
  'response_format JSON é opt-in para completions estruturadas'
);

const deepseekClientOptions = buildReceptionistClientOptions(deepseekRuntime);
assert.equal(deepseekClientOptions.baseURL, DEEPSEEK_BASE_URL);
assert.equal(deepseekClientOptions.maxRetries, 0);
assert.equal(deepseekClientOptions.timeout, RECEPTIONIST_AI_TIMEOUT_MS);

const opaqueUserId = buildOpaqueConversationUserId(
  deepseekConfig,
  '+5511999999999'
);
assert.equal(typeof opaqueUserId, 'string');
assert.match(opaqueUserId, /^[a-f0-9]{64}$/);
assert.equal(opaqueUserId.includes('5511999999999'), false);
assert.equal(opaqueUserId.includes('tenant-smoke'), false);
assert.equal(
  buildOpaqueConversationUserId(deepseekConfig, '+5511999999999'),
  opaqueUserId
);
assert.notEqual(
  buildOpaqueConversationUserId(deepseekConfig, '+5511888888888'),
  opaqueUserId
);

const deepseekRequest = buildReceptionistCompletionRequest(deepseekRuntime, {
  messages,
  tools,
  temperature: 0.4,
  maxTokens: 500,
  userId: opaqueUserId,
});
assert.equal('tool_choice' in deepseekRequest, false);
assert.equal(deepseekRequest.temperature, 0.4);
assert.deepEqual(
  (deepseekRequest as unknown as { thinking: unknown }).thinking,
  { type: 'disabled' }
);
assert.equal(
  (deepseekRequest as unknown as { user_id: string }).user_id,
  opaqueUserId
);

const thinkingRequest = buildReceptionistCompletionRequest(deepseekRuntime, {
  messages,
  tools,
  temperature: 0.4,
  maxTokens: 500,
  thinkingMode: 'enabled',
});
assert.equal('temperature' in thinkingRequest, false);
assert.equal(
  (thinkingRequest as unknown as { reasoning_effort: string }).reasoning_effort,
  'high'
);

process.env.NODE_ENV = 'production';
delete process.env.RECEPTIONIST_USER_ID_HMAC_SECRET;
delete process.env[DEEPSEEK_PRODUCTION_APPROVAL_ENV];
assert.equal(
  buildOpaqueConversationUserId(deepseekConfig, '+5511999999999'),
  undefined
);
assert.throws(
  () => resolveReceptionistAiRuntime(deepseekConfig),
  new RegExp(DEEPSEEK_PRODUCTION_APPROVAL_ENV)
);
assert.throws(
  () =>
    buildReceptionistCompletionRequest(deepseekRuntime, {
      messages,
      tools,
      temperature: 0.4,
      maxTokens: 500,
    }),
  new RegExp(DEEPSEEK_PRODUCTION_APPROVAL_ENV),
  'runtime construído antes do modo production também deve falhar fechado'
);
process.env[DEEPSEEK_PRODUCTION_APPROVAL_ENV] = 'true';
assert.equal(
  resolveReceptionistAiRuntime(deepseekConfig).provider,
  'deepseek',
  'aprovação explícita libera somente o provider já configurado'
);
assert.throws(
  () =>
    buildReceptionistCompletionRequest(deepseekRuntime, {
      messages,
      tools,
      temperature: 0.4,
      maxTokens: 500,
      thinkingMode: 'enabled',
    }),
  /Thinking mode do DeepSeek está bloqueado em produção/
);
const resumeRuntime = resolveAnaResumeClassifierRuntime();
const resumeRequest = buildAnaResumeClassifierRequest(resumeRuntime, {
  messages,
});
assert.equal('tools' in resumeRequest, false);
assert.equal('tool_choice' in resumeRequest, false);
assert.equal('temperature' in resumeRequest, false);
assert.deepEqual(
  (resumeRequest as unknown as { thinking: unknown }).thinking,
  { type: 'enabled' },
  'gate one-shot sem tools pode usar Thinking em produção'
);
assert.deepEqual(
  (resumeRequest as unknown as { response_format: unknown }).response_format,
  { type: 'json_object' }
);
process.env.NODE_ENV = 'test';
delete process.env[DEEPSEEK_PRODUCTION_APPROVAL_ENV];
assert.throws(
  () => buildOpaqueConversationUserId(deepseekConfig, '+5511999999999'),
  /RECEPTIONIST_USER_ID_HMAC_SECRET/
);
process.env.RECEPTIONIST_USER_ID_HMAC_SECRET =
  'smoke-secret-with-at-least-32-characters';

assert.throws(
  () =>
    resolveReceptionistAiRuntime(
      config({ aiProvider: 'deepseek', aiModel: 'gpt-4o-mini' })
    ),
  /exige o modelo deepseek-v4-flash/
);
assert.throws(
  () =>
    resolveReceptionistAiRuntime(
      config({ aiProvider: 'openai', aiModel: DEEPSEEK_V4_FLASH_MODEL })
    ),
  /provider openai/
);
assert.throws(
  () =>
    resolveReceptionistAiRuntime(
      config({ aiProvider: 'provider-inexistente' })
    ),
  /Provider de IA não suportado/
);

const savedDeepSeekKey = process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
assert.throws(
  () => resolveReceptionistAiRuntime(deepseekConfig),
  /DEEPSEEK_API_KEY/
);
process.env.DEEPSEEK_API_KEY = savedDeepSeekKey;

assert.equal(
  isRetryableAiError(new OpenAI.APIConnectionTimeoutError()),
  true
);
assert.equal(
  isRetryableAiError(
    new OpenAI.APIConnectionError({
      cause: Object.assign(new Error('network'), { code: 'ECONNRESET' }),
    })
  ),
  true
);
assert.equal(isRetryableAiError({ cause: { code: 'EAI_AGAIN' } }), true);
assert.equal(isRetryableAiError({ status: 503 }), true);
assert.equal(isRetryableAiError({ status: 401 }), false);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runConfigFallbackChecks(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalWarn = console.warn;
  const savedLegacyPhone = process.env.WA_PHONE_NUMBER_ID;
  const savedLegacyToken = process.env.WA_ACCESS_TOKEN;
  const savedAiProvider = process.env.AI_PROVIDER;
  const savedOpenAiModel = process.env.OPENAI_MODEL;
  let now = Date.parse('2026-07-28T12:00:00.000Z');
  let fetchMode: 'success' | 'network-error' | 'unauthorized' | 'not-found' =
    'success';

  process.env.WA_PHONE_NUMBER_ID = deepseekConfig.phoneNumberId;
  process.env.WA_ACCESS_TOKEN = 'legacy-wa-token';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  Date.now = () => now;
  console.warn = () => undefined;
  globalThis.fetch = (async () => {
    if (fetchMode === 'network-error') {
      throw new Error('simulated network failure');
    }
    if (fetchMode === 'unauthorized') {
      return new Response('{}', { status: 401 });
    }
    if (fetchMode === 'not-found') {
      return new Response('{}', { status: 404 });
    }
    return new Response(JSON.stringify(deepseekConfig), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    __resetTenantConfigCacheForTest();
    const fresh = await getTenantConfig(deepseekConfig.phoneNumberId);
    assert.equal(fresh?.aiProvider, 'deepseek');
    assert.equal(fresh?.aiModel, DEEPSEEK_V4_FLASH_MODEL);

    now += 5 * 60 * 1000 + 1;
    fetchMode = 'network-error';
    const stale = await getTenantConfig(deepseekConfig.phoneNumberId);
    assert.equal(stale?.aiProvider, 'deepseek');
    assert.equal(stale?.aiModel, DEEPSEEK_V4_FLASH_MODEL);

    __resetTenantConfigCacheForTest();
    fetchMode = 'success';
    await getTenantConfig(deepseekConfig.phoneNumberId);
    now += 5 * 60 * 1000 + 1;
    fetchMode = 'unauthorized';
    const rejected = await getTenantConfig(deepseekConfig.phoneNumberId);
    assert.equal(rejected, null);

    fetchMode = 'network-error';
    const cannotResurrectStale = await getTenantConfig(
      deepseekConfig.phoneNumberId
    );
    assert.equal(cannotResurrectStale, null);

    __resetTenantConfigCacheForTest();
    fetchMode = 'not-found';
    const authoritativeColdStart = await getTenantConfig(
      deepseekConfig.phoneNumberId
    );
    assert.equal(authoritativeColdStart, null);

    fetchMode = 'network-error';
    const rejectedStillClosed = await getTenantConfig(
      deepseekConfig.phoneNumberId
    );
    assert.equal(rejectedStillClosed, null);

    __resetTenantConfigCacheForTest();
    fetchMode = 'network-error';
    const legacyOnUnknownColdStart = await getTenantConfig(
      deepseekConfig.phoneNumberId
    );
    assert.equal(legacyOnUnknownColdStart?.aiProvider, 'openai');
    assert.equal(legacyOnUnknownColdStart?.aiModel, 'gpt-4o-mini');
  } finally {
    __resetTenantConfigCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    console.warn = originalWarn;
    restoreEnv('WA_PHONE_NUMBER_ID', savedLegacyPhone);
    restoreEnv('WA_ACCESS_TOKEN', savedLegacyToken);
    restoreEnv('AI_PROVIDER', savedAiProvider);
    restoreEnv('OPENAI_MODEL', savedOpenAiModel);
  }
}

runConfigFallbackChecks()
  .then(() => {
    console.log('✅ smoke receptionist provider: provider, retry and config fail-closed checks');
  })
  .catch((error) => {
    console.error('❌ smoke receptionist provider falhou.');
    console.error(error instanceof Error ? error.message : 'Erro desconhecido.');
    process.exitCode = 1;
  });
