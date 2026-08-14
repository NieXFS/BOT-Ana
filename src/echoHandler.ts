import { pauseConversationByEcho } from './services/pauseService';
import {
  addMessage,
  buildConversationKey,
} from './services/contextManager';
import {
  HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE,
  HUMAN_ECHO_PREFIX,
} from './services/humanConversationContext';
import {
  markMessageProcessed,
  unmarkMessageProcessed,
} from './services/processedMessages';
import { Sentry } from './observability/sentry';
import { runtimeErrorKind } from './observability/safeRuntime';
import {
  canonicalCustomerPhone,
  canonicalConversationKey,
  withConversationLock,
} from './services/conversationOrder';
import { getTenantConfig, type TenantBotConfig } from './configProvider';
import { downloadMedia } from './whatsappCloudService';
import { transcreverAudioBuffer } from './utils/transcriber';
import { isAnaResumeGateEnabled } from './services/anaResumeGate';
import { persistHumanEchoAtomically } from './services/anaWave2Store';

export { HUMAN_ECHO_PREFIX };

export interface EchoTarget {
  phoneNumberId: string;
  customerPhone: string;
}

/** Um echo do humano pronto pra gravar no histórico (§8.2/INV-10). */
export interface EchoMessage {
  phoneNumberId: string;
  customerPhone: string;
  /** message id do echo — chave de idempotência (a Meta retransmite). */
  messageId: string;
  messageType: string;
  /** ID de mídia do objeto audio/voice; nunca entra em log/telemetria. */
  mediaId: string | null;
  /** conteúdo JÁ prefixado com HUMAN_ECHO_PREFIX, pronto pra persistir. */
  content: string;
}

export interface EchoDeps {
  pauseConversation: (phoneNumberId: string, customerPhone: string) => Promise<void>;
  /** Idempotência por message id do echo: true = 1ª vez (gravar); false = noop. */
  markEchoProcessed: (
    messageId: string,
    phoneNumberId: string,
    conversationKey?: string
  ) => Promise<boolean>;
  /** Desfaz a marca quando a gravação falha → a retransmissão da Meta re-tenta. */
  unmarkEcho: (messageId: string) => Promise<void>;
  /** Caminho produtivo: dedup + histórico em uma transação crash-safe. */
  persistEchoAtomically?: (input: {
    messageId: string;
    phoneNumberId: string;
    conversationKey: string;
    content: string;
  }) => Promise<boolean>;
  recordMessage: (
    conversationKey: string,
    role: 'user' | 'assistant',
    content: string
  ) => Promise<void>;
  loadConfig?: (phoneNumberId: string) => Promise<TenantBotConfig | null>;
  downloadAudio?: typeof downloadMedia;
  transcribeAudio?: typeof transcreverAudioBuffer;
  shouldTranscribeHumanAudio?: (config: TenantBotConfig) => boolean;
  /** Mesma serialização PG do intake/envio. Omitida em smokes legados = inline. */
  withConversationLock?: (
    phoneNumberId: string,
    customerPhone: string,
    work: () => Promise<void>
  ) => Promise<void>;
  /** Fala humana invalida PendingFrame v2 dentro da mesma advisory lock. */
  invalidatePendingByHuman?: (
    phoneNumberId: string,
    customerPhone: string
  ) => Promise<void>;
}

async function invalidatePendingByHumanWhenV2Enabled(
  phoneNumberId: string,
  customerPhone: string
): Promise<void> {
  const raw = process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS?.trim();
  if (!raw) return;
  const config = await getTenantConfig(phoneNumberId);
  if (!config) return;
  const [{ isAnaConversationalV2Enabled }, { pgConversationalV2StateStore }] =
    await Promise.all([
      import('./services/conversationalV2/featureFlag'),
      import('./services/conversationalV2/stateStore'),
    ]);
  if (!isAnaConversationalV2Enabled(config.tenantSlug, raw)) return;
  await pgConversationalV2StateStore.invalidateOpenPendingByHuman(
    canonicalConversationKey(phoneNumberId, customerPhone)
  );
}

const defaultEchoDeps: EchoDeps = {
  pauseConversation: pauseConversationByEcho,
  markEchoProcessed: markMessageProcessed,
  unmarkEcho: unmarkMessageProcessed,
  persistEchoAtomically: persistHumanEchoAtomically,
  recordMessage: addMessage,
  withConversationLock: (phoneNumberId, customerPhone, work) =>
    withConversationLock(phoneNumberId, customerPhone, async () => work()),
  loadConfig: getTenantConfig,
  downloadAudio: downloadMedia,
  transcribeAudio: transcreverAudioBuffer,
  shouldTranscribeHumanAudio: isAnaResumeGateEnabled,
  invalidatePendingByHuman: invalidatePendingByHumanWhenV2Enabled,
};

