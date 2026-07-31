import { pool } from './contextManager';
import { addMessage, buildConversationKey, getLastInboundAtMs } from './contextManager';
import { customerPhoneVariants } from './conversationActivity';
import type { TenantBotConfig } from '../configProvider';
import { getTenantConfig } from '../configProvider';
import { isConversationPaused } from './pauseService';
import {
  markFollowupOptedOut,
  scheduleOnboardingFollowup,
} from './salesFollowups';
import { sendFreeformMessage } from '../whatsappCloudService';
import { Sentry } from '../observability/sentry';
import { isRenataVoiceEnabled } from '../voice/voiceConfig';
import { deliverSalesReply } from '../voice/voiceDelivery';

/**
 * Gatilho pós-cadastro da Renata (v1.1, D4). O Receps avisa (POST assinado em
 * /sales-notify) quando o lead vira `trial`: a conta ficou pronta.
 *
 * Duas coisas acontecem, nesta ordem e independentes:
 * 1. a régua de follow-up de VENDA é encerrada — sempre. A pessoa converteu;
 *    continuar batendo "ficou alguma dúvida?" é ruído (e agora é cliente).
 * 2. a mensagem de parabéns sai SÓ se couber na janela de serviço de 24h e a
 *    conversa não estiver pausada. Fora disso: SKIP SILENCIOSO — nada de
 *    template pago na v1.1.
 *
 * A decisão é PURA (`shouldSendTrialNotice`) pra ter smoke determinístico; o
 * resto é a casca de I/O. Sem PII em log (só phoneNumberId e o motivo do skip).
 */

/** Janela de serviço do WhatsApp: 24h a partir do último inbound do lead. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SalesNotifyEvent = 'trial_started';

/** Copy do manual (§D4). Freeform, dentro da janela — custo zero de template. */
export const TRIAL_STARTED_MESSAGE =
  'Vi que sua conta tá pronta! 🎉 Bem-vinda à Receps. Quer aproveitar e agendar a configuração assistida de 30min com o Victor? Ele conecta tudo com você.';
export const ONBOARDING_TRIAL_STARTED_MESSAGE =
  'Vi que sua conta tá pronta! 🎉 Bem-vinda à Receps. Quer que eu configure sua clínica com você agora, por aqui mesmo? Leva uns 10 minutinhos.';

export type TrialNoticeDecision =
  | { send: true }
  | { send: false; reason: 'no-inbound' | 'outside-window' | 'paused' };

/**
 * "Dá pra mandar a mensagem agora?" — PURA. Sem inbound não há janela aberta;
 * fora das 24h a Meta só aceitaria template pago (fora de escopo); pausada
 * significa que o Victor (ou o echo do app) assumiu a conversa.
 */
export function shouldSendTrialNotice(input: {
  lastInboundAtMs: number | null;
  nowMs: number;
  paused: boolean;
}): TrialNoticeDecision {
  if (input.lastInboundAtMs === null) {
    return { send: false, reason: 'no-inbound' };
  }
  if (input.paused) {
    return { send: false, reason: 'paused' };
  }
  if (input.nowMs - input.lastInboundAtMs >= SERVICE_WINDOW_MS) {
    return { send: false, reason: 'outside-window' };
  }
  return { send: true };
}

export interface SalesConversationRef {
  phoneNumberId: string;
  /** Telefone COMO a Ana o guarda (wa_id cru) — não o canônico do Receps. */
  customerPhone: string;
}

/**
 * Acha a conversa de venda pelo telefone que o Receps mandou (canônico
 * `+55DDDNUMERO`). A `sales_followups` tem uma linha por conversa de venda —
 * escrita a cada inbound da Renata — e é o único lugar que sabe o
 * `phoneNumberId` do número de vendas sem hardcode nem env nova.
 *
 * Casa por VARIANTES (canônico + só-dígitos) porque a Ana guarda o wa_id cru.
 * Devolve o telefone COMO ESTÁ NA LINHA: é a chave que o histórico, a pausa e o
 * envio usam. Linhas com opt-out entram de propósito — a régua precisa ser
 * encerrada de todo jeito, e quem decide o envio é `shouldSendTrialNotice`.
 */
