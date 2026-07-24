import { pool } from '../services/contextManager';

export const DEMO_VIDEO_ASSET_KEY = 'demo-video';

export interface MediaCacheRow {
  assetKey: string;
  contentHash: string;
  phoneNumberId: string;
  mediaId: string;
  mediaUploadedAt: Date;
  hitCount: number;
  createdAt: Date;
}

export type MediaCacheQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

const defaultQuery: MediaCacheQuery = (text, params) => pool.query(text, params);

export async function ensureMediaCacheTable(
  query: MediaCacheQuery = defaultQuery
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS media_cache (
      asset_key          text NOT NULL,
      content_hash       text NOT NULL,
      phone_number_id    text NOT NULL,
      media_id           text NOT NULL,
      media_uploaded_at  timestamptz NOT NULL DEFAULT now(),
      hit_count          integer NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (asset_key, content_hash, phone_number_id)
    )
  `);
}

interface RawMediaCacheRow {
  asset_key: string;
  content_hash: string;
  phone_number_id: string;
  media_id: string;
  media_uploaded_at: Date | string;
  hit_count: number;
  created_at: Date | string;
}

function mapRow(row: RawMediaCacheRow): MediaCacheRow {
  return {
    assetKey: row.asset_key,
    contentHash: row.content_hash,
    phoneNumberId: row.phone_number_id,
    mediaId: row.media_id,
    mediaUploadedAt: new Date(row.media_uploaded_at),
    hitCount: row.hit_count,
    createdAt: new Date(row.created_at),
  };
}

export async function lookupMedia(
  assetKey: string,
  contentHash: string,
  phoneNumberId: string,
  query: MediaCacheQuery = defaultQuery
): Promise<MediaCacheRow | null> {
  const result = await query(
    `SELECT asset_key, content_hash, phone_number_id, media_id,
            media_uploaded_at, hit_count, created_at
       FROM media_cache
      WHERE asset_key = $1 AND content_hash = $2 AND phone_number_id = $3`,
    [assetKey, contentHash, phoneNumberId]
  );
  const row = result.rows[0] as RawMediaCacheRow | undefined;
  if (!row) return null;

  await query(
    `UPDATE media_cache
        SET hit_count = hit_count + 1
      WHERE asset_key = $1 AND content_hash = $2 AND phone_number_id = $3`,
    [assetKey, contentHash, phoneNumberId]
  );
  return mapRow(row);
}

export async function upsertMedia(
  assetKey: string,
  contentHash: string,
  phoneNumberId: string,
  mediaId: string,
  query: MediaCacheQuery = defaultQuery
): Promise<void> {
  // Diferente do `tts_cache`, os bytes NÃO vão pro Postgres: o áudio TTS é uma
  // saída paga/cara de regerar; este MP4 é um asset commitado e reler do disco
  // para um eventual re-upload é gratuito. Evita ~10 MB por linha de cache.
  await query(
    `INSERT INTO media_cache
       (asset_key, content_hash, phone_number_id, media_id, media_uploaded_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (asset_key, content_hash, phone_number_id) DO UPDATE SET
       media_id = EXCLUDED.media_id,
       media_uploaded_at = EXCLUDED.media_uploaded_at`,
    [assetKey, contentHash, phoneNumberId, mediaId]
  );
}
