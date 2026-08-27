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
} from './services/contextManager';
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
} from './services/inboundOutbox';
import {
  ensureSilentEscalationHoldTable,
  startSilentEscalationHoldSweep,
} from './services/silentEscalationHold';
import {
  getQuestionReplyStatus,
  sendQuestionReply,
} from './services/questionReplyService';
import { purgeConversationData } from './services/privacyPurge';
import {
  handleWhatsAppStatuses,
  startWhatsAppStatusCallbackSweep,
} from './services/whatsappStatusHandler';
import {
  startProviderStatusRecoverySweepV2,
} from './services/conversationalV2/providerStatus';
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
} from './services/anaRetention';
import {
  canonicalLabCustomerPhone,
  labV2RecoveryJobsEnabled,
  labBlockedWriteEffect,
  resolveAnaRuntimeConfig,
  type AnaLabRuntimeConfig,
  type AnaRuntimeConfig,
} from './runtimePolicy';
import {
  assertProductionStorageIsNotLab,
  validateLabSchema,
} from './services/labSchema';

interface CloudWebhookMetadata {
  phone_number_id?: string;
}

export interface CloudWebhookValue {
  metadata?: CloudWebhookMetadata;
  contacts?: CloudContact[];
  messages?: CloudMessage[];
  message_echoes?: unknown[];
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
let activeRuntimeConfig: AnaRuntimeConfig | null = null;

function currentRuntimeConfig(): AnaRuntimeConfig {
  return activeRuntimeConfig ?? resolveAnaRuntimeConfig(process.env);
}

function rejectLabAdministrativeWrite(
  res: Response,
  operation: string
): boolean {
  const blocked = labBlockedWriteEffect(operation);
  if (!blocked) return false;
  res.status(423).json({
    success: blocked.success,
    class: blocked.class,
    outcome: blocked.outcome,
    writeCommitted: blocked.writeCommitted,
    reason: blocked.reason,
  });
  return true;
}

type WebhookEchoHandler = typeof handleSmbMessageEchoes;
let webhookEchoHandler: WebhookEchoHandler = handleSmbMessageEchoes;
type WebhookStatusHandler = typeof handleWhatsAppStatuses;
let webhookStatusHandler: WebhookStatusHandler = handleWhatsAppStatuses;
type WebhookStatusConfigLoader = (
  phoneNumberId: string
) => Promise<TenantBotConfig | null>;
let webhookStatusConfigLoader: WebhookStatusConfigLoader = getTenantConfig;
type WebhookMessageHandler = typeof handleIncomingMessage;
let webhookMessageHandler: WebhookMessageHandler = handleIncomingMessage;

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

/** Seam exclusivo de smoke HTTP; `undefined` restaura o handler produtivo. */
export function __setWebhookMessageHandlerForTest(
  handler?: WebhookMessageHandler
): void {
  webhookMessageHandler = handler ?? handleIncomingMessage;
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

export type LabWebhookFenceReason =
  | 'missing_phone_number_id'
  | 'phone_number_not_allowed'
  | 'tenant_config_unavailable'
  | 'tenant_inactive'
  | 'tenant_role_not_allowed'
  | 'tenant_slug_not_allowed'
  | 'tenant_phone_mismatch'
  | 'missing_customer_phone'
  | 'customer_phone_not_allowed';

export class LabWebhookRejectedError extends Error {
  constructor(readonly reason: LabWebhookFenceReason) {
    super('LAB webhook callback rejected');
    this.name = 'LabWebhookRejectedError';
  }
}

export function authorizeLabWebhookValue(
  value: CloudWebhookValue,
  config: TenantBotConfig | null,
  runtime: AnaLabRuntimeConfig
): TenantBotConfig {
  const phoneNumberId = value.metadata?.phone_number_id?.trim();
  if (!phoneNumberId) {
    throw new LabWebhookRejectedError('missing_phone_number_id');
  }
  if (!runtime.allowedPhoneNumberIds.has(phoneNumberId)) {
    throw new LabWebhookRejectedError('phone_number_not_allowed');
  }
  if (!config) {
    throw new LabWebhookRejectedError('tenant_config_unavailable');
  }
  if (!config.isActive) {
    throw new LabWebhookRejectedError('tenant_inactive');
  }
  if (config.botRole !== 'receptionist') {
    throw new LabWebhookRejectedError('tenant_role_not_allowed');
  }
  if (!runtime.allowedTenantSlugs.has(config.tenantSlug)) {
    throw new LabWebhookRejectedError('tenant_slug_not_allowed');
  }
  if (config.phoneNumberId !== phoneNumberId) {
    throw new LabWebhookRejectedError('tenant_phone_mismatch');
  }
  return config;
}

function authorizeLabWebhookCustomers(
  change: WebhookChange,
  runtime: AnaLabRuntimeConfig
): void {
  const value = change.value;
  if (!value) return;
  const candidates: unknown[] = isEchoChange(change.field)
    ? (value.message_echoes ?? []).map((echo) =>
        echo && typeof echo === 'object'
          ? (echo as { to?: unknown }).to
          : undefined
      )
    : (value.messages ?? []).map((message) => message.from);

  if (
    (isEchoChange(change.field) || Boolean(value.messages?.length)) &&
    candidates.length === 0
  ) {
    throw new LabWebhookRejectedError('missing_customer_phone');
  }
  for (const candidate of candidates) {
    const customerPhone =
      typeof candidate === 'string'
        ? canonicalLabCustomerPhone(candidate)
        : '';
    if (!customerPhone) {
      throw new LabWebhookRejectedError('missing_customer_phone');
    }
    if (!runtime.allowedCustomerPhones.has(customerPhone)) {
      throw new LabWebhookRejectedError('customer_phone_not_allowed');
    }
  }
}

interface WebhookChange {
  field?: unknown;
  value?: CloudWebhookValue;
}

function webhookChanges(body: unknown): WebhookChange[] {
  const source = body as { entry?: unknown } | null | undefined;
  const entries = Array.isArray(source?.entry) ? source.entry : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const changes = (entry as { changes?: unknown }).changes;
    return Array.isArray(changes) ? (changes as WebhookChange[]) : [];
  });
}

