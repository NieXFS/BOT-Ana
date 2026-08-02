process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import {
  buildSalesMessageRequest,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  resolveSalesMaxTokens,
  resolveSalesAiRuntime,
  SONNET_SALES_MIN_MAX_TOKENS,
} from '../src/services/salesLlmProvider';

const originalAnthropic = process.env.ANTHROPIC_API_KEY;
const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
const originalApproval = process.env.DEEPSEEK_PRODUCTION_APPROVED;
const originalNodeEnv = process.env.NODE_ENV;

function config(
  overrides: Partial<TenantBotConfig> = {}
): TenantBotConfig {
  return {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'Persona.',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.5,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'synthetic',
    waApiVersion: 'v21.0',
    phoneNumberId: 'synthetic',
    isActive: true,
    ...overrides,
  };
}

function restore(): void {
  if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  if (originalDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalDeepSeek;
  if (originalApproval === undefined)
    delete process.env.DEEPSEEK_PRODUCTION_APPROVED;
  else process.env.DEEPSEEK_PRODUCTION_APPROVED = originalApproval;
  process.env.NODE_ENV = originalNodeEnv;
}

try {
  process.env.ANTHROPIC_API_KEY = 'anthropic-smoke';
  process.env.DEEPSEEK_API_KEY = 'deepseek-smoke';

  console.log('▶ registry sem fallback cruzado');
  const anthropic = resolveSalesAiRuntime(config());
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.model, 'claude-sonnet-5');
  console.log('  ✓ Anthropic resolvido');

  const deepseek = resolveSalesAiRuntime(
    config({ aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash' })
  );
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.baseURL, DEEPSEEK_ANTHROPIC_BASE_URL);
  console.log('  ✓ DeepSeek usa endpoint Anthropic compatível');

  assert.throws(
    () =>
      resolveSalesAiRuntime(
        config({ aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash-20260802' })
      ),
    /exige deepseek-v4-flash/
  );
  console.log('  ✓ registry fechado não inventa ID versionado ausente na API');

  assert.throws(
    () =>
      resolveSalesAiRuntime(
        config({ aiProvider: 'anthropic', aiModel: 'deepseek-v4-flash' })
      ),
    /incompatível/
  );
  assert.throws(
    () =>
      resolveSalesAiRuntime(
        config({ aiProvider: 'deepseek', aiModel: 'claude-sonnet-5' })
      ),
    /incompatível/
  );
  console.log('  ✓ combinações cruzadas falham fechadas');

  const base = {
    maxTokens: 500,
    system: [{ type: 'text' as const, text: 'system' }],
    tools: [],
    messages: [{ role: 'user' as const, content: 'oi' }],
  };
  const anthropicRequest = buildSalesMessageRequest({
    runtime: anthropic,
    ...base,
  });
  assert.equal('thinking' in anthropicRequest, false);
  assert.equal(
    anthropicRequest.max_tokens,
    SONNET_SALES_MIN_MAX_TOKENS
  );
  const deepseekRequest = buildSalesMessageRequest({
    runtime: deepseek,
    ...base,
  });
  assert.deepEqual(deepseekRequest.thinking, { type: 'disabled' });
  assert.equal(deepseekRequest.max_tokens, 500);
  const retryRequest = buildSalesMessageRequest({
    runtime: anthropic,
    ...base,
    thinkingMode: 'disabled',
  });
  assert.deepEqual(retryRequest.thinking, { type: 'disabled' });
  assert.equal(resolveSalesMaxTokens('deepseek', Number.NaN), 500);
  console.log(
    '  ✓ Sonnet ganha budget anti-thinking-only; DeepSeek e retry desligam thinking'
  );

  process.env.NODE_ENV = 'production';
  delete process.env.DEEPSEEK_PRODUCTION_APPROVED;
  assert.throws(
    () =>
      resolveSalesAiRuntime(
        config({ aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash' })
      ),
    /DEEPSEEK_PRODUCTION_APPROVED/
  );
  process.env.DEEPSEEK_PRODUCTION_APPROVED = 'true';
  assert.equal(
    resolveSalesAiRuntime(
      config({ aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash' })
    ).provider,
    'deepseek'
  );
  console.log('  ✓ gate de governança continua obrigatório em produção');

  console.log('\n✅ smoke-sales-provider OK');
} finally {
  restore();
}
