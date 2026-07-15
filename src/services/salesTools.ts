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

function capture(error: unknown, operation: string, phoneNumberId?: string): void {
  Sentry.captureException(error, {
    tags: { service: 'sales-tools', operation, ...(phoneNumberId ? { phoneNumberId } : {}) },
  });
  const message = axios.isAxiosError(error)
    ? error.response?.status
      ? `HTTP ${error.response.status}`
      : error.message
    : String(error);
  console.error(`❌ [sales-tools] falha em ${operation}: ${message}`);
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
