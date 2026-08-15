import type OpenAI from 'openai';
import type { TenantBotConfig } from '../../../configProvider';
import {
  createReceptionistChatCompletion,
  resolveReceptionistAiRuntime,
  type ReceptionistCompletionInput,
} from '../../receptionistLlmProvider';
import {
  connectiveIdsForActV2,
  materializeVoiceConnectiveV2,
  splitPhase1ATemplateV2,
} from './compose';
import { policyForCopyIdV2 } from './registry';
import {
  VOICE_PROMPT_PROFILE_V2,
  VOICE_REPHRASE_MAX_TOKENS,
  VOICE_REPHRASE_TEMPERATURE,
  VOICE_REPHRASE_TIMEOUT_MS,
  type VoiceCopyIdV2,
} from './types';

export interface VoiceRephraseCompletionInputV2 {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: [];
  temperature: number;
  maxTokens: number;
  thinkingMode: 'disabled';
  timeoutMs: number;
}

export type VoiceRephraseCompletionFactoryV2 = (
  input: VoiceRephraseCompletionInputV2
) => Promise<OpenAI.Chat.Completions.ChatCompletion>;

export interface VoiceRephraseRequestV2 {
  config: TenantBotConfig;
  copyId: VoiceCopyIdV2;
  template: string;
  timeoutMs?: number;
  completionFactory?: VoiceRephraseCompletionFactoryV2;
}

export type VoiceRephraseResultV2 =
  | {
      ok: true;
      rewrite: string;
      providerCalls: 1;
      provider: 'openai' | 'deepseek' | 'luna';
      requestedModel: string;
      returnedModel: string | null;
      systemFingerprint: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: 'timeout' | 'provider_error' | 'empty' | 'tool_calls';
      providerCalls: 1;
      provider: 'openai' | 'deepseek' | 'luna';
      requestedModel: string;
      returnedModel: string | null;
      systemFingerprint: string | null;
      latencyMs: number;
    };

export function buildVoiceRephraseMessagesV2(
  copyId: VoiceCopyIdV2,
  template: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const semanticAct = policyForCopyIdV2(copyId).semanticAct;
  const split = splitPhase1ATemplateV2(template, semanticAct);
  const core = split?.core ?? template;
  const allowed = connectiveIdsForActV2(semanticAct);
  const catalog = allowed
    .map(
      (connectiveId) =>
        `- ${connectiveId} → "${materializeVoiceConnectiveV2(connectiveId)}"`
    )
    .join('\n');
  return [
    {
      role: 'system',
      content:
        `Perfil ${VOICE_PROMPT_PROFILE_V2}. ` +
        'Escolha SOMENTE um VoiceConnectiveId da lista fechada. ' +
        'Não escreva frase, fato, pergunta nem o núcleo canônico. ' +
        'Não há mensagem da cliente neste prompt. ' +
        'Devolva JSON {"connectiveId":"<id>"} e nada mais.\n\n' +
        `IDS_PERMITIDOS:\n${catalog || '(nenhum)'}\n\n` +
        `NUCLEO_CANONICO:\n<<<\n${core}\n>>>`,
    },
  ];
}

export async function rephraseVoiceCopyV2(
  input: VoiceRephraseRequestV2
): Promise<VoiceRephraseResultV2> {
  const runtime = resolveReceptionistAiRuntime(input.config);
  const timeoutMs = input.timeoutMs ?? VOICE_REPHRASE_TIMEOUT_MS;
  const completionInput: ReceptionistCompletionInput = {
    messages: buildVoiceRephraseMessagesV2(input.copyId, input.template),
    tools: [],
    temperature: VOICE_REPHRASE_TEMPERATURE,
    maxTokens: VOICE_REPHRASE_MAX_TOKENS,
    thinkingMode: 'disabled',
    timeoutMs,
  };
  const started = Date.now();
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await Promise.race([
      input.completionFactory
        ? input.completionFactory({
            messages: completionInput.messages,
            tools: [],
            temperature: VOICE_REPHRASE_TEMPERATURE,
            maxTokens: VOICE_REPHRASE_MAX_TOKENS,
            thinkingMode: 'disabled',
            timeoutMs,
          })
        : createReceptionistChatCompletion(runtime, completionInput),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('voice_timeout'), { code: 'voice_timeout' })), timeoutMs);
      }),
    ]);
  } catch (error: unknown) {
    const timeout =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'voice_timeout';
    return {
      ok: false,
      reason: timeout ? 'timeout' : 'provider_error',
      providerCalls: 1,
      provider: runtime.provider,
      requestedModel: runtime.model,
      returnedModel: null,
      systemFingerprint: null,
      latencyMs: Date.now() - started,
    };
  }
  const choice = completion.choices[0];
  const rewrite = choice?.message.content?.trim() ?? '';
  const latencyMs = Date.now() - started;
  const base = {
    providerCalls: 1 as const,
    provider: runtime.provider,
    requestedModel: runtime.model,
    returnedModel: completion.model ?? null,
    systemFingerprint: completion.system_fingerprint ?? null,
    latencyMs,
  };
  if (choice?.message.tool_calls?.length) {
    return { ok: false, reason: 'tool_calls', ...base };
  }
  if (!rewrite) {
    return { ok: false, reason: 'empty', ...base };
  }
  return { ok: true, rewrite, ...base };
}
