import 'dotenv/config';
// Init do Sentry o mais cedo possível (depois do dotenv, antes do express e
// dos services) pra instrumentar erros e auto-instrumentar http/express.
import { Sentry } from './observability/sentry';
import express, { Request, Response } from 'express';
import { getTenantConfig } from './configProvider';
import {
  handleIncomingMessage,
  CloudMessage,
  CloudContact,
  redactPhone,
} from './messageHandler';
import {
  botSignatureMiddleware,
  webhookRateLimitMiddleware,
  isValidBearerToken,
} from './security';
import {
  ensureProcessedMessagesTable,
  markMessageProcessed,
  cleanupOldProcessedMessages,
} from './services/processedMessages';
import {
  ensureSalesFollowupsTable,
  startFollowupPoller,
} from './services/salesFollowups';
import { handleSalesNotify } from './services/salesNotify';
import { resetAdminConversation } from './services/adminReset';
import {
  isValidAdminReprocessInput,
  reprocessSalesResponse,
} from './services/adminReprocess';
import {
  getLastMessageMeta,
  listConversations,
  getHistoryWithTimestamps,
} from './services/contextManager';
import { decideConversationActivity } from './services/conversationActivity';
import { ERP_API_TOKEN } from './erpApiToken';
import { isEchoChange, handleSmbMessageEchoes } from './echoHandler';
import { ensureTtsCacheTable } from './voice/ttsCache';
import { ensureTtsUsageTable } from './voice/costMeter';
import { ensureChannelPrefsTable } from './voice/channelPref';
import { checkFfmpegAvailable } from './voice/audioEncoder';
import {
  getVoiceEnvConfig,
  providerApiKey,
} from './voice/voiceConfig';
import { ensureMediaCacheTable } from './media/mediaCache';

interface CloudWebhookMetadata {
  phone_number_id?: string;
}

interface CloudWebhookValue {
  metadata?: CloudWebhookMetadata;
  contacts?: CloudContact[];
  messages?: CloudMessage[];
}

const app = express();

// 1) Rate limit ANTES do parser: barra enxurradas sem custo de parsing JSON.
app.use(webhookRateLimitMiddleware);

// 2) Parser de JSON capturando o corpo bruto (rawBody) — necessário para o
//    HMAC da Meta, que tem que bater contra os BYTES exatos recebidos, não
//    contra um JSON re-serializado.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

const VERIFY_TOKEN =
  process.env.WA_GLOBAL_VERIFY_TOKEN ?? process.env.WA_VERIFY_TOKEN ?? '';
const LEGACY_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID ?? '';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function processWebhookValue(value: CloudWebhookValue): Promise<void> {
  const phoneNumberId =
    value.metadata?.phone_number_id?.trim() || LEGACY_PHONE_NUMBER_ID;

  if (!phoneNumberId) {
    console.warn('⚠️ Webhook recebido sem phone_number_id.');
    return;
  }

  const config = await getTenantConfig(phoneNumberId);

  if (!config || !config.isActive) {
    console.warn(`⚠️ Nenhuma configuração ativa encontrada para ${phoneNumberId}.`);
    return;
  }

  const contacts = value.contacts ?? [];

  for (const message of value.messages ?? []) {
    // Idempotência: a Meta retransmite em timeout/erro. Marca atômico por
    // message_id; reenvio vira noop (sem resposta/agendamento duplicado).
    const fresh = await markMessageProcessed(message.id, phoneNumberId);
    if (!fresh) {
      console.log(`↩️ Mensagem ${message.id} já processada — ignorando retransmissão da Meta.`);
      continue;
    }

    const contact = contacts.find((entry) => entry.wa_id === message.from);

    // Escopo de isolamento por mensagem: tudo que acontecer dentro do
    // processamento desta mensagem fica anexado a este contexto no Sentry.
    // Só metadados não-PII (phoneNumberId do salão, tenantSlug, messageId) —
    // o número e o conteúdo do cliente NÃO entram no contexto.
    Sentry.withIsolationScope((scope) => {
      scope.setTag('phoneNumberId', phoneNumberId);
      scope.setTag('tenantSlug', config.tenantSlug);
      scope.setTag('messageId', message.id);
      scope.setContext('whatsapp_message', {
        phoneNumberId,
        tenantSlug: config.tenantSlug,
        messageId: message.id,
        type: message.type,
      });

      return handleIncomingMessage(message, contact, config).catch((err) => {
        if (config.botRole === 'sales') {
          Sentry.captureException(
            new Error('webhook_server sales message processing failed')
          );
          console.error(
            `❌ Erro ao processar mensagem de vendas | phoneNumberId=${phoneNumberId} | lead=${redactPhone(message.from)} | error=${err instanceof Error ? err.name : typeof err}`
          );
        } else {
          Sentry.captureException(err);
          console.error(`❌ Erro ao processar mensagem de ${message.from}:`, err);
        }
      });
    });
  }
}

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado pela Meta.');
    res.status(200).send(challenge);
    return;
  }

  console.warn('⚠️ Falha na verificação do webhook — token incorreto.');
  res.sendStatus(403);
});

