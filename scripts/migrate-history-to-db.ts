import 'dotenv/config';
import fs from 'fs';
import { Pool } from 'pg';

const canonicalHistoryFile = '/root/Receps-IA/historico_conversas.json';
const legacyHistoryFile = '/root/Ana/historico_conversas.json';

function resolveHistoryFile(): string {
  const explicit = process.env.RECEPS_IA_HISTORY_FILE?.trim();
  if (explicit) return explicit;

  const canonicalExists = fs.existsSync(canonicalHistoryFile);
  const legacyExists = fs.existsSync(legacyHistoryFile);
  if (canonicalExists && legacyExists) {
    throw new Error(
      'Há dois históricos legados; defina RECEPS_IA_HISTORY_FILE explicitamente.'
    );
  }
  return canonicalExists ? canonicalHistoryFile : legacyHistoryFile;
}

const HISTORY_FILE = resolveHistoryFile();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log('Sem arquivo legado pra migrar.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as Record<
    string,
    unknown
  >;
  let total = 0;

  for (const [key, messages] of Object.entries(data)) {
    if (!Array.isArray(messages)) continue;

    for (const msg of messages) {
      if (
        !msg ||
        typeof msg !== 'object' ||
        !['user', 'assistant'].includes((msg as { role?: unknown }).role as string) ||
        typeof (msg as { content?: unknown }).content !== 'string'
      ) {
        continue;
      }

      await pool.query(
        `INSERT INTO ana_conversation_history ("conversationKey", "role", "content")
         VALUES ($1, $2, $3)`,
        [
          key,
          (msg as { role: 'user' | 'assistant' }).role,
          (msg as { content: string }).content,
        ]
      );
      total++;
    }
  }

  console.log(`Migradas ${total} mensagens de ${Object.keys(data).length} conversas.`);

  fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.migrated-${Date.now()}.bak`);
  console.log('Arquivo legado renomeado pra .bak');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
