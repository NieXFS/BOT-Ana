import type { TenantBotConfig } from './configProvider';
import {
  ConversationPausedBeforeDispatch,
  getLastResolvedSalesConversationRole,
  getReply,
} from './services/brainService';
import {
  addMessage,
  buildConversationKey,
  withPersistedInboundContext,
} from './services/contextManager';
import { tryHandleOptOut } from './services/optOutService';
import { isConversationPaused } from './services/pauseService';
import { shouldAnaResumeForInbound } from './services/anaResumeGate';
import {
  markFollowupOptedOut,
  markFollowupPostLink,
} from './services/salesFollowups';
import { hasSalesSignupUrl } from './services/salesGuards';
import { captureReferral, type CtwaReferral } from './services/salesEvents';
import { transcreverAudioBuffer } from './utils/transcriber';
import {
  sendFreeformMessage,
  sendFreeformMessageWithReceipt,
  downloadMedia,
  typingDelay,
  isAmbiguousWhatsAppTransportError,
} from './whatsappCloudService';
import { conversationTracker } from './conversationTracker';
import { Sentry } from './observability/sentry';
import { isRenataVoiceEnabled } from './voice/voiceConfig';
import { deliverSalesReply } from './voice/voiceDelivery';
import { rememberConversationAdHeadline } from './services/salesAdState';
import {
  cancelSalesRecovery,
  notifySalesReplyDelivered,
  scheduleSalesRecovery,
} from './services/salesRecovery';
import {
  cancelOnboardingPolling,
  noteOnboardingInbound,
} from './services/onboardingPolling';
import { clearPendingOnboardingProposal } from './services/onboardingConfirmationGate';
import {
  markInboundTranscriptionFailed,
  persistInboundAtomically,
  updateInboundHistoryContent,
  type AtomicInboundInput,
  type InboundContentStatus,
  type InboundMessageType,
} from './services/anaWave2Store';
import {
  deliverInboundWithFastRetries,
  shouldSuspendForPendingInbound,
  type InboundDeliveryResult,
} from './services/inboundOutbox';
import {
  conversationHash,
  runtimeErrorKind,
} from './observability/safeRuntime';
import { truncateForW1 } from './services/inboundContent';
import {
  buildReceptionistEnvelope,
  canonicalReceptionistOutbound,
  catalogFromConfig,
  deliverValidatedReceptionistText,
  validateReceptionistOutbound,
  type ValidatedReceptionistOutbound,
} from './services/receptionistOutbound';
import { withConversationLock } from './services/conversationOrder';

type OutboundReply = string | ValidatedReceptionistOutbound;
export type ConfiguredReplyDelivery = 'sent' | 'suppressed';

interface MessageBuffer {
  texts: string[];
  name: string;
  timer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  firstMessageAt: number;
  config: TenantBotConfig;
  from: string;
  isProcessing: boolean;
  pendingTexts: string[];
  /** Onda 2 só-recepcionista: inbounds já estão no history pelo intake. */
  inboundPersisted: boolean;
  messageIds: string[];
  pendingMessageIds: string[];
}

const messageBuffers = new Map<string, MessageBuffer>();
const DEBOUNCE_TIME_MS = 12_000;
const MAX_WAIT_TIME_MS = 30_000;

const FLUSH_RECOVERY_WINDOW_MS = 60_000;
const FLUSH_FALLBACK_MESSAGE =
  'Tive um probleminha aqui. Pode repetir sua última mensagem?';

// Janela (por CONVERSA) em que NÃO reenviamos o fallback de erro — evita spam se
// o cliente insistir e o flush continuar falhando. Chave = bufferKey
// (phoneNumberId:from), não só phoneNumberId, pra não silenciar OUTROS clientes
// do mesmo número de negócio.
const flushRecoveryUntil = new Map<string, number>();

// FIX 2: throttle do aviso de fora-de-horário. Sem isso, mandávamos o aviso 1x
// POR mensagem recebida → spam (3 mensagens iguais no teste real). Mesma ideia
// do flushRecoveryUntil: "suprimido até" por CONVERSA (bufferKey).
const OUTSIDE_HOURS_NOTICE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h
const outsideHoursNoticeUntil = new Map<string, number>();

/**
 * FIX 2: decide se o aviso de fora-de-horário deve ser enviado pra esta conversa
 * AGORA. Retorna true na 1ª vez (e marca a supressão pelos próximos
 * OUTSIDE_HOURS_NOTICE_WINDOW_MS); false enquanto dentro da janela. Pura o
 * suficiente pra smoke (recebe now). Marca o timestamp SÓ quando autoriza.
 */
export function shouldSendOutsideHoursNotice(
  bufferKey: string,
  now: number = Date.now()
): boolean {
  const suppressedUntil = outsideHoursNoticeUntil.get(bufferKey) ?? 0;
  if (now < suppressedUntil) {
    return false;
  }
  outsideHoursNoticeUntil.set(bufferKey, now + OUTSIDE_HOURS_NOTICE_WINDOW_MS);
  return true;
}

/**
 * Reverte a reserva quando a mensagem não chegou ao transporte (por exemplo,
 * takeover humano venceu a revalidação sob lock). A janela representa aviso
 * efetivamente entregue, não apenas uma tentativa.
 */
export function releaseOutsideHoursNotice(bufferKey: string): void {
  outsideHoursNoticeUntil.delete(bufferKey);
}

