import axios from 'axios';
import type { TenantBotConfig } from './configProvider';

type WhatsAppTenantConfig = Pick<
  TenantBotConfig,
  'phoneNumberId' | 'waAccessToken' | 'waApiVersion'
>;

function buildApiUrl(waConfig: WhatsAppTenantConfig) {
  return `https://graph.facebook.com/${waConfig.waApiVersion}/${waConfig.phoneNumberId}/messages`;
}

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
    { headers: headers(waConfig) }
  );
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
