import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DATABASE_PREFIX = 'receps_incident_smoke_';
const CONFIRMATION = 'DISPOSABLE_LOCAL_DATABASES_ONLY';

function runCommand(
  cwd: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} falhou em ${cwd} (exit ${result.status ?? 'null'})`
    );
  }
}

function runNpm(cwd: string, script: string, env: NodeJS.ProcessEnv): void {
  runCommand(cwd, 'npm', ['run', script], env);
}

function commandOutput(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} falhou em ${cwd}: ${result.stderr.trim()}`
    );
  }
  return result.stdout.trim();
}

function requireDisposableDatabaseUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} é obrigatório.`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} não é uma URL PostgreSQL válida.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${name} deve usar postgres:// ou postgresql://.`);
  }
  if (!ALLOWED_TEST_HOSTS.has(parsed.hostname)) {
    throw new Error(`${name} deve apontar exclusivamente para PostgreSQL local.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.startsWith(DATABASE_PREFIX)) {
    throw new Error(
      `${name} deve usar database com prefixo ${DATABASE_PREFIX}.`
    );
  }
  return raw;
}

function requireCoordinatedCheckout(
  rootInput: string,
  expectedPackageName: string,
  expectedHeadEnv: string
): string {
  const root = realpathSync(path.resolve(rootInput));
  const gitRoot = realpathSync(commandOutput(root, 'git', ['rev-parse', '--show-toplevel']));
  if (root !== gitRoot) {
    throw new Error(`Checkout coordenado inválido: ${root} não é a raiz Git ${gitRoot}.`);
  }
  const pkg = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  ) as { name?: unknown };
  if (pkg.name !== expectedPackageName) {
    throw new Error(
      `Checkout ${root} tem package ${String(pkg.name)}, esperado ${expectedPackageName}.`
    );
  }
  const expectedHead = process.env[expectedHeadEnv]?.trim();
  if (!expectedHead || !/^[0-9a-f]{40}$/u.test(expectedHead)) {
    throw new Error(`${expectedHeadEnv} deve conter o SHA Git completo esperado.`);
  }
  const actualHead = commandOutput(root, 'git', ['rev-parse', 'HEAD']);
  if (actualHead !== expectedHead) {
    throw new Error(
      `${expectedHeadEnv} não confere: checkout=${actualHead} esperado=${expectedHead}.`
    );
  }
  const status = commandOutput(root, 'git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const unexpected = status
    .split('\n')
    .filter(Boolean)
    // Worktree local compartilha as dependências por um symlink deliberadamente
    // não versionado; ele não compõe o artefato publicado. Todo código/config/
    // teste, inclusive untracked, precisa estar dentro do commit atestado.
    .filter((line) => !/^\?\? node_modules(?:\/|$)/u.test(line));
  if (unexpected.length > 0) {
    throw new Error(
      `Checkout ${root} não está limpo para release: ${unexpected.join(' | ')}`
    );
  }
  return root;
}

async function assertDisposableMarker(
  databaseUrl: string,
  role: 'runtime' | 'erp',
  nonce: string
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const expectedMarker = `receps-incident-smoke:${role}:${nonce}`;
    const result = await client.query<{ marker: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS marker
       FROM pg_database
       WHERE datname = current_database()`,
      []
    );
    if (result.rows[0]?.marker !== expectedMarker) {
      throw new Error(`marker ausente para ${role}`);
    }
  } catch (error) {
    throw new Error(
      `Banco ${role} não possui o marker descartável esperado: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.env.ANA_SMOKE_SKIP_DB === '1') {
    throw new Error('ANA_SMOKE_SKIP_DB=1 é proibido no gate de release do incidente.');
  }
  if (process.env.RECEPS_INCIDENT_TEST_DB_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `RECEPS_INCIDENT_TEST_DB_CONFIRM deve ser exatamente ${CONFIRMATION}.`
    );
  }
  const nonce = process.env.RECEPS_INCIDENT_TEST_DB_NONCE?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{24,128}$/u.test(nonce)) {
    throw new Error(
      'RECEPS_INCIDENT_TEST_DB_NONCE deve ter 24-128 caracteres seguros.'
    );
  }

  const runtimeDatabaseUrl = requireDisposableDatabaseUrl(
    'RECEPS_RUNTIME_TEST_DATABASE_URL'
  );
  const erpDatabaseUrl = requireDisposableDatabaseUrl(
    'RECEPS_ERP_TEST_DATABASE_URL'
  );
  if (runtimeDatabaseUrl === erpDatabaseUrl) {
    throw new Error('Runtime e ERP devem usar bancos descartáveis distintos.');
  }

  const runtimeRoot = requireCoordinatedCheckout(
    path.resolve(import.meta.dirname, '..'),
    'receps-ia-runtime',
    'RECEPS_RUNTIME_EXPECTED_HEAD'
  );
  const erpRootInput = process.env.RECEPS_ERP_ROOT?.trim();
  if (!erpRootInput) {
    throw new Error('RECEPS_ERP_ROOT deve apontar para o checkout ERP coordenado.');
  }
  const erpRoot = requireCoordinatedCheckout(
    erpRootInput,
    'receps-erp',
    'RECEPS_ERP_EXPECTED_HEAD'
  );

  await Promise.all([
    assertDisposableMarker(runtimeDatabaseUrl, 'runtime', nonce),
    assertDisposableMarker(erpDatabaseUrl, 'erp', nonce),
  ]);

  const commonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANA_SMOKE_SKIP_DB: '0',
    // Build local não publica sourcemaps nem cria release externo.
    SENTRY_AUTH_TOKEN: '',
    SENTRY_ORG: '',
    SENTRY_PROJECT: '',
    SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'incident-smoke',
    SENTRY_RELEASE: '',
    RECEPS_IA_SENTRY_DSN: '',
    ANA_SENTRY_DSN: '',
    RECEPS_IA_RELEASE: '',
    ANA_RELEASE: '',
    RECEPS_IA_SENTRY_ENVIRONMENT: 'incident-smoke',
    ANA_SENTRY_ENVIRONMENT: 'incident-smoke',
  };
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...commonEnv,
    DATABASE_URL: runtimeDatabaseUrl,
    RECEPS_IA_DIRECT_DATABASE_URL: runtimeDatabaseUrl,
    ANA_DIRECT_DATABASE_URL: runtimeDatabaseUrl,
  };
  const erpEnv: NodeJS.ProcessEnv = {
    ...commonEnv,
    DATABASE_URL: erpDatabaseUrl,
    DIRECT_URL: erpDatabaseUrl,
    RECEPS_IA_DIRECT_DATABASE_URL: '',
    ANA_DIRECT_DATABASE_URL: '',
  };

  runCommand(runtimeRoot, 'git', ['diff', '--check'], runtimeEnv);
  runNpm(runtimeRoot, 'build', runtimeEnv);
  runNpm(runtimeRoot, 'smoke:ana-incident-suite', runtimeEnv);
  runNpm(runtimeRoot, 'smoke:ana-incident-db-suite', runtimeEnv);

  runCommand(erpRoot, 'git', ['diff', '--check'], erpEnv);
  runCommand(erpRoot, 'npx', ['prisma', 'generate'], erpEnv);
  runCommand(erpRoot, 'npx', ['prisma', 'migrate', 'deploy'], erpEnv);
  runNpm(erpRoot, 'typecheck', erpEnv);
  runNpm(erpRoot, 'lint', erpEnv);
  runNpm(erpRoot, 'build', erpEnv);
  runNpm(erpRoot, 'smoke:bot-customer-identity', erpEnv);
  runNpm(erpRoot, 'smoke:public-booking-auth', erpEnv);
  runNpm(erpRoot, 'smoke:bot-availability', erpEnv);
  runNpm(erpRoot, 'smoke:ana-technical-maintenance', erpEnv);
  runNpm(erpRoot, 'smoke:ana-resume-gate', erpEnv);
  runNpm(erpRoot, 'smoke:pause-state-schedule', erpEnv);

  console.log(
    `gate coordenado Ana OK | runtime=${commandOutput(runtimeRoot, 'git', ['rev-parse', '--short=12', 'HEAD'])}:${commandOutput(runtimeRoot, 'git', ['rev-parse', '--short=12', 'HEAD^{tree}'])} | erp=${commandOutput(erpRoot, 'git', ['rev-parse', '--short=12', 'HEAD'])}:${commandOutput(erpRoot, 'git', ['rev-parse', '--short=12', 'HEAD^{tree}'])}`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
