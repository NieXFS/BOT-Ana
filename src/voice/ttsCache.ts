import { pool } from '../services/contextManager';

export const MEDIA_FRESH_MS = 25 * 24 * 60 * 60 * 1000;

export interface TtsCacheRow {
  textHash: string;
  voiceFingerprint: string;
  oggBytes: Buffer;
  mediaId: string | null;
  mediaUploadedAt: Date | null;
  hitCount: number;
  createdAt: Date;
}

export type TtsCacheQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

const defaultQuery: TtsCacheQuery = (text, params) => pool.query(text, params);

export async function ensureTtsCacheTable(
  query: TtsCacheQuery = defaultQuery
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS tts_cache (
      text_hash          text NOT NULL,
      voice_fingerprint  text NOT NULL,
      ogg_bytes          bytea NOT NULL,
      media_id           text,
      media_uploaded_at  timestamptz,
      hit_count          integer NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (text_hash, voice_fingerprint)
    )
  `);
}

interface RawCacheRow {
  text_hash: string;
  voice_fingerprint: string;
  ogg_bytes: Buffer;
  media_id: string | null;
  media_uploaded_at: Date | string | null;
  hit_count: number;
  created_at: Date | string;
}

function mapRow(row: RawCacheRow): TtsCacheRow {
  return {
    textHash: row.text_hash,
    voiceFingerprint: row.voice_fingerprint,
    oggBytes: Buffer.from(row.ogg_bytes),
    mediaId: row.media_id,
    mediaUploadedAt: row.media_uploaded_at
      ? new Date(row.media_uploaded_at)
      : null,
    hitCount: row.hit_count,
    createdAt: new Date(row.created_at),
  };
}

export async function lookup(
  textHash: string,
  fingerprint: string,
  query: TtsCacheQuery = defaultQuery
): Promise<TtsCacheRow | null> {
  const result = await query(
    `SELECT text_hash, voice_fingerprint, ogg_bytes, media_id,
            media_uploaded_at, hit_count, created_at
       FROM tts_cache
      WHERE text_hash = $1 AND voice_fingerprint = $2`,
    [textHash, fingerprint]
  );
  const row = result.rows[0] as RawCacheRow | undefined;
  if (!row) return null;

  await query(
    `UPDATE tts_cache
        SET hit_count = hit_count + 1
      WHERE text_hash = $1 AND voice_fingerprint = $2`,
    [textHash, fingerprint]
  );
  return mapRow(row);
}

export async function saveNew(
  textHash: string,
  fingerprint: string,
  oggBytes: Buffer,
  mediaId: string,
  query: TtsCacheQuery = defaultQuery
): Promise<void> {
  await query(
    `INSERT INTO tts_cache
       (text_hash, voice_fingerprint, ogg_bytes, media_id, media_uploaded_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (text_hash, voice_fingerprint) DO UPDATE SET
       ogg_bytes = EXCLUDED.ogg_bytes,
       media_id = EXCLUDED.media_id,
       media_uploaded_at = EXCLUDED.media_uploaded_at`,
    [textHash, fingerprint, oggBytes, mediaId]
  );
}

export async function refreshMediaId(
  textHash: string,
  fingerprint: string,
  mediaId: string,
  query: TtsCacheQuery = defaultQuery
): Promise<void> {
  await query(
    `UPDATE tts_cache
        SET media_id = $3, media_uploaded_at = now()
      WHERE text_hash = $1 AND voice_fingerprint = $2`,
    [textHash, fingerprint, mediaId]
  );
}

export function isMediaFresh(
  row: Pick<TtsCacheRow, 'mediaId' | 'mediaUploadedAt'>,
  nowMs: number = Date.now()
): boolean {
  if (!row.mediaId || !row.mediaUploadedAt) return false;
  return nowMs - row.mediaUploadedAt.getTime() < MEDIA_FRESH_MS;
}
