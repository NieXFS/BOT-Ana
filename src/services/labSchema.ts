import type { Pool } from 'pg';
import { pool } from './contextManager';

export const ANA_LAB_SCHEMA_VERSION = 1;
export const ANA_LAB_SCHEMA_MARKER_TABLE = 'ana_lab_schema_metadata';
export const PRODUCTION_STORAGE_IS_LAB_ERROR =
  'Storage de produção aponta para um schema reservado do LAB.';

/**
 * Schema completo criado pelo bootstrap explícito. A lista inclui superfícies
 * que ficam inativas no LAB-1 para que um futuro acionamento local não dependa
 * de DDL implícito durante o boot normal.
 */
export const ANA_LAB_REQUIRED_TABLES = [
  'processed_messages',
  'ana_conversation_history',
  'ana_conversation_seq',
  'inbound_event_outbox',
  'sent_question_replies',
  'ana_v2_silent_escalation_holds',
  'ana_v2_pending_frames',
  'ana_v2_outbound_outbox',
  'ana_v2_turn_receipts',
  'ana_v2_successor_batches',
  'ana_v2_flow_state_invalidations',
  'ana_v2_provider_status_events',
  'sales_followups',
  'tts_cache',
  'tts_daily_usage',
  'renata_channel_prefs',
  'media_cache',
] as const;

export interface LabSchemaQuery {
  query: Pool['query'];
}

/**
 * Cerca reversa de identidade do storage. Produção só faz esta leitura de
 * catálogo antes do boot histórico: não lê rows operacionais, não executa DDL
 * e nunca tenta corrigir um banco marcado como LAB.
 */
export async function assertProductionStorageIsNotLab(
  deps: LabSchemaQuery = pool
): Promise<void> {
  const existing = await deps.query<{ relation: string | null }>(
    'SELECT to_regclass($1)::text AS relation',
    [ANA_LAB_SCHEMA_MARKER_TABLE]
  );
  if (existing.rows[0]?.relation) {
    throw new Error(PRODUCTION_STORAGE_IS_LAB_ERROR);
  }
}

export async function assertLabStorageEmpty(
  deps: LabSchemaQuery = pool
): Promise<void> {
  for (const table of [
    ANA_LAB_SCHEMA_MARKER_TABLE,
    ...ANA_LAB_REQUIRED_TABLES,
  ]) {
    const existing = await deps.query<{ relation: string | null }>(
      'SELECT to_regclass($1)::text AS relation',
      [table]
    );
    if (!existing.rows[0]?.relation) continue;
    const count = await deps.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`
    );
    if (Number(count.rows[0]?.count ?? '0') > 0) {
      throw new Error('Storage LAB contém estado operacional preexistente.');
    }
  }
}

export async function writeLabSchemaMarker(
  databaseFingerprint: string,
  deps: LabSchemaQuery = pool
): Promise<void> {
  await deps.query(`
    CREATE TABLE IF NOT EXISTS ${ANA_LAB_SCHEMA_MARKER_TABLE} (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
      schema_version integer NOT NULL,
      database_fingerprint text NOT NULL,
      bootstrapped_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await deps.query(
    `INSERT INTO ${ANA_LAB_SCHEMA_MARKER_TABLE}
       (singleton, schema_version, database_fingerprint)
     VALUES (true, $1, $2)
     ON CONFLICT (singleton) DO UPDATE SET
       schema_version = EXCLUDED.schema_version,
       database_fingerprint = EXCLUDED.database_fingerprint,
       bootstrapped_at = now()`,
    [ANA_LAB_SCHEMA_VERSION, databaseFingerprint]
  );
}

export async function validateLabSchema(
  databaseFingerprint: string,
  deps: LabSchemaQuery = pool
): Promise<void> {
  const missing: string[] = [];
  for (const table of [
    ANA_LAB_SCHEMA_MARKER_TABLE,
    ...ANA_LAB_REQUIRED_TABLES,
  ]) {
    const existing = await deps.query<{ relation: string | null }>(
      'SELECT to_regclass($1)::text AS relation',
      [table]
    );
    if (!existing.rows[0]?.relation) missing.push(table);
  }
  if (missing.length > 0) {
    throw new Error('Schema LAB ausente ou incompleto.');
  }

  const marker = await deps.query<{
    schema_version: number;
    database_fingerprint: string;
  }>(
    `SELECT schema_version, database_fingerprint
     FROM ${ANA_LAB_SCHEMA_MARKER_TABLE}
     WHERE singleton = true`
  );
  const row = marker.rows[0];
  if (
    !row ||
    Number(row.schema_version) !== ANA_LAB_SCHEMA_VERSION ||
    row.database_fingerprint !== databaseFingerprint
  ) {
    throw new Error('Identidade/versão do schema LAB não confere.');
  }
}
