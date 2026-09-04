import 'dotenv/config';
// Init do Sentry o mais cedo possível (depois do dotenv, antes do express e
// dos services) pra instrumentar erros e auto-instrumentar http/express.
import { Sentry } from './observability/sentry';
import express, { Request, Response } from 'express';
import { getTenantConfig, type TenantBotConfig } from './configProvider';
import {
  deliverDurableSuccessorFallbackV2,
  handleIncomingMessage,
  reprocessDurableSuccessorBatchV2,
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
  pool,
} from './services/contextManager';
import { closeConversationOrderPoolForShutdown } from './services/conversationOrder';
import { panelVisibleConversationContent } from './services/humanConversationContext';
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
import { ensureAnaWave2Tables } from './services/anaWave2Store';
import {
  reprocessQuarantinedInbound,
  startInboundOutboxSweep,
  stopInboundOutboxSweep,
} from './services/inboundOutbox';
import {
  ensureSilentEscalationHoldTable,
  startSilentEscalationHoldSweep,
  stopSilentEscalationHoldSweep,
} from './services/silentEscalationHold';
import {
  getQuestionReplyStatus,
  sendQuestionReply,
} from './services/questionReplyService';
import { purgeConversationData } from './services/privacyPurge';
import {
  handleWhatsAppStatuses,
  startWhatsAppStatusCallbackSweep,
  stopWhatsAppStatusCallbackSweep,
} from './services/whatsappStatusHandler';
import { isAnaConversationalV2Enabled } from './services/conversationalV2/featureFlag';
import { questionReplyResultToHttp } from './services/questionReplyHttp';
import {
  conversationHash,
  runtimeErrorKind,
  technicalHash,
} from './observability/safeRuntime';
import {
  getAnaRetentionState,
  runAnaRetention,
  startAnaRetentionScheduler,
  stopAnaRetentionScheduler,
} from './services/anaRetention';
import { stopFollowupPoller } from './services/salesFollowups';
import {
  isMaintenanceWorkerEligible,
  readMaintenanceBoolean,
  stopAllMaintenanceSchedulers,
} from './services/maintenanceScheduler';

interface CloudWebhookMetadata {
  phone_number_id?: string;
}

interface CloudWebhookValue {
  metadata?: CloudWebhookMetadata;
  contacts?: CloudContact[];
  messages?: CloudMessage[];
  statuses?: unknown[];
}

export const app = express();

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
/** PM2 kill_timeout leaves a small margin after this graceful HTTP deadline. */
export const HTTP_SHUTDOWN_GRACE_MS = 25_000;
let runtimeReady = false;
let httpServer: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;

type WebhookEchoHandler = typeof handleSmbMessageEchoes;
let webhookEchoHandler: WebhookEchoHandler = handleSmbMessageEchoes;
type WebhookStatusHandler = typeof handleWhatsAppStatuses;
let webhookStatusHandler: WebhookStatusHandler = handleWhatsAppStatuses;
type WebhookStatusConfigLoader = (
  phoneNumberId: string
) => Promise<TenantBotConfig | null>;
let webhookStatusConfigLoader: WebhookStatusConfigLoader = getTenantConfig;

/** Seam exclusivo de smoke HTTP; `undefined` restaura o handler produtivo. */
export function __setWebhookEchoHandlerForTest(
  handler?: WebhookEchoHandler
): void {
  webhookEchoHandler = handler ?? handleSmbMessageEchoes;
}

/** Seam exclusivo de smoke HTTP; `undefined` restaura o handler produtivo. */
export function __setWebhookStatusHandlerForTest(
  handler?: WebhookStatusHandler
): void {
  webhookStatusHandler = handler ?? handleWhatsAppStatuses;
}

/** Seam exclusivo de smoke HTTP; `undefined` restaura o loader produtivo. */
export function __setWebhookStatusConfigLoaderForTest(
  loader?: WebhookStatusConfigLoader
): void {
  webhookStatusConfigLoader = loader ?? getTenantConfig;
}

