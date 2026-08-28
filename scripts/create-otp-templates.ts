/**
 * Submete os templates transacionais da Onda OTP diretamente na Graph API.
 *
 * Requer no ambiente: WA_BUSINESS_ACCOUNT_ID, WA_ACCESS_TOKEN e, opcionalmente,
 * WA_API_VERSION. É idempotente por nome+idioma e nunca imprime token, WABA ID,
 * template ID ou corpo cru de erro da Meta.
 *
 * Execução real (no host que possui o env do Receps-IA):
 *   npx tsx scripts/create-otp-templates.ts
 */

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

function requiredEnv(name: 'WA_BUSINESS_ACCOUNT_ID' | 'WA_ACCESS_TOKEN'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
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

  const wabaId = requiredEnv('WA_BUSINESS_ACCOUNT_ID');
  const token = requiredEnv('WA_ACCESS_TOKEN');
  const endpoint = templateEndpoint(graphVersion(), wabaId);

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
    /^(?:missing_env|invalid_env|meta_http_|existing_template_)/.test(
      error.message
    )
      ? error.message
      : 'template_submission_failed';
  console.error(safeMessage);
  process.exitCode = 1;
});
