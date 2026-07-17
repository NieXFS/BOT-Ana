import crypto from 'crypto';
import axios from 'axios';
import { Sentry } from '../observability/sentry';
import { ERP_API_TOKEN } from '../erpApiToken';
import type { SalesConfig } from '../salesConfigProvider';
import { markFollowupOptedOut } from './salesFollowups';

/**
 * Ferramentas de VENDAS da Renata (Workstream B). Substituem/complementam as de
 * agenda: link de cadastro (URL builder puro), registro de lead qualificado e
 * handoff pro Victor. Escrevem no Receps via o padrão de API do bot
 * (Bearer ERP_API_TOKEN). SEM PII em log (só phoneNumberId / status).
 *
 * `scheduleDemo` NÃO mora aqui: reusa `calendarService` (bookAppointment) no
 * próprio tenant receps-vendas — zero código novo de booking (ver salesBrain).
 */

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

// Atribuição CTWA (Workstream C pluga o ctwa_clid real depois).
const UTM = 'utm_source=whatsapp&utm_medium=renata&utm_campaign=ctwa';

/**
 * ⚠️ NUNCA entregue o AxiosError CRU ao Sentry: ele carrega `config.data`, que
 * aqui é o payload do lead (telefone, e-mail, nome, clínica) — o scrub não
 * garante remover esse JSON sob a chave genérica `data`. Capturamos um erro
 * SINTÉTICO, preservando operação e status HTTP sem anexar PII. Mesmo padrão
 * (e mesma razão) do `capture()` de `salesEvents.ts`.
 */
function capture(error: unknown, operation: string, phoneNumberId?: string): void {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const detail = status
    ? `HTTP ${status}`
    : axios.isAxiosError(error)
      ? error.code ?? error.message
      : String(error);

  Sentry.captureException(new Error(`sales-tools ${operation} failed (${detail})`), {
    tags: { service: 'sales-tools', operation, ...(phoneNumberId ? { phoneNumberId } : {}) },
  });
  console.error(`❌ [sales-tools] falha em ${operation}: ${detail}`);
}

/**
 * Hash estável e curto do telefone p/ atribuição SEM expor o número cru na URL
 * (SHA-256 truncado). Vira `cid=wa:<hash>` até o Workstream C ligar o ctwa_clid.
 */
