import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import { sendFreeformMessage, typingDelay } from '../whatsappCloudService';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const ERP_API_TOKEN =
  process.env.ERP_API_TOKEN ?? 'minha-chave-secreta-receps-123';

const OPT_OUT_KEYWORDS = [
  'pare',
  'parar',
  'sair',
  'cancelar',
  'cancelar inscricao',
  'nao quero mais',
  'nao envie mais',
  'nao receber mais',
  'remover',
  'me remove',
  'descadastrar',
];

const MAX_OPT_OUT_WORDS = 6;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OPT_OUT_REGEX = new RegExp(
  `\\b(?:${OPT_OUT_KEYWORDS.map(escapeRegex).join('|')})\\b`,
  'i'
);

export function isOptOutMessage(text: string): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0 || wordCount > MAX_OPT_OUT_WORDS) return false;
  return OPT_OUT_REGEX.test(normalized);
}

interface OptOutResponse {
  ok: boolean;
  customerFound: boolean;
  reason?: string;
  customerId?: string;
}

async function callReceps(
  phoneNumberId: string,
  customerPhone: string
): Promise<OptOutResponse | null> {
  try {
    const { data } = await axios.post<OptOutResponse>(
      `${RECEPS_INTERNAL_API_URL}/api/internal/opt-out`,
      { phoneNumberId, customerPhone },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    );
    return data;
  } catch (error) {
    const message = axios.isAxiosError(error)
      ? error.response?.status
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message
      : String(error);
    console.error(`❌ [optOut] falha ao chamar Receps: ${message}`);
    return null;
  }
}

export async function tryHandleOptOut(
  text: string,
  from: string,
  config: TenantBotConfig
): Promise<boolean> {
  if (!isOptOutMessage(text)) return false;

  console.log(`🚫 [optOut] mensagem de ${from} identificada como opt-out: "${text}"`);

  const result = await callReceps(config.phoneNumberId, from);

  if (result) {
    if (result.customerFound) {
      console.log(`✅ [optOut] cliente ${result.customerId} marcado como optOut.`);
    } else {
      console.log(
        `ℹ️ [optOut] cliente não localizado no Receps${
          result.reason ? ` (${result.reason})` : ''
        }. Confirmação será enviada mesmo assim.`
      );
    }
  }

  const botName = config.botName || 'nossa atendente';
  const reply = `Entendi! A partir de agora você não receberá mais mensagens automáticas da ${botName}. Se precisar de algo, é só nos chamar aqui.`;

  try {
    await typingDelay(reply);
    await sendFreeformMessage(from, reply, config);
  } catch (error) {
    console.error(`❌ [optOut] falha ao enviar confirmação para ${from}:`, error);
  }

  return true;
}
