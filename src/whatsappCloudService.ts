import axios, { type AxiosRequestConfig } from 'axios';
import type { TenantBotConfig } from './configProvider';

export type WhatsAppTenantConfig = Pick<
  TenantBotConfig,
  'phoneNumberId' | 'waAccessToken' | 'waApiVersion'
>;

function buildApiUrl(waConfig: WhatsAppTenantConfig) {
  return `https://graph.facebook.com/${waConfig.waApiVersion}/${waConfig.phoneNumberId}/messages`;
}

/** Limite cancelável do POST; evita segurar a lock da conversa indefinidamente. */
export const WHATSAPP_TEXT_TIMEOUT_MS = 20_000;

const headers = (waConfig: WhatsAppTenantConfig) => ({
  Authorization: `Bearer ${waConfig.waAccessToken}`,
  'Content-Type': 'application/json',
});

// --- Mensagem de texto livre (dentro da janela de 24h) -----------------------
export async function sendFreeformMessage(
  to: string,
  text: string,
  waConfig: WhatsAppTenantConfig
): Promise<void> {
  await axios.post(
    buildApiUrl(waConfig),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    { headers: headers(waConfig), timeout: WHATSAPP_TEXT_TIMEOUT_MS }
  );
}

export class WhatsAppReceiptMissingError extends Error {
  readonly deliveryClassification = 'ambiguous' as const;

  constructor() {
    super('WhatsApp provider response contained no message id');
    this.name = 'WhatsAppReceiptMissingError';
  }
}

/**
 * Transporte com recibo (Rev. 3 §5.2). Diferente do helper legado acima, esta
 * variante só conclui sucesso quando a Meta devolve `messages[0].id`.
 */
export async function sendFreeformMessageWithReceipt(
  to: string,
  text: string,
  waConfig: WhatsAppTenantConfig
): Promise<{ providerMessageId: string }> {
  const response = await axios.post<{
    messages?: Array<{ id?: unknown }>;
  }>(
    buildApiUrl(waConfig),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    { headers: headers(waConfig), timeout: WHATSAPP_TEXT_TIMEOUT_MS }
  );

  const providerMessageId = response.data?.messages?.[0]?.id;
  if (typeof providerMessageId !== 'string' || !providerMessageId.trim()) {
    throw new WhatsAppReceiptMissingError();
  }
  return { providerMessageId: providerMessageId.trim() };
}

/**
 * Sem resposta HTTP, o POST pode ter sido aceito pela Meta e só o recibo ter se
 * perdido. Essa condição nunca autoriza retry nem outra mensagem automática.
 */
export function isAmbiguousWhatsAppTransportError(error: unknown): boolean {
  if (error instanceof WhatsAppReceiptMissingError) return true;
  if (!error || typeof error !== 'object') return false;

  // Axios normalmente preserva `isAxiosError`, mas adapters, interceptors e
  // wrappers podem devolver um Error estruturalmente equivalente. Depois que o
  // caller entrou na etapa de POST, timeout/reset sem resposta HTTP continua
  // sendo resultado DESCONHECIDO: a Meta pode ter aceitado o payload. Exigir a
  // marca privada do Axios aqui autorizava fallback/retry justamente nos erros
  // comuns ETIMEDOUT/ECONNRESET.
  const candidate = error as {
    code?: unknown;
    request?: unknown;
    response?: unknown;
  };
  if (candidate.response) return false;
  const ambiguousCode = [
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ERR_NETWORK',
  ].includes(String(candidate.code ?? '').toUpperCase());

  return axios.isAxiosError(error)
    ? Boolean(candidate.request) || ambiguousCode
    : ambiguousCode;
}

