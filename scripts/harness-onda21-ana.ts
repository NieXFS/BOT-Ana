import 'dotenv/config';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { TenantBotConfig } from '../src/configProvider';
import type { CloudMessage, IncomingMessageDeps } from '../src/messageHandler';
import type { InboundDeliveryPayload } from '../src/services/inboundOutbox';
import type { QuestionReplyInput } from '../src/services/questionReplyService';
import type { QuestionReplyStatusCallbackPayload } from '../src/services/whatsappStatusHandler';

export {};

const TEXT_FIXTURE = 'Minha unha está doendo muito, o que pode ser?';
const AUDIO_TRANSCRIPTION_FIXTURE =
  'Quero saber se vocês tratam micose de unha';
const FIRST_SUPERSEDE_FIXTURE = 'Tenho uma dúvida sobre os serviços disponíveis';
const SUPERSEDE_FIXTURE = 'Tenho outra pergunta sobre os horários disponíveis';
const LONG_TEXT_FIXTURE = `${'L'.repeat(3_999)}😀${'cauda'.repeat(32)}`;
const LONG_TEXT_TRUNCATED = 'L'.repeat(3_999);
const RETENTION_OLD_FIXTURE = 'Histórico antigo para retenção Onda 2.2';

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requireHarnessDir(): string {
  const raw = process.env.HARNESS_DIR?.trim();
  if (!raw) throw new Error('HarnessDirectoryMissing');
  const resolved = path.resolve(raw);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function writeJson(directory: string, filename: string, value: unknown): void {
  fs.writeFileSync(
    path.join(directory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
  );
}

function readJson(directory: string, filename: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeConfig(phoneNumberId: string): TenantBotConfig {
  return {
    tenantSlug: 'harness-onda21',
    botName: 'Ana',
    botRole: 'receptionist',
    systemPrompt: '',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'harness-never-used',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  };
}

async function ensureSchema(): Promise<void> {
  const processed = await import('../src/services/processedMessages');
  const wave2 = await import('../src/services/anaWave2Store');
  await processed.ensureProcessedMessagesTable();
  await wave2.ensureAnaWave2Tables();
}

async function emitPhase(harnessDir: string): Promise<void> {
  const handler = await import('../src/messageHandler');
  const wave2 = await import('../src/services/anaWave2Store');
  const outbox = await import('../src/services/inboundOutbox');

  const runKey = createHash('sha256')
    .update(`${harnessDir}:${Date.now()}:${process.pid}`)
    .digest('hex')
    .slice(0, 16);
  const phoneNumberIdPrefix = 'harness-onda21-';
  const primaryPhoneNumberId = `${phoneNumberIdPrefix}${runKey}`;
  const oldPhoneNumberId = `${phoneNumberIdPrefix}${runKey}-old`;
  const customerPhones = {
    text: '+5511999990001',
    audio: '+5511999990002',
    supersede: '+5511999990003',
    truncated: '+5511999990004',
    retention: '+5511999990005',
  } as const;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const captured = new Map<string, InboundDeliveryPayload>();

  const deliverInbound: IncomingMessageDeps['deliverInbound'] = (messageId) =>
    outbox.deliverInboundWithFastRetries(messageId, {
      store: outbox.pgInboundOutboxStore,
      postInbound: async (payload) => {
        captured.set(payload.messageId, payload);
        return {
          escalation: { active: false, questionId: null, version: 1 },
        };
      },
      wait: async () => undefined,
      now: Date.now,
    });

  const deps: IncomingMessageDeps = {
    persistInbound: wave2.persistInboundAtomically,
    deliverInbound,
    updateInboundContent: wave2.updateInboundHistoryContent,
    markTranscriptionFailed: wave2.markInboundTranscriptionFailed,
    downloadAudio: async () => Buffer.from('injected-audio-fixture'),
    transcribeAudio: async () => AUDIO_TRANSCRIPTION_FIXTURE,
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    // Evita brain/WhatsApp depois de provar o intake e o POST W1.
    isPaused: async () => true,
  };
  const primaryConfig = makeConfig(primaryPhoneNumberId);
  const oldConfig = makeConfig(oldPhoneNumberId);
  const messageIds = {
    text: `wamid-harness-${runKey}-text`,
    audio: `wamid-harness-${runKey}-audio`,
    first: `wamid-harness-${runKey}-first`,
    supersede: `wamid-harness-${runKey}-supersede`,
    truncated: `wamid-harness-${runKey}-truncated`,
    retention: `wamid-harness-${runKey}-retention-old`,
  };

  const messages: CloudMessage[] = [
    {
      from: customerPhones.text,
      id: messageIds.text,
      timestamp: String(nowSeconds),
      type: 'text',
      text: { body: TEXT_FIXTURE },
    },
    {
      from: customerPhones.audio,
      id: messageIds.audio,
      timestamp: String(nowSeconds + 1),
      type: 'audio',
      audio: { id: 'media-injected', mime_type: 'audio/ogg' },
    },
    {
      from: customerPhones.supersede,
      id: messageIds.first,
      timestamp: String(nowSeconds + 2),
      type: 'text',
      text: { body: FIRST_SUPERSEDE_FIXTURE },
    },
    {
      from: customerPhones.supersede,
      id: messageIds.supersede,
      timestamp: String(nowSeconds + 3),
      type: 'text',
      text: { body: SUPERSEDE_FIXTURE },
    },
    {
      from: customerPhones.truncated,
      id: messageIds.truncated,
      timestamp: String(nowSeconds + 4),
      type: 'text',
      text: { body: LONG_TEXT_FIXTURE },
    },
    {
      from: customerPhones.retention,
      id: messageIds.retention,
      timestamp: String(nowSeconds - 91 * 24 * 60 * 60),
      type: 'text',
      text: { body: RETENTION_OLD_FIXTURE },
    },
  ];

  for (const message of messages) {
    const contact = {
      profile: { name: 'Cliente Harness' },
      wa_id: message.from,
    };
    const config =
      message.id === messageIds.truncated ? oldConfig : primaryConfig;
    await handler.handleIncomingMessage(message, contact, config, deps);
  }

  const textPayload = captured.get(messageIds.text);
  const audioPayload = captured.get(messageIds.audio);
  const firstPayload = captured.get(messageIds.first);
  const supersedePayload = captured.get(messageIds.supersede);
  const truncatedPayload = captured.get(messageIds.truncated);
  const retentionPayload = captured.get(messageIds.retention);
  assert(
    textPayload &&
      audioPayload &&
      firstPayload &&
      supersedePayload &&
      truncatedPayload &&
      retentionPayload,
    'HarnessInboundPayloadMissing'
  );
  assert(
    textPayload.phoneNumberId === primaryPhoneNumberId &&
      audioPayload.phoneNumberId === primaryPhoneNumberId &&
      firstPayload.phoneNumberId === primaryPhoneNumberId &&
      supersedePayload.phoneNumberId === primaryPhoneNumberId &&
      retentionPayload.phoneNumberId === primaryPhoneNumberId,
    'HarnessPrimaryPhoneNumberIdMismatch'
  );
  assert(
    truncatedPayload.phoneNumberId === oldPhoneNumberId &&
      oldPhoneNumberId !== primaryPhoneNumberId &&
      oldPhoneNumberId.startsWith(phoneNumberIdPrefix) &&
      primaryPhoneNumberId.startsWith(phoneNumberIdPrefix),
    'HarnessOldPhoneNumberIdMismatch'
  );
  assert(
    textPayload.customerPhone === customerPhones.text &&
      audioPayload.customerPhone === customerPhones.audio &&
      firstPayload.customerPhone === customerPhones.supersede &&
      supersedePayload.customerPhone === customerPhones.supersede &&
      truncatedPayload.customerPhone === customerPhones.truncated &&
      retentionPayload.customerPhone === customerPhones.retention,
    'HarnessConversationLayoutMismatch'
  );
  assert(textPayload.contentText === TEXT_FIXTURE, 'HarnessTextMismatch');
  assert(textPayload.contentHash === sha256(TEXT_FIXTURE), 'HarnessTextHashMismatch');
  assert(textPayload.contentLength === TEXT_FIXTURE.length, 'HarnessTextLengthMismatch');
  assert(
    textPayload.contentOriginalLength === TEXT_FIXTURE.length,
    'HarnessTextOriginalLengthMismatch'
  );
  assert(audioPayload.messageType === 'audio', 'HarnessAudioTypeMismatch');
  assert(audioPayload.contentStatus === 'final', 'HarnessAudioStatusMismatch');
  assert(
    audioPayload.contentOriginalLength === AUDIO_TRANSCRIPTION_FIXTURE.length,
    'HarnessAudioOriginalLengthMismatch'
  );
  assert(
    audioPayload.contentText === AUDIO_TRANSCRIPTION_FIXTURE,
    'HarnessAudioTranscriptionMismatch'
  );
  assert(
    audioPayload.contentHash === sha256(AUDIO_TRANSCRIPTION_FIXTURE),
    'HarnessAudioHashMismatch'
  );
  assert(!JSON.stringify(audioPayload).includes('áudio recebido'), 'HarnessAudioPlaceholderLeak');
  assert(firstPayload.contentText === FIRST_SUPERSEDE_FIXTURE, 'HarnessFirstMismatch');
  assert(
    firstPayload.contentHash === sha256(FIRST_SUPERSEDE_FIXTURE),
    'HarnessFirstHashMismatch'
  );
  assert(
    firstPayload.contentLength === FIRST_SUPERSEDE_FIXTURE.length,
    'HarnessFirstLengthMismatch'
  );
  assert(supersedePayload.contentText === SUPERSEDE_FIXTURE, 'HarnessSupersedeMismatch');
  assert(
    supersedePayload.contentHash === sha256(SUPERSEDE_FIXTURE),
    'HarnessSupersedeHashMismatch'
  );
  assert(
    supersedePayload.contentLength === SUPERSEDE_FIXTURE.length,
    'HarnessSupersedeLengthMismatch'
  );
  assert(truncatedPayload.contentStatus === 'truncated', 'HarnessTruncatedStatusMismatch');
  assert(truncatedPayload.contentText === LONG_TEXT_TRUNCATED, 'HarnessTruncatedTextMismatch');
  assert(truncatedPayload.contentLength === LONG_TEXT_TRUNCATED.length, 'HarnessTruncatedLengthMismatch');
  assert(
    truncatedPayload.contentOriginalLength === LONG_TEXT_FIXTURE.length,
    'HarnessTruncatedOriginalLengthMismatch'
  );
  assert(
    truncatedPayload.contentHash === sha256(LONG_TEXT_TRUNCATED),
    'HarnessTruncatedHashMismatch'
  );
  assert(
    retentionPayload.receivedAt ===
      new Date((nowSeconds - 91 * 24 * 60 * 60) * 1000).toISOString(),
    'HarnessRetentionTimestampMismatch'
  );

  writeJson(harnessDir, '01-inbound-text.json', textPayload);
  writeJson(harnessDir, '02-inbound-audio.json', audioPayload);
  writeJson(harnessDir, '03-inbound-first.json', firstPayload);
  writeJson(harnessDir, '04-inbound-supersede.json', supersedePayload);
  writeJson(harnessDir, '05-inbound-truncated.json', truncatedPayload);
  writeJson(harnessDir, '06-retention-old.json', {
    messageId: messageIds.retention,
    receivedAt: retentionPayload.receivedAt,
    contentStatus: retentionPayload.contentStatus,
  });
  console.log('[harness-onda21-ana] emit OK | payloads=6');
}

function parseReplyRequest(value: unknown): QuestionReplyInput {
  assert(value && typeof value === 'object', 'HarnessReplyRequestInvalid');
  const raw = value as Record<string, unknown>;
  const input: QuestionReplyInput = {
    phoneNumberId: typeof raw.phoneNumberId === 'string' ? raw.phoneNumberId.trim() : '',
    customerPhone: typeof raw.customerPhone === 'string' ? raw.customerPhone.trim() : '',
    idempotencyKey:
      typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey.trim() : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    sourceInboundMessageId:
      typeof raw.sourceInboundMessageId === 'string'
        ? raw.sourceInboundMessageId.trim()
        : '',
  };
  assert(
    input.phoneNumberId &&
      input.customerPhone &&
      input.idempotencyKey &&
      input.text.trim() &&
      input.sourceInboundMessageId,
    'HarnessReplyRequestFieldsMissing'
  );
  return input;
}

async function replyPhase(harnessDir: string): Promise<void> {
  const replyService = await import('../src/services/questionReplyService');
  const replyHttp = await import('../src/services/questionReplyHttp');
  const statusHandler = await import('../src/services/whatsappStatusHandler');
  const { pool } = await import('../src/services/contextManager');

  const request = parseReplyRequest(readJson(harnessDir, '10-reply-request.json'));
  const providerMessageId = `wamid-harness-reply-${sha256(
    request.idempotencyKey
  ).slice(0, 20)}`;
  let whatsappSends = 0;
  let failSentPersistenceOnce = true;
  const replyStore: import('../src/services/questionReplyService').QuestionReplyStore = {
    ...replyService.pgQuestionReplyStore,
    async update(
      idempotencyKey,
      status,
      persistedProviderMessageId,
      failureCode,
      snapshot
    ) {
      if (status === 'sent' && failSentPersistenceOnce) {
        failSentPersistenceOnce = false;
        throw new Error('injected sent persistence failure');
      }
      return replyService.pgQuestionReplyStore.update(
        idempotencyKey,
        status,
        persistedProviderMessageId,
        failureCode,
        snapshot
      );
    },
  };
  const result = await replyService.sendQuestionReply(
    request,
    {
      phoneNumberId: request.phoneNumberId,
      waAccessToken: 'harness-never-used',
      waApiVersion: 'v21.0',
    },
    replyService.createQuestionReplyDeps({
      store: replyStore,
      sendReceipt: async () => {
        whatsappSends += 1;
        return { providerMessageId };
      },
    })
  );
  const httpResult = replyHttp.questionReplyResultToHttp(result);
  assert(httpResult.statusCode === 202, 'HarnessReplyWasNotPending');
  assert(
    httpResult.body.status === 'confirmation_pending',
    'HarnessReplyPendingStatusMismatch'
  );
  assert(
    httpResult.body.providerMessageId === providerMessageId,
    'HarnessReplyProviderIdMismatch'
  );
  assert(
    Object.keys(httpResult.body).length === 2,
    'HarnessReplyPendingBodyWasNotExact'
  );
  assert(whatsappSends === 1, 'HarnessWhatsAppTransportCountMismatch');
  const pendingReplyStatus = await replyService.getQuestionReplyStatus(
    request.idempotencyKey,
    replyStore
  );
  assert(
    pendingReplyStatus?.status === 'confirmation_pending' &&
      pendingReplyStatus.providerMessageId === providerMessageId &&
      pendingReplyStatus.failureCode === 'RECEIPT_PERSIST_FAILED' &&
      pendingReplyStatus.providerStatus === null &&
      pendingReplyStatus.callbackPending === false,
    'HarnessReplyPendingWasNotDurable'
  );
  writeJson(harnessDir, '11-reply-result.json', httpResult.body);

  const callbacks: QuestionReplyStatusCallbackPayload[] = [];
  let callbackAvailable = true;
  const statusDeps: import('../src/services/whatsappStatusHandler').WhatsAppStatusDeps = {
    store: statusHandler.pgWhatsAppStatusStore,
    postCallback: async (payload) => {
      if (!callbackAvailable) throw new TypeError('injected callback unavailable');
      callbacks.push(payload);
    },
    wait: async () => undefined,
    // Mantém next_attempt_at injetado no passado, permitindo ao harness provar
    // a retomada sem sleep e sem mutar diretamente o modelo testado.
    now: () => 0,
  };
  const statusBase = Math.floor(Date.now() / 1000);
  const statusValue = (statusEvent: 'sent' | 'delivered', offset: number) => ({
    statuses: [
      {
        id: providerMessageId,
        status: statusEvent,
        timestamp: String(statusBase + offset),
      },
    ],
  });

  assert(
    (await statusHandler.handleWhatsAppStatuses(statusValue('sent', 0), statusDeps)) === 1,
    'HarnessSentStatusNotApplied'
  );
  callbackAvailable = false;
  assert(
    (await statusHandler.handleWhatsAppStatuses(
      statusValue('delivered', 1),
      statusDeps
    )) === 1,
    'HarnessDeliveredStatusNotApplied'
  );
  const pending = await pool.query<{
    callback_pending: boolean;
    callback_attempts: number;
    provider_status: string;
  }>(
    `SELECT callback_pending, callback_attempts, provider_status
     FROM sent_question_replies
     WHERE provider_message_id = $1`,
    [providerMessageId]
  );
  assert(
    pending.rows[0]?.callback_pending === true &&
      pending.rows[0]?.callback_attempts === 4 &&
      pending.rows[0]?.provider_status === 'delivered',
    'HarnessCallbackPendingWasNotDurable'
  );
  writeJson(harnessDir, '22-status-callback-pending.json', {
    providerStatus: pending.rows[0]?.provider_status,
    callbackPending: pending.rows[0]?.callback_pending,
    attempts: pending.rows[0]?.callback_attempts,
    whatsappSends,
  });

  callbackAvailable = true;
  const recovered = await statusHandler.sweepWhatsAppStatusCallbacks(statusDeps);
  assert(
    recovered.attempted === 1 && recovered.acknowledged === 1,
    'HarnessCallbackSweepDidNotConverge'
  );
  assert(
    (await statusHandler.handleWhatsAppStatuses(
      statusValue('delivered', 1),
      statusDeps
    )) === 0,
    'HarnessDuplicateStatusApplied'
  );
  assert(
    (await statusHandler.handleWhatsAppStatuses(statusValue('sent', 0), statusDeps)) === 0,
    'HarnessOutOfOrderStatusApplied'
  );
  assert(callbacks.length === 2, 'HarnessUnexpectedCallbackCount');
  assert(callbacks[0]?.statusEvent === 'sent', 'HarnessSentCallbackMissing');
  assert(callbacks[1]?.statusEvent === 'delivered', 'HarnessDeliveredCallbackMissing');
  assert(whatsappSends === 1, 'HarnessWhatsAppRepeatedDuringCallbackRecovery');

  const local = await pool.query<{
    provider_status: string | null;
    callback_pending: boolean;
    callback_ack_at: Date | null;
  }>(
    `SELECT provider_status, callback_pending, callback_ack_at
     FROM sent_question_replies
     WHERE provider_message_id = $1`,
    [providerMessageId]
  );
  assert(local.rows[0]?.provider_status === 'delivered', 'HarnessLocalStatusNotMonotonic');
  assert(
    local.rows[0]?.callback_pending === false &&
      local.rows[0]?.callback_ack_at instanceof Date,
    'HarnessCallbackAckMissing'
  );

  const replyStatus = await replyService.getQuestionReplyStatus(
    request.idempotencyKey,
    replyStore
  );
  assert(replyStatus, 'HarnessReplyStatusMissing');
  assert(
    replyStatus.status === 'confirmation_pending' &&
      replyStatus.providerMessageId === providerMessageId &&
      replyStatus.failureCode === 'RECEIPT_PERSIST_FAILED',
    'HarnessReplyStatusLostPendingEvidence'
  );
  assert(
    replyStatus.providerStatus === 'delivered' &&
      replyStatus.providerStatusAt ===
        new Date((statusBase + 1) * 1000).toISOString() &&
      replyStatus.providerFailureCode === null &&
      replyStatus.callbackPending === false,
    'HarnessReplyStatusDidNotConverge'
  );

  writeJson(harnessDir, '12-reply-status.json', replyStatus);
  writeJson(harnessDir, '20-status-callback-sent.json', callbacks[0]);
  writeJson(harnessDir, '21-status-callback-delivered.json', callbacks[1]);
  writeJson(harnessDir, '23-status-callback-recovered.json', {
    providerStatus: local.rows[0]?.provider_status,
    callbackPending: local.rows[0]?.callback_pending,
    callbackAckAt: local.rows[0]?.callback_ack_at?.toISOString() ?? null,
    whatsappSends,
  });
  console.log('[harness-onda21-ana] reply OK | callbacks=2');
}

async function main(): Promise<void> {
  const phase = argValue('phase');
  assert(phase === 'emit' || phase === 'reply', 'HarnessPhaseInvalid');
  const harnessDir = requireHarnessDir();
  await ensureSchema();
  try {
    if (phase === 'emit') await emitPhase(harnessDir);
    else await replyPhase(harnessDir);
  } finally {
    const { pool } = await import('../src/services/contextManager');
    const order = await import('../src/services/conversationOrder');
    await Promise.all([pool.end(), order.closeConversationOrderPoolForSmoke()]);
  }
}

main().catch((error) => {
  // O harness nunca imprime a mensagem/stack: ela pode incorporar request/body.
  console.error(
    `[harness-onda21-ana] FAIL | error_kind=${
      error instanceof Error ? error.name : typeof error
    }`
  );
  process.exitCode = 1;
});
