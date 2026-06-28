import { pauseConversationByEcho } from './services/pauseService';
import {
  addMessage,
  buildConversationKey,
  HUMAN_ECHO_PREFIX,
} from './services/contextManager';
import {
  markMessageProcessed,
  unmarkMessageProcessed,
} from './services/processedMessages';
import { Sentry } from './observability/sentry';

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
  /** conteúdo JÁ prefixado com HUMAN_ECHO_PREFIX, pronto pra persistir. */
  content: string;
}

export interface EchoDeps {
  pauseConversation: (phoneNumberId: string, customerPhone: string) => Promise<void>;
  /** Idempotência por message id do echo: true = 1ª vez (gravar); false = noop. */
  markEchoProcessed: (messageId: string, phoneNumberId: string) => Promise<boolean>;
  /** Desfaz a marca quando a gravação falha → a retransmissão da Meta re-tenta. */
  unmarkEcho: (messageId: string) => Promise<void>;
  recordMessage: (
    conversationKey: string,
    role: 'user' | 'assistant',
    content: string
  ) => Promise<void>;
}

const defaultEchoDeps: EchoDeps = {
  pauseConversation: pauseConversationByEcho,
  markEchoProcessed: markMessageProcessed,
  unmarkEcho: unmarkMessageProcessed,
  recordMessage: addMessage,
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
    const customerPhone = typeof to === 'string' ? to.trim() : '';
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
    };
    const customerPhone = typeof e.to === 'string' ? e.to.trim() : '';
    const messageId = typeof e.id === 'string' ? e.id.trim() : '';
    if (!customerPhone || !messageId) continue;
    messages.push({
      phoneNumberId,
      customerPhone,
      messageId,
      content: buildEchoContent(e),
    });
  }

  return messages;
}

/**
 * Processa um `change.value` de smb_message_echoes:
 *  1) PAUSA cada conversa cujo dono respondeu pelo app (1 por cliente/payload);
 *  2) GRAVA cada echo do humano no histórico como role `assistant` (§8.2/INV-10),
 *     pra Ana ter contexto ao retomar. Idempotente por message id (a Meta
 *     retransmite) → não grava 2x.
 *
 * NUNCA lança (os erros das chamadas são capturados aqui e no pauseService).
 * NUNCA loga o conteúdo do echo (só o fato; o scrub vale — sem console.log do
 * texto). Qualquer tipo de echo conta como ação humana → pausa.
 */
export async function handleSmbMessageEchoes(
  value: unknown,
  fallbackPhoneNumberId?: string,
  deps: EchoDeps = defaultEchoDeps
): Promise<void> {
  // 1) Pausa (handoff). Não depende de id; dedup por cliente já no parser.
  const targets = parseEchoTargets(value, fallbackPhoneNumberId);
  for (const target of targets) {
    await deps.pauseConversation(target.phoneNumberId, target.customerPhone);
  }

  // 2) Captura no histórico (escuta enquanto pausada). Dedup por message id.
  const messages = parseEchoMessages(value, fallbackPhoneNumberId);
  for (const message of messages) {
    let fresh = true;
    try {
      fresh = await deps.markEchoProcessed(message.messageId, message.phoneNumberId);
    } catch (err) {
      // Sem o "carimbo" de idempotência não dá pra garantir 1x → NÃO grava
      // (evita duplicar na retransmissão). Captura sem PII.
      Sentry.captureException(err, {
        tags: {
          service: 'echo_handler',
          operation: 'mark_echo_processed',
          phoneNumberId: message.phoneNumberId,
        },
      });
      continue;
    }
    if (!fresh) continue;

    try {
      await deps.recordMessage(
        buildConversationKey(message.phoneNumberId, message.customerPhone),
        'assistant',
        message.content
      );
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          service: 'echo_handler',
          operation: 'record_echo',
          phoneNumberId: message.phoneNumberId,
        },
      });
      // A marca de idempotência já foi gravada (markEchoProcessed acima); como a
      // gravação no histórico FALHOU, desfaz a marca pra a retransmissão da Meta
      // re-tentar — senão o echo (contexto do §8.2) sumiria de vez num blip de
      // DB. Best-effort: se o unmark também falhar, capturamos e seguimos.
      try {
        await deps.unmarkEcho(message.messageId);
      } catch (unmarkErr) {
        Sentry.captureException(unmarkErr, {
          tags: {
            service: 'echo_handler',
            operation: 'unmark_echo',
            phoneNumberId: message.phoneNumberId,
          },
        });
      }
    }
  }
}