app.post('/webhook', botSignatureMiddleware, (req: Request, res: Response) => {
  res.sendStatus(200);

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value as CloudWebhookValue | undefined;
      if (!value) {
        continue;
      }

      // Coexistence: o dono respondeu PELO app do WhatsApp (echo) → pausa a
      // conversa pra Ana não falar por cima do humano. NÃO é mensagem de cliente,
      // então não vai pra handleIncomingMessage.
      if (isEchoChange(change?.field)) {
        handleSmbMessageEchoes(value, LEGACY_PHONE_NUMBER_ID).catch((err) => {
          Sentry.captureException(err);
          console.error('❌ Erro ao processar smb_message_echoes:', err);
        });
        continue;
      }

      if (!value.messages?.length) {
        continue;
      }

      processWebhookValue(value).catch((err) => {
        Sentry.captureException(err);
        console.error('❌ Erro ao processar payload do webhook:', err);
      });
    }
  }
});

/**
 * POST /sales-notify (Renata v1.1, D4)
 *
 * O Receps avisa que o lead virou trial (a conta ficou pronta). Autenticado
 * pelo MESMO HMAC do forward do webhook (`RECEPS_BOT_WEBHOOK_SECRET` via
 * X-Bot-Signature) — fail-closed em produção, igual ao /webhook.
 *
 * Responde 200 na hora e processa fora do request: o Receps dispara isso no meio
 * da criação do trial e não pode ficar esperando o WhatsApp. Body:
 * `{ customerPhone, event: "trial_started" }`.
 */
app.post('/sales-notify', botSignatureMiddleware, (req: Request, res: Response) => {
  res.sendStatus(200);

  const customerPhone =
    typeof req.body?.customerPhone === 'string' ? req.body.customerPhone.trim() : '';
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';

  if (!customerPhone || !event) {
    console.warn('⚠️ [sales-notify] payload sem customerPhone/event — ignorado.');
    return;
  }

  handleSalesNotify(event, customerPhone).catch((err) => {
    Sentry.captureException(err, {
      tags: { service: 'webhook_server', operation: 'sales_notify' },
    });
    console.error('❌ Erro ao processar sales-notify:', err);
  });
});

app.post(
  '/admin/reset-conversation',
  botSignatureMiddleware,
  async (req: Request, res: Response) => {
    const phoneNumberId =
      typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId.trim() : '';
    const customerPhone =
      typeof req.body?.customerPhone === 'string' ? req.body.customerPhone.trim() : '';
    const dryRun = req.body?.dryRun;

    if (
      !phoneNumberId ||
      !customerPhone ||
      (dryRun !== undefined && typeof dryRun !== 'boolean')
    ) {
      res.status(400).json({
        error: 'phoneNumberId/customerPhone obrigatórios; dryRun deve ser boolean.',
      });
      return;
    }

    try {
      const counts = await resetAdminConversation({
        phoneNumberId,
        customerPhone,
        dryRun,
      });
      console.info(
        `[admin-reset] concluído | phoneNumberId=${phoneNumberId} | dryRun=${dryRun === true} | history=${counts.history} | followups=${counts.followups}`
      );
      res.status(200).json(counts);
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          service: 'webhook_server',
          operation: 'admin_reset_conversation',
          phoneNumberId,
        },
      });
      console.error(`[admin-reset] falha | phoneNumberId=${phoneNumberId}`);
      res.status(500).json({ error: 'internal error' });
    }
  }
);

