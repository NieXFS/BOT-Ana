import { Sentry } from '../observability/sentry';
import {
  getTtsProvider,
  type TtsProvider,
  type TtsSynthesisResult,
} from './ttsProvider';
import {
  providerApiKey,
  type VoiceEnvConfig,
  type VoiceTtsProviderName,
} from './voiceConfig';

export const TTS_QUICK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const TTS_NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface TtsErrorShape {
  status?: number;
  code?: string;
  response?: { status?: number };
  cause?: { code?: string };
}

export interface ResilientTtsProviderDeps {
  providers?: Partial<Record<VoiceTtsProviderName, TtsProvider>>;
  createProvider?: (
    name: VoiceTtsProviderName,
    config: VoiceEnvConfig
  ) => TtsProvider;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  captureProviderFailure?: (provider: VoiceTtsProviderName) => void;
  logSuccess?: (
    provider: VoiceTtsProviderName,
    fallbackFrom?: VoiceTtsProviderName
  ) => void;
}

function errorShape(error: unknown): TtsErrorShape {
  return error && typeof error === 'object' ? (error as TtsErrorShape) : {};
}

function errorStatus(error: unknown): number | undefined {
  const shape = errorShape(error);
  return shape.status ?? shape.response?.status;
}

function errorCode(error: unknown): string | undefined {
  const shape = errorShape(error);
  return shape.code ?? shape.cause?.code;
}

export function isRetryableTtsError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }
  const code = errorCode(error);
  return Boolean(code && TTS_NETWORK_ERROR_CODES.has(code));
}

function safeProviderError(
  provider: VoiceTtsProviderName,
  error: unknown
): Error {
  const status = errorStatus(error);
  const code = errorCode(error);
  const safe = new Error(
    `renata voice TTS provider ${provider} failed${
      status ? ` (HTTP ${status})` : ''
    }`
  ) as Error & { status?: number; code?: string };
  if (status !== undefined) safe.status = status;
  if (code) safe.code = code;
  return safe;
}

const defaultCaptureProviderFailure = (provider: VoiceTtsProviderName): void => {
  // Mensagem sintética: nunca anexa AxiosError/config.data nem texto/telefone.
  Sentry.captureMessage(`renata_voice: TTS provider failed (${provider})`, {
    level: 'warning',
    tags: {
      service: 'renata_voice',
      provider,
      step: 'tts',
    },
  });
};

async function synthesizeWithRetry(
  text: string,
  providerName: VoiceTtsProviderName,
  provider: TtsProvider,
  deps: ResilientTtsProviderDeps
): Promise<TtsSynthesisResult> {
  const delays = deps.retryDelaysMs ?? TTS_QUICK_RETRY_DELAYS_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const output = await provider.synthesize(text);
      return {
        ...output,
        format: provider.outputFormat,
        provider: providerName,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableTtsError(error) || attempt >= delays.length) break;
      const delay = delays[attempt]!;
      console.warn(
        `⚠️ Renata TTS provider=${providerName} retry=${
          attempt + 1
        } delay_ms=${delay}`
      );
      await sleep(delay);
    }
  }

  throw safeProviderError(providerName, lastError);
}

function resolveProvider(
  name: VoiceTtsProviderName,
  config: VoiceEnvConfig,
  deps: ResilientTtsProviderDeps
): TtsProvider {
  return (
    deps.providers?.[name] ??
    (deps.createProvider ?? getTtsProvider)(name, config)
  );
}

/**
 * Tenta o provider selecionado com retry curto. Quando Gemini é o primário,
 * ElevenLabs é o fallback automático se sua chave estiver configurada.
 *
 * Chave ausente no provider selecionado falha fechado: o gate de configuração
 * deve manter a entrega em texto, sem escolher outro provider silenciosamente.
 */
export async function synthesizeWithFallback(
  text: string,
  config: VoiceEnvConfig,
  deps: ResilientTtsProviderDeps = {}
): Promise<TtsSynthesisResult> {
  const primary = config.provider;
  if (!providerApiKey(config, primary)) {
    throw new Error(`renata voice selected TTS provider ${primary} has no key`);
  }

  const capture = deps.captureProviderFailure ?? defaultCaptureProviderFailure;
  const logSuccess =
    deps.logSuccess ??
    ((provider, fallbackFrom) => {
      console.log(
        `🔊 Renata TTS provider=${provider}${
          fallbackFrom ? ` fallback_from=${fallbackFrom}` : ''
        }`
      );
    });

  try {
    const result = await synthesizeWithRetry(
      text,
      primary,
      resolveProvider(primary, config, deps),
      deps
    );
    logSuccess(primary);
    return result;
  } catch {
    capture(primary);
  }

  // O contrato de rollout preserva ElevenLabs como fallback do Gemini. Quando
  // ElevenLabs é selecionada, não muda de voz/provider em runtime.
  const secondary: VoiceTtsProviderName | null =
    primary === 'gemini' && providerApiKey(config, 'elevenlabs')
      ? 'elevenlabs'
      : null;
  if (!secondary) {
    throw new Error(`renata voice TTS provider ${primary} failed`);
  }

  try {
    const result = await synthesizeWithRetry(
      text,
      secondary,
      resolveProvider(secondary, config, deps),
      deps
    );
    logSuccess(secondary, primary);
    return result;
  } catch {
    capture(secondary);
    throw new Error('renata voice TTS providers failed');
  }
}
