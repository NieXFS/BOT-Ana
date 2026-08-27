import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import { sendFreeformMessage, typingDelay } from '../whatsappCloudService';
import {
  canonicalReceptionistOutbound,
  deliverValidatedReceptionistText,
} from './receptionistOutbound';
import { Sentry } from '../observability/sentry';
import { ERP_API_TOKEN } from '../erpApiToken';
import {
  conversationHash,
  runtimeErrorKind,
  safeHttpStatus,
} from '../observability/safeRuntime';
import {
  assertExternalWriteAllowed,
  labBlockedWriteEffect,
} from '../runtimePolicy';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';

const STRONG_STOP_KEYWORDS = new Set<string>([
  'pare', 'parar', 'parem',
  'descadastrar', 'descadastra', 'descadastre', 'descadastrem', 'descadastro',
  'stop',
]);

// Estes verbos também pertencem ao domínio operacional da recepção. Mesmo em
// mensagens curtas, só significam opt-out quando a cliente explicita que está
// falando das comunicações — nunca apenas de um agendamento/horário.
const AMBIGUOUS_DOMAIN_STOP_KEYWORDS = new Set<string>([
  'cancelar', 'cancele', 'cancela', 'cancelem',
  'remover', 'remova', 'remove', 'removam',
  'sair', 'saia', 'saiam',
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

  // Compatibilidade com o comando unitário consagrado "PARA", sem recolocar
  // a preposição mais comum do português no léxico forte.
  if (normalized === 'para') return true;

  // Perguntar sobre parar/cancelar/remover nunca executa uma mutação de
  // compliance por keyword. Frases explícitas acima permanecem soberanas.
  if (text.trim().endsWith('?')) return false;

  const hasStrong = hasAny(words, STRONG_STOP_KEYWORDS);
  if (hasStrong) {
    if (wordCount <= VERY_SHORT_MSG_WORDS) return true;
    return hasContext;
  }

  return hasAny(words, AMBIGUOUS_DOMAIN_STOP_KEYWORDS) && hasContext;
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
    assertExternalWriteAllowed();
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
    // M10: a falha de opt-out no Receps deixava o cliente "marcado" mas não
    // registrado — risco LGPD silencioso. Reporta ao Sentry. O telefone do
    // cliente (customerPhone) NÃO vai nas tags (PII); só o phoneNumberId do
    // negócio (allowlistado no scrub da Ana).
    Sentry.captureException(new Error('ana opt-out Receps request failed'), {
      tags: {
        service: 'ana-opt-out',
        operation: 'call-receps',
        phoneNumberId,
        error_kind: runtimeErrorKind(error),
        http_status: safeHttpStatus(error) ?? 'n/a',
      },
    });
    console.error(
      `❌ [optOut] falha ao chamar Receps | phoneNumberId=${phoneNumberId} | error=${runtimeErrorKind(error)} | status=${safeHttpStatus(error) ?? 'n/a'}`
    );
    return null;
  }
}

export async function tryHandleOptOut(
  text: string,
  from: string,
  config: TenantBotConfig
): Promise<boolean> {
  if (!isOptOutMessage(text)) return false;

  const convHash = conversationHash(config.phoneNumberId, from);
  console.log(
    `🚫 [optOut] detectado | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | chars=${text.length}`
  );

  const labBlock = labBlockedWriteEffect('optOut');
  const result = labBlock
    ? null
    : await callReceps(config.phoneNumberId, from);

  if (result) {
    if (result.customerFound) {
      console.log(
        `✅ [optOut] persistido | phoneNumberId=${config.phoneNumberId} | convHash=${convHash}`
      );
    } else {
      console.log(
        `ℹ️ [optOut] cliente não localizado | phoneNumberId=${config.phoneNumberId} | convHash=${convHash}`
      );
    }
  }

  const botName = config.botName || 'nossa atendente';
  const reply = labBlock
    ? 'Não consegui atualizar sua preferência por este atendimento. Por favor, peça à equipe do estabelecimento para interromper as mensagens.'
    : `Entendi! A partir de agora você não receberá mais mensagens automáticas da ${botName}. Se precisar de algo, é só nos chamar aqui.`;

  try {
    if (config.botRole !== 'sales') {
      const outbound = canonicalReceptionistOutbound('OPT_OUT', reply, config);
      await typingDelay(outbound.payload);
      await deliverValidatedReceptionistText(from, outbound, config);
    } else {
      await typingDelay(reply);
      await sendFreeformMessage(from, reply, config);
    }
  } catch (error) {
    // M10: confirmação de opt-out não enviada = cliente sem feedback de que
    // foi removido. Reporta ao Sentry sem o número do cliente (PII).
    Sentry.captureException(new Error('ana opt-out confirmation send failed'), {
      tags: {
        service: 'ana-opt-out',
        operation: 'send-confirmation',
        phoneNumberId: config.phoneNumberId,
        error_kind: runtimeErrorKind(error),
        http_status: safeHttpStatus(error) ?? 'n/a',
      },
    });
    console.error(
      `❌ [optOut] falha ao enviar confirmação | phoneNumberId=${config.phoneNumberId} | convHash=${convHash} | error=${runtimeErrorKind(error)} | status=${safeHttpStatus(error) ?? 'n/a'}`
    );
  }

  return true;
}