function actionableWebhookValue(change: WebhookChange): boolean {
  const value = change.value;
  return Boolean(
    value &&
      (isEchoChange(change.field) ||
        value.statuses?.length ||
        value.messages?.length)
  );
}

async function preflightLabWebhook(
  changes: readonly WebhookChange[],
  runtime: AnaLabRuntimeConfig
): Promise<Map<CloudWebhookValue, TenantBotConfig>> {
  const configByPhone = new Map<string, Promise<TenantBotConfig | null>>();
  const authorized = new Map<CloudWebhookValue, TenantBotConfig>();
  for (const change of changes) {
    if (!actionableWebhookValue(change) || !change.value) continue;
    const phoneNumberId = change.value.metadata?.phone_number_id?.trim();
    if (!phoneNumberId) {
      throw new LabWebhookRejectedError('missing_phone_number_id');
    }
    if (!runtime.allowedPhoneNumberIds.has(phoneNumberId)) {
      throw new LabWebhookRejectedError('phone_number_not_allowed');
    }
    // A cerca do cliente precede config/state/model/tool/handler. Em especial,
    // um remetente estranho não provoca nem a leitura de configuração do tenant.
    authorizeLabWebhookCustomers(change, runtime);
    let pending = configByPhone.get(phoneNumberId);
    if (!pending) {
      pending = webhookStatusConfigLoader(phoneNumberId);
      configByPhone.set(phoneNumberId, pending);
    }
    const config = authorizeLabWebhookValue(
      change.value,
      await pending,
      runtime
    );
    authorized.set(change.value, config);
  }
  return authorized;
}