// --- Simulação de digitação --------------------------------------------------
export async function typingDelay(text: string): Promise<void> {
  const MS_PER_CHAR = 50;
  const MIN_MS = 2_000;
  const MAX_MS = 10_000;
  const ms = Math.min(Math.max(text.length * MS_PER_CHAR, MIN_MS), MAX_MS);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// --- Download de mídia (áudios enviados pelo cliente) ------------------------
export async function downloadMedia(
  mediaId: string,
  waConfig: WhatsAppTenantConfig
): Promise<Buffer> {
  // Passo 1: Resolve a URL do CDN a partir do media ID
  const urlResponse = await axios.get<{ url: string }>(
    `https://graph.facebook.com/${waConfig.waApiVersion}/${mediaId}`,
    { headers: headers(waConfig) }
  );

  // Passo 2: Baixa o binário
  const mediaResponse = await axios.get<ArrayBuffer>(urlResponse.data.url, {
    headers: { Authorization: `Bearer ${waConfig.waAccessToken}` },
    responseType: 'arraybuffer',
  });

  return Buffer.from(mediaResponse.data);
}

// --- Upload + envio de nota de voz (Renata) ---------------------------------

export type WhatsAppHttpPost = (
  url: string,
  data: unknown,
  config?: AxiosRequestConfig
) => Promise<{ data: unknown }>;

const defaultHttpPost: WhatsAppHttpPost = (url, data, config) =>
  axios.post(url, data, config);

export function buildAudioMessagePayload(to: string, mediaId: string) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { id: mediaId, voice: true },
  } as const;
}

export function buildVideoMessagePayload(
  to: string,
  mediaId: string,
  caption?: string
) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'video',
    video: {
      id: mediaId,
      ...(caption ? { caption } : {}),
    },
  } as const;
}

/**
 * Faz upload de OGG/Opus usando FormData/Blob globais do Node 20. O axios
 * reconhece FormData WHATWG e injeta o boundary correto; por isso não setamos
 * Content-Type manualmente.
 */
export async function uploadMedia(
  oggBuffer: Buffer,
  waConfig: WhatsAppTenantConfig,
  post: WhatsAppHttpPost = defaultHttpPost
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append(
    'file',
    new Blob([new Uint8Array(oggBuffer)], { type: 'audio/ogg' }),
    'renata.ogg'
  );

  const response = await post(
    `https://graph.facebook.com/${waConfig.waApiVersion}/${waConfig.phoneNumberId}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${waConfig.waAccessToken}`,
      },
      timeout: 20_000,
    }
  );

  const mediaId = (response.data as { id?: unknown } | undefined)?.id;
  if (typeof mediaId !== 'string' || !mediaId) {
    throw new Error('WhatsApp media upload returned no id');
  }
  return mediaId;
}

/** Upload do MP4 commitado da demonstração; 10 MB pedem timeout maior. */
export async function uploadVideoMedia(
  videoBuffer: Buffer,
  waConfig: WhatsAppTenantConfig,
  post: WhatsAppHttpPost = defaultHttpPost
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append(
    'file',
    new Blob([new Uint8Array(videoBuffer)], { type: 'video/mp4' }),
    'receps-demo.mp4'
  );

  const response = await post(
    `https://graph.facebook.com/${waConfig.waApiVersion}/${waConfig.phoneNumberId}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${waConfig.waAccessToken}`,
      },
      timeout: 60_000,
    }
  );

  const mediaId = (response.data as { id?: unknown } | undefined)?.id;
  if (typeof mediaId !== 'string' || !mediaId) {
    throw new Error('WhatsApp video upload returned no id');
  }
  return mediaId;
}

/** Envia o media ID como PTT (`voice:true`), não como anexo de áudio comum. */
export async function sendAudioMessage(
  to: string,
  mediaId: string,
  waConfig: WhatsAppTenantConfig,
  post: WhatsAppHttpPost = defaultHttpPost
): Promise<void> {
  await post(buildApiUrl(waConfig), buildAudioMessagePayload(to, mediaId), {
    headers: headers(waConfig),
    timeout: 20_000,
  });
}

/** Envia um vídeo já hospedado pela Graph API. */
export async function sendVideoMessage(
  to: string,
  mediaId: string,
  waConfig: WhatsAppTenantConfig,
  post: WhatsAppHttpPost = defaultHttpPost,
  caption?: string
): Promise<void> {
  await post(
    buildApiUrl(waConfig),
    buildVideoMessagePayload(to, mediaId, caption),
    {
      headers: headers(waConfig),
      timeout: 20_000,
    }
  );
}