export async function findSalesConversation(
  customerPhone: string
): Promise<SalesConversationRef | null> {
  const variants = customerPhoneVariants(customerPhone);
  if (variants.length === 0) return null;

  const { rows } = await pool.query<{
    phone_number_id: string;
    customer_phone: string;
  }>(
    `SELECT phone_number_id, customer_phone
       FROM sales_followups
      WHERE customer_phone = ANY($1)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [variants]
  );

  const row = rows[0];
  return row
    ? { phoneNumberId: row.phone_number_id, customerPhone: row.customer_phone }
    : null;
}

export interface SalesNotifyDeps {
  now: () => number;
  findConversation: (customerPhone: string) => Promise<SalesConversationRef | null>;
  getConfig: (phoneNumberId: string) => Promise<TenantBotConfig | null>;
  endFollowups: (phoneNumberId: string, customerPhone: string) => Promise<void>;
  activateOnboarding?: (
    phoneNumberId: string,
    customerPhone: string,
    customerName: string | null,
    anchorAtMs?: number
  ) => Promise<void>;
  isPaused: (phoneNumberId: string, customerPhone: string) => Promise<boolean>;
  lastInboundAt: (phoneNumberId: string, customerPhone: string) => Promise<number | null>;
  send: (to: string, text: string, config: TenantBotConfig) => Promise<void>;
  record: (conversationKey: string, role: 'assistant', content: string) => Promise<void>;
}

const defaultDeps: SalesNotifyDeps = {
  now: () => Date.now(),
  findConversation: findSalesConversation,
  getConfig: getTenantConfig,
  endFollowups: markFollowupOptedOut,
  activateOnboarding: scheduleOnboardingFollowup,
  isPaused: isConversationPaused,
  lastInboundAt: getLastInboundAtMs,
  send: (to, text, config) =>
    isRenataVoiceEnabled(config)
      ? deliverSalesReply(to, text, config)
      : sendFreeformMessage(to, text, config),
  record: (key, role, content) => addMessage(key, role, content),
};

export type SalesNotifySkipReason =
  | Extract<TrialNoticeDecision, { send: false }>['reason']
  | 'unknown-conversation'
  | 'no-sales-config';

export type SalesNotifyResult =
  | { handled: true; sent: true }
  | { handled: true; sent: false; reason: SalesNotifySkipReason }
  | { handled: false; reason: 'unknown-conversation' | 'no-sales-config' };

/**
 * Processa o aviso de trial. Idempotência vem do Receps: o hook do funil só
 * dispara na transição REAL do lead (escrita condicional), então este handler
 * não precisa deduplicar. Nunca lança — o Receps já respondeu ao usuário.
 */
export async function handleTrialStarted(
  customerPhone: string,
  deps: SalesNotifyDeps = defaultDeps,
  onboarding = false
): Promise<SalesNotifyResult> {
  const conversation = await deps.findConversation(customerPhone);
  if (!conversation) {
    // Trial de alguém que nunca falou com a Renata (cadastro pelo site, match
    // por telefone). Não é erro: não há conversa pra responder.
    console.info('[sales-notify] trial sem conversa de venda — nada a fazer.');
    return { handled: false, reason: 'unknown-conversation' };
  }

  const { phoneNumberId, customerPhone: phone } = conversation;

  const config = await deps.getConfig(phoneNumberId);
  if (!config || !config.isActive || config.botRole !== 'sales') {
    await deps.endFollowups(phoneNumberId, phone).catch(() => undefined);
    console.info(
      `[sales-notify] sem config ativa de vendas — só a régua foi encerrada | ${phoneNumberId}`
    );
    return { handled: false, reason: 'no-sales-config' };
  }

  const [paused, lastInboundAtMs] = await Promise.all([
    deps.isPaused(phoneNumberId, phone),
    deps.lastInboundAt(phoneNumberId, phone),
  ]);
  const decision = shouldSendTrialNotice({
    lastInboundAtMs,
    nowMs: deps.now(),
    paused,
  });

  // 1) A pessoa converteu: a régua de venda para AQUI. Quando o Receps abriu a
  // sessão, a mesma linha troca de ciclo de vida para o toque único de
  // onboarding, mas somente dentro da janela vigente. Pausa, ausência de
  // inbound ou janela expirada são terminadores e nunca armam um toque.
  if (
    onboarding &&
    decision.send &&
    lastInboundAtMs !== null &&
    deps.activateOnboarding
  ) {
    await deps
      .activateOnboarding(
        phoneNumberId,
        phone,
        null,
        lastInboundAtMs
      )
      .catch(() => undefined);
  } else {
    await deps.endFollowups(phoneNumberId, phone).catch(() => undefined);
  }

  if (!decision.send) {
    console.info(
      `[sales-notify] mensagem de trial não enviada (${decision.reason}) | ${phoneNumberId}`
    );
    return { handled: true, sent: false, reason: decision.reason };
  }

  const message = onboarding
    ? ONBOARDING_TRIAL_STARTED_MESSAGE
    : TRIAL_STARTED_MESSAGE;
  await deps.send(phone, message, config);
  await deps
    .record(buildConversationKey(phoneNumberId, phone), 'assistant', message)
    .catch(() => undefined);

  console.info(`[sales-notify] mensagem de trial enviada | ${phoneNumberId}`);
  return { handled: true, sent: true };
}

/** Roteia o aviso pelo tipo. Nunca lança: reporta e segue. */
export async function handleSalesNotify(
  event: string,
  customerPhone: string,
  deps: SalesNotifyDeps = defaultDeps,
  onboarding = false
): Promise<void> {
  if (event !== 'trial_started') {
    console.warn(`[sales-notify] evento desconhecido ignorado: ${event}`);
    return;
  }

  try {
    await handleTrialStarted(customerPhone, deps, onboarding);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { service: 'sales-notify', operation: 'trial-started' },
    });
    console.error('❌ [sales-notify] falha ao processar trial_started:', err);
  }
}
