/**
 * Submete os templates transacionais da Onda OTP diretamente na Graph API.
 *
 * Usa, em ordem, os nomes explícitos do env e a mesma config multi-tenant que
 * o runtime consulta no ERP. Se o WABA não estiver no env, deriva-o pela Graph
 * a partir do phone_number_id do remetente. É idempotente por nome+idioma e
 * nunca imprime token, WABA/phone/template ID ou corpo cru de erro da Meta.
 *
 * Execução real (no host que possui o env do Receps-IA):
 *   npx tsx scripts/create-otp-templates.ts
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

type TemplateCategory = 'AUTHENTICATION' | 'UTILITY';

interface TemplateSpec {
  name: string;
  language: 'pt_BR';
  category: TemplateCategory;
  components: Array<Record<string, unknown>>;
}

interface MetaTemplate {
  name?: unknown;
  language?: unknown;
  status?: unknown;
  category?: unknown;
  components?: unknown;
}

interface MetaListResponse {
  data?: MetaTemplate[];
}

interface RuntimeBotConfig {
  tenantSlug?: unknown;
  botRole?: unknown;
  isActive?: unknown;
  phoneNumberId?: unknown;
  waAccessToken?: unknown;
}

interface RuntimeSender {
  phoneNumberId: string;
  accessToken: string | null;
}

const ACCESS_TOKEN_ENV_NAMES = [
  'WA_ACCESS_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'META_WHATSAPP_ACCESS_TOKEN',
] as const;

const PHONE_NUMBER_ID_ENV_NAMES = [
  'RECEPS_TRANSACTIONAL_PHONE_NUMBER_ID',
  'WA_PHONE_NUMBER_ID',
  'RENATA_PHONE_NUMBER_ID',
] as const;

const WABA_ID_ENV_NAMES = [
  'WA_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'META_WABA_ID',
] as const;

const AUTH_TEMPLATE_NAME =
  process.env.RECEPS_AUTH_OTP_TEMPLATE_NAME?.trim() ||
  'receps_auth_otp_v1';
const WELCOME_TEMPLATE_NAME =
  process.env.RECEPS_ONBOARDING_WELCOME_TEMPLATE_NAME?.trim() ||
  'receps_onboarding_welcome_v1';

export const OTP_TEMPLATE_SPECS: readonly TemplateSpec[] = [
  {
    name: AUTH_TEMPLATE_NAME,
    language: 'pt_BR',
    category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }],
      },
    ],
  },
  {
    name: WELCOME_TEMPLATE_NAME,
    language: 'pt_BR',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Conta criada ✅ Sou a Renata — qualquer dúvida na configuração, responde aqui que eu te ajudo.',
      },
    ],
  },
];

function firstConfiguredEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function numericId(value: string, reason: string): string {
  if (!/^\d+$/.test(value)) throw new Error(reason);
  return value;
}

function graphVersion(): string {
  const value = process.env.WA_API_VERSION?.trim() || 'v21.0';
  if (!/^v\d+\.\d+$/.test(value)) {
    throw new Error('invalid_env:WA_API_VERSION');
  }
  return value;
}

function templateEndpoint(version: string, wabaId: string): string {
  return `https://graph.facebook.com/${version}/${wabaId}/message_templates`;
}

function recepsBaseUrl(): string {
  return (
    process.env.RECEPS_INTERNAL_API_URL?.trim() ||
    process.env.ERP_BASE_URL?.trim() ||
    'http://localhost:3000'
  );
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function safeMetaFailure(status: number, body: unknown): Error {
  const graphError =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: unknown }).error
      : undefined;
  const record =
    graphError && typeof graphError === 'object'
      ? (graphError as Record<string, unknown>)
      : {};
  const code = typeof record.code === 'number' ? record.code : 'unknown';
  const subcode =
    typeof record.error_subcode === 'number'
      ? record.error_subcode
      : 'none';
  const type =
    typeof record.type === 'string' && /^[A-Za-z0-9_]+$/.test(record.type)
      ? record.type
      : 'unknown';
  return new Error(
    `meta_http_${status}:code=${code}:subcode=${subcode}:type=${type}`
  );
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const runtimeConfigCache = new Map<string, RuntimeBotConfig | null>();

async function fetchRuntimeSalesConfig(
  phoneNumberId: string
): Promise<RuntimeBotConfig | null> {
  if (runtimeConfigCache.has(phoneNumberId)) {
    return runtimeConfigCache.get(phoneNumberId) ?? null;
  }

  const erpToken = process.env.ERP_API_TOKEN?.trim();
  if (!erpToken) {
    runtimeConfigCache.set(phoneNumberId, null);
    return null;
  }

  const url = new URL('/api/v1/bot/config', recepsBaseUrl());
  url.searchParams.set('phoneNumberId', phoneNumberId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${erpToken}` },
  });
  if (response.status === 404) {
    runtimeConfigCache.set(phoneNumberId, null);
    return null;
  }
  if (!response.ok) {
    throw new Error(`runtime_config_http_${response.status}`);
  }

  const body = await parseJson(response);
  if (!body || typeof body !== 'object') {
    throw new Error('runtime_config_invalid_json');
  }
  const config = body as RuntimeBotConfig;
  const matchesSalesSender =
    config.tenantSlug === 'receps-vendas' &&
    config.botRole === 'sales' &&
    config.isActive === true &&
    typeof config.waAccessToken === 'string' &&
    config.waAccessToken.trim().length > 0 &&
    (config.phoneNumberId === undefined ||
      config.phoneNumberId === phoneNumberId);
  const result = matchesSalesSender ? config : null;
  runtimeConfigCache.set(phoneNumberId, result);
  return result;
}

async function salesFollowupPhoneNumberIds(): Promise<string[]> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return [];

  interface PgClientLike {
    connect(): Promise<void>;
    query(text: string): Promise<{
      rows: Array<{ phone_number_id?: unknown }>;
    }>;
    end(): Promise<void>;
  }

  let client: PgClientLike | null = null;
  try {
    const requireFromRuntime = createRequire(`${process.cwd()}/package.json`);
    const pg = requireFromRuntime('pg') as {
      Client: new (config: { connectionString: string }) => PgClientLike;
    };
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const result = await client.query(
      `SELECT DISTINCT phone_number_id
         FROM sales_followups
        WHERE phone_number_id ~ '^[0-9]+$'
        LIMIT 20`
    );
    return [
      ...new Set(
        result.rows
          .map((row) => row.phone_number_id)
          .filter((value): value is string => typeof value === 'string')
      ),
    ];
  } catch {
    throw new Error('runtime_sender_lookup_failed');
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

async function storedRuntimeWabaIds(
  phoneNumberId: string
): Promise<string[]> {
  let databaseUrl = process.env.RECEPS_ERP_DATABASE_URL?.trim() || '';
  const envFile = process.env.RECEPS_ERP_ENV_FILE?.trim();
  try {
    const requireFromRuntime = createRequire(`${process.cwd()}/package.json`);
    if (!databaseUrl && envFile) {
      const dotenv = requireFromRuntime('dotenv') as {
        parse(source: Buffer): Record<string, string>;
      };
      databaseUrl = dotenv.parse(readFileSync(envFile)).DATABASE_URL?.trim() || '';
    }
    if (!databaseUrl) return [];

    interface PgClientLike {
      connect(): Promise<void>;
      query(
        text: string,
        params: unknown[]
      ): Promise<{ rows: Array<{ wabaId?: unknown }> }>;
      end(): Promise<void>;
    }
    const pg = requireFromRuntime('pg') as {
      Client: new (config: { connectionString: string }) => PgClientLike;
    };
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      const result = await client.query(
        `SELECT "wabaId"
           FROM bot_configs
          WHERE "phoneNumberId" = $1
            AND "botRole" = 'sales'
            AND "isActive" = true
          LIMIT 2`,
        [phoneNumberId]
      );
      return [
        ...new Set(
          result.rows
            .map((row) => String(row.wabaId ?? ''))
            .filter((value) => /^\d+$/.test(value))
        ),
      ];
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    throw new Error(
      `runtime_erp_waba_lookup_failed:code=${/^[A-Z0-9]{5}$/.test(code) ? code : 'unknown'}`
    );
  }
}

async function resolveRuntimeSender(): Promise<RuntimeSender> {
  const explicitPhoneNumberId = firstConfiguredEnv(
    PHONE_NUMBER_ID_ENV_NAMES
  );
  if (explicitPhoneNumberId) {
    const phoneNumberId = numericId(
      explicitPhoneNumberId,
      'invalid_runtime_phone_number_id'
    );
    const config = await fetchRuntimeSalesConfig(phoneNumberId);
    return {
      phoneNumberId,
      accessToken:
        typeof config?.waAccessToken === 'string'
          ? config.waAccessToken.trim()
          : null,
    };
  }

  const candidates = await salesFollowupPhoneNumberIds();
  const matches: RuntimeSender[] = [];
  for (const candidate of candidates) {
    const phoneNumberId = numericId(
      candidate,
      'invalid_runtime_phone_number_id'
    );
    const config = await fetchRuntimeSalesConfig(phoneNumberId);
    if (typeof config?.waAccessToken === 'string') {
      matches.push({
        phoneNumberId,
        accessToken: config.waAccessToken.trim(),
      });
    }
  }

  if (matches.length === 0) throw new Error('runtime_sender_not_found');
  if (matches.length > 1) {
    throw new Error(`runtime_sender_ambiguous:count=${matches.length}`);
  }
  return matches[0]!;
}

function resolveAccessToken(sender: RuntimeSender): string {
  return (
    firstConfiguredEnv(ACCESS_TOKEN_ENV_NAMES) ||
    sender.accessToken ||
    (() => {
      throw new Error('runtime_access_token_not_found');
    })()
  );
}

async function resolveWabaId(
  version: string,
  sender: RuntimeSender,
  token: string
): Promise<string> {
  const explicit = firstConfiguredEnv(WABA_ID_ENV_NAMES);
  if (explicit) return numericId(explicit, 'invalid_runtime_waba_id');

  // A Graph documenta WABA → phone_numbers, mas não o inverso direto. O
  // debug_token expõe somente os target_ids autorizados para os escopos WA;
  // consultamos /<target>/phone_numbers e escolhemos o único que contém o
  // phone_number_id factual do remetente. Nenhum id/token é impresso.
  const debugUrl = new URL(
    `https://graph.facebook.com/${version}/debug_token`
  );
  debugUrl.searchParams.set('input_token', token);
  const debugResponse = await fetch(debugUrl, {
    headers: authHeaders(token),
  });
  const debugBody = await parseJson(debugResponse);
  if (!debugResponse.ok) {
    throw safeMetaFailure(debugResponse.status, debugBody);
  }
  const data =
    debugBody && typeof debugBody === 'object' && 'data' in debugBody
      ? (debugBody as { data?: unknown }).data
      : undefined;
  const granularScopes =
    data && typeof data === 'object' && 'granular_scopes' in data
      ? (data as { granular_scopes?: unknown }).granular_scopes
      : undefined;
  const topLevelScopes =
    data && typeof data === 'object' && 'scopes' in data
      ? (data as { scopes?: unknown }).scopes
      : undefined;
  let managementScopePresent =
    Array.isArray(topLevelScopes) &&
    topLevelScopes.includes('whatsapp_business_management');
  const targetIds = new Set<string>();
  if (Array.isArray(granularScopes)) {
    for (const entry of granularScopes) {
      if (!entry || typeof entry !== 'object') continue;
      const scope = (entry as { scope?: unknown }).scope;
      const targets = (entry as { target_ids?: unknown }).target_ids;
      if (scope === 'whatsapp_business_management') {
        managementScopePresent = true;
      }
      if (
        (scope !== 'whatsapp_business_management' &&
          scope !== 'whatsapp_business_messaging') ||
        !Array.isArray(targets)
      ) {
        continue;
      }
      for (const target of targets) {
        const normalizedTarget = String(target);
        if (/^\d+$/.test(normalizedTarget)) {
          targetIds.add(normalizedTarget);
        }
      }
    }
  }
  if (!managementScopePresent) {
    throw new Error(
      'runtime_token_scope_missing:whatsapp_business_management'
    );
  }

  // Tokens de system user podem declarar o escopo no topo sem granular
  // target_ids. Nesse caso a edge de assets atribuídos fornece os WABAs
  // candidatos; ainda validamos o phone_number_id pela edge /phone_numbers.
  const systemUserId =
    data && typeof data === 'object' && 'user_id' in data
      ? String((data as { user_id?: unknown }).user_id ?? '')
      : '';
  if (targetIds.size === 0 && /^\d+$/.test(systemUserId)) {
    const assignedUrl = new URL(
      `https://graph.facebook.com/${version}/${systemUserId}/assigned_whatsapp_business_accounts`
    );
    assignedUrl.searchParams.set('fields', 'id');
    assignedUrl.searchParams.set('limit', '100');
    const response = await fetch(assignedUrl, {
      headers: authHeaders(token),
    });
    const body = await parseJson(response);
    if (!response.ok) throw safeMetaFailure(response.status, body);
    const assigned =
      body && typeof body === 'object' && 'data' in body
        ? (body as { data?: unknown }).data
        : undefined;
    if (Array.isArray(assigned)) {
      for (const entry of assigned) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String((entry as { id?: unknown }).id ?? '');
        if (/^\d+$/.test(id)) targetIds.add(id);
      }
    }
  }
  for (const storedWabaId of await storedRuntimeWabaIds(
    sender.phoneNumberId
  )) {
    targetIds.add(storedWabaId);
  }

  const matches: string[] = [];
  let phoneObjectsSeen = 0;
  for (const candidateWabaId of targetIds) {
    const phonesUrl = new URL(
      `https://graph.facebook.com/${version}/${candidateWabaId}/phone_numbers`
    );
    phonesUrl.searchParams.set('fields', 'id');
    phonesUrl.searchParams.set('limit', '100');
    const response = await fetch(phonesUrl, {
      headers: authHeaders(token),
    });
    const body = await parseJson(response);
    if (!response.ok) throw safeMetaFailure(response.status, body);
    const phones =
      body && typeof body === 'object' && 'data' in body
        ? (body as { data?: unknown }).data
        : undefined;
    if (Array.isArray(phones)) phoneObjectsSeen += phones.length;
    if (
      Array.isArray(phones) &&
      phones.some(
        (phone) =>
          phone &&
          typeof phone === 'object' &&
          String((phone as { id?: unknown }).id ?? '') ===
            sender.phoneNumberId
      )
    ) {
      matches.push(candidateWabaId);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `runtime_waba_not_found:targets=${targetIds.size}:phones=${phoneObjectsSeen}`
    );
  }
  if (matches.length > 1) {
    throw new Error(`runtime_waba_ambiguous:count=${matches.length}`);
  }
  return matches[0]!;
}

async function findTemplate(
  endpoint: string,
  token: string,
  spec: TemplateSpec
): Promise<MetaTemplate | null> {
  const url = new URL(endpoint);
  url.searchParams.set('name', spec.name);
  url.searchParams.set(
    'fields',
    'name,language,status,category,components'
  );
  url.searchParams.set('limit', '100');

  const response = await fetch(url, { headers: authHeaders(token) });
  const body = await parseJson(response);
  if (!response.ok) throw safeMetaFailure(response.status, body);
  const data = (body as MetaListResponse | null)?.data;
  if (!Array.isArray(data)) return null;
  return (
    data.find(
      (entry) =>
        entry?.name === spec.name && entry?.language === spec.language
    ) ?? null
  );
}

function utilityBody(template: MetaTemplate): string | null {
  if (!Array.isArray(template.components)) return null;
  for (const component of template.components) {
    if (!component || typeof component !== 'object') continue;
    const record = component as Record<string, unknown>;
    if (String(record.type).toUpperCase() !== 'BODY') continue;
    return typeof record.text === 'string' ? record.text : null;
  }
  return null;
}

function assertExistingCompatible(
  existing: MetaTemplate,
  spec: TemplateSpec
): void {
  const category = String(existing.category ?? '').toUpperCase();
  const acceptedCategories =
    spec.category === 'UTILITY'
      ? new Set(['UTILITY', 'MARKETING'])
      : new Set(['AUTHENTICATION']);
  if (!acceptedCategories.has(category)) {
    throw new Error(`existing_template_category_mismatch:${spec.name}`);
  }

  if (spec.category === 'UTILITY') {
    const desiredBody = String(spec.components[0]?.text ?? '');
    if (utilityBody(existing) !== desiredBody) {
      throw new Error(`existing_template_body_mismatch:${spec.name}`);
    }
  }
}

async function createTemplate(
  endpoint: string,
  token: string,
  spec: TemplateSpec
): Promise<MetaTemplate> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(spec),
  });
  const body = await parseJson(response);
  if (!response.ok) throw safeMetaFailure(response.status, body);
  return body && typeof body === 'object' ? (body as MetaTemplate) : {};
}

function safeStatus(value: unknown): string {
  const normalized = String(value ?? 'UNKNOWN').toUpperCase();
  return /^[A-Z_]+$/.test(normalized) ? normalized : 'UNKNOWN';
}

function safeCategory(value: unknown, fallback: TemplateCategory): string {
  const normalized = String(value ?? fallback).toUpperCase();
  return /^[A-Z_]+$/.test(normalized) ? normalized : fallback;
}

async function submitTemplate(
  endpoint: string,
  token: string,
  spec: TemplateSpec
): Promise<{ category: string; status: string }> {
  const existing = await findTemplate(endpoint, token, spec);
  if (existing) {
    assertExistingCompatible(existing, spec);
    return {
      category: safeCategory(existing.category, spec.category),
      status: safeStatus(existing.status),
    };
  }

  const created = await createTemplate(endpoint, token, spec);
  const resolved =
    created.status || created.category
      ? created
      : (await findTemplate(endpoint, token, spec)) ?? created;
  return {
    category: safeCategory(resolved.category, spec.category),
    status: safeStatus(resolved.status),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--dry-run')) {
    for (const spec of OTP_TEMPLATE_SPECS) {
      console.log(
        `${spec.name} | ${spec.language} | ${spec.category} | NOT_SUBMITTED`
      );
    }
    return;
  }

  const version = graphVersion();
  const sender = await resolveRuntimeSender();
  const token = resolveAccessToken(sender);
  const wabaId = await resolveWabaId(version, sender, token);
  if (process.argv.includes('--preflight')) {
    console.log('preflight=ok');
    return;
  }
  const endpoint = templateEndpoint(version, wabaId);

  for (const spec of OTP_TEMPLATE_SPECS) {
    const result = await submitTemplate(endpoint, token, spec);
    console.log(
      `${spec.name} | ${spec.language} | ${result.category} | ${result.status}`
    );
  }
}

main().catch((error) => {
  const safeMessage =
    error instanceof Error &&
    /^(?:missing_env|invalid_env|meta_http_|existing_template_|runtime_)/.test(
      error.message
    )
      ? error.message
      : 'template_submission_failed';
  console.error(safeMessage);
  process.exitCode = 1;
});
