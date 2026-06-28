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
import { getLastMessageMeta } from './services/contextManager';
import { decideConversationActivity } from './services/conversationActivity';
import { ERP_API_TOKEN } from './erpApiToken';
import { isEchoChange, handleSmbMessageEchoes } from './echoHandler';

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
        Sentry.captureException(err);
        console.error(`❌ Erro ao processar mensagem de ${message.from}:`, err);
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

  app.listen(PORT, () => {
    console.log(`🚀 Ana — Atendente Virtual rodando na porta ${PORT}`);
  });
}

boot().catch((err) => {
  Sentry.captureException(err);
  console.error('❌ Falha no boot da Ana:', err);
  process.exit(1);
});
