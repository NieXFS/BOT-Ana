import { pool } from '../services/contextManager';

export type ChannelRequest = 'text' | 'audio' | null;

export type ChannelPrefQuery = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

const defaultQuery: ChannelPrefQuery = (text, params) => pool.query(text, params);

export async function ensureChannelPrefsTable(
  query: ChannelPrefQuery = defaultQuery
): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS renata_channel_prefs (
      conversation_key text PRIMARY KEY,
      prefers_text     boolean NOT NULL DEFAULT false,
      updated_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function getChannelPref(
  conversationKey: string,
  query: ChannelPrefQuery = defaultQuery
): Promise<boolean> {
  const result = await query(
    `SELECT prefers_text
       FROM renata_channel_prefs
      WHERE conversation_key = $1`,
    [conversationKey]
  );
  const row = result.rows[0] as { prefers_text?: boolean } | undefined;
  return row?.prefers_text ?? false;
}

export async function setChannelPref(
  conversationKey: string,
  prefersText: boolean,
  query: ChannelPrefQuery = defaultQuery
): Promise<void> {
  await query(
    `INSERT INTO renata_channel_prefs
       (conversation_key, prefers_text, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (conversation_key) DO UPDATE SET
       prefers_text = EXCLUDED.prefers_text,
       updated_at = now()`,
    [conversationKey, prefersText]
  );
}

function normalizeRequest(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detecta pedidos explícitos de canal. Texto tem precedência quando uma frase
 * ambígua contém sinais dos dois lados.
 */
export function detectChannelRequest(inboundText: string): ChannelRequest {
  const text = normalizeRequest(inboundText);
  if (!text) return null;

  const asksForText =
    /\bpor escrito\b/.test(text) ||
    /\bsem audio\b/.test(text) ||
    /\bnao (?:consigo|posso) ouvir\b/.test(text) ||
    /\b(?:escreve|escreva|digita|digite)(?: ai)?\b/.test(text) ||
    /\b(?:detesto|odeio) audio\b/.test(text) ||
    /\b(?:manda|mande|responde|responda|prefiro)(?:\s+\w+){0,3}\s+(?:por\s+)?(?:escrito|texto)\b/.test(
      text
    );
  if (asksForText) return 'text';

  const asksForAudio =
    /\bprefiro audio\b/.test(text) ||
    /\baudio de volta\b/.test(text) ||
    /\bpode falar\b/.test(text) ||
    /\b(?:manda|mande|mandar|responde|responda|pode)(?:\s+\w+){0,3}\s+(?:um\s+)?audio\b/.test(
      text
    ) ||
    /\b(?:manda|mande|mandar)\s+no audio\b/.test(text);

  return asksForAudio ? 'audio' : null;
}