app.post(
  '/admin/reprocess-response',
  botSignatureMiddleware,
  async (req: Request, res: Response) => {
    if (!isValidAdminReprocessInput(req.body)) {
      res.status(400).json({
        error: 'phoneNumberId e customerPhone são obrigatórios.',
      });
      return;
    }

    const phoneNumberId = req.body.phoneNumberId.trim();
    const customerPhone = req.body.customerPhone.trim();

    try {
      const result = await reprocessSalesResponse({
        phoneNumberId,
        customerPhone,
      });
      console.info(
        `[admin-reprocess] concluído | phoneNumberId=${phoneNumberId} | replied=${result.replied}`
      );
      res.status(200).json(result);
    } catch (err) {
      Sentry.captureException(
        new Error('webhook_server admin reprocess failed'),
        {
          tags: {
            service: 'webhook_server',
            operation: 'admin_reprocess_response',
            phoneNumberId,
            error_kind: err instanceof Error ? err.name : typeof err,
          },
        }
      );
      console.error(
        `[admin-reprocess] falha | phoneNumberId=${phoneNumberId} | error=${
          err instanceof Error ? err.name : typeof err
        }`
      );
      res.status(500).json({ error: 'internal error' });
    }
  }
);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

/**
 * GET /internal/conversation-activity?phoneNumberId=&customerPhone= (§8.1/§11)
 *
 * O motor de automação do Receps consulta ANTES de cada envio proativo (guarda de
 * "bom momento"). Auth: Bearer ERP_API_TOKEN (segredo compartilhado Ana↔Receps =
 * AI_BOT_API_KEY do Receps). A Ana devolve SÓ o que ela sabe (deriva do
 * histórico) — o estado de PAUSA fica do lado do Receps, então NÃO retornamos
 * `paused`. NUNCA loga/ecoa o token nem o telefone do cliente (PII).
 */
app.get('/internal/conversation-activity', (req: Request, res: Response) => {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }

  const phoneNumberId =
    typeof req.query.phoneNumberId === 'string' ? req.query.phoneNumberId.trim() : '';
  const customerPhone =
    typeof req.query.customerPhone === 'string' ? req.query.customerPhone.trim() : '';

  if (!phoneNumberId || !customerPhone) {
    res.status(400).json({ error: 'phoneNumberId e customerPhone são obrigatórios.' });
    return;
  }

  getLastMessageMeta(phoneNumberId, customerPhone)
    .then((meta) => {
      const activity = decideConversationActivity(
        {
          lastRole: meta?.role ?? null,
          lastActivityAtMs: meta?.lastActivityAtMs ?? null,
        },
        Date.now()
      );
      res.json(activity);
    })
    .catch((err) => {
      Sentry.captureException(err, {
        tags: {
          service: 'webhook_server',
          operation: 'conversation_activity',
          phoneNumberId,
        },
      });
      console.error('❌ Erro ao consultar conversation-activity:', err);
      res.status(500).json({ error: 'internal error' });
    });
});

/** Parseia um query param inteiro; ausente/vazio/inválido → undefined (o
 * clamp em contextManager aplica os defaults). */
function parseQueryInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * GET /internal/conversations?phoneNumberId=&limit=&offset=
 *
 * Lista as conversas da Ana de um tenant (por phoneNumberId), para o histórico
 * de conversas no painel interno do Receps (/painel-receps, SUPER_ADMIN). Auth:
 * Bearer ERP_API_TOKEN (segredo compartilhado Ana↔Receps = AI_BOT_API_KEY do
 * Receps). READ-ONLY sobre a janela rolante de MAX_MESSAGES — não mexe no trim.
 * NUNCA loga/ecoa o token nem o telefone/conteúdo do cliente (PII).
 */