/** A Meta envia o campo "smb_message_echoes" em change.field (Coexistence). */
export function isEchoChange(field: unknown): boolean {
  return field === 'smb_message_echoes';
}

/**
 * Parser PURO e defensivo do `change.value` de smb_message_echoes.
 *
 * Shape (Meta): `value.metadata.phone_number_id` + `value.message_echoes[]`, em
 * que cada echo tem `from` (número do salão) e `to` (número do CLIENTE). Como a
 * Ana envia pelo Cloud API (não pelo app), todo smb_message_echoes = ação humana
 * pelo app → o número a pausar é o `to`.
 *
 * Defensivo: ignora payload sem objeto, sem `phone_number_id` (com fallback do
 * env), e echo sem `to`. Deduplica por cliente (1 PAUSA por cliente por payload).
 */
export function parseEchoTargets(
  value: unknown,
  fallbackPhoneNumberId?: string
): EchoTarget[] {
  if (!value || typeof value !== 'object') return [];

  const v = value as {
    metadata?: { phone_number_id?: unknown };
    message_echoes?: unknown;
  };

  const rawPhoneId =
    typeof v.metadata?.phone_number_id === 'string'
      ? v.metadata.phone_number_id.trim()
      : '';
  const phoneNumberId = rawPhoneId || (fallbackPhoneNumberId ?? '').trim();
  if (!phoneNumberId) return [];

  const echoes = Array.isArray(v.message_echoes) ? v.message_echoes : [];
  const targets: EchoTarget[] = [];
  const seen = new Set<string>();

  for (const echo of echoes) {
    if (!echo || typeof echo !== 'object') continue;
    const to = (echo as { to?: unknown }).to;
    const customerPhone =
      typeof to === 'string' ? canonicalCustomerPhone(to) : '';
    if (!customerPhone) continue;
    if (seen.has(customerPhone)) continue;
    seen.add(customerPhone);
    targets.push({ phoneNumberId, customerPhone });
  }

  return targets;
}

/** Placeholder curto por tipo de echo não-textual (sem vazar conteúdo). */
function placeholderForType(type: string): string {
  switch (type) {
    case 'image':
      return 'enviou uma imagem';
    case 'audio':
    case 'voice':
      return 'enviou um áudio';
    case 'video':
      return 'enviou um vídeo';
    case 'document':
      return 'enviou um documento';
    case 'sticker':
      return 'enviou uma figurinha';
    case 'location':
      return 'enviou uma localização';
    case 'contacts':
      return 'enviou um contato';
    default:
      return 'enviou uma mensagem';
  }
}

/**
 * Conteúdo a gravar para um echo, JÁ prefixado com HUMAN_ECHO_PREFIX. Echo de
 * texto = o corpo; não-texto = placeholder curto por tipo. Ponto ÚNICO em que o
 * prefixo é aplicado → o que `parseEchoMessages` devolve é o que se persiste.
 */
function buildEchoContent(echo: {
  type?: unknown;
  text?: { body?: unknown };
}): string {
  const type = typeof echo.type === 'string' ? echo.type : '';
  if (type === 'text') {
    const body = typeof echo.text?.body === 'string' ? echo.text.body.trim() : '';
    return `${HUMAN_ECHO_PREFIX}${body || 'enviou uma mensagem'}`;
  }
  if (type === 'audio' || type === 'voice') {
    return `${HUMAN_ECHO_PREFIX}${HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE}`;
  }
  return `${HUMAN_ECHO_PREFIX}${placeholderForType(type)}`;
}

/**
 * Parser PURO dos echoes a GRAVAR (§8.2). Diferente de parseEchoTargets: NÃO
 * deduplica por cliente (cada mensagem do humano é gravada) e EXIGE `id` (sem id
 * não há como deduplicar na retransmissão → omite; a PAUSA do mesmo echo ainda
 * ocorre via parseEchoTargets, que não depende do id). Defensivo a malformados.
 */
