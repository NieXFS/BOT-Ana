import crypto from 'crypto';
import type { TenantBotConfig } from '../configProvider';
import { ffmpegAvailable } from './audioEncoder';

const DEFAULT_VOICE_ID = 'x8FWrDHAK5xiFTJLpnHq';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_STABILITY = 0.40;
const DEFAULT_SIMILARITY = 0.75;
const DEFAULT_SPEED = 1.13;
const DEFAULT_STYLE = 0.10;
const DEFAULT_DAILY_CHAR_BUDGET = 200_000;
const DEFAULT_MAX_CHARS = 600;
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_GEMINI_VOICE = 'Achernar';
const DEFAULT_GEMINI_TEMPERATURE = 1.1;
const DEFAULT_GEMINI_STYLE_PROMPT =
  'Style: Vocal Smile. Pace: Natural.';
const DEFAULT_GEMINI_DAILY_CHAR_BUDGET = 100_000;

export type VoiceTtsProviderName = 'gemini' | 'elevenlabs';
export type GeminiTtsStyleMode = 'prefix' | 'system';

export interface GeminiTtsConfig {
  apiKey: string;
  model: string;
  voice: string;
  temperature: number;
  stylePrompt: string;
  styleMode: GeminiTtsStyleMode;
  dailyCharBudget: number;
}

export interface VoiceEnvConfig {
  enabled: boolean;
  provider: VoiceTtsProviderName;
  gemini: GeminiTtsConfig;
  /** Chave e parâmetros da ElevenLabs, mantidos no shape histórico. */
  apiKey: string;
  voiceId: string;
  model: string;
  stability: number;
  similarity: number;
  speed: number;
  style: number;
  dailyCharBudget: number;
  maxChars: number;
}

let warnedInvalidProvider = false;

function parseFloatWithFallback(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntWithFallback(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProvider(value: string | undefined): VoiceTtsProviderName {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'elevenlabs') return 'elevenlabs';
  if (normalized === 'gemini') return 'gemini';

  if (!warnedInvalidProvider) {
    warnedInvalidProvider = true;
    console.warn(
      `⚠️ RENATA_TTS_PROVIDER inválido (${normalized}); usando elevenlabs.`
    );
  }
  return 'elevenlabs';
}

function parseGeminiStyleMode(value: string | undefined): GeminiTtsStyleMode {
  return value?.trim().toLowerCase() === 'system' ? 'system' : 'prefix';
}

export function getVoiceEnvConfig(): VoiceEnvConfig {
  return {
    enabled: process.env.RENATA_VOICE_ENABLED?.trim().toLowerCase() === 'true',
    provider: parseProvider(process.env.RENATA_TTS_PROVIDER),
    gemini: {
      apiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
      model:
        process.env.RENATA_GEMINI_TTS_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
      voice:
        process.env.RENATA_GEMINI_TTS_VOICE?.trim() || DEFAULT_GEMINI_VOICE,
      temperature: parseFloatWithFallback(
        process.env.RENATA_GEMINI_TTS_TEMPERATURE,
        DEFAULT_GEMINI_TEMPERATURE
      ),
      stylePrompt:
        process.env.RENATA_GEMINI_TTS_STYLE_PROMPT?.trim() ||
        DEFAULT_GEMINI_STYLE_PROMPT,
      styleMode: parseGeminiStyleMode(
        process.env.RENATA_GEMINI_TTS_STYLE_MODE
      ),
      dailyCharBudget: parseIntWithFallback(
        process.env.RENATA_GEMINI_TTS_DAILY_CHAR_BUDGET,
        DEFAULT_GEMINI_DAILY_CHAR_BUDGET
      ),
    },
    apiKey: process.env.RENATA_ELEVENLABS_API_KEY?.trim() ?? '',
    voiceId: process.env.RENATA_ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID,
    model: process.env.RENATA_TTS_MODEL?.trim() || DEFAULT_MODEL,
    stability: parseFloatWithFallback(
      process.env.RENATA_TTS_STABILITY,
      DEFAULT_STABILITY
    ),
    similarity: parseFloatWithFallback(
      process.env.RENATA_TTS_SIMILARITY,
      DEFAULT_SIMILARITY
    ),
    speed: parseFloatWithFallback(process.env.RENATA_TTS_SPEED, DEFAULT_SPEED),
    style: parseFloatWithFallback(process.env.RENATA_TTS_STYLE, DEFAULT_STYLE),
    dailyCharBudget: parseIntWithFallback(
      process.env.RENATA_TTS_DAILY_CHAR_BUDGET,
      DEFAULT_DAILY_CHAR_BUDGET
    ),
    maxChars: parseIntWithFallback(
      process.env.RENATA_VOICE_MAX_CHARS,
      DEFAULT_MAX_CHARS
    ),
  };
}

export function providerApiKey(
  cfg: VoiceEnvConfig,
  provider: VoiceTtsProviderName
): string {
  return provider === 'gemini' ? cfg.gemini.apiKey : cfg.apiKey;
}

export function providerDailyCharBudget(
  cfg: VoiceEnvConfig,
  provider: VoiceTtsProviderName
): number {
  return provider === 'gemini'
    ? cfg.gemini.dailyCharBudget
    : cfg.dailyCharBudget;
}

/**
 * Gate único da feature. Fora de sales, com kill-switch desligado, sem ffmpeg
 * ou sem a chave do provider selecionado, o encanamento atual de texto
 * permanece em uso. O fallback entre providers só existe após falha em runtime.
 */
export function isRenataVoiceEnabled(config: TenantBotConfig): boolean {
  const env = getVoiceEnvConfig();
  return (
    config.botRole === 'sales' &&
    env.enabled &&
    ffmpegAvailable() &&
    Boolean(providerApiKey(env, env.provider))
  );
}

/** Invalida o cache automaticamente quando voz/modelo/parâmetros mudam. */
export function voiceFingerprint(
  cfg: VoiceEnvConfig,
  provider: VoiceTtsProviderName
): string {
  const input =
    provider === 'gemini'
      ? `v2|gemini|${cfg.gemini.model}|${cfg.gemini.voice}|${
          cfg.gemini.temperature
        }|${crypto
          .createHash('sha256')
          .update(cfg.gemini.stylePrompt)
          .digest('hex')}|${cfg.gemini.styleMode}`
      : `v2|elevenlabs|${cfg.voiceId}|${cfg.model}|${cfg.stability}|${cfg.similarity}|${cfg.speed}|${cfg.style}`;

  return crypto
    .createHash('sha256')
    .update(input)
    .digest('hex');
}
