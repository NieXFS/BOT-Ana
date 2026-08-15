import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_luna_protocol';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.OPENAI_API_KEY_LUNA = 'sk-luna-smoke-no-network';
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';

function response(input: {
  outputText?: string;
  output?: Response['output'];
  status?: Response['status'];
  incompleteReason?: 'max_output_tokens' | 'content_filter' | null;
}): Response {
  return {
    id: 'resp_protocol_fixture',
    object: 'response',
    created_at: 1_723_600_000,
    model: 'gpt-5.6-luna',
    output_text: input.outputText ?? '',
    output: input.output ?? [],
    status: input.status ?? 'completed',
    incomplete_details: input.incompleteReason
      ? { reason: input.incompleteReason }
      : null,
    error: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 40,
      output_tokens: 12,
      total_tokens: 52,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  } as Response;
}

function toolCall(callId: string, name: string, args = '{}') {
  return {
    type: 'function_call' as const,
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: args,
    status: 'completed' as const,
  };
}

async function main(): Promise<void> {
  const provider = await import('../src/services/receptionistLlmProvider');
  const brain = await import('../src/services/brainService');
  const runtimeV2 = await import('../src/services/conversationalV2/runtime');

  const text = provider.normalizeLunaResponseToChatCompletion(
    response({ outputText: 'Olá!' })
  );
  assert.equal(text.choices[0]?.message.content, 'Olá!');
  assert.equal(text.choices[0]?.finish_reason, 'stop');
  assert.equal(text.model, 'gpt-5.6-luna');
  assert.equal(text.system_fingerprint, undefined);
  assert.equal(text.usage?.prompt_tokens_details?.cached_tokens, 8);
  assert.equal(text.usage?.completion_tokens_details?.reasoning_tokens, 3);

  const withFingerprint = provider.normalizeLunaResponseToChatCompletion(
    {
      ...response({ outputText: 'Olá!' }),
      system_fingerprint: 'fp_luna_protocol',
    } as Response & { system_fingerprint: string }
  );
  assert.equal(withFingerprint.system_fingerprint, 'fp_luna_protocol');

  const fromMetadata = provider.normalizeLunaResponseToChatCompletion(
    {
      ...response({ outputText: 'Olá!' }),
      metadata: { system_fingerprint: 'fp_luna_meta' },
    } as Response
  );
  assert.equal(fromMetadata.system_fingerprint, 'fp_luna_meta');
  const echoAbsent = provider.providerResponseEchoV2(
    response({ outputText: 'Olá!' })
  );
  assert.equal(echoAbsent.responseModel, 'gpt-5.6-luna');
  assert.equal(echoAbsent.systemFingerprint, null);
  assert.equal(echoAbsent.fingerprintStatus, 'absent');

  const oneTool = provider.normalizeLunaResponseToChatCompletion(
    response({ output: [toolCall('call_slots', 'getAvailableSlots')] })
  );
  assert.equal(oneTool.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(oneTool.choices[0]?.message.tool_calls?.[0]?.id, 'call_slots');

  const multiTool = provider.normalizeLunaResponseToChatCompletion(
    response({
      output: [
        toolCall('call_a', 'getUpcomingAppointments'),
        toolCall('call_b', 'getAvailableSlots'),
      ],
    })
  );
  assert.deepEqual(
    multiTool.choices[0]?.message.tool_calls?.map((call) => call.id),
    ['call_a', 'call_b']
  );

  const whitespaceTool = provider.normalizeLunaResponseToChatCompletion(
    response({
      outputText: '   ',
      output: [toolCall('call_ws', 'getUpcomingAppointments')],
    })
  );
  assert.equal(whitespaceTool.choices[0]?.message.content, '   ');
  assert.equal(whitespaceTool.choices[0]?.finish_reason, 'tool_calls');

  const lunaRuntime = provider.resolveReceptionistAiRuntime({
    tenantSlug: 'luna-protocol',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'fixture',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'luna',
    aiModel: provider.OPENAI_LUNA_MODEL,
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'fixture',
    waApiVersion: 'v21.0',
    phoneNumberId: 'pnid-luna-protocol',
    isActive: true,
  });
  const lunaClientOptions = provider.buildReceptionistClientOptions(lunaRuntime);
  assert.equal(lunaClientOptions.maxRetries, 0);
  assert.equal(lunaClientOptions.timeout, provider.RECEPTIONIST_AI_TIMEOUT_MS);
  assert.equal(lunaClientOptions.baseURL, undefined);
  const textOnlyRequest = provider.buildLunaResponsesRequest(lunaRuntime, {
    messages: [{ role: 'user', content: 'Oi' }],
    tools: [],
    temperature: 0.4,
    maxTokens: 500,
  });
  assert.equal('tools' in textOnlyRequest, false);
  assert.equal('tool_choice' in textOnlyRequest, false);
  assert.equal(textOnlyRequest.store, false);
  const continuationMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Sistema fixture.' },
    { role: 'user', content: 'Consulte.' },
    oneTool.choices[0]!.message,
    { role: 'tool', tool_call_id: 'call_slots', content: '{"success":true}' },
  ];
  const continuation = provider.buildLunaResponsesRequest(lunaRuntime, {
    messages: continuationMessages,
    tools: runtimeV2.RECEPTIONIST_V2_TOOLS,
    temperature: 0.4,
    maxTokens: 500,
  });
  const continuationInput = continuation.input as Array<Record<string, unknown>>;
  assert.ok(
    continuationInput.some(
      (item) => item.type === 'function_call' && item.call_id === 'call_slots'
    )
  );
  assert.ok(
    continuationInput.some(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'call_slots'
    )
  );
  const toolToText = provider.normalizeLunaResponseToChatCompletion(
    response({ outputText: 'Encontrei horários.' })
  );
  assert.equal(toolToText.choices[0]?.finish_reason, 'stop');
  assert.equal(toolToText.choices[0]?.message.content, 'Encontrei horários.');

  const truncated = provider.normalizeLunaResponseToChatCompletion(
    response({ status: 'incomplete', incompleteReason: 'max_output_tokens' })
  );
  assert.equal(truncated.choices[0]?.finish_reason, 'length');

  const empty = provider.normalizeLunaResponseToChatCompletion(response({}));
  assert.equal(empty.choices[0]?.finish_reason, 'stop');
  assert.equal(empty.choices[0]?.message.content, '');

  assert.equal(runtimeV2.RECEPTIONIST_V2_TOOLS.length, 4);
  provider.assertStrictToolSchemas(runtimeV2.RECEPTIONIST_V2_TOOLS);
  const deepseekRuntime = provider.resolveReceptionistAiRuntime({
    ...({} as Parameters<typeof provider.resolveReceptionistAiRuntime>[0]),
    tenantSlug: 'strict-smoke',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: 'fixture',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'deepseek',
    aiModel: provider.DEEPSEEK_V4_FLASH_MODEL,
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'fixture',
    waApiVersion: 'v21.0',
    phoneNumberId: 'pnid-strict',
    isActive: true,
  });
  assert.equal(deepseekRuntime.supportsStrictTools, true);
  assert.equal(
    provider.runtimeForStrictToolEndpoint(deepseekRuntime, []),
    deepseekRuntime,
    '/beta nunca é selecionado sem tools strict'
  );
  assert.equal(
    provider.runtimeForStrictToolEndpoint(
      deepseekRuntime,
      runtimeV2.RECEPTIONIST_V2_TOOLS
    ).baseURL,
    provider.DEEPSEEK_BETA_BASE_URL
  );

  const invalid = JSON.parse(
    JSON.stringify(runtimeV2.RECEPTIONIST_V2_TOOLS)
  ) as OpenAI.Chat.Completions.ChatCompletionTool[];
  const firstProperty = Object.values(
    (invalid[0]!.function.parameters as { properties: Record<string, object> })
      .properties
  )[0];
  if (firstProperty) Object.assign(firstProperty, { minLength: 1 });
  else (invalid[0]!.function.parameters as Record<string, unknown>).maxItems = 1;
  assert.throws(
    () =>
      provider.buildReceptionistCompletionRequest(deepseekRuntime, {
        messages: [{ role: 'user', content: 'fixture' }],
        tools: invalid,
        temperature: 0.2,
        maxTokens: 500,
      }),
    (error: unknown) =>
      error instanceof provider.StrictToolSchemaError && error.status === 400
  );

  assert.ok(brain.RECEPTIONIST_TOOLS.every((tool) => tool.function.strict === true));
  console.log('PASS smoke Luna Responses: 7 protocolos + strict tools fail-fast 400.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
