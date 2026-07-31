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
 * salesConfig: plano inexistente → recusa listando os válidos; plano
 * temporariamente pausado → recusa e devolve o link da lista de interesse. `cid` usa o
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
      message: `O plano ${plan.name} está sendo atualizado e não é vendido agora. Ofereça a lista de interesse e o Essencial como opção com a Ana disponível.`,
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
  niche?: string;
  professionalsCount?: number;
};

export const PREFILL_NICHES = [
  'estetica_facial_corporal',
  'sobrancelhas_cilios',
  'podologia',
  'depilacao',
  'outro',
] as const;

export type PrefilledSignupLinkResult =
  | {
      success: true;
      url: string;
      prefilled: true;
      plan: string;
      interval: 'monthly' | 'annual';
    }
  | {
      success: true;
      url: string;
      prefilled: false;
      plan: string;
      interval: 'monthly' | 'annual';
      fallbackReason: 'prefill_indisponivel';
      warning: string;
    }
  | { success: false; message: string; waitlistHref?: string };

/**
 * Link mágico de cadastro pré-preenchido (v1.2): a Renata já coletou e-mail,
 * nome, clínica, plano e, quando disponíveis, nicho/número de profissionais —
 * o link leva tudo isso e o lead só cria a senha.
 *
 * Valida o plano ANTES da chamada com a MESMA função do `sendSignupLink`
 * (`buildSignupLink`): plano inexistente/temporariamente pausado volta a mesma
 * mensagem e a lista de interesse, sem gastar round-trip. O servidor revalida de
 * qualquer jeito (422) — esta checagem é UX, não segurança.
 *
 * O `ctwaClid` NÃO vai daqui: o Receps tira o snapshot do SalesLead, que já tem
 * a atribuição capturada do referral (C1). O evento `link_enviado` também é
 * emitido lá — a Ana não emite no caminho do prefill (seria contagem dupla).
 *
 * Nunca lança: se o prefill estiver indisponível, a própria tool devolve o link
 * comum já validado, marcado como `prefilled:false`, e instrui a Renata a não
 * prometer dados pré-preenchidos. Plano inválido/pausado mantém a recusa original.
 */
export async function createPrefilledSignupLink(
  phone: string,
  phoneNumberId: string,
  input: PrefilledSignupInput,
  config: SalesConfig
): Promise<PrefilledSignupLinkResult> {
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
        ...(input.niche !== undefined ? { niche: input.niche } : {}),
        ...(input.professionalsCount !== undefined
          ? { professionalsCount: input.professionalsCount }
          : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    if (!data?.url) return buildPrefillFallback(validation);

    return {
      success: true,
      url: data.url,
      prefilled: true,
      plan: validation.plan,
      interval: validation.interval,
    };
  } catch (error) {
    capture(error, 'create-prefilled-signup', phoneNumberId);
    return buildPrefillFallback(validation);
  }
}

function buildPrefillFallback(
  validation: Extract<SignupLinkResult, { success: true }>
): Extract<PrefilledSignupLinkResult, { success: true; prefilled: false }> {
  return {
    success: true,
    url: validation.url,
    prefilled: false,
    plan: validation.plan,
    interval: validation.interval,
    fallbackReason: 'prefill_indisponivel',
    warning:
      'ESTE É O LINK COMUM (não pré-preenchido). NÃO diga que já vem com os dados nem que só falta a senha — peça pra ela preencher e-mail e dados no cadastro normalmente.',
  };
}

export type QualifiedLeadPayload = {
  name?: string;
  clinicName?: string;
  professionalsCount?: number;
  whatsappVolume?: string;
  currentSystem?: string;
  mainPain?: string;
  interest?: 'sistema' | 'ia' | 'ambos';
  recommendedPlan?: string;
  score?: number;
  status?: string;
  /** Origem determinística da 1ª mensagem; nunca vem do modelo. */
  partnerSlug?: string;
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
  const { interest, ...payloadWithoutInterest } = payload;
  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/sales-lead`,
      {
        ...payloadWithoutInterest,
        ...(interest !== undefined ? { interest } : {}),
        status,
        customerPhone: phone,
      },
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