export function parseEchoMessages(
  value: unknown,
  fallbackPhoneNumberId?: string
): EchoMessage[] {
  if (!value || typeof value !== 'object') return [];

  const v = value as {
    metadata?: { phone_number_id?: unknown };
    message_echoes?: unknown;
  };

  const rawPhoneId =
    typeof v.metadata?.phone_number_id === 'string'
      ? v.metadata.phone_number_id.trim()
      : '';
  const phoneNumberId = rawPhoneId || (fallbackPhoneNumberId ?? '').trim();
  if (!phoneNumberId) return [];

  const echoes = Array.isArray(v.message_echoes) ? v.message_echoes : [];
  const messages: EchoMessage[] = [];

  for (const echo of echoes) {
    if (!echo || typeof echo !== 'object') continue;
    const e = echo as {
      to?: unknown;
      id?: unknown;
      type?: unknown;
      text?: { body?: unknown };
      audio?: { id?: unknown };
      voice?: { id?: unknown };
    };
    const customerPhone =
      typeof e.to === 'string' ? canonicalCustomerPhone(e.to) : '';
    const messageId = typeof e.id === 'string' ? e.id.trim() : '';
    if (!customerPhone || !messageId) continue;
    const messageType = typeof e.type === 'string' ? e.type : '';
    const rawMediaId =
      messageType === 'voice' ? e.voice?.id ?? e.audio?.id : e.audio?.id;
    const mediaId = typeof rawMediaId === 'string' ? rawMediaId.trim() : '';
    messages.push({
      phoneNumberId,
      customerPhone,
      messageId,
      messageType,
      mediaId: mediaId || null,
      content: buildEchoContent(e),
    });
  }

  return messages;
}

async function resolveEchoContent(
  message: EchoMessage,
  deps: EchoDeps
): Promise<string> {
  if (message.messageType !== 'audio' && message.messageType !== 'voice') {
    return message.content;
  }

  const loadConfig = deps.loadConfig ?? defaultEchoDeps.loadConfig;
  const downloadAudio = deps.downloadAudio ?? defaultEchoDeps.downloadAudio;
  const transcribeAudio = deps.transcribeAudio ?? defaultEchoDeps.transcribeAudio;
  const shouldTranscribe =
    deps.shouldTranscribeHumanAudio ?? defaultEchoDeps.shouldTranscribeHumanAudio;
  try {
    const config = await loadConfig?.(message.phoneNumberId);
    if (!config || !shouldTranscribe?.(config)) {
      return `${HUMAN_ECHO_PREFIX}${HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE}`;
    }
    if (!message.mediaId || !downloadAudio || !transcribeAudio) {
      return `${HUMAN_ECHO_PREFIX}${HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE}`;
    }
    const audio = await downloadAudio(message.mediaId, config);
    const transcription = (await transcribeAudio(
      audio,
      config.openaiApiKey
    )).trim();
    if (!transcription) {
      return `${HUMAN_ECHO_PREFIX}${HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE}`;
    }
    console.log(
      `🎙️ Áudio do atendente transcrito | phoneNumberId=${message.phoneNumberId} | chars=${transcription.length}`
    );
    return `${HUMAN_ECHO_PREFIX}${transcription}`;
  } catch (err) {
    Sentry.captureException(new Error('echo audio transcription failed'), {
      level: 'warning',
      tags: {
        service: 'echo_handler',
        operation: 'transcribe_human_audio',
        phoneNumberId: message.phoneNumberId,
        error_kind: runtimeErrorKind(err),
      },
    });
    return `${HUMAN_ECHO_PREFIX}${HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE}`;
  }
}

/**
 * Processa um `change.value` de smb_message_echoes:
 *  1) PAUSA cada conversa cujo dono respondeu pelo app (1 por cliente/payload);
 *  2) GRAVA cada echo do humano no histórico como role `assistant` (§8.2/INV-10),
 *     pra Ana ter contexto ao retomar. Idempotente por message id (a Meta
 *     retransmite) → não grava 2x.
 *
 * Falha de persistência/serialização é observada e PROPAGADA para o webhook
 * responder 5xx. Só depois da gravação durável a Meta pode receber 200; assim
 * uma retransmissão continua possível se o processo ou o PostgreSQL falharem.
 * NUNCA loga o conteúdo do echo (só o fato; o scrub vale — sem console.log do
 * texto). Qualquer tipo de echo conta como ação humana → pausa.
 */
