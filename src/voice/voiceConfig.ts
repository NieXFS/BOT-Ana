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

export interface VoiceEnvConfig {
  enabled: boolean;
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

export function getVoiceEnvConfig(): VoiceEnvConfig {
  return {
    enabled: process.env.RENATA_VOICE_ENABLED?.trim().toLowerCase() === 'true',
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

/**
 * Gate único da feature. Fora de sales, com kill-switch desligado, sem ffmpeg
 * ou sem chave, o encanamento atual de texto permanece em uso.
 */
export function isRenataVoiceEnabled(config: TenantBotConfig): boolean {
  const env = getVoiceEnvConfig();
  return (
    config.botRole === 'sales' &&
    env.enabled &&
    ffmpegAvailable() &&
    Boolean(env.apiKey)
  );
}

/** Invalida o cache automaticamente quando voz/modelo/parâmetros mudam. */
export function voiceFingerprint(cfg: VoiceEnvConfig): string {
  return crypto
    .createHash('sha256')
    .update(
      `v1|${cfg.voiceId}|${cfg.model}|${cfg.stability}|${cfg.similarity}|${cfg.speed}|${cfg.style}`
    )
    .digest('hex');
}