app.get('/internal/conversations', (req: Request, res: Response) => {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }

  const phoneNumberId =
    typeof req.query.phoneNumberId === 'string' ? req.query.phoneNumberId.trim() : '';

  if (!phoneNumberId) {
    res.status(400).json({ error: 'phoneNumberId é obrigatório.' });
    return;
  }

  listConversations(
    phoneNumberId,
    parseQueryInt(req.query.limit),
    parseQueryInt(req.query.offset)
  )
    .then((result) => {
      res.json(result);
    })
    .catch((err) => {
      Sentry.captureException(err, {
        tags: {
          service: 'webhook_server',
          operation: 'list_conversations',
          phoneNumberId,
        },
      });
      console.error('❌ Erro ao listar conversas:', err);
      res.status(500).json({ error: 'internal error' });
    });
});

/**
 * GET /internal/conversation-messages?phoneNumberId=&customerPhone=
 *
 * Thread completa de UMA conversa (janela de MAX_MESSAGES, ordem ASC) para o
 * painel interno do Receps. Mesma auth do /internal/conversations. Mensagens
 * `assistant` com prefixo "[atendente] " (echo do humano) VÃO no payload como
 * estão — quem interpreta o marcador é a UI do Receps. Conversa inexistente →
 * { messages: [] } (200). NUNCA loga PII.
 */
app.get('/internal/conversation-messages', (req: Request, res: Response) => {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }

  const phoneNumberId =
    typeof req.query.phoneNumberId === 'string' ? req.query.phoneNumberId.trim() : '';
  const customerPhone =
    typeof req.query.customerPhone === 'string' ? req.query.customerPhone.trim() : '';

  if (!phoneNumberId || !customerPhone) {
    res.status(400).json({ error: 'phoneNumberId e customerPhone são obrigatórios.' });
    return;
  }

  getHistoryWithTimestamps(phoneNumberId, customerPhone)
    .then((messages) => {
      res.json({ messages });
    })
    .catch((err) => {
      Sentry.captureException(err, {
        tags: {
          service: 'webhook_server',
          operation: 'conversation_messages',
          phoneNumberId,
        },
      });
      console.error('❌ Erro ao consultar conversation-messages:', err);
      res.status(500).json({ error: 'internal error' });
    });
});

async function boot(): Promise<void> {
  // Garante a tabela de idempotência ANTES de aceitar tráfego, e limpa antigos.
  await ensureProcessedMessagesTable();
  cleanupOldProcessedMessages()
    .then((n) => {
      if (n > 0) console.log(`🧹 ${n} message_id(s) antigos removidos de processed_messages.`);
    })
    .catch((err) => {
      Sentry.captureException(err);
      console.error('❌ Cleanup de processed_messages falhou:', err);
    });

  // Workstream B (Renata): régua de follow-up. Garante a tabela e liga o poller
  // de 30min por default (só VENDA — o receptionist não escreve na tabela).
  await ensureSalesFollowupsTable();
  startFollowupPoller();

  // Voz da Renata: tabelas raw pg + checagem do ffmpeg antes de aceitar
  // tráfego. A flag continua OFF por default; sem chave/ffmpeg o gate mantém
  // texto, sem degradar a recepção nem deixar a Renata em silêncio.
  await ensureTtsCacheTable();
  await ensureTtsUsageTable();
  await ensureChannelPrefsTable();
  await ensureMediaCacheTable();
  const ffmpegReady = await checkFfmpegAvailable();
  const voiceConfig = getVoiceEnvConfig();

  if (!ffmpegReady && process.env.NODE_ENV === 'production') {
    Sentry.captureMessage('renata_voice: ffmpeg missing', {
      level: 'warning',
      tags: { service: 'renata_voice', reason: 'ffmpeg_missing' },
    });
  }

  const voiceState = !voiceConfig.enabled
    ? 'disabled (flag_off)'
    : !providerApiKey(voiceConfig, voiceConfig.provider)
      ? `disabled (api_key_missing provider=${voiceConfig.provider})`
      : !ffmpegReady
        ? 'disabled (ffmpeg_missing)'
        : `enabled (ready provider=${voiceConfig.provider})`;
  console.log(`🔊 Renata voice: ${voiceState}`);

  app.listen(PORT, () => {
    console.log(`🚀 Ana — Atendente Virtual rodando na porta ${PORT}`);
  });
}

boot().catch((err) => {
  Sentry.captureException(err);
  console.error('❌ Falha no boot da Ana:', err);
  process.exit(1);
});
