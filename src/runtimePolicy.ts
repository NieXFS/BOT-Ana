import { createHash, timingSafeEqual } from 'crypto';

export type AnaRuntimeMode = 'production' | 'lab';
export type LabWritePolicy = 'disabled';

type RuntimeEnvironment = Record<string, string | undefined>;

export interface AnaProductionRuntimeConfig {
  mode: 'production';
  backgroundJobs: true;
  bindHost: string | undefined;
}

export interface AnaLabRuntimeConfig {
  mode: 'lab';
  writePolicy: 'disabled';
  globalBackgroundJobs: false;
  v2RecoveryJobs: boolean;
  bindHost: '127.0.0.1';
  allowedTenantSlugs: ReadonlySet<string>;
  allowedPhoneNumberIds: ReadonlySet<string>;
  allowedCustomerPhones: ReadonlySet<string>;
  databaseFingerprint: string;
}

export type AnaRuntimeConfig =
  | AnaProductionRuntimeConfig
  | AnaLabRuntimeConfig;

export const LAB_WRITE_DISABLED_REASON = 'lab_write_disabled' as const;

export interface LabBlockedWriteEffect {
  success: false;
  class: 'write';
  outcome: 'blocked';
  writeCommitted: false;
  reason: typeof LAB_WRITE_DISABLED_REASON;
  message: string;
}

export class LabWriteDisabledError extends Error {
  readonly reason = LAB_WRITE_DISABLED_REASON;
  readonly writeCommitted = false;

  constructor() {
    super('LAB external write disabled');
    this.name = 'LabWriteDisabledError';
  }
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveAnaRuntimeMode(
  env: RuntimeEnvironment = process.env
): AnaRuntimeMode {
  const raw = trimmed(env.ANA_RUNTIME_MODE);
  if (!raw || raw === 'production') return 'production';
  if (raw === 'lab') return 'lab';
  throw new Error('ANA_RUNTIME_MODE inválido.');
}

/**
 * Tag técnica best-effort usada antes do boot pelo Sentry. Um valor inválido
 * continua falhando no resolver autoritativo; aqui nunca anexamos o valor cru.
 */
export function safeAnaRuntimeModeTag(
  env: RuntimeEnvironment = process.env
): AnaRuntimeMode | 'invalid' {
  try {
    return resolveAnaRuntimeMode(env);
  } catch {
    return 'invalid';
  }
}

function parseRequiredAllowlist(
  env: RuntimeEnvironment,
  name:
    | 'ANA_LAB_ALLOWED_TENANT_SLUGS'
    | 'ANA_LAB_ALLOWED_PHONE_NUMBER_IDS'
    | 'ANA_LAB_ALLOWED_CUSTOMER_PHONES',
  normalize: (entry: string) => string = (entry) => entry
): ReadonlySet<string> {
  const raw = trimmed(env[name]);
  if (!raw) throw new Error(`${name} é obrigatória no LAB.`);
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error(`${name} não pode ser vazia.`);
  if (entries.includes('*')) throw new Error(`${name} não aceita wildcard.`);
  const normalized = entries.map(normalize).filter(Boolean);
  if (normalized.length === 0) throw new Error(`${name} não pode ser vazia.`);
  return new Set(normalized);
}

/**
 * Mesma forma estável usada nas chaves de conversa: números formatados viram
 * somente dígitos; valores sintéticos de smoke continuam comparáveis sem serem
 * confundidos com telefone real.
 */
export function canonicalLabCustomerPhone(customerPhone: string): string {
  const value = customerPhone.trim();
  if (!/^[+\d\s().-]+$/.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  return digits || value;
}

export function labV2RecoveryJobsEnabled(
  allowedTenantSlugs: ReadonlySet<string>,
  rawV2Allowlist: string | undefined
): boolean {
  const entries = rawV2Allowlist
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  if (entries.includes('*')) return false;
  return entries.some((entry) => allowedTenantSlugs.has(entry));
}

/**
 * Identidade sanitizada: protocolo/host/porta/database. Usuário, senha,
 * query-string e fragmento nunca participam do hash nem de logs.
 */
export function sanitizedDatabaseIdentity(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL inválida para fingerprint do LAB.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL do LAB precisa usar PostgreSQL.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim();
  if (!parsed.hostname || !database) {
    throw new Error('DATABASE_URL do LAB não identifica host/database.');
  }
  const protocol = parsed.protocol === 'postgres:' ? 'postgresql:' : parsed.protocol;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  return `${protocol}//${host}:${port}/${database}`;
}

export function databaseFingerprint(databaseUrl: string): string {
  return createHash('sha256')
    .update(sanitizedDatabaseIdentity(databaseUrl), 'utf8')
    .digest('hex');
}

function fingerprintsMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(expected)) return false;
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected.toLowerCase(), 'hex');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function resolveAnaRuntimeConfig(
  env: RuntimeEnvironment = process.env
): AnaRuntimeConfig {
  const mode = resolveAnaRuntimeMode(env);
  if (mode === 'production') {
    return {
      mode,
      backgroundJobs: true,
      // Produção preserva o listen histórico em todas as interfaces. HOST é
      // uma cerca explícita do processo LAB, não uma flag de deploy produtivo.
      bindHost: undefined,
    };
  }

  const rawWritePolicy = trimmed(env.LAB_WRITE_POLICY) ?? 'disabled';
  if (rawWritePolicy !== 'disabled') {
    throw new Error('LAB_WRITE_POLICY inválida.');
  }
  if (trimmed(env.HOST) !== '127.0.0.1') {
    throw new Error('HOST precisa ser 127.0.0.1 no LAB.');
  }
  if (
    trimmed(env.RECEPS_IA_DIRECT_DATABASE_URL) ||
    trimmed(env.ANA_DIRECT_DATABASE_URL)
  ) {
    throw new Error('O LAB usa exclusivamente DATABASE_URL para storage local.');
  }

  const databaseUrl = trimmed(env.DATABASE_URL);
  const expectedFingerprint = trimmed(env.ANA_LAB_DATABASE_FINGERPRINT);
  if (!databaseUrl || !expectedFingerprint) {
    throw new Error('Fingerprint do storage LAB ausente.');
  }
  const actualFingerprint = databaseFingerprint(databaseUrl);
  if (!fingerprintsMatch(actualFingerprint, expectedFingerprint)) {
    throw new Error('Fingerprint do storage LAB não confere.');
  }

  const allowedTenantSlugs = parseRequiredAllowlist(
    env,
    'ANA_LAB_ALLOWED_TENANT_SLUGS'
  );

  return {
    mode,
    writePolicy: rawWritePolicy,
    globalBackgroundJobs: false,
    v2RecoveryJobs: labV2RecoveryJobsEnabled(
      allowedTenantSlugs,
      env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS
    ),
    bindHost: '127.0.0.1',
    allowedTenantSlugs,
    allowedPhoneNumberIds: parseRequiredAllowlist(
      env,
      'ANA_LAB_ALLOWED_PHONE_NUMBER_IDS'
    ),
    allowedCustomerPhones: parseRequiredAllowlist(
      env,
      'ANA_LAB_ALLOWED_CUSTOMER_PHONES',
      canonicalLabCustomerPhone
    ),
    databaseFingerprint: actualFingerprint,
  };
}

