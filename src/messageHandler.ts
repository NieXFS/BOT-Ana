import type { TenantBotConfig } from './configProvider';
import { getReply } from './services/brainService';
import { addMessage, buildConversationKey } from './services/contextManager';
import { tryHandleOptOut } from './services/optOutService';
import { isConversationPaused } from './services/pauseService';
import { markFollowupOptedOut } from './services/salesFollowups';
import { transcreverAudioBuffer } from './utils/transcriber';
import {
  sendFreeformMessage,
  downloadMedia,
  typingDelay,
} from './whatsappCloudService';
import { conversationTracker } from './conversationTracker';
import { Sentry } from './observability/sentry';

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

export interface FlushDeps {
  getReply: typeof getReply;
  sendReply: (
    from: string,
    text: string,
    config: TenantBotConfig
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

const defaultFlushDeps: FlushDeps = {
  getReply,
  sendReply: async (from, text, config) => {
    if (typingSimEnabled(config)) {
      await typingDelay(text);
    }
    await sendFreeformMessage(from, text, config);
  },
};

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
    console.log(`🟡 [flush] ${bufferKey} em janela de recovery — fallback suprimido`);
    return;
  }
  flushRecoveryUntil.set(bufferKey, now + FLUSH_RECOVERY_WINDOW_MS);
  try {
    await deps.sendReply(from, FLUSH_FALLBACK_MESSAGE, config);
    console.log(`🆘 [flush] fallback de erro enviado para ${bufferKey}`);
  } catch (sendErr) {
    Sentry.captureException(sendErr, {
      tags: {
        service: 'message_handler',
        operation: 'flush_fallback_send',
        phoneNumberId: config.phoneNumberId,
        tenantSlug: config.tenantSlug,
      },
    });
    console.error(`❌ [flush] falha ao enviar fallback para ${bufferKey}:`, sendErr);
  }
}

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
  const consolidatedText = buffer.texts.join(' ');
  const messageCount = buffer.texts.length;
  buffer.texts = [];
  const { name, config, from } = buffer;

  console.log(`🧠 Enviando para ${config.botName} (${bufferKey}): "${consolidatedText}"`);

  let flushFailed = false;
  try {
    const reply = await deps.getReply(from, consolidatedText, name, config);

    await deps.sendReply(from, reply, config);
    console.log(`🤖 ${config.botName} respondeu para ${bufferKey}: "${reply}"`);
  } catch (err) {
    flushFailed = true;
    Sentry.captureException(err, {
      tags: {
        service: 'message_handler',
        operation: 'flush_buffer',
        phoneNumberId: config.phoneNumberId,
        tenantSlug: config.tenantSlug,
        messageCount,
      },
    });
    console.error(`❌ Erro ao processar mensagens de ${bufferKey}:`, err);
    // M24: antes o cliente ficava em silêncio total quando o flush falhava.
    // Avisa que houve um problema e pede pra repetir (uma vez por janela).
    await emitFlushFallback(bufferKey, from, config, deps);
  }

  const currentBuffer = messageBuffers.get(bufferKey);
  if (!currentBuffer) return;

  // M24: flush falhou → limpa o buffer INTEIRO (inclui pendingTexts) e NÃO
  // re-arma. Um debounce condenado só re-falharia, e o cliente já foi convidado
  // a reenviar; o que ele mandar de novo abre um buffer limpo. A janela de
  // recovery impede spam de fallback se ele insistir.
  if (flushFailed) {
    messageBuffers.delete(bufferKey);
    return;
  }

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
    Sentry.captureException(err, {
      tags: {
        service: 'message_handler',
        operation: 'record_inbound_while_paused',
        phoneNumberId: config.phoneNumberId,
        tenantSlug: config.tenantSlug,
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
      Sentry.captureException(err, {
        tags: { service: 'message_handler', operation: 'audio_transcription' },
      });
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

  if (await tryHandleOptOut(text, from, config)) {
    // Sales-only: opt-out de compliance também encerra a régua de follow-up da
    // Renata (o receptionist não tem régua, então nada muda pra ele).
    if (config.botRole === 'sales') {
      await markFollowupOptedOut(config.phoneNumberId, from).catch(() => undefined);
    }
    return;
  }

  // Pausa: se o salão (geral) OU esta conversa estão pausados, a Ana fica calada
  // (sem OpenAI, sem buffer). FAIL-OPEN: erro/timeout/404 → responde normal.
  // Opt-out roda ANTES (compliance vale mesmo pausado). §8.2/INV-10: enquanto
  // pausada, a Ana NÃO responde mas REGISTRA o inbound no histórico (o echo do
  // humano é gravado pelo echoHandler) — assim ela tem contexto ao retomar.
  if (await isConversationPaused(config.phoneNumberId, from)) {
    await recordInboundWhilePaused(conversationKey, text, config);
    console.log('⏸️ [pausado] Ana não responde; inbound registrado no histórico.');
    return;
  }

  conversationTracker.markActive(conversationKey);
  console.log(`💬 Mensagem de ${conversationKey} (${name}): "${text}"`);

  const bufferKey = buildBufferKey(config, from);

  if (!isBotActive(config)) {
    // FIX 2: só envia o aviso de fora-de-horário 1x por janela (por conversa),
    // pra não spammar quem manda várias mensagens seguidas fora do expediente.
    if (shouldSendOutsideHoursNotice(bufferKey)) {
      const outsideHoursMessage = buildOutsideHoursMessage(config);
      await typingDelay(outsideHoursMessage);
      await sendFreeformMessage(from, outsideHoursMessage, config);
    } else {
      console.log(`🟡 [fora-de-horário] aviso suprimido (throttle) para ${bufferKey}`);
    }
    return;
  }

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
