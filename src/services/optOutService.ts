import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import { sendFreeformMessage, typingDelay } from '../whatsappCloudService';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const ERP_API_TOKEN =
  process.env.ERP_API_TOKEN ?? 'minha-chave-secreta-receps-123';

const STRONG_STOP_KEYWORDS = new Set<string>([
  'pare', 'parar', 'parem', 'para',
  'cancelar', 'cancele', 'cancela', 'cancelem',
  'remover', 'remova', 'remove', 'removam',
  'descadastrar', 'descadastra', 'descadastre', 'descadastrem', 'descadastro',
  'sair', 'saia', 'saiam',
  'stop',
]);

const COMMS_CONTEXT_KEYWORDS = new Set<string>([
  'mensagem', 'mensagens',
  'marketing',
  'automacao', 'automacoes', 'automatica', 'automaticas', 'automatico', 'automaticos',
  'envio', 'envios', 'enviar', 'envia', 'envie', 'enviem',
  'receber', 'recebo', 'recebia',
  'whatsapp', 'wpp', 'zap', 'zapzap',
  'propaganda', 'propagandas',
  'publicidade',
  'comunicacao', 'comunicacoes', 'comunicado', 'comunicados',
  'newsletter',
  'aviso', 'avisos',
  'lembrete', 'lembretes',
  'spam',
]);

const OPT_OUT_PHRASES = [
  'me remove', 'me removam', 'me remova', 'me retire', 'me retira', 'me retirem',
  'me descadastra', 'me descadastre', 'me descadastrem',
  'nao quero mais', 'nao quero receber', 'nao quero mensagem', 'nao quero mensagens',
  'nao envie mais', 'nao envia mais', 'nao mande mais', 'nao manda mais',
  'nao receber mais', 'nao quero ser incomodado', 'nao quero ser incomodada',
  'parar de receber', 'parar com isso', 'para de mandar', 'para de enviar',
  'sair da lista',
];

const MAX_OPT_OUT_WORDS = 15;
const SHORT_MSG_WORDS = 6;
const VERY_SHORT_MSG_WORDS = 3;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function hasAny(words: string[], set: Set<string>): boolean {
  for (const w of words) {
    if (set.has(w)) return true;
  }
  return false;
}

export function isOptOutMessage(text: string): boolean {
  if (!text) return false;

  const normalized = normalize(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (wordCount === 0 || wordCount > MAX_OPT_OUT_WORDS) return false;

  const hasContext = hasAny(words, COMMS_CONTEXT_KEYWORDS);

  for (const phrase of OPT_OUT_PHRASES) {
    if (normalized.includes(phrase)) {
      if (wordCount <= SHORT_MSG_WORDS) return true;
      if (hasContext) return true;
      break;
    }
  }

  const hasStrong = hasAny(words, STRONG_STOP_KEYWORDS);
  if (!hasStrong) return false;

  if (wordCount <= VERY_SHORT_MSG_WORDS) return true;

  return hasContext;
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