export function isAnaLabRuntime(
  env: RuntimeEnvironment = process.env
): boolean {
  return resolveAnaRuntimeMode(env) === 'lab';
}

export function labBlockedWriteEffect(
  operation: string,
  env: RuntimeEnvironment = process.env
): LabBlockedWriteEffect | null {
  if (!isAnaLabRuntime(env)) return null;
  return {
    success: false,
    class: 'write',
    outcome: 'blocked',
    writeCommitted: false,
    reason: LAB_WRITE_DISABLED_REASON,
    message: `INTERNAL_HINT: ${operation} foi bloqueado pela política de escrita do LAB. Não afirme que a operação foi concluída.`,
  };
}

export function assertExternalWriteAllowed(
  env: RuntimeEnvironment = process.env
): void {
  if (isAnaLabRuntime(env)) throw new LabWriteDisabledError();
}

export function labPhoneNumberAllowed(
  phoneNumberId: string,
  env: RuntimeEnvironment = process.env
): boolean {
  const config = resolveAnaRuntimeConfig(env);
  return (
    config.mode === 'production' ||
    config.allowedPhoneNumberIds.has(phoneNumberId.trim())
  );
}

export function labCustomerPhoneAllowed(
  customerPhone: string,
  env: RuntimeEnvironment = process.env
): boolean {
  const config = resolveAnaRuntimeConfig(env);
  return (
    config.mode === 'production' ||
    config.allowedCustomerPhones.has(canonicalLabCustomerPhone(customerPhone))
  );
}
