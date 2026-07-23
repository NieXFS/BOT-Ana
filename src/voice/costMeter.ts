import { pool } from '../services/contextManager';
import { Sentry } from '../observability/sentry';
import { getVoiceEnvConfig } from './voiceConfig';

export type TtsUsageQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

export interface CostMeterDeps {
  query: TtsUsageQuery;
  captureBudgetWarning: () => void;
}

const defaultDeps: CostMeterDeps = {
  query: (text, params) => pool.query(text, params),
  captureBudgetWarning: () => {
    Sentry.captureMessage('renata_voice: TTS daily budget 80%', {
      level: 'warning',
      tags: { service: 'renata_voice' },
    });
  },
};

export async function ensureTtsUsageTable(
  query: TtsUsageQuery = defaultDeps.query
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS tts_daily_usage (
      day        text PRIMARY KEY,
      chars      integer NOT NULL DEFAULT 0,
      hits       integer NOT NULL DEFAULT 0,
      misses     integer NOT NULL DEFAULT 0,
      alerted    boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
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
  deps: CostMeterDeps = defaultDeps
): Promise<void> {
  await deps.query(
    `INSERT INTO tts_daily_usage (day, hits, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (day) DO UPDATE SET
       hits = tts_daily_usage.hits + 1,
       updated_at = now()`,
    [day]
  );
}

export async function recordMiss(
  day: string,
  chars: number,
  dailyCharBudget: number = getVoiceEnvConfig().dailyCharBudget,
  deps: CostMeterDeps = defaultDeps
): Promise<void> {
  const safeChars = Math.max(0, Math.floor(chars));
  const result = await deps.query(
    `INSERT INTO tts_daily_usage (day, chars, misses, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (day) DO UPDATE SET
       chars = tts_daily_usage.chars + EXCLUDED.chars,
       misses = tts_daily_usage.misses + 1,
       updated_at = now()
     RETURNING chars, alerted`,
    [day, safeChars]
  );
  const usage = result.rows[0] as { chars?: number; alerted?: boolean } | undefined;
  const threshold = Math.ceil(Math.max(1, dailyCharBudget) * 0.8);
  if (!usage || Number(usage.chars ?? 0) < threshold || usage.alerted) return;

  // CAS: somente um worker ganha o direito de alertar naquele dia.
  const alerted = await deps.query(
    `UPDATE tts_daily_usage
        SET alerted = true, updated_at = now()
      WHERE day = $1 AND alerted = false
      RETURNING day`,
    [day]
  );
  if ((alerted.rowCount ?? alerted.rows.length) > 0) {
    deps.captureBudgetWarning();
  }
}