export function hashPhoneForCid(phone: string): string {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

export type SignupLinkResult =
  | { success: true; url: string; plan: string; interval: 'monthly' | 'annual' }
  | { success: false; message: string; waitlistHref?: string };

/**
 * Monta o link de cadastro do plano (URL builder PURO). Valida contra a
 * salesConfig: plano inexistente → recusa listando os válidos; plano em fase de
 * testes (beta) → recusa e devolve o link da lista de espera. `cid` usa o
 * ctwaClid quando existir (C1), senão `wa:<hash-telefone>`.
 */
export function buildSignupLink(
  planInput: string,
  intervalInput: string | undefined,
  phone: string,
  config: SalesConfig,
  ctwaClid?: string | null
): SignupLinkResult {
  const slug = (planInput ?? '').trim().toLowerCase();
  const plan = config.plans.find((p) => p.slug.toLowerCase() === slug);

  if (!plan) {
    const valid = config.plans.map((p) => p.slug).join(', ');
    return {
      success: false,
      message: `Plano "${planInput}" não existe. Planos válidos: ${valid}.`,
    };
  }

  if (!plan.sellable) {
    const href = plan.waitlist?.href ?? config.anaBeta.waitlistHref;
    return {
      success: false,
      message: `O plano ${plan.name} está em fase de testes e não é vendido agora. Ofereça a lista de espera.`,
      waitlistHref: href,
    };
  }

  const interval: 'monthly' | 'annual' =
    (intervalInput ?? '').trim().toLowerCase() === 'annual' ? 'annual' : 'monthly';

  const cid = ctwaClid?.trim() ? ctwaClid.trim() : `wa:${hashPhoneForCid(phone)}`;

  const params = new URLSearchParams();
  params.set('plan', plan.slug);
  if (interval === 'annual') {
    params.set('interval', 'annual');
  }
  // UTM em texto fixo (não re-encode) + atribuição. URLSearchParams cuida do cid.
  params.set('cid', cid);

  const url = `${config.signupBaseUrl}?${UTM}&${params.toString()}`;
  return { success: true, url, plan: plan.slug, interval };
}

export type PrefilledSignupInput = {
  email: string;
  name?: string;
  clinicName?: string;
  plan: string;
  interval?: string;
};

/**
 * Link mágico de cadastro pré-preenchido (v1.1): a Renata já coletou e-mail,
 * nome, clínica e plano — o link leva tudo isso e o lead só cria a senha.
 *
 * Valida o plano ANTES da chamada com a MESMA função do `sendSignupLink`
 * (`buildSignupLink`): plano inexistente/em fase de testes volta a mesma
 * mensagem e a lista de espera, sem gastar round-trip. O servidor revalida de
 * qualquer jeito (422) — esta checagem é UX, não segurança.
 *
 * O `ctwaClid` NÃO vai daqui: o Receps tira o snapshot do SalesLead, que já tem
 * a atribuição capturada do referral (C1). O evento `link_enviado` também é
 * emitido lá — a Ana não emite no caminho do prefill (seria contagem dupla).
 *
 * Nunca lança: erro vira { success:false } e a Renata cai no sendSignupLink.
 */
export async function createPrefilledSignupLink(
  phone: string,
  phoneNumberId: string,
  input: PrefilledSignupInput,
  config: SalesConfig
): Promise<SignupLinkResult> {
  const validation = buildSignupLink(input.plan, input.interval, phone, config);
  if (!validation.success) {
    return validation;
  }

  try {
    const { data } = await axios.post<{ url?: string }>(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/signup-prefill`,
      {
        customerPhone: phone,
        email: input.email,
        name: input.name,
        clinicName: input.clinicName,
        plan: validation.plan,
        interval: validation.interval,
      },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    if (!data?.url) {
      return { success: false, message: 'Não consegui gerar o link agora.' };
    }

    return { success: true, url: data.url, plan: validation.plan, interval: validation.interval };
  } catch (error) {
    capture(error, 'create-prefilled-signup', phoneNumberId);
    return {
      success: false,
      message: 'Não consegui gerar o link com os dados agora. Mande o link normal de cadastro.',
    };
  }
}

export type QualifiedLeadPayload = {
  name?: string;
  clinicName?: string;
  professionalsCount?: number;
  whatsappVolume?: string;
  currentSystem?: string;
  mainPain?: string;
  recommendedPlan?: string;
  score?: number;
  status?: string;
};

// Status que encerram a régua de follow-up (convertido / perdido / opt-out).
const TERMINAL_STATUSES = new Set(['trial', 'pagante', 'perdido', 'optout']);

/**
 * Registra/atualiza o lead no funil (POST /api/v1/bot/sales-lead). Injeta o
 * telefone (o modelo NÃO fornece). Status terminal → encerra a régua de
 * follow-up (best-effort). Nunca lança: erro vira { success:false }.
 */
export async function registerQualifiedLead(
  phone: string,
  phoneNumberId: string,
  payload: QualifiedLeadPayload
): Promise<{ success: boolean; message?: string }> {
  const status = payload.status ?? 'qualificado';
  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/sales-lead`,
      { ...payload, status, customerPhone: phone },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
  } catch (error) {
    capture(error, 'register-qualified-lead', phoneNumberId);
    return { success: false, message: 'Não consegui registrar agora.' };
  }

  if (TERMINAL_STATUSES.has(status)) {
    await markFollowupOptedOut(phoneNumberId, phone).catch(() => undefined);
  }

  return { success: true };
}

/**
 * Handoff pro Victor: (1) registra o lead com status "handoff" + motivo (dispara
 * o e-mail interno no Receps); (2) pausa a conversa (source=handoff → MANUAL) pra
 * Renata calar até o Victor assumir; (3) encerra a régua de follow-up. Cada passo
 * é best-effort; nunca lança. Devolve uma dica pra Renata avisar o lead.
 */
export async function handoffToHuman(
  phone: string,
  phoneNumberId: string,
  reason: string,
  payload: QualifiedLeadPayload = {}
): Promise<{ success: boolean; message: string }> {
  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/sales-lead`,
      { ...payload, status: 'handoff', reason, customerPhone: phone },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
  } catch (error) {
    capture(error, 'handoff-register', phoneNumberId);
  }

  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/pause-conversation`,
      { phoneNumberId, customerPhone: phone, source: 'handoff' },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
  } catch (error) {
    capture(error, 'handoff-pause', phoneNumberId);
  }

  await markFollowupOptedOut(phoneNumberId, phone).catch(() => undefined);

  return {
    success: true,
    message:
      'Lead transferido pro Victor e conversa pausada. Avise o lead que o Victor responde por aqui mesmo já já.',
  };
}