export async function handleSmbMessageEchoes(
  value: unknown,
  fallbackPhoneNumberId?: string,
  deps: EchoDeps = defaultEchoDeps
): Promise<void> {
  const targets = parseEchoTargets(value, fallbackPhoneNumberId);
  const messages = parseEchoMessages(value, fallbackPhoneNumberId);
  const serialize =
    deps.withConversationLock ??
    (async (_phoneNumberId: string, _customerPhone: string, work: () => Promise<void>) =>
      work());
  let processingFailure: unknown = null;

  // A pausa local é publicada antes de qualquer I/O caro. Download/transcrição
  // ficam fora da advisory lock para não prender o pool por segundos; somente
  // dedup + persistência final compartilham a lock de ordenação da conversa.
  for (const target of targets) {
    try {
      await deps.pauseConversation(target.phoneNumberId, target.customerPhone);
    } catch (err) {
      // A pausa local já foi publicada pelo pauseService. Ainda assim, sem o
      // carimbo durável no ERP a entrega não pode ser confirmada à Meta: o erro
      // agregado no final faz o webhook responder 5xx e habilita retransmissão.
      processingFailure ??= err;
      Sentry.captureException(new Error('echo durable pause failed'), {
        tags: {
          service: 'echo_handler',
          operation: 'pause_conversation',
          phoneNumberId: target.phoneNumberId,
          error_kind: runtimeErrorKind(err),
        },
      });
    }

    try {
      const resolvedMessages: Array<{
        message: EchoMessage;
        content: string;
      }> = [];
      for (const message of messages) {
        if (
          message.phoneNumberId !== target.phoneNumberId ||
          message.customerPhone !== target.customerPhone
        ) {
          continue;
        }
        resolvedMessages.push({
          message,
          content: await resolveEchoContent(message, deps),
        });
      }

      await serialize(target.phoneNumberId, target.customerPhone, async () => {
        for (const { message, content } of resolvedMessages) {
          const conversationKey = canonicalConversationKey(
            message.phoneNumberId,
            message.customerPhone
          );
          if (deps.persistEchoAtomically) {
            try {
              await deps.persistEchoAtomically({
                messageId: message.messageId,
                phoneNumberId: message.phoneNumberId,
                conversationKey,
                content,
              });
            } catch (err) {
              processingFailure ??= err;
              Sentry.captureException(new Error('echo atomic persistence failed'), {
                tags: {
                  service: 'echo_handler',
                  operation: 'persist_echo_atomically',
                  phoneNumberId: message.phoneNumberId,
                  error_kind: runtimeErrorKind(err),
                },
              });
            }
            continue;
          }
          let fresh = true;
          try {
            fresh = await deps.markEchoProcessed(
              message.messageId,
              message.phoneNumberId,
              conversationKey
            );
          } catch (err) {
            processingFailure ??= err;
            Sentry.captureException(new Error('echo dedup write failed'), {
              tags: {
                service: 'echo_handler',
                operation: 'mark_echo_processed',
                phoneNumberId: message.phoneNumberId,
                error_kind: runtimeErrorKind(err),
              },
            });
            continue;
          }
          if (!fresh) continue;

          try {
            await deps.recordMessage(
              buildConversationKey(message.phoneNumberId, message.customerPhone),
              'assistant',
              content
            );
          } catch (err) {
            processingFailure ??= err;
            Sentry.captureException(new Error('echo history write failed'), {
              tags: {
                service: 'echo_handler',
                operation: 'record_echo',
                phoneNumberId: message.phoneNumberId,
                error_kind: runtimeErrorKind(err),
              },
            });
            try {
              await deps.unmarkEcho(message.messageId);
            } catch (unmarkErr) {
              processingFailure ??= unmarkErr;
              Sentry.captureException(new Error('echo dedup rollback failed'), {
                tags: {
                  service: 'echo_handler',
                  operation: 'unmark_echo',
                  phoneNumberId: message.phoneNumberId,
                  error_kind: runtimeErrorKind(unmarkErr),
                },
              });
            }
          }
        }
        await (deps.invalidatePendingByHuman ??
          defaultEchoDeps.invalidatePendingByHuman)?.(
          target.phoneNumberId,
          target.customerPhone
        );
      });
    } catch (err) {
      processingFailure ??= err;
      Sentry.captureException(new Error('echo serialization failed'), {
        tags: {
          service: 'echo_handler',
          operation: 'serialize_echo',
          phoneNumberId: target.phoneNumberId,
          error_kind: runtimeErrorKind(err),
        },
      });
    }
  }

  if (processingFailure) {
    const error = new Error('HumanEchoProcessingFailed');
    (error as Error & { cause?: unknown }).cause = processingFailure;
    throw error;
  }
}
