import { pool } from '../services/contextManager';
import { Sentry } from '../observability/sentry';
import {
  getVoiceEnvConfig,
  providerDailyCharBudget,
  type VoiceTtsProviderName,
} from './voiceConfig';
import type { TtsUsage } from './ttsProvider';

/**
 * Fallback de duração quando o Gemini não devolve usageMetadata. Não é uma
 * duração medida; evita ffprobe/dependência extra e não interfere na entrega.
 */
export const GEMINI_ESTIMATED_CHARS_PER_SECOND = 14;

/**
 * Medida empírica em 2026-07-30: 63 tokens para 1,9665 s (~32 tokens/s).
 * O token reportado pela API é a verdade de faturamento; a regra de bolso de
 * 25 tokens/s não bateu com a medição real.
 */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

export type TtsUsageQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

export interface CostMeterDeps {
  query: TtsUsageQuery;
  captureBudgetWarning: (provider: VoiceTtsProviderName) => void;
}

export function budgetWarningMessage(provider: VoiceTtsProviderName): string {
  return `renata_voice: TTS daily budget 80% (provider=${provider})`;
}

const defaultDeps: CostMeterDeps = {
  query: (text, params) => pool.query(text, params),
  captureBudgetWarning: (provider) => {
    Sentry.captureMessage(budgetWarningMessage(provider), {
      level: 'warning',
      tags: { service: 'renata_voice', provider },
    });
  },
};

export async function ensureTtsUsageTable(
  query: TtsUsageQuery = defaultDeps.query
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS tts_daily_usage (
      day           text NOT NULL,
      provider      text NOT NULL DEFAULT 'elevenlabs',
      chars         integer NOT NULL DEFAULT 0,
      audio_tokens  integer NOT NULL DEFAULT 0,
      audio_seconds integer NOT NULL DEFAULT 0,
      hits          integer NOT NULL DEFAULT 0,
      misses        integer NOT NULL DEFAULT 0,
      alerted       boolean NOT NULL DEFAULT false,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (day, provider)
    )
  `);
  // Backfill aditivo: linhas históricas eram todas da ElevenLabs.
  await query(`
    ALTER TABLE tts_daily_usage
      ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'elevenlabs',
      ADD COLUMN IF NOT EXISTS audio_tokens integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS audio_seconds integer NOT NULL DEFAULT 0
  `);
  await query(`
    DO $$
    DECLARE
      current_pk_name text;
      current_pk_columns text[];
    BEGIN
      SELECT constraint_info.conname, constraint_info.columns
        INTO current_pk_name, current_pk_columns
        FROM (
          SELECT c.conname,
                 array_agg(a.attname::text ORDER BY key_column.ordinality) AS columns
            FROM pg_constraint c
            JOIN unnest(c.conkey) WITH ORDINALITY
              AS key_column(attnum, ordinality) ON true
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid
             AND a.attnum = key_column.attnum
           WHERE c.conrelid = 'tts_daily_usage'::regclass
             AND c.contype = 'p'
           GROUP BY c.conname
        ) AS constraint_info
       LIMIT 1;

      IF current_pk_columns = ARRAY['day']::text[] THEN
        EXECUTE format(
          'ALTER TABLE tts_daily_usage DROP CONSTRAINT %I',
          current_pk_name
        );
        current_pk_name := NULL;
      END IF;

      IF current_pk_name IS NULL THEN
        ALTER TABLE tts_daily_usage
          ADD CONSTRAINT tts_daily_usage_pkey PRIMARY KEY (day, provider);
      END IF;
    END
    $$
  `);
}

/** Chave civil YYYY-MM-DD no fuso pedido, sem depender do fuso do processo. */
export function dayKey(
  now: Date = new Date(),
  tz: string = 'America/Sao_Paulo'
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function recordHit(
  day: string,
  provider: VoiceTtsProviderName,
  deps: CostMeterDeps = defaultDeps
): Promise<void> {
  await deps.query(
    `INSERT INTO tts_daily_usage (day, provider, hits, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (day, provider) DO UPDATE SET
       hits = tts_daily_usage.hits + 1,
       updated_at = now()`,
    [day, provider]
  );
}

export async function recordMiss(
  day: string,
  provider: VoiceTtsProviderName,
  chars: number,
  dailyCharBudget: number = providerDailyCharBudget(
    getVoiceEnvConfig(),
    provider
  ),
  providerUsage?: TtsUsage,
  deps: CostMeterDeps = defaultDeps
): Promise<void> {
  const safeChars = Math.max(0, Math.floor(chars));
  const reportedAudioTokens = providerUsage?.audioTokens;
  const hasReportedAudioTokens =
    typeof reportedAudioTokens === 'number' &&
    Number.isFinite(reportedAudioTokens) &&
    reportedAudioTokens >= 0;
  const safeAudioTokens =
    hasReportedAudioTokens
      ? Math.max(0, Math.floor(reportedAudioTokens))
      : 0;
  const audioSeconds =
    hasReportedAudioTokens
      ? Math.ceil(safeAudioTokens / GEMINI_AUDIO_TOKENS_PER_SECOND)
      : provider === 'gemini' && safeChars > 0
      ? Math.ceil(safeChars / GEMINI_ESTIMATED_CHARS_PER_SECOND)
      : 0;
  const result = await deps.query(
    `INSERT INTO tts_daily_usage
       (day, provider, chars, audio_tokens, audio_seconds, misses, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, now())
     ON CONFLICT (day, provider) DO UPDATE SET
       chars = tts_daily_usage.chars + EXCLUDED.chars,
       audio_tokens = tts_daily_usage.audio_tokens + EXCLUDED.audio_tokens,
       audio_seconds = tts_daily_usage.audio_seconds + EXCLUDED.audio_seconds,
       misses = tts_daily_usage.misses + 1,
       updated_at = now()
     RETURNING chars, audio_tokens, audio_seconds, alerted`,
    [day, provider, safeChars, safeAudioTokens, audioSeconds]
  );
  const usage = result.rows[0] as { chars?: number; alerted?: boolean } | undefined;
  const threshold = Math.ceil(Math.max(1, dailyCharBudget) * 0.8);
  if (!usage || Number(usage.chars ?? 0) < threshold || usage.alerted) return;

  // CAS: somente um worker ganha o direito de alertar naquele dia.
  const alerted = await deps.query(
    `UPDATE tts_daily_usage
        SET alerted = true, updated_at = now()
      WHERE day = $1 AND provider = $2 AND alerted = false
      RETURNING day, provider`,
    [day, provider]
  );
  if ((alerted.rowCount ?? alerted.rows.length) > 0) {
    deps.captureBudgetWarning(provider);
  }
}
