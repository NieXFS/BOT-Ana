import type { TenantBotConfig } from './configProvider';
import { getReply } from './services/brainService';
import { buildConversationKey } from './services/contextManager';
import { tryHandleOptOut } from './services/optOutService';
import { transcreverAudioBuffer } from './utils/transcriber';
import {
  sendFreeformMessage,
  downloadMedia,
  typingDelay,
} from './whatsappCloudService';
import { conversationTracker } from './conversationTracker';

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
}

const messageBuffers = new Map<string, MessageBuffer>();
const DEBOUNCE_TIME_MS = 12_000;
const MAX_WAIT_TIME_MS = 30_000;

function buildBufferKey(config: TenantBotConfig, from: string): string {
  return `${config.phoneNumberId}:${from}`;
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

async function flushBuffer(bufferKey: string): Promise<void> {
  const buffer = messageBuffers.get(bufferKey);
  if (!buffer) return;

  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
  buffer.timer = null;
  buffer.maxWaitTimer = null;

  buffer.isProcessing = true;
  const consolidatedText = buffer.texts.join(' ');
  buffer.texts = [];
  const { name, config, from } = buffer;

  console.log(`🧠 Enviando para ${config.botName} (${bufferKey}): "${consolidatedText}"`);

  try {
    const reply = await getReply(from, consolidatedText, name, config);

    await typingDelay(reply);
    await sendFreeformMessage(from, reply, config);
    console.log(`🤖 ${config.botName} respondeu para ${bufferKey}: "${reply}"`);
  } catch (err) {
    console.error(`❌ Erro ao processar mensagens de ${bufferKey}:`, err);
  } finally {
    const currentBuffer = messageBuffers.get(bufferKey);
    if (!currentBuffer) return;

    if (currentBuffer.pendingTexts.length > 0) {
      console.log(
        `🔄 ${currentBuffer.pendingTexts.length} mensagem(s) pendente(s) pra ${bufferKey}, abrindo novo debounce`
      );
      currentBuffer.texts = currentBuffer.pendingTexts;
      currentBuffer.pendingTexts = [];
      currentBuffer.isProcessing = false;
      currentBuffer.firstMessageAt = Date.now();

      currentBuffer.timer = setTimeout(() => {
        flushBuffer(bufferKey).catch((err) =>
          console.error(`❌ Erro ao processar mensagens pendentes de ${bufferKey}:`, err)
        );
      }, DEBOUNCE_TIME_MS);

      currentBuffer.maxWaitTimer = setTimeout(() => {
        console.log(`⏰ Max wait atingido pra ${bufferKey}, forçando flush`);
        flushBuffer(bufferKey).catch((err) =>
          console.error(`❌ Erro no max-wait flush de ${bufferKey}:`, err)
        );
      }, MAX_WAIT_TIME_MS);
    } else {
      messageBuffers.delete(bufferKey);
    }
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
}

export interface CloudContact {
  profile?: { name?: string };
  wa_id?: string;
}

export async function handleIncomingMessage(
  message: CloudMessage,
  contact: CloudContact | undefined,
  config: TenantBotConfig
): Promise<void> {
  const from = message.from;
  const name = contact?.profile?.name ?? 'Cliente';
  const conversationKey = buildConversationKey(config.phoneNumberId, from);

  let text = '';

  if (message.type === 'button') {
    text = message.button?.text ?? '';
    console.log(`🔘 Botão clicado por ${conversationKey}: "${text}"`);
  } else if (message.type === 'text') {
    text = message.text?.body ?? '';
  } else if (message.type === 'audio') {
    if (!message.audio?.id) return;

    try {
      const buffer = await downloadMedia(message.audio.id, config);
      text = await transcreverAudioBuffer(buffer, config.openaiApiKey);
      console.log(`🎙️ Áudio transcrito de ${conversationKey}: "${text}"`);
    } catch (err) {
      console.error(`❌ Falha ao transcrever áudio de ${conversationKey}:`, err);
      await sendFreeformMessage(
        from,
        'Desculpe, não consegui ouvir o áudio. Pode me mandar por escrito?',
        config
      );
      return;
    }
  }

  if (!text.trim()) return;

  if (await tryHandleOptOut(text, from, config)) return;

  conversationTracker.markActive(conversationKey);
  console.log(`💬 Mensagem de ${conversationKey} (${name}): "${text}"`);

  if (!isBotActive(config)) {
    const outsideHoursMessage = buildOutsideHoursMessage(config);
    await typingDelay(outsideHoursMessage);
    await sendFreeformMessage(from, outsideHoursMessage, config);
    return;
  }

  const bufferKey = buildBufferKey(config, from);
  const existing = messageBuffers.get(bufferKey);

  if (existing) {
    if (existing.isProcessing) {
      existing.pendingTexts.push(text);
      existing.name = name;
      existing.config = config;
      console.log(`📥 Mensagem adicionada à fila pendente de ${bufferKey} (Ana processando)`);
    } else {
      if (existing.timer) clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.name = name;
      existing.config = config;
      existing.timer = setTimeout(() => {
        flushBuffer(bufferKey).catch((err) =>
          console.error(`❌ Erro ao processar mensagens de ${bufferKey}:`, err)
        );
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
    };

    newBuffer.timer = setTimeout(() => {
      flushBuffer(bufferKey).catch((err) =>
        console.error(`❌ Erro ao processar mensagens de ${bufferKey}:`, err)
      );
    }, DEBOUNCE_TIME_MS);

    newBuffer.maxWaitTimer = setTimeout(() => {
      console.log(`⏰ Max wait atingido pra ${bufferKey}, forçando flush`);
      flushBuffer(bufferKey).catch((err) =>
        console.error(`❌ Erro no max-wait flush de ${bufferKey}:`, err)
      );
    }, MAX_WAIT_TIME_MS);

    messageBuffers.set(bufferKey, newBuffer);
  }
}
