import { createHash } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { Sentry } from '../observability/sentry';
import { recepsIaEnvValuesConflict } from '../runtimeIdentity';

/**
 * Ordenação distribuída por conversa (Rev. 3 §6.1).
 *
 * A trava é uma advisory lock de SESSÃO PostgreSQL, em uma conexão dedicada do
 * pool. Ela pode atravessar o HTTP da Meta, mas nunca implica transação aberta.
 * Se o processo morrer, o PostgreSQL encerra a sessão e libera a trava.
 *
 * Advisory locks de sessão exigem afinidade com o mesmo backend. O endpoint
 * `-pooler` do Neon usa transaction pooling e pode encaminhar lock, trabalho e
 * unlock para backends diferentes. Por isso SOMENTE este fluxo usa um pool
 * dedicado no endpoint direto; o pool geral do contextManager continua usando
 * DATABASE_URL normalmente.
 */

interface ConversationOrderDatabaseEnv {
  [name: string]: string | undefined;
  RECEPS_IA_DIRECT_DATABASE_URL?: string;
  ANA_DIRECT_DATABASE_URL?: string;
  DATABASE_URL?: string;
}

let warnedDirectDatabaseAliasConflict = false;

function parseDatabaseUrl(connectionString: string): URL {
  try {
    return new URL(connectionString);
  } catch {
    // Não inclua a URL/DSN no erro: ela pode conter credenciais.
    throw new Error('URL de banco inválida para a ordenação de conversas do Receps-IA.');
  }
}

export function removePoolerSuffixFromDatabaseUrl(
  connectionString: string
): string {
  const parsed = parseDatabaseUrl(connectionString);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.|$)/i, '');
  return parsed.toString();
}

export function databaseUrlHasPoolerHostname(
  connectionString: string
): boolean {
  return /(?:^|[.-])pooler(?:[.-]|$)/i.test(
    parseDatabaseUrl(connectionString).hostname
  );
}

export function resolveConversationOrderDatabaseUrl(
  env: ConversationOrderDatabaseEnv = process.env
): string {
  if (
    !warnedDirectDatabaseAliasConflict &&
    recepsIaEnvValuesConflict(
      env,
      'RECEPS_IA_DIRECT_DATABASE_URL',
      'ANA_DIRECT_DATABASE_URL'
    )
  ) {
    warnedDirectDatabaseAliasConflict = true;
    console.warn(
      '[Receps-IA] RECEPS_IA_DIRECT_DATABASE_URL e ANA_DIRECT_DATABASE_URL divergem; o nome canônico será usado.'
    );
  }
  const explicitDirectUrl =
    env.RECEPS_IA_DIRECT_DATABASE_URL?.trim() ||
    env.ANA_DIRECT_DATABASE_URL?.trim();
  if (explicitDirectUrl) {
    // Valida sem reescrever: quando o operador define a URL direta, ela é a
    // fonte autoritativa e o guard abaixo acusa eventual endpoint pooled.
    parseDatabaseUrl(explicitDirectUrl);
    if (databaseUrlHasPoolerHostname(explicitDirectUrl)) {
      throw new Error(
        'Endpoint pooled não é permitido para a ordenação de conversas do Receps-IA.'
      );
    }
    return explicitDirectUrl;
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      'RECEPS_IA_DIRECT_DATABASE_URL, ANA_DIRECT_DATABASE_URL ou DATABASE_URL não configurada para ordenar conversas.'
    );
  }
  const resolved = removePoolerSuffixFromDatabaseUrl(databaseUrl);
  if (databaseUrlHasPoolerHostname(resolved)) {
    throw new Error(
      'Endpoint pooled não é permitido para a ordenação de conversas do Receps-IA.'
    );
  }
  return resolved;
}

const conversationOrderDatabaseUrl = resolveConversationOrderDatabaseUrl();

const conversationOrderPool = new Pool({
  connectionString: conversationOrderDatabaseUrl,
  application_name: 'receps-ia-conversation-lock',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
  statement_timeout: 30_000,
});

conversationOrderPool.on('error', (error) => {
  console.error('[conversation-order] conexão ociosa do pool direto foi derrubada.');
  try {
    Sentry.captureException(new Error('conversation order direct pool client failed'), {
      level: 'warning',
      tags: {
        service: 'ana_conversation_order',
        operation: 'idle_client',
        error_kind: error.name,
      },
    });
  } catch {
    // O listener existe para impedir que um erro ocioso derrube o processo.
  }
});

export function canonicalCustomerPhone(customerPhone: string): string {
  const trimmed = customerPhone.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits || trimmed;
}

/** Forma explícita no fio para contratos internos: `+<wa_id>` (E.164). */
export function customerPhoneAsE164(customerPhone: string): string {
  const canonical = canonicalCustomerPhone(customerPhone);
  return /^\d+$/.test(canonical) ? `+${canonical}` : canonical;
}

export function canonicalConversationKey(
  phoneNumberId: string,
  customerPhone: string
): string {
  return `${phoneNumberId.trim()}:${canonicalCustomerPhone(customerPhone)}`;
}

/**
 * SHA-256 truncado em 64 bits com sinal, no domínio aceito por pg_advisory_lock.
 * O valor é estável entre processos/hosts e não depende do hash randômico do JS.
 */
export function conversationAdvisoryLockKey(
  phoneNumberId: string,
  customerPhone: string
): string {
  const digest = createHash('sha256')
    .update(canonicalConversationKey(phoneNumberId, customerPhone), 'utf8')
    .digest();
  return digest.readBigInt64BE(0).toString();
}

export interface ConversationLockDeps {
  connect: () => Promise<PoolClient>;
}

const defaultDeps: ConversationLockDeps = {
  connect: () => conversationOrderPool.connect(),
};

/** Expõe somente as stats do pool dedicado necessárias aos processos de smoke. */
export function getConversationOrderPoolStatsForSmoke(): {
  totalCount: number;
} {
  return { totalCount: conversationOrderPool.totalCount };
}

/** Fecha somente o pool dedicado em processos de smoke que terminam no mesmo Node. */
export async function closeConversationOrderPoolForSmoke(): Promise<void> {
  await conversationOrderPool.end();
}

/** Fecha o pool dedicado no encerramento gracioso do runtime. */
export async function closeConversationOrderPoolForShutdown(): Promise<void> {
  await closeConversationOrderPoolForSmoke();
}

export async function withConversationLock<T>(
  phoneNumberId: string,
  customerPhone: string,
  work: (client: PoolClient) => Promise<T>,
  deps: ConversationLockDeps = defaultDeps
): Promise<T> {
  const client = await deps.connect();
  const lockKey = conversationAdvisoryLockKey(phoneNumberId, customerPhone);
  let locked = false;
  let released = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
    locked = true;
    return await work(client);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } catch {
        // A conexão será descartada abaixo. Fechar a sessão também libera a
        // advisory lock; observabilidade aqui não pode mascarar o erro original.
        client.release(true);
        released = true;
      }
    }
    if (!released) client.release();
  }
}