async function processWebhookValue(
  value: CloudWebhookValue,
  prevalidatedConfig?: TenantBotConfig,
  runtime: AnaRuntimeConfig = currentRuntimeConfig()
): Promise<void> {
  const phoneNumberId =
    value.metadata?.phone_number_id?.trim() ||
    (runtime.mode === 'production' ? LEGACY_PHONE_NUMBER_ID : '');

  if (!phoneNumberId) {
    console.warn('⚠️ Webhook recebido sem phone_number_id.');
    return;
  }

  const config =
    prevalidatedConfig ?? (await webhookStatusConfigLoader(phoneNumberId));

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

      return webhookMessageHandler(message, contact, config).catch((err) => {
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
    const runtime = currentRuntimeConfig();
    const changes = webhookChanges(req.body);
    // LAB valida o payload INTEIRO antes do primeiro handler. Assim, uma change
    // inesperada posterior não pode chegar depois que uma anterior já gravou
    // state e também não pode ser escondida por um 200 antecipado.
    const labAuthorized =
      runtime.mode === 'lab'
        ? await preflightLabWebhook(changes, runtime)
        : new Map<CloudWebhookValue, TenantBotConfig>();
    const allowV2ByPhoneNumberId = new Map<string, Promise<boolean>>();

    for (const change of changes) {
      const value = change.value;
      if (!value) {
        continue;
      }

      // Coexistence: o dono respondeu PELO app do WhatsApp (echo) → pausa a
      // conversa pra Ana não falar por cima do humano. O 200 só sai DEPOIS
      // da persistência durável; falha retorna 500 para a Meta retransmitir.
      if (isEchoChange(change.field)) {
        await webhookEchoHandler(
          value,
          runtime.mode === 'production' ? LEGACY_PHONE_NUMBER_ID : undefined
        );
        continue;
      }

      // Status Meta (sent/delivered/read/failed) é um fato separado de inbound:
      // não passa pelo dedup por message.id e não é mais descartado. O
      // durable ingest termina antes do 200; callbacks ERP continuam fora
      // da resposta HTTP como obrigações retomáveis.
      if (value.statuses?.length) {
        const statusPhoneNumberId =
          value.metadata?.phone_number_id?.trim() ||
          (runtime.mode === 'production' ? LEGACY_PHONE_NUMBER_ID : '');
        await webhookStatusHandler(value, undefined, {
          awaitCallbacks: false,
          throwOnPersistenceFailure: true,
          resolveAllowV2Fallback: async () => {
            if (!statusPhoneNumberId) return false;
            const prevalidated = labAuthorized.get(value);
            if (prevalidated) {
              return isAnaV2ProviderStatusEligible(prevalidated);
            }
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

      processWebhookValue(value, labAuthorized.get(value), runtime).catch((err) => {
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

    res.sendStatus(200);
  } catch (err) {
    if (err instanceof LabWebhookRejectedError) {
      Sentry.captureMessage('lab webhook callback rejected', {
        level: 'warning',
        tags: {
          service: 'webhook_server',
          operation: 'lab_preflight',
          runtime_mode: 'lab',
          reason: err.reason,
        },
      });
      // A Meta recebe non-2xx e mantém a entrega elegível para retry. O corpo não
      // revela phoneNumberId, tenant ou configuração.
      res.status(503).json({ error: 'lab_callback_rejected' });
      return;
    }
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
  if (rejectLabAdministrativeWrite(res, 'salesNotify')) return;
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
    if (rejectLabAdministrativeWrite(res, 'adminResetConversation')) return;
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
    if (rejectLabAdministrativeWrite(res, 'adminReprocessResponse')) return;
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
  const runtime = currentRuntimeConfig();
  if (runtime.mode === 'lab') {
    res.json({
      status: 'ok',
      runtimeMode: 'lab',
      writePolicy: runtime.writePolicy,
      globalBackgroundJobs: runtime.globalBackgroundJobs,
      v2RecoveryJobs: runtime.v2RecoveryJobs,
      localRecoveryJobs: {
        conversationalV2State: runtime.v2RecoveryJobs,
        conversationalV2Successor: runtime.v2RecoveryJobs,
        providerStatusV2: runtime.v2RecoveryJobs,
      },
      ts: new Date().toISOString(),
    });
    return;
  }
  res.json({ status: 'ok', ts: new Date().toISOString() });
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
  if (rejectLabAdministrativeWrite(res, 'sendQuestionReply')) return;

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
    if (rejectLabAdministrativeWrite(res, 'reprocessInboundOutbox')) return;
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
    if (rejectLabAdministrativeWrite(res, 'privacyPurgeConversation')) return;
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

export interface RuntimeBootOperations {
  assertProductionStorageIsNotLab: () => Promise<void>;
  validateLabSchema: (databaseFingerprint: string) => Promise<void>;
  ensureProcessedMessages: () => Promise<void>;
  ensureAnaWave2: () => Promise<void>;
  ensureSilentEscalationHold: () => Promise<void>;
  startSilentEscalationHold: () => Promise<void>;
  ensureConversationalV2: () => Promise<void>;
  startConversationalV2: () => Promise<void>;
  startConversationalV2Successor: () => Promise<void>;
  startProviderStatusV2Recovery: () => Promise<void>;
  runRetentionOnce: () => Promise<void>;
  startRetentionScheduler: () => Promise<void>;
  startInboundOutbox: () => Promise<void>;
  startWhatsAppStatusCallback: () => Promise<void>;
  ensureSalesFollowups: () => Promise<void>;
  startSalesFollowup: () => Promise<void>;
  initializeVoiceStorageAndProbe: () => Promise<void>;
}

const defaultRuntimeBootOperations: RuntimeBootOperations = {
  assertProductionStorageIsNotLab,
  validateLabSchema,
  ensureProcessedMessages: ensureProcessedMessagesTable,
  ensureAnaWave2: ensureAnaWave2Tables,
  ensureSilentEscalationHold: ensureSilentEscalationHoldTable,
  startSilentEscalationHold: async () => {
    startSilentEscalationHoldSweep(async () => {
      const { sweepSilentEscalationHolds } = await import(
        './services/questionEscalation'
      );
      return sweepSilentEscalationHolds();
    });
  },
  ensureConversationalV2: async () => {
    const { ensureConversationalV2Tables } = await import(
      './services/conversationalV2/stateStore'
    );
    await ensureConversationalV2Tables();
  },
  startConversationalV2: async () => {
    const { startConversationalV2Sweep } = await import(
      './services/conversationalV2/stateStore'
    );
    startConversationalV2Sweep();
  },
  startConversationalV2Successor: async () => {
    const { startConversationalV2SuccessorSweep } = await import(
      './services/conversationalV2/successorProcessor'
    );
    startConversationalV2SuccessorSweep({
      process: reprocessDurableSuccessorBatchV2,
      fallback: deliverDurableSuccessorFallbackV2,
    });
  },
  startProviderStatusV2Recovery: async () => {
    startProviderStatusRecoverySweepV2();
  },
  runRetentionOnce: async () => {
    // Falha de retenção é observada/sanitizada no serviço e nunca impede o boot.
    await runAnaRetention().catch(() => undefined);
  },
  startRetentionScheduler: async () => {
    startAnaRetentionScheduler();
  },
  startInboundOutbox: async () => {
    startInboundOutboxSweep();
  },
  startWhatsAppStatusCallback: async () => {
    startWhatsAppStatusCallbackSweep();
  },
  ensureSalesFollowups: ensureSalesFollowupsTable,
  startSalesFollowup: async () => {
    startFollowupPoller();
  },
  initializeVoiceStorageAndProbe: async () => {
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
  },
};

export async function initializeRuntimeServices(
  runtime: AnaRuntimeConfig,
  operations: RuntimeBootOperations = defaultRuntimeBootOperations,
  rawV2Allowlist = process.env.ANA_CONVERSATIONAL_V2_TENANT_SLUGS
): Promise<void> {
  if (runtime.mode === 'lab') {
    // Boot normal LAB nunca faz DDL. Só os três recoveries locais da V2 operam
    // sobre o storage dedicado; workers externos permanecem desligados.
    await operations.validateLabSchema(runtime.databaseFingerprint);
    if (
      labV2RecoveryJobsEnabled(runtime.allowedTenantSlugs, rawV2Allowlist)
    ) {
      await operations.startConversationalV2();
      await operations.startConversationalV2Successor();
      await operations.startProviderStatusV2Recovery();
    }
    return;
  }

  // A leitura de catálogo é a única preflight nova. Se passar, a sequência
  // histórica de produção permanece íntegra e só então pode executar DDL/jobs.
  await operations.assertProductionStorageIsNotLab();
  await operations.ensureProcessedMessages();
  await operations.ensureAnaWave2();
  await operations.ensureSilentEscalationHold();
  await operations.startSilentEscalationHold();

  const v2Allowlist =
    rawV2Allowlist
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== '*') ?? [];
  if (v2Allowlist.length > 0) {
    await operations.ensureConversationalV2();
    await operations.startConversationalV2();
    await operations.startConversationalV2Successor();
  }

  await operations.runRetentionOnce();
  await operations.startRetentionScheduler();
  await operations.startInboundOutbox();
  await operations.startWhatsAppStatusCallback();
  await operations.ensureSalesFollowups();
  await operations.startSalesFollowup();
  await operations.initializeVoiceStorageAndProbe();
}

export async function boot(): Promise<void> {
  const runtime = resolveAnaRuntimeConfig(process.env);
  activeRuntimeConfig = runtime;
  await initializeRuntimeServices(runtime);

  const onListening = () => {
    console.log(
      runtime.mode === 'lab'
        ? `🚀 Receps-IA runtime rodando na porta ${PORT} | personas=Ana,Renata | runtimeMode=lab`
        : `🚀 Receps-IA runtime rodando na porta ${PORT} | personas=Ana,Renata`
    );
  };
  if (runtime.bindHost) {
    app.listen(PORT, runtime.bindHost, onListening);
    return;
  }
  app.listen(PORT, onListening);
}

if (process.env.RECEPS_IA_SKIP_BOOT !== '1') {
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