export interface FlushDeps {
  getReply: typeof getReply;
  sendReply: (
    from: string,
    // `any` apenas no seam de smoke legado; a implementação default abaixo
    // continua apontando para a fronteira tipada `sendConfiguredReply`.
    text: any,
    config: TenantBotConfig
  ) => Promise<void | ConfiguredReplyDelivery>;
  /** Caminho que ignora voz para fallbacks de sistema. */
  sendReplyPlain?: (
    from: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void | ConfiguredReplyDelivery>;
  isPaused?: (phoneNumberId: string, customerPhone: string) => Promise<boolean>;
  recordPausedInbound?: (
    conversationKey: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  markPostLink?: typeof markFollowupPostLink;
  withConversationLock?: (
    phoneNumberId: string,
    customerPhone: string,
    work: () => Promise<void>
  ) => Promise<void>;
}

/**
 * Simulação de digitação: LIGADA para recepção, DESLIGADA para vendas (Renata).
 * typingDelay OFF em sales é mitigação B2a (não simular ser humano). Puro/
 * exportado pra smoke determinístico.
 */
export function typingSimEnabled(config: TenantBotConfig): boolean {
  return config.botRole !== 'sales';
}

export interface ConfiguredReplyDeps {
  voiceEnabled: (config: TenantBotConfig) => boolean;
  deliverVoice: (
    from: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  waitTyping: (text: string) => Promise<void>;
  sendText: (
    from: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  /** Sales exige o recibo `messages[0].id`; recepção usa o mesmo transporte com recibo. */
  sendSalesText?: (
    from: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  /** Revalidação imediatamente após a digitação e antes do POST. */
  isPausedBeforeTransport?: (
    phoneNumberId: string,
    customerPhone: string
  ) => Promise<boolean>;
}

const defaultConfiguredReplyDeps: ConfiguredReplyDeps = {
  voiceEnabled: isRenataVoiceEnabled,
  deliverVoice: deliverSalesReply,
  waitTyping: typingDelay,
  sendText: async (from, text, config) => {
    await sendFreeformMessageWithReceipt(from, text, config);
  },
  sendSalesText: async (from, text, config) => {
    await sendFreeformMessageWithReceipt(from, text, config);
  },
  isPausedBeforeTransport: isConversationPaused,
};

/** Seam do ponto de entrega: permite provar o caminho byte-idêntico da recepção. */
export async function sendConfiguredReply(
  from: string,
  text: OutboundReply,
  config: TenantBotConfig,
  deps: ConfiguredReplyDeps = defaultConfiguredReplyDeps
): Promise<ConfiguredReplyDelivery> {
  if (config.botRole !== 'sales') {
    const validated = typeof text === 'string'
      ? validateReceptionistOutbound(buildReceptionistEnvelope({
          purpose: 'REACTIVE',
          blocks: [{ source: 'GENERATED', text }],
          authoritativeCatalog: catalogFromConfig(config),
        }))
      : text;
    if (!validated.originalAccepted) {
      console.warn(
        `[receptionist-outbound] suppressed purpose=${validated.purpose} reasons=${validated.reasonCodes.join(',')} sources=${validated.sources.join(',')} convHash=${conversationHash(config.phoneNumberId, from)}`
      );
      Sentry.captureMessage('Saída da recepcionista suprimida antes do WhatsApp', {
        level: 'warning',
        tags: {
          service: 'receptionist_outbound',
          operation: 'suppress_unsafe_outbound',
          phoneNumberId: config.phoneNumberId,
          tenantSlug: config.tenantSlug,
          purpose: validated.purpose,
          reason_codes: validated.reasonCodes.join(','),
        },
      });
      return 'suppressed';
    }
    if (typingSimEnabled(config)) await deps.waitTyping(validated.payload);
    if (
      deps.isPausedBeforeTransport &&
      (await deps.isPausedBeforeTransport(config.phoneNumberId, from))
    ) {
      return 'suppressed';
    }
    await deps.sendText(from, validated.payload, config);
    return 'sent';
  }
  const salesText = typeof text === 'string' ? text : text.payload;
  if (deps.voiceEnabled(config)) {
    await deps.deliverVoice(from, salesText, config);
    return 'sent';
  }
  if (typingSimEnabled(config)) {
    await deps.waitTyping(salesText);
  }
  await (deps.sendSalesText ?? deps.sendText)(from, salesText, config);
  return 'sent';
}

const defaultFlushDeps: FlushDeps = {
  getReply,
  sendReply: sendConfiguredReply,
  sendReplyPlain: async (from, text, config) => {
    if (config.botRole !== 'sales') {
      const outbound = canonicalReceptionistOutbound(
        'FLUSH_FALLBACK',
        text,
        config
      );
      if (!outbound.originalAccepted) return 'suppressed';
      if (typingSimEnabled(config)) await typingDelay(outbound.payload);
      if (await isConversationPaused(config.phoneNumberId, from)) {
        return 'suppressed';
      }
      return (await deliverValidatedReceptionistText(from, outbound, config))
        ? 'sent'
        : 'suppressed';
    }
    const outbound = text;
    if (typingSimEnabled(config)) {
      await typingDelay(outbound);
    }
    await sendFreeformMessage(from, outbound, config);
    return 'sent';
  },
  isPaused: isConversationPaused,
  recordPausedInbound: recordInboundWhilePaused,
  markPostLink: markFollowupPostLink,
  withConversationLock: (phoneNumberId, customerPhone, work) =>
    withConversationLock(phoneNumberId, customerPhone, async () => work()),
};

function safeSalesContext(config: TenantBotConfig, from: string): string {
  return `phoneNumberId=${config.phoneNumberId} convHash=${conversationHash(
    config.phoneNumberId,
    from
  )}`;
}

function errorKind(error: unknown): string {
  return runtimeErrorKind(error);
}

/**
 * M24: após uma falha no flush, avisa o cliente UMA vez (dentro da janela de
 * recovery) que houve um problema e pede pra repetir — antes ele ficava em
 * silêncio total. A captura do erro no Sentry já aconteceu no chamador.
 */
async function emitFlushFallback(
  bufferKey: string,
  from: string,
  config: TenantBotConfig,
  deps: FlushDeps
): Promise<void> {
  const now = Date.now();
  const suppressedUntil = flushRecoveryUntil.get(bufferKey) ?? 0;
  if (now < suppressedUntil) {
    console.log(
      `🟡 [flush] ${safeSalesContext(config, from)} em recovery — fallback suprimido`
    );
    return;
  }
  flushRecoveryUntil.set(bufferKey, now + FLUSH_RECOVERY_WINDOW_MS);
  try {
    const sendFallback = () =>
      (deps.sendReplyPlain ?? deps.sendReply)(
        from,
        FLUSH_FALLBACK_MESSAGE,
        config
      );
    let sent = true;
    if (config.botRole !== 'sales') {
      const serialize = deps.withConversationLock ??
        (async (
          _phoneNumberId: string,
          _customerPhone: string,
          work: () => Promise<void>
        ) => work());
      const isPaused = deps.isPaused ?? isConversationPaused;
      await serialize(config.phoneNumberId, from, async () => {
        if (await isPaused(config.phoneNumberId, from)) {
          sent = false;
          return;
        }
        const result = await sendFallback();
        if (result === 'suppressed') sent = false;
      });
    } else {
      await sendFallback();
    }
    if (sent) {
      console.log(`🆘 [flush] fallback de erro enviado | ${safeSalesContext(config, from)}`);
    } else {
      console.log(`⏸️ [flush] fallback suprimido por pausa/validação | ${safeSalesContext(config, from)}`);
    }
  } catch (sendErr) {
    Sentry.captureException(new Error('message_handler flush fallback send failed'), {
      tags: {
        service: 'message_handler',
        operation: 'flush_fallback_send',
        phoneNumberId: config.phoneNumberId,
        tenantSlug: config.tenantSlug,
        error_kind: runtimeErrorKind(sendErr),
      },
    });
    console.error(
      `❌ [flush] falha ao enviar fallback | ${safeSalesContext(config, from)} | error=${errorKind(sendErr)}`
    );
  }
}

function buildBufferKey(config: TenantBotConfig, from: string): string {
  return buildConversationKey(config.phoneNumberId, from);
}

function getCurrentTimeInTimezone(timezone: string): string {
  return new Date().toLocaleTimeString('pt-BR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function isBotActive(config: TenantBotConfig): boolean {
  if (config.botIsAlwaysActive) {
    return true;
  }

  const now = getCurrentTimeInTimezone(config.timezone);
  return now >= config.botActiveStart && now < config.botActiveEnd;
}

function buildOutsideHoursMessage(config: TenantBotConfig): string {
  return `Nosso atendimento funciona das ${config.botActiveStart} às ${config.botActiveEnd}. Envie sua mensagem e responderemos assim que possível!`;
}

async function suppressFlushIfPaused(params: {
  bufferKey: string;
  buffer: MessageBuffer;
  alreadyProcessedTexts: string[];
  deps: FlushDeps;
}): Promise<boolean> {
  const { bufferKey, buffer, alreadyProcessedTexts, deps } = params;
  const isPaused = deps.isPaused ?? isConversationPaused;
  if (!(await isPaused(buffer.config.phoneNumberId, buffer.from))) {
    return false;
  }
  cancelOnboardingPolling(bufferKey);
  clearPendingOnboardingProposal(bufferKey);

  // Textos ainda não entregues ao brain precisam entrar no histórico pra Renata
  // retomar com o contexto correto depois da pausa. Os já processados pelo brain
  // não são gravados de novo.
  const recordPausedInbound = deps.recordPausedInbound ?? recordInboundWhilePaused;
  const unprocessedTexts = [...alreadyProcessedTexts, ...buffer.pendingTexts];
  buffer.pendingTexts = [];
  buffer.pendingMessageIds = [];
  if (!buffer.inboundPersisted) {
    for (const text of unprocessedTexts) {
      if (text.trim()) {
        await recordPausedInbound(
          buildConversationKey(buffer.config.phoneNumberId, buffer.from),
          text,
          buffer.config
        );
      }
    }
  }

  messageBuffers.delete(bufferKey);
  console.log('⏸️ [pausado] resposta pendente suprimida após intervenção humana.');
  return true;
}

async function getBufferedReply(
  buffer: MessageBuffer,
  bufferedMessageIds: string[],
  consolidatedText: string,
  deps: FlushDeps
): Promise<OutboundReply> {
  const work = () =>
    deps.getReply(buffer.from, consolidatedText, buffer.name, buffer.config);
  if (!buffer.inboundPersisted) return work();
  return withPersistedInboundContext(bufferedMessageIds, work);
}

export async function flushBuffer(
  bufferKey: string,
  deps: FlushDeps = defaultFlushDeps
): Promise<void> {
  const buffer = messageBuffers.get(bufferKey);
  if (!buffer) return;

  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
  buffer.timer = null;
  buffer.maxWaitTimer = null;

  buffer.isProcessing = true;
  const bufferedTexts = [...buffer.texts];
  const bufferedMessageIds = [...buffer.messageIds];
  const consolidatedText = bufferedTexts.join(' ');
  const messageCount = buffer.texts.length;
  buffer.texts = [];
  buffer.messageIds = [];
  const { name, config, from } = buffer;

  // A conversa pode ter sido pausada DEPOIS que o inbound entrou no debounce.
  // Revalidar aqui impede gerar resposta para um buffer aberto antes do echo.
  if (
    await suppressFlushIfPaused({
      bufferKey,
      buffer,
      alreadyProcessedTexts: bufferedTexts,
      deps,
    })
  ) {
    return;
  }

  console.log(
    `🧠 Processando mensagens | ${safeSalesContext(config, from)} | messages=${messageCount}`
  );

  let flushFailed = false;
  if (config.botRole === 'sales') {
    let reply = '';
    try {
      const generated = await getBufferedReply(
        buffer,
        bufferedMessageIds,
        consolidatedText,
        deps
      );
      reply = typeof generated === 'string' ? generated : generated.payload;
    } catch (err) {
      flushFailed = true;
      Sentry.captureException(new Error('message_handler sales brain failed'), {
        tags: {
          service: 'message_handler',
          operation: 'flush_buffer_brain',
          phoneNumberId: config.phoneNumberId,
          tenantSlug: config.tenantSlug,
          messageCount,
        },
      });
      console.error(
        `❌ Erro no brain de vendas | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
      );

      // Pausa/takeover não é falha recuperável: a intervenção humana vence e
      // suprime tanto a resposta quanto o evento/timer de recovery.
      if (
        await suppressFlushIfPaused({
          bufferKey,
          buffer,
          alreadyProcessedTexts: [],
          deps,
        })
      ) {
        return;
      }

      // Todo erro no caminho do brain sales agenda recovery. Edge residual:
      // se o próprio addMessage do inbound falhou, o histórico não contém a
      // mensagem e a guarda da reexecução cancela silenciosamente; a
      // visibilidade permanece no Sentry + evento falha_resposta do painel.
      scheduleSalesRecovery({
        conversationKey: bufferKey,
        phone: from,
        userName: name,
        config,
        failure: { kind: 'brain' },
        conversationRole:
          getLastResolvedSalesConversationRole(bufferKey),
      });
    }

    if (!flushFailed) {
      // Segunda barreira: se o humano assumiu enquanto o brain estava em voo, a
      // resposta gerada é descartada e nunca chega ao WhatsApp.
      if (
        await suppressFlushIfPaused({
          bufferKey,
          buffer,
          alreadyProcessedTexts: [],
          deps,
        })
      ) {
        return;
      }

      try {
        const salesDelivery = await deps.sendReply(from, reply!, config);
        if (
          salesDelivery !== 'suppressed' &&
          hasSalesSignupUrl(reply) &&
          deps.markPostLink
        ) {
          await deps
            .markPostLink(config.phoneNumberId, from)
            .catch(() => undefined);
        }
        if (salesDelivery !== 'suppressed') {
          notifySalesReplyDelivered(bufferKey, 'novo_inbound');
        }
        console.log(
          `🤖 ${config.botName} respondeu | ${safeSalesContext(config, from)} | chars=${reply.length}`
        );
      } catch (err) {
        flushFailed = true;
        // A proposta só pode autorizar B3 depois de ter sido entregue. Se o
        // envio falhou, descarta o Map; a recuperação pode reenviar o texto,
        // mas uma futura escrita exigirá nova proposta/confirmação.
        clearPendingOnboardingProposal(bufferKey);
        Sentry.captureException(new Error('message_handler sales send failed'), {
          tags: {
            service: 'message_handler',
            operation: 'flush_buffer_send',
            phoneNumberId: config.phoneNumberId,
            tenantSlug: config.tenantSlug,
            messageCount,
          },
        });
        console.error(
          `❌ Erro ao enviar resposta de vendas | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
        );

        if (isAmbiguousWhatsAppTransportError(err)) {
          console.warn(
            `🟡 [sales] resultado do transporte desconhecido; sem recovery/retry | ${safeSalesContext(config, from)}`
          );
          Sentry.captureMessage('Resultado do transporte de vendas desconhecido', {
            level: 'warning',
            tags: {
              service: 'message_handler',
              operation: 'sales_transport_outcome_unknown',
              phoneNumberId: config.phoneNumberId,
              tenantSlug: config.tenantSlug,
            },
          });
          const current = messageBuffers.get(bufferKey);
          if (current) {
            current.pendingTexts = [];
            current.pendingMessageIds = [];
          }
          messageBuffers.delete(bufferKey);
          return;
        }

        // Um takeover ocorrido durante a tentativa de envio não deve abrir um
        // recovery nem emitir falha_resposta.
        if (
          await suppressFlushIfPaused({
            bufferKey,
            buffer,
            alreadyProcessedTexts: [],
            deps,
          })
        ) {
          return;
        }

        scheduleSalesRecovery({
          conversationKey: bufferKey,
          phone: from,
          userName: name,
          config,
          failure: { kind: 'send', replyText: reply },
          conversationRole:
            getLastResolvedSalesConversationRole(bufferKey),
        });
      }
    }
  } else {
    try {
      const reply = await getBufferedReply(
        buffer,
        bufferedMessageIds,
        consolidatedText,
        deps
      );
      const serialize =
        deps.withConversationLock ??
        (async (
          _phoneNumberId: string,
          _customerPhone: string,
          work: () => Promise<void>
        ) => work());
      let delivery: ConfiguredReplyDelivery = 'sent';

      // A pausa e o transporte compartilham a MESMA advisory lock do echo. Se o
      // humano assumir durante o brain, o echo grava a pausa antes deste bloco e
      // a resposta é descartada. Não existe mais janela entre o último check e o
      // POST ao WhatsApp.
      await serialize(config.phoneNumberId, from, async () => {
        if (
          await suppressFlushIfPaused({
            bufferKey,
            buffer,
            alreadyProcessedTexts: [],
            deps,
          })
        ) {
          delivery = 'suppressed';
          return;
        }
        const result = await deps.sendReply(from, reply, config);
        if (result === 'suppressed') delivery = 'suppressed';
      });

      if (delivery === 'sent') {
        console.log(
          `🤖 Resposta enviada | ${safeSalesContext(config, from)} | chars=${typeof reply === 'string' ? reply.length : reply.payload.length}`
        );
      } else {
        console.warn(
          `🛑 Resposta da recepcionista não foi enviada | ${safeSalesContext(config, from)}`
        );
      }
    } catch (err) {
      flushFailed = true;
      Sentry.captureException(new Error('message_handler receptionist flush failed'), {
        tags: {
          service: 'message_handler',
          operation: 'flush_buffer',
          phoneNumberId: config.phoneNumberId,
          tenantSlug: config.tenantSlug,
          messageCount,
          error_kind: runtimeErrorKind(err),
        },
      });
      console.error(
        `❌ Erro no flush | ${safeSalesContext(config, from)} | error=${runtimeErrorKind(err)}`
      );

      if (err instanceof ConversationPausedBeforeDispatch) {
        if (
          !(await suppressFlushIfPaused({
            bufferKey,
            buffer,
            alreadyProcessedTexts: [],
            deps,
          }))
        ) {
          messageBuffers.delete(bufferKey);
        }
        return;
      }

      if (isAmbiguousWhatsAppTransportError(err)) {
        console.warn(
          `🟡 [flush] resultado do transporte desconhecido; sem retry/fallback | ${safeSalesContext(config, from)}`
        );
        Sentry.captureMessage('Resultado do transporte da recepcionista desconhecido', {
          level: 'warning',
          tags: {
            service: 'message_handler',
            operation: 'receptionist_transport_outcome_unknown',
            phoneNumberId: config.phoneNumberId,
            tenantSlug: config.tenantSlug,
          },
        });
        // A Meta pode ter aceitado o primeiro POST. Qualquer segunda mensagem
        // criaria duplicidade, então este turno termina em silêncio.
        const current = messageBuffers.get(bufferKey);
        if (current) {
          current.pendingTexts = [];
          current.pendingMessageIds = [];
        }
        messageBuffers.delete(bufferKey);
        return;
      }

      // `emitFlushFallback` é o único dono de lock+pausa+transporte neste
      // caminho. Advisory locks PG não são reentrantes entre conexões: adquirir
      // aqui e novamente dentro do helper causaria deadlock real.
      await emitFlushFallback(bufferKey, from, config, deps);
    }
  }

  const currentBuffer = messageBuffers.get(bufferKey);
  if (!currentBuffer) return;

  // Falha no flush → limpa o buffer INTEIRO (inclui pendingTexts) e NÃO re-arma.
  // No receptionist, M24 já convidou o cliente a reenviar; em sales, o recovery
  // volátil assumiu a resposta silenciosamente.
  if (flushFailed) {
    messageBuffers.delete(bufferKey);
    return;
  }

  if (currentBuffer.pendingTexts.length > 0) {
    console.log(
      `🔄 ${currentBuffer.pendingTexts.length} mensagem(s) pendente(s) | ${safeSalesContext(config, from)}`
    );
    currentBuffer.texts = currentBuffer.pendingTexts;
    currentBuffer.pendingTexts = [];
    currentBuffer.messageIds = currentBuffer.pendingMessageIds;
    currentBuffer.pendingMessageIds = [];
    currentBuffer.isProcessing = false;
    currentBuffer.firstMessageAt = Date.now();

    currentBuffer.timer = setTimeout(() => {
      flushBuffer(bufferKey).catch((err) => {
        console.error(
          `❌ Erro ao processar mensagens pendentes | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
        );
      });
    }, DEBOUNCE_TIME_MS);

    currentBuffer.maxWaitTimer = setTimeout(() => {
      console.log(`⏰ Max wait atingido | ${safeSalesContext(config, from)}`);
      flushBuffer(bufferKey).catch((err) => {
        console.error(
          `❌ Erro no max-wait flush | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
        );
      });
    }, MAX_WAIT_TIME_MS);
  } else {
    messageBuffers.delete(bufferKey);
  }
}

// --- Escuta enquanto pausada (§8.2 / INV-10) ---------------------------------
// Enquanto pausada, a Ana NÃO responde, mas REGISTRA o inbound do cliente no
// histórico (como role `user`), pra ter contexto ao retomar. O echo do humano é
// gravado pelo echoHandler (role `assistant`, prefixo "[atendente] "). Aqui só o
// lado do cliente. Deps injetáveis pra smoke determinístico (imports ESM frozen
// impedem spy — mesmo motivo do FlushDeps/EchoDeps).

export interface PausedRecordDeps {
  recordMessage: (
    conversationKey: string,
    role: 'user' | 'assistant',
    content: string
  ) => Promise<void>;
}

const defaultPausedRecordDeps: PausedRecordDeps = { recordMessage: addMessage };

/**
 * Grava o inbound do cliente recebido durante a pausa (sem chamar o modelo nem
 * responder). À prova de falha: erro de persistência é capturado no Sentry e
 * NÃO propaga (a pausa não pode quebrar por causa disso). NUNCA loga o conteúdo
 * (só o fato) — o scrub vale; sem console.log do texto.
 */
export async function recordInboundWhilePaused(
  conversationKey: string,
  text: string,
  config: TenantBotConfig,
  deps: PausedRecordDeps = defaultPausedRecordDeps
): Promise<void> {
  try {
    await deps.recordMessage(conversationKey, 'user', text);
  } catch (err) {
    Sentry.captureException(new Error('message_handler paused history write failed'), {
      tags: {
        service: 'message_handler',
        operation: 'record_inbound_while_paused',
        phoneNumberId: config.phoneNumberId,
        tenantSlug: config.tenantSlug,
        error_kind: runtimeErrorKind(err),
      },
    });
  }
}

export interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | 'button' | 'image' | 'document' | 'sticker' | string;
  text?: { body: string };
  audio?: { id: string; mime_type: string };
  button?: { text: string; payload: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply' | string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  referral?: CtwaReferral;
}

export interface CloudContact {
  profile?: { name?: string };
  wa_id?: string;
}

export interface NormalizedInboundContent {
  messageType: InboundMessageType;
  contentStatus: InboundContentStatus;
  content: string;
  contentOriginalLength: number | null;
}

/** Representação única: o mesmo texto vai para history, brain e W1. */
export function normalizeInboundContent(
  message: CloudMessage,
  enforceW1Limit = true
): NormalizedInboundContent {
  let messageType: InboundMessageType = 'other';
  let content = '';

  if (message.type === 'text') {
    messageType = 'text';
    content = message.text?.body ?? '';
  } else if (message.type === 'button') {
    messageType = 'button';
    content = message.button?.text ?? '';
  } else if (message.type === 'interactive') {
    if (message.interactive?.type === 'list_reply') {
      messageType = 'list';
      content = message.interactive.list_reply?.title ?? '';
    } else if (message.interactive?.type === 'button_reply') {
      messageType = 'button';
      content = message.interactive.button_reply?.title ?? '';
    }
  } else if (message.type === 'audio') {
    return {
      messageType: 'audio',
      contentStatus: 'pending',
      content: '',
      contentOriginalLength: null,
    };
  }

  if (!content.trim()) {
    return {
      messageType,
      contentStatus: 'no_text',
      content: '',
      contentOriginalLength: null,
    };
  }

  if (!enforceW1Limit) {
    return {
      messageType,
      contentStatus: 'final',
      content,
      contentOriginalLength: content.length,
    };
  }

  const truncated = truncateForW1(content);

  return {
    messageType,
    contentStatus: truncated.truncated ? 'truncated' : 'final',
    content: truncated.text,
    contentOriginalLength: truncated.originalLength,
  };
}

function inboundReceivedAt(message: CloudMessage): Date {
  const seconds = Number(message.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) {
    const parsed = new Date(seconds * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export interface IncomingMessageDeps {
  persistInbound: (input: AtomicInboundInput) => Promise<{
    fresh: boolean;
    conversationKey: string;
    sequence: number | null;
  }>;
  deliverInbound: (messageId: string) => Promise<InboundDeliveryResult>;
  updateInboundContent: (messageId: string, content: string) => Promise<void>;
  markTranscriptionFailed: (messageId: string) => Promise<void>;
  downloadAudio: typeof downloadMedia;
  transcribeAudio: typeof transcreverAudioBuffer;
  handleOptOut: typeof tryHandleOptOut;
  shouldSuspend: typeof shouldSuspendForPendingInbound;
  isPaused: typeof isConversationPaused;
  resumeGate?: typeof shouldAnaResumeForInbound;
  sendReply?: typeof sendConfiguredReply;
  withConversationLock?: (
    phoneNumberId: string,
    customerPhone: string,
    work: () => Promise<void>
  ) => Promise<void>;
}

const defaultIncomingMessageDeps: IncomingMessageDeps = {
  persistInbound: persistInboundAtomically,
  deliverInbound: deliverInboundWithFastRetries,
  updateInboundContent: updateInboundHistoryContent,
  markTranscriptionFailed: markInboundTranscriptionFailed,
  downloadAudio: downloadMedia,
  transcribeAudio: transcreverAudioBuffer,
  handleOptOut: tryHandleOptOut,
  shouldSuspend: shouldSuspendForPendingInbound,
  isPaused: isConversationPaused,
  resumeGate: shouldAnaResumeForInbound,
  sendReply: sendConfiguredReply,
  withConversationLock: (phoneNumberId, customerPhone, work) =>
    withConversationLock(phoneNumberId, customerPhone, async () => work()),
};

/**
 * Fronteira única para respostas automáticas diretas da recepcionista que não
 * passam pelo debounce (por exemplo: áudio ilegível e fora de horário). A
 * revalidação da pausa e o transporte ficam sob a mesma lock usada pelo echo;
 * se o humano venceu a ordem, Ana não digita nem envia.
 */
export async function sendDirectReceptionistReplyIfUnpaused(
  from: string,
  reply: ValidatedReceptionistOutbound,
  config: TenantBotConfig,
  deps: Pick<IncomingMessageDeps, 'isPaused' | 'sendReply' | 'withConversationLock'>
): Promise<ConfiguredReplyDelivery> {
  const serialize = deps.withConversationLock ??
    (async (
      _phoneNumberId: string,
      _customerPhone: string,
      work: () => Promise<void>
    ) => work());
  const sendReply = deps.sendReply ?? sendConfiguredReply;
  let delivery: ConfiguredReplyDelivery = 'suppressed';

  await serialize(config.phoneNumberId, from, async () => {
    if (await deps.isPaused(config.phoneNumberId, from)) return;
    const result = await sendReply(from, reply, config);
    delivery = result ?? 'sent';
  });
  return delivery;
}

export async function handleIncomingMessage(
  message: CloudMessage,
  contact: CloudContact | undefined,
  config: TenantBotConfig,
  deps: IncomingMessageDeps = defaultIncomingMessageDeps
): Promise<void> {
  const from = message.from;
  const name = contact?.profile?.name ?? 'Cliente';
  let conversationKey = buildConversationKey(config.phoneNumberId, from);
  const inboundPersisted = config.botRole !== 'sales';
  let inboundDeliveryPending = false;
  const normalizedInbound = normalizeInboundContent(message, inboundPersisted);
  const convHash = conversationHash(config.phoneNumberId, from);

  const deliverPersistedInbound = async (): Promise<void> => {
    if (!inboundPersisted) return;
    try {
      const delivery = await deps.deliverInbound(message.id);
      inboundDeliveryPending = !delivery.delivered;
    } catch (error) {
      // O registro já está durável no outbox. O sweep retomará sem repetir intake.
      inboundDeliveryPending = true;
      Sentry.captureException(new Error('ana inbound immediate delivery failed'), {
        level: 'warning',
        tags: {
          service: 'message_handler',
          operation: 'inbound_outbox_immediate',
          phoneNumberId: config.phoneNumberId,
          messageId: message.id,
          error_kind: runtimeErrorKind(error),
        },
      });
    }
  };

  // Rev. 3 §6.2 — somente a recepcionista Ana. Renata/onboarding permanecem no
  // intake legado e não são tocados por esta onda.
  if (inboundPersisted) {
    const intake = await deps.persistInbound({
      messageId: message.id,
      phoneNumberId: config.phoneNumberId,
      customerPhone: from,
      content: normalizedInbound.content,
      messageType: normalizedInbound.messageType,
      contentStatus: normalizedInbound.contentStatus,
      contentOriginalLength: normalizedInbound.contentOriginalLength,
      receivedAt: inboundReceivedAt(message),
    });
    if (!intake.fresh) {
      console.info(`↩️ Inbound ${message.id} repetida — intake atômico em noop.`);
      return;
    }
    conversationKey = intake.conversationKey;
  }

  let text = '';

  if (
    normalizedInbound.messageType === 'button' ||
    normalizedInbound.messageType === 'list'
  ) {
    text = normalizedInbound.content;
    if (config.botRole === 'sales') {
      console.log(`🔘 Botão clicado | ${safeSalesContext(config, from)}`);
    } else {
      console.log(
        `🔘 Interação recebida | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | type=${normalizedInbound.messageType}`
      );
    }
  } else if (normalizedInbound.messageType === 'text') {
    text = normalizedInbound.content;
  } else if (message.type === 'audio') {
    try {
      if (!message.audio?.id) {
        throw new Error('InboundAudioMediaIdMissing');
      }
      const buffer = await deps.downloadAudio(message.audio.id, config);
      const transcription = await deps.transcribeAudio(buffer, config.openaiApiKey);
      if (!transcription.trim()) {
        throw new Error('InboundAudioTranscriptionEmpty');
      }
      if (inboundPersisted) {
        // Só depois deste commit atômico o outbox deixa o estado `pending`.
        await deps.updateInboundContent(message.id, transcription);
        text = truncateForW1(transcription).text;
      } else {
        text = transcription;
      }
      console.log(
        `🎙️ Áudio transcrito | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | chars=${text.length}`
      );
    } catch (err) {
      Sentry.captureException(
        new Error('message_handler audio transcription failed'),
        {
          tags: {
            service: 'message_handler',
            operation: 'audio_transcription',
            phoneNumberId: config.phoneNumberId,
            tenantSlug: config.tenantSlug,
            messageId: message.id,
            error_kind: runtimeErrorKind(err),
          },
        }
      );
      console.error(
        `❌ Falha ao transcrever áudio | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | error=${runtimeErrorKind(err)}`
      );
      if (inboundPersisted) {
        try {
          await deps.markTranscriptionFailed(message.id);
          await deliverPersistedInbound();
        } catch (finalizeError) {
          Sentry.captureException(
            new Error('ana inbound transcription failure finalization failed'),
            {
              tags: {
                service: 'message_handler',
                operation: 'finalize_audio_failure',
                phoneNumberId: config.phoneNumberId,
                messageId: message.id,
                error_kind: runtimeErrorKind(finalizeError),
              },
            }
          );
        }
      }
      const transcriptionFallback = canonicalReceptionistOutbound(
        'TRANSCRIPTION_FALLBACK',
        'Desculpe, não consegui ouvir o áudio. Pode me mandar por escrito?',
        config
      );
      if (config.botRole !== 'sales') {
        const resumeAllowed = await (deps.resumeGate ?? shouldAnaResumeForInbound)({
          config,
          customerPhone: from,
          customerName: name,
        });
        if (resumeAllowed) {
          await sendDirectReceptionistReplyIfUnpaused(
            from,
            transcriptionFallback,
            config,
            deps
          );
        }
      } else {
        await (deps.sendReply ?? sendConfiguredReply)(
          from,
          transcriptionFallback,
          config
        );
      }
      return;
    }
  }

  // Texto/lista/botão já estavam finais na transação; áudio só chega aqui após
  // history+content_status finalizados. Tipos sem texto enviam W1 `no_text`.
  await deliverPersistedInbound();

  if (!text.trim()) return;

  if (await deps.handleOptOut(text, from, config)) {
    // Sales-only: opt-out de compliance também encerra a régua de follow-up da
    // Renata (o receptionist não tem régua, então nada muda pra ele).
    if (config.botRole === 'sales') {
      await markFollowupOptedOut(config.phoneNumberId, from).catch(() => undefined);
    }
    return;
  }

  // C1: o referral só acompanha a primeira mensagem CTWA. Capturamos mesmo se
  // a conversa estiver pausada, mas exclusivamente no brain de vendas. Não
  // bloqueia nem altera a resposta da Renata.
  if (config.botRole === 'sales' && message.referral?.ctwa_clid) {
    void captureReferral(config.phoneNumberId, from, message.referral).catch(
      () => undefined
    );
    // A Meta só anexa referral na primeira janela CTWA. O estado é volátil,
    // first-write-wins e sales-only; a headline nunca entra em logs.
    if (message.referral.headline) {
      rememberConversationAdHeadline(
        buildConversationKey(config.phoneNumberId, from),
        message.referral.headline
      );
    }
  }

  if (
    inboundDeliveryPending &&
    (await deps.shouldSuspend(config.phoneNumberId, from))
  ) {
    console.info(
      `⏸️ [escalation] inbound ${message.id} pendente; conversa mantida suspensa.`
    );
    return;
  }

  if (
    config.botRole !== 'sales' &&
    !(await (deps.resumeGate ?? shouldAnaResumeForInbound)({
      config,
      customerPhone: from,
      customerName: name,
    }))
  ) {
    console.log(
      `⏸️ [retomada] Ana permaneceu em silêncio | phoneNumberId=${config.phoneNumberId} | convHash=${convHash}`
    );
    return;
  }

  // Pausa: se o salão (geral) OU esta conversa estão pausados, a Ana fica calada
  // (sem OpenAI, sem buffer). FAIL-OPEN: erro/timeout/404 → responde normal.
  // Opt-out roda ANTES (compliance vale mesmo pausado). §8.2/INV-10: enquanto
  // pausada, a Ana NÃO responde mas REGISTRA o inbound no histórico (o echo do
  // humano é gravado pelo echoHandler) — assim ela tem contexto ao retomar.
  if (await deps.isPaused(config.phoneNumberId, from)) {
    if (config.botRole === 'sales') {
      cancelOnboardingPolling(conversationKey);
    }
    if (!inboundPersisted) {
      await recordInboundWhilePaused(conversationKey, text, config);
    }
    console.log('⏸️ [pausado] Ana não responde; inbound registrado no histórico.');
    return;
  }

  conversationTracker.markActive(conversationKey);
  if (config.botRole === 'sales') {
    // Novo inbound cancela a rodada de polling vigente. Só a frase
    // determinística de conclusão habilita a segunda (e última) rodada.
    noteOnboardingInbound(conversationKey, text);
    console.log(
      `💬 Mensagem de vendas recebida | ${safeSalesContext(config, from)} | chars=${text.length}`
    );
  } else {
    console.log(
      `💬 Inbound recebida | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | chars=${text.length}`
    );
  }

  const bufferKey = buildBufferKey(config, from);

  if (!isBotActive(config)) {
    // FIX 2: só envia o aviso de fora-de-horário 1x por janela (por conversa),
    // pra não spammar quem manda várias mensagens seguidas fora do expediente.
    if (shouldSendOutsideHoursNotice(bufferKey)) {
      const outsideHoursMessage = buildOutsideHoursMessage(config);
      const outbound = canonicalReceptionistOutbound(
        'OUTSIDE_HOURS',
        outsideHoursMessage,
        config
      );
      let delivered = false;
      try {
        if (config.botRole !== 'sales') {
          delivered =
            (await sendDirectReceptionistReplyIfUnpaused(
              from,
              outbound,
              config,
              deps
            )) === 'sent';
        } else {
          const result = await (deps.sendReply ?? sendConfiguredReply)(
            from,
            outbound,
            config
          );
          delivered = (result ?? 'sent') === 'sent';
        }
      } finally {
        if (!delivered) releaseOutsideHoursNotice(bufferKey);
      }
    } else {
      console.log(
        `🟡 [fora-de-horário] aviso suprimido | ${safeSalesContext(config, from)}`
      );
    }
    return;
  }

  if (config.botRole === 'sales') {
    cancelSalesRecovery(conversationKey);
  }

  const existing = messageBuffers.get(bufferKey);

  if (existing) {
    if (existing.isProcessing) {
      existing.pendingTexts.push(text);
      if (inboundPersisted) existing.pendingMessageIds.push(message.id);
      existing.name = name;
      existing.config = config;
      console.log(
        `📥 Mensagem adicionada à fila pendente | ${safeSalesContext(config, from)}`
      );
    } else {
      if (existing.timer) clearTimeout(existing.timer);
      existing.texts.push(text);
      if (inboundPersisted) existing.messageIds.push(message.id);
      existing.name = name;
      existing.config = config;
      existing.timer = setTimeout(() => {
        flushBuffer(bufferKey).catch((err) => {
          console.error(
            `❌ Erro ao processar mensagens | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
          );
        });
      }, DEBOUNCE_TIME_MS);
    }
  } else {
    const now = Date.now();
    const newBuffer: MessageBuffer = {
      texts: [text],
      name,
      timer: null,
      maxWaitTimer: null,
      firstMessageAt: now,
      config,
      from,
      isProcessing: false,
      pendingTexts: [],
      inboundPersisted,
      messageIds: inboundPersisted ? [message.id] : [],
      pendingMessageIds: [],
    };

    newBuffer.timer = setTimeout(() => {
      flushBuffer(bufferKey).catch((err) => {
        console.error(
          `❌ Erro ao processar mensagens | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
        );
      });
    }, DEBOUNCE_TIME_MS);

    newBuffer.maxWaitTimer = setTimeout(() => {
      console.log(`⏰ Max wait atingido | ${safeSalesContext(config, from)}`);
      flushBuffer(bufferKey).catch((err) => {
        console.error(
          `❌ Erro no max-wait flush | ${safeSalesContext(config, from)} | error=${errorKind(err)}`
        );
      });
    }, MAX_WAIT_TIME_MS);

    messageBuffers.set(bufferKey, newBuffer);
  }
}

// --- Test seams (M24) --------------------------------------------------------
// Exercitam o caminho de erro do flush de forma determinística no smoke
// (scripts/smoke-debounce-flush-error.ts) com deps injetadas — sem WhatsApp/
// OpenAI reais. Mesmo motivo do service-gate: imports ESM frozen impedem spy.

export function __seedFlushBufferForTest(
  config: TenantBotConfig,
  from: string,
  texts: string[]
): string {
  const bufferKey = buildBufferKey(config, from);
  messageBuffers.set(bufferKey, {
    texts: [...texts],
    name: 'Cliente',
    timer: null,
    maxWaitTimer: null,
    firstMessageAt: Date.now(),
    config,
    from,
    isProcessing: false,
    pendingTexts: [],
    inboundPersisted: false,
    messageIds: [],
    pendingMessageIds: [],
  });
  return bufferKey;
}

export function __hasBufferForTest(bufferKey: string): boolean {
  return messageBuffers.has(bufferKey);
}

export function __resetFlushStateForTest(): void {
  for (const buf of messageBuffers.values()) {
    if (buf.timer) clearTimeout(buf.timer);
    if (buf.maxWaitTimer) clearTimeout(buf.maxWaitTimer);
  }
  messageBuffers.clear();
  flushRecoveryUntil.clear();
  outsideHoursNoticeUntil.clear();
}