export function isAnaV2ProviderStatusEligible(
  config: Pick<TenantBotConfig, 'botRole' | 'tenantSlug'> | null,
  rawAllowlist = process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS
): boolean {
  return Boolean(
    config &&
      config.botRole === 'receptionist' &&
      isAnaConversationalV2Enabled(config.tenantSlug, rawAllowlist)
  );
}

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
    // Renata/onboarding ficam explicitamente no caminho legado. A recepcionista
    // faz processed+history+seq+outbox dentro do próprio messageHandler.
    if (config.botRole === 'sales') {
      const fresh = await markMessageProcessed(message.id, phoneNumberId);
      if (!fresh) {
        console.log(
          `↩️ Mensagem ${message.id} já processada — ignorando retransmissão da Meta.`
        );
        continue;
      }
    }

    const contact = contacts.find((entry) => entry.wa_id === message.from);

    // Escopo de isolamento por mensagem: tudo que acontecer dentro do
    // processamento desta mensagem fica anexado a este contexto no Sentry.
    // Só metadados não-PII (phoneNumberId do salão, tenantSlug, hash do wamid) —
    // o wamid cru pode carregar o telefone do remetente de forma reversível.
    Sentry.withIsolationScope((scope) => {
      scope.setTag('phoneNumberId', phoneNumberId);
      scope.setTag('tenantSlug', config.tenantSlug);
      scope.setTag('messageIdHash', technicalHash(message.id));
      scope.setContext('whatsapp_message', {
        phoneNumberId,
        tenantSlug: config.tenantSlug,
        messageIdHash: technicalHash(message.id),
        type: message.type,
      });

      return handleIncomingMessage(message, contact, config).catch((err) => {
        if (config.botRole === 'sales') {
          Sentry.captureException(
            new Error('webhook_server sales message processing failed')
          );
          console.error(
            `❌ Erro ao processar mensagem de vendas | phoneNumberId=${phoneNumberId} | convHash=${conversationHash(phoneNumberId, message.from)} | error=${runtimeErrorKind(err)}`
          );
        } else {
          Sentry.captureException(new Error('webhook inbound processing failed'), {
            tags: {
              service: 'webhook_server',
              operation: 'inbound_message',
              phoneNumberId,
              messageIdHash: technicalHash(message.id),
              error_kind: runtimeErrorKind(err),
            },
          });
          console.error(
            `❌ Erro ao processar inbound | phoneNumberId=${phoneNumberId} | messageIdHash=${technicalHash(message.id)} | error=${runtimeErrorKind(err)}`
          );
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

app.post('/webhook', botSignatureMiddleware, async (req: Request, res: Response) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const allowV2ByPhoneNumberId = new Map<string, Promise<boolean>>();

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change?.value as CloudWebhookValue | undefined;
        if (!value) {
          continue;
        }

        // Coexistence: o dono respondeu PELO app do WhatsApp (echo) → pausa a
        // conversa pra Ana não falar por cima do humano. O 200 só sai DEPOIS
        // da persistência durável; falha retorna 500 para a Meta retransmitir.
        if (isEchoChange(change?.field)) {
          await webhookEchoHandler(value, LEGACY_PHONE_NUMBER_ID);
          continue;
        }

        // Status Meta (sent/delivered/read/failed) é um fato separado de inbound:
        // não passa pelo dedup por message.id e não é mais descartado. O
        // durable ingest termina antes do 200; callbacks ERP continuam fora
        // da resposta HTTP como obrigações retomáveis.
        if (value.statuses?.length) {
          const statusPhoneNumberId =
            value.metadata?.phone_number_id?.trim() || LEGACY_PHONE_NUMBER_ID;
          await webhookStatusHandler(value, undefined, {
            awaitCallbacks: false,
            throwOnPersistenceFailure: true,
            resolveAllowV2Fallback: async () => {
              if (!statusPhoneNumberId) return false;
              let pending = allowV2ByPhoneNumberId.get(statusPhoneNumberId);
              if (!pending) {
                pending = webhookStatusConfigLoader(statusPhoneNumberId).then(
                  (statusConfig) => {
                    if (!statusConfig) {
                      // Unknown legacy status + absent config is inconclusive,
                      // never evidence of v1/sales. Force Meta replay without
                      // exposing phone/config details.
                      throw new Error('status tenant config unavailable');
                    }
                    return isAnaV2ProviderStatusEligible(statusConfig);
                  }
                );
                allowV2ByPhoneNumberId.set(statusPhoneNumberId, pending);
              }
              return pending;
            },
          });
        }

        if (!value.messages?.length) {
          continue;
        }

        processWebhookValue(value).catch((err) => {
          Sentry.captureException(new Error('webhook payload processing failed'), {
            tags: {
              service: 'webhook_server',
              operation: 'process_payload',
              error_kind: runtimeErrorKind(err),
            },
          });
          console.error(
            `❌ Erro ao processar payload do webhook | error=${runtimeErrorKind(err)}`
          );
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    Sentry.captureException(new Error('webhook durable processing failed'), {
      tags: {
        service: 'webhook_server',
        operation: 'durable_ingest',
        error_kind: runtimeErrorKind(err),
      },
    });
    console.error(
      `❌ Erro no durable ingest do webhook | error=${runtimeErrorKind(err)}`
    );
    res.sendStatus(500);
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
 * `{ customerPhone, event: "trial_started", onboarding?: boolean }`.
 */
app.post('/sales-notify', botSignatureMiddleware, (req: Request, res: Response) => {
  res.sendStatus(200);

  const customerPhone =
    typeof req.body?.customerPhone === 'string' ? req.body.customerPhone.trim() : '';
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  const onboarding = req.body?.onboarding === true;

  if (!customerPhone || !event) {
    console.warn('⚠️ [sales-notify] payload sem customerPhone/event — ignorado.');
    return;
  }

  handleSalesNotify(
    event,
    customerPhone,
    undefined,
    onboarding
  ).catch((err) => {
    Sentry.captureException(new Error('sales notify processing failed'), {
      tags: {
        service: 'webhook_server',
        operation: 'sales_notify',
        error_kind: runtimeErrorKind(err),
      },
    });
    console.error(
      `❌ Erro ao processar sales-notify | error=${runtimeErrorKind(err)}`
    );
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
      Sentry.captureException(new Error('admin reset failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'admin_reset_conversation',
          phoneNumberId,
          error_kind: runtimeErrorKind(err),
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

function sendLiveHealth(_req: Request, res: Response): void {
  res.json({ status: 'ok', ts: new Date().toISOString() });
}

// Liveness não consulta o Neon e pode ser sondado com alta frequência.
app.get('/health/live', sendLiveHealth);
// Compatibilidade com o monitor histórico; continua sendo liveness, não readiness.
app.get('/health', sendLiveHealth);
// Readiness só informa o estado do próprio processo. A saúde do banco é uma
// verificação operacional separada, nunca embutida no endpoint de liveness.
app.get('/health/ready', (_req: Request, res: Response) => {
  res.status(runtimeReady ? 200 : 503).json({
    status: runtimeReady ? 'ok' : 'starting',
    ts: new Date().toISOString(),
  });
});

/**
 * POST /internal/question-replies/send (Rev. 3 §5.2/§5.5)
 * Body já contém a copy final montada pelo Receps. A Ana não reescreve texto.
 */
app.post('/internal/question-replies/send', async (req: Request, res: Response) => {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }

  const phoneNumberId =
    typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId.trim() : '';
  const customerPhone =
    typeof req.body?.customerPhone === 'string' ? req.body.customerPhone.trim() : '';
  const idempotencyKey =
    typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey.trim()
      : '';
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const sourceInboundMessageId =
    typeof req.body?.sourceInboundMessageId === 'string'
      ? req.body.sourceInboundMessageId.trim()
      : '';

  if (
    !phoneNumberId ||
    !customerPhone ||
    !idempotencyKey ||
    !text.trim() ||
    !sourceInboundMessageId
  ) {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }

  try {
    const config = await getTenantConfig(phoneNumberId);
    if (!config || !config.isActive) {
      res.status(404).json({ error: 'conversation owner not found' });
      return;
    }
    const result = await sendQuestionReply(
      {
        contractVersion:
          typeof req.body?.contractVersion === 'number'
            ? req.body.contractVersion
            : undefined,
        phoneNumberId,
        customerPhone,
        idempotencyKey,
        text,
        sourceInboundMessageId,
        blocks: Array.isArray(req.body?.blocks) ? req.body.blocks : undefined,
        evidence:
          req.body?.evidence && typeof req.body.evidence === 'object'
            ? req.body.evidence
            : undefined,
        authoritativeCatalog:
          req.body?.authoritativeCatalog &&
          typeof req.body.authoritativeCatalog === 'object'
            ? req.body.authoritativeCatalog
            : undefined,
        clinicalAuthorization:
          req.body?.clinicalAuthorization &&
          typeof req.body.clinicalAuthorization === 'object'
            ? req.body.clinicalAuthorization
            : undefined,
      },
      config
    );
    const response = questionReplyResultToHttp(result);
    res.status(response.statusCode).json(response.body);
  } catch (error) {
    Sentry.captureException(new Error('internal question reply send failed'), {
      tags: {
        service: 'webhook_server',
        operation: 'question_reply_send',
        phoneNumberHash: technicalHash(phoneNumberId),
        error_kind: error instanceof Error ? error.name : typeof error,
      },
    });
    res.status(500).json({ error: 'internal error' });
  }
});

/** GET /internal/question-replies/status?key= — nunca devolve texto/telefone. */
app.get('/internal/question-replies/status', async (req: Request, res: Response) => {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (!key) {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  try {
    const status = await getQuestionReplyStatus(key);
    if (!status) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(200).json(status);
  } catch (error) {
    Sentry.captureException(new Error('internal question reply status failed'), {
      tags: {
        service: 'webhook_server',
        operation: 'question_reply_status',
        error_kind: error instanceof Error ? error.name : typeof error,
      },
    });
    res.status(500).json({ error: 'internal error' });
  }
});

/** Reprocessamento explícito: somente quarentena, nunca item entregue/pendente. */
app.post(
  '/internal/inbound-outbox/reprocess',
  async (req: Request, res: Response) => {
    if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
      res.sendStatus(401);
      return;
    }
    const messageId =
      typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
    if (!messageId) {
      res.status(400).json({ error: 'messageId is required' });
      return;
    }
    try {
      const rearmed = await reprocessQuarantinedInbound(messageId);
      res.status(rearmed ? 200 : 409).json({ rearmed });
    } catch (error) {
      Sentry.captureException(new Error('inbound outbox reprocess failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'inbound_outbox_reprocess',
          error_kind: runtimeErrorKind(error),
        },
      });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

/** Estado estritamente técnico da retenção, sem ids ou dados de conversa. */
function retentionStatusHandler(req: Request, res: Response): void {
  if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
    res.sendStatus(401);
    return;
  }
  res.status(200).json(getAnaRetentionState());
}

app.get('/internal/receps-ia/retention/status', retentionStatusHandler);
// Alias legado durante a janela de compatibilidade do rebrand.
app.get('/internal/ana-retention/status', retentionStatusHandler);

/** Purge imediato acionado pelo Receps; retorno contém apenas contagens. */
app.post(
  '/internal/privacy/purge-conversation',
  async (req: Request, res: Response) => {
    if (!isValidBearerToken(req.get('authorization'), ERP_API_TOKEN)) {
      res.sendStatus(401);
      return;
    }
    const phoneNumberId =
      typeof req.body?.phoneNumberId === 'string'
        ? req.body.phoneNumberId.trim()
        : '';
    const customerPhone =
      typeof req.body?.customerPhone === 'string'
        ? req.body.customerPhone.trim()
        : '';
    if (!phoneNumberId || !customerPhone) {
      res.status(400).json({ error: 'invalid payload' });
      return;
    }
    try {
      const counts = await purgeConversationData(phoneNumberId, customerPhone);
      console.info(
        `[privacy-purge] concluído | phoneNumberId=${phoneNumberId} | rows=${Object.values(counts).reduce((sum, value) => sum + value, 0)}`
      );
      res.status(200).json({ purged: true, counts });
    } catch (error) {
      Sentry.captureException(new Error('privacy conversation purge failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'privacy_purge_conversation',
          phoneNumberId,
          error_kind: error instanceof Error ? error.name : typeof error,
        },
      });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

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
      Sentry.captureException(new Error('conversation activity lookup failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'conversation_activity',
          phoneNumberId,
          error_kind: runtimeErrorKind(err),
        },
      });
      console.error(
        `❌ Erro ao consultar conversation-activity | phoneNumberId=${phoneNumberId} | error=${runtimeErrorKind(err)}`
      );
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
      Sentry.captureException(new Error('conversation list lookup failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'list_conversations',
          phoneNumberId,
          error_kind: runtimeErrorKind(err),
        },
      });
      console.error(
        `❌ Erro ao listar conversas | phoneNumberId=${phoneNumberId} | error=${runtimeErrorKind(err)}`
      );
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
      res.json({
        messages: messages.map((message) => ({
          ...message,
          content: panelVisibleConversationContent(message.role, message.content),
        })),
      });
    })
    .catch((err) => {
      Sentry.captureException(new Error('conversation messages lookup failed'), {
        tags: {
          service: 'webhook_server',
          operation: 'conversation_messages',
          phoneNumberId,
          error_kind: runtimeErrorKind(err),
        },
      });
      console.error(
        `❌ Erro ao consultar conversation-messages | phoneNumberId=${phoneNumberId} | error=${runtimeErrorKind(err)}`
      );
      res.status(500).json({ error: 'internal error' });
    });
});

async function boot(): Promise<void> {
  if (shuttingDown) return;
  // Garante a tabela de idempotência e o schema da Onda 2 antes do tráfego.
  await ensureProcessedMessagesTable();
  await ensureAnaWave2Tables();
  await ensureSilentEscalationHoldTable();
  if (shuttingDown) return;
  startSilentEscalationHoldSweep(async () => {
    const { sweepSilentEscalationHolds } = await import(
      './services/questionEscalation'
    );
    return sweepSilentEscalationHolds();
  });
  // O schema/worker v2 só é carregado quando existe allowlist configurada.
  // Flag vazia mantém o boot e a rota v1 sem importar o runtime v2 pesado.
  const v2Allowlist = process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '*') ?? [];
  if (v2Allowlist.length > 0) {
    const {
      ensureConversationalV2Tables,
      startConversationalV2Sweep,
    } = await import('./services/conversationalV2/stateStore');
    await ensureConversationalV2Tables();
    if (shuttingDown) return;
    startConversationalV2Sweep();
    const { startConversationalV2SuccessorSweep } = await import(
      './services/conversationalV2/successorProcessor'
    );
    if (shuttingDown) return;
    startConversationalV2SuccessorSweep({
      process: reprocessDurableSuccessorBatchV2,
      fallback: deliverDurableSuccessorFallbackV2,
    });
  }
  // Falha de retenção é observada/sanitizada no serviço e nunca impede o boot.
  // O kill switch também cobre a execução inicial, não apenas o timer.
  if (
    isMaintenanceWorkerEligible() &&
    readMaintenanceBoolean('ANA_RETENTION_SCHEDULER_ENABLED', true)
  ) {
    await runAnaRetention().catch(() => undefined);
  }
  if (shuttingDown) return;
  startAnaRetentionScheduler();
  startInboundOutboxSweep();
  startWhatsAppStatusCallbackSweep();

  // Workstream B (Renata): régua de follow-up. Garante a tabela e liga o poller
  // de 30min por default (só VENDA — o receptionist não escreve na tabela).
  await ensureSalesFollowupsTable();
  if (shuttingDown) return;
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

  httpServer = app.listen(PORT, () => {
    runtimeReady = true;
    console.log(`🚀 Receps-IA runtime rodando na porta ${PORT} | personas=Ana,Renata`);
  });
}

type ShutdownServer = {
  close: (callback?: (error?: Error) => void) => void;
  closeAllConnections?: () => void;
};

async function closeHttpServerForShutdown(
  server: ShutdownServer | null
): Promise<void> {
  if (!server) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      console.warn(
        `[runtime] HTTP graceful shutdown deadline reached | graceMs=${HTTP_SHUTDOWN_GRACE_MS}`
      );
      try {
        // Do not cut active requests at signal time. This is only the bounded
        // last resort before PM2's kill_timeout is allowed to terminate us.
        server.closeAllConnections?.();
      } catch {
        // The process is already on the termination path; keep pool cleanup moving.
      }
      finish();
    }, HTTP_SHUTDOWN_GRACE_MS);
    timeout.unref?.();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    try {
      server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          console.warn(
            `[runtime] HTTP close reported ${runtimeErrorKind(error)}`
          );
        }
        finish();
      });
    } catch (error) {
      console.warn(`[runtime] HTTP close threw ${runtimeErrorKind(error)}`);
      finish();
    }
  });
}

function stopMaintenanceSchedulersImmediately(): void {
  // The registry is the first and broadest boundary: it also covers optional
  // V2 workers and future workers that use the common scheduler.
  stopAllMaintenanceSchedulers();
  stopSilentEscalationHoldSweep();
  stopInboundOutboxSweep();
  stopWhatsAppStatusCallbackSweep();
  stopAnaRetentionScheduler();
  stopFollowupPoller();
}

async function clearLoadedV2SchedulerReferences(): Promise<void> {
  const v2Allowlist =
    process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== '*') ?? [];
  if (v2Allowlist.length > 0) {
    const [{ stopConversationalV2Sweep }, { stopConversationalV2SuccessorSweep }] =
      await Promise.all([
        import('./services/conversationalV2/stateStore'),
        import('./services/conversationalV2/successorProcessor'),
      ]);
    stopConversationalV2Sweep();
    stopConversationalV2SuccessorSweep();
  }
}

async function cancelMaintenanceSchedulersForShutdown(): Promise<void> {
  // This call is synchronous and happens before the first await that closes
  // HTTP. In-flight cycles are allowed to finish, but cannot schedule again.
  stopMaintenanceSchedulersImmediately();
  try {
    // Clear module-local handles after the registry has already cancelled them.
    await clearLoadedV2SchedulerReferences();
  } catch (error) {
    console.warn(
      `[runtime] V2 scheduler reference cleanup failed | error=${runtimeErrorKind(error)}`
    );
  }
}

export interface ShutdownSequenceDeps {
  cancelSchedulers: () => void | Promise<void>;
  closeHttp: () => Promise<void>;
  closePools: () => Promise<void>;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

/** Pure phase seam used by the deterministic shutdown-order smoke. */
export async function __runShutdownSequenceForTest(
  deps: ShutdownSequenceDeps
): Promise<void> {
  await runShutdownSequence('SMOKE', deps);
}

async function runShutdownSequence(
  signal: string,
  deps: ShutdownSequenceDeps
): Promise<void> {
  runtimeReady = false;
  const log = deps.log ?? ((message: string) => console.info(message));
  log(`[runtime] encerramento iniciado | signal=${signal}`);

  await deps.cancelSchedulers();
  await deps.closeHttp();
  await deps.closePools();
  log('[runtime] encerramento concluído');
  deps.exit?.(0);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await runShutdownSequence(signal, {
    cancelSchedulers: cancelMaintenanceSchedulersForShutdown,
    closeHttp: () => closeHttpServerForShutdown(httpServer),
    closePools: async () => {
      await Promise.allSettled([
        pool.end(),
        closeConversationOrderPoolForShutdown(),
      ]);
    },
    exit: (code) => process.exit(code),
  });
}

if (process.env.RECEPS_IA_SKIP_BOOT !== '1') {
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  void boot().catch((err) => {
    Sentry.captureException(new Error('receps-ia boot failed'), {
      tags: {
        service: 'webhook_server',
        operation: 'boot',
        error_kind: runtimeErrorKind(err),
      },
    });
    console.error(`❌ Falha no boot do Receps-IA | error=${runtimeErrorKind(err)}`);
    process.exit(1);
  });
}
