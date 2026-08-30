/**
 * Smoke em memória para a fidelidade do dedupe no cutover PROD → LAB.
 *
 * O conjunto de mensagens só é selecionado depois da quiescência, o mais
 * perto possível de T_SEED, e reconfirmado imediatamente antes de T_LAB. PROD
 * e LAB são bancos diferentes e não existe transação atômica cross-storage;
 * a segurança operacional vem de hold + quiescência + conjunto estável. Se o
 * count da interseção mudar entre a leitura final e a seed, o cutover aborta.
 * Esse contexto é documentado aqui, mas não é exercitado por este smoke.
 *
 * O primeiro caso representa o tombstone semeado em `processed_messages` do
 * LAB. O segundo representa um inbound novo. Todo storage é um store em
 * memória e todas as fronteiras de entrega/pausa/modelo são injetadas; não há
 * Postgres, rede, provider ou WhatsApp real.
 */

// Estes valores precisam existir antes do import dinâmico de messageHandler:
// contextManager valida DATABASE_URL no load. O valor é deliberadamente
// inválido e nenhuma dependência deste smoke abre uma conexão.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/ana-lab-dedupe';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';

import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  CloudContact,
  CloudMessage,
  FlushDeps,
  IncomingMessageDeps,
} from '../src/messageHandler';
import type { AtomicInboundInput } from '../src/services/anaWave2Store';
import type { InboundDeliveryResult } from '../src/services/inboundOutbox';
import { technicalHash } from '../src/observability/safeRuntime';

const PHONE_NUMBER_ID = 'PN-CROSS-STORAGE-SMOKE';
const CUSTOMER_PHONE = 'customer-fixture';
const CONVERSATION_KEY = `${PHONE_NUMBER_ID}:${CUSTOMER_PHONE}`;
const SEEDED_MESSAGE_ID = 'seeded-message-fixture';
const NEW_MESSAGE_ID = 'new-message-fixture';

const config: TenantBotConfig = {
  tenantSlug: 'cross-storage-dedupe-smoke',
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
  waAccessToken: 'token-fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: PHONE_NUMBER_ID,
  isActive: true,
};

interface MemoryHistoryRow {
  messageId: string;
  conversationKey: string;
}

interface MemoryProcessedMessageRow {
  messageId: string;
  phoneNumberId: string;
  conversationKey: string | null;
}

interface MemoryProcessedMessages {
  rows: Map<string, MemoryProcessedMessageRow>;
  insert(input: MemoryProcessedMessageRow):
    | { inserted: true }
    | { inserted: false; conflict: 'message_id_primary_key' };
}

interface MemoryStore {
  processedMessages: MemoryProcessedMessages;
  history: MemoryHistoryRow[];
  inboundEventOutbox: Set<string>;
  conversationSeq: Map<string, number>;
  trace: string[];
}

interface Counters {
  processedMessageInsertAttempts: number;
  processedMessageConflicts: number;
  intakeFresh: number;
  intakeDuplicate: number;
  deliverInbound: number;
  history: number;
  conversationSeq: number;
  inboundEventOutbox: number;
  bufferDebounce: number;
  download: number;
  transcribe: number;
  model: number;
  tools: number;
  whatsappOutbound: number;
  erpWrite: number;
}

function newCounters(): Counters {
  return {
    processedMessageInsertAttempts: 0,
    processedMessageConflicts: 0,
    intakeFresh: 0,
    intakeDuplicate: 0,
    deliverInbound: 0,
    history: 0,
    conversationSeq: 0,
    inboundEventOutbox: 0,
    bufferDebounce: 0,
    download: 0,
    transcribe: 0,
    model: 0,
    tools: 0,
    whatsappOutbound: 0,
    erpWrite: 0,
  };
}

function resetCounters(counters: Counters): void {
  Object.assign(counters, newCounters());
}

function textMessage(id: string, body: string): CloudMessage {
  return {
    from: CUSTOMER_PHONE,
    id,
    timestamp: '1786550400',
    type: 'text',
    text: { body },
  };
}

function newProcessedMessages(
  seed: readonly MemoryProcessedMessageRow[] = []
): MemoryProcessedMessages {
  return {
    rows: new Map(seed.map((row) => [row.messageId, { ...row }])),
    insert(input):
      | { inserted: true }
      | { inserted: false; conflict: 'message_id_primary_key' } {
      if (this.rows.has(input.messageId)) {
        return { inserted: false, conflict: 'message_id_primary_key' };
      }
      this.rows.set(input.messageId, { ...input });
      return { inserted: true };
    },
  };
}

function createInboundDeps(
  store: MemoryStore,
  counters: Counters
): IncomingMessageDeps {
  const successfulDelivery: InboundDeliveryResult = {
    delivered: true,
    attempts: 1,
    terminal: false,
    fastRetryAllowed: false,
  };

  return {
    // Espelha a autoridade real: `processed_messages` recebe um INSERT com PK
    // `message_id`. O resultado do conflito, e não um pre-check, decide o
    // `fresh:false` antes de qualquer mutação de history/seq/outbox.
    persistInbound: async (input: AtomicInboundInput) => {
      counters.processedMessageInsertAttempts += 1;
      store.trace.push('processed_messages:INSERT');
      const inserted = store.processedMessages.insert({
        messageId: input.messageId,
        phoneNumberId: input.phoneNumberId,
        conversationKey: CONVERSATION_KEY,
      });
      if (!inserted.inserted) {
        counters.processedMessageConflicts += 1;
        counters.intakeDuplicate += 1;
        store.trace.push(
          `processed_messages:CONFLICT:${inserted.conflict}`
        );
        store.trace.push('persistInbound:return:fresh=false');
        return {
          fresh: false,
          conversationKey: CONVERSATION_KEY,
          sequence: null,
        };
      }

      counters.intakeFresh += 1;
      store.trace.push('processed_messages:INSERT:COMMITTED');

      store.history.push({
        messageId: input.messageId,
        conversationKey: CONVERSATION_KEY,
      });
      counters.history += 1;
      store.trace.push('history:WRITE');

      store.inboundEventOutbox.add(input.messageId);
      counters.inboundEventOutbox += 1;
      store.trace.push('inbound_event_outbox:WRITE');

      const sequence = (store.conversationSeq.get(CONVERSATION_KEY) ?? 0) + 1;
      store.conversationSeq.set(CONVERSATION_KEY, sequence);
      counters.conversationSeq += 1;
      store.trace.push('conversation_seq:WRITE');
      store.trace.push('persistInbound:return:fresh=true');

      return {
        fresh: true,
        conversationKey: CONVERSATION_KEY,
        sequence,
      };
    },
    deliverInbound: async () => {
      counters.deliverInbound += 1;
      counters.erpWrite += 1;
      store.trace.push('deliverInbound:CALL');
      store.trace.push('ERP:WRITE');
      return successfulDelivery;
    },
    updateInboundContent: async () => undefined,
    markTranscriptionFailed: async () => undefined,
    downloadAudio: async () => {
      counters.download += 1;
      store.trace.push('download:CALL');
      return Buffer.from('unused');
    },
    transcribeAudio: async () => {
      counters.transcribe += 1;
      store.trace.push('transcribe:CALL');
      return 'unused';
    },
    handleOptOut: async () => false,
    shouldSuspend: async () => false,
    isPaused: async () => false,
    // Gate de retomada determinístico: libera o caminho normal sem chamar
    // Receps, provider ou qualquer classificador.
    resumeGate: async () => true,
  };
}

function createFlushDeps(store: MemoryStore, counters: Counters): FlushDeps {
  return {
    getReply: async () => {
      counters.model += 1;
      store.trace.push('model:CALL');
      return 'resposta fixture';
    },
    sendReply: async () => {
      counters.whatsappOutbound += 1;
      store.trace.push('WhatsApp outbound:CALL');
      return 'sent';
    },
    isPaused: async () => false,
  };
}

async function main(): Promise<void> {
  const handler = await import('../src/messageHandler');
  const originalConsoleInfo = console.info;
  const capturedInfo: string[] = [];

  // Preserve o diagnóstico no terminal enquanto captura a superfície de
  // telemetria para a regressão de privacidade. O teste nunca aceita o ID cru.
  console.info = (...args: unknown[]) => {
    const line = args.map((value) => String(value)).join(' ');
    capturedInfo.push(line);
    originalConsoleInfo(...args);
  };

  try {
    handler.__resetFlushStateForTest();

    const store: MemoryStore = {
      processedMessages: newProcessedMessages([
        {
          messageId: SEEDED_MESSAGE_ID,
          phoneNumberId: PHONE_NUMBER_ID,
          conversationKey: CONVERSATION_KEY,
        },
      ]),
      history: [],
      inboundEventOutbox: new Set(),
      conversationSeq: new Map(),
      trace: [],
    };
    const counters = newCounters();
    const incomingDeps = createInboundDeps(store, counters);

    // Caso A: o tombstone PROD já está no processed_messages do LAB. Duas
    // chegadas do mesmo ID devem ser no-op antes de qualquer downstream.
    await handler.handleIncomingMessage(
      textMessage(SEEDED_MESSAGE_ID, 'fixture semeado'),
      undefined as CloudContact | undefined,
      config,
      incomingDeps
    );
    await handler.handleIncomingMessage(
      textMessage(SEEDED_MESSAGE_ID, 'fixture semeado retransmitido'),
      undefined as CloudContact | undefined,
      config,
      incomingDeps
    );

    assert.equal(
      counters.processedMessageInsertAttempts,
      2,
      'tombstone tenta INSERT duas vezes'
    );
    assert.equal(
      counters.processedMessageConflicts,
      2,
      'tombstone conflita na PK duas vezes'
    );
    assert.equal(counters.intakeDuplicate, 2, 'tombstone deve conflitar duas vezes');
    assert.equal(counters.intakeFresh, 0, 'tombstone não cria novo intake');
    assert.equal(counters.deliverInbound, 0, 'tombstone não entrega inbound');
    assert.equal(counters.history, 0, 'tombstone não grava history');
    assert.equal(counters.conversationSeq, 0, 'tombstone não atualiza conversation_seq');
    assert.equal(
      counters.inboundEventOutbox,
      0,
      'tombstone não grava inbound_event_outbox'
    );
    assert.equal(counters.bufferDebounce, 0, 'tombstone não abre buffer/debounce');
    assert.equal(counters.download, 0, 'tombstone não baixa mídia');
    assert.equal(counters.transcribe, 0, 'tombstone não transcreve mídia');
    assert.equal(counters.model, 0, 'tombstone não chama modelo');
    assert.equal(counters.tools, 0, 'tombstone não chama tools');
    assert.equal(counters.whatsappOutbound, 0, 'tombstone não envia WhatsApp outbound');
    assert.equal(counters.erpWrite, 0, 'tombstone não faz ERP write');
    assert.equal(store.history.length, 0, 'tombstone deixa history vazia');
    assert.equal(
      store.inboundEventOutbox.size,
      0,
      'tombstone deixa inbound_event_outbox vazia'
    );
    assert.equal(store.conversationSeq.size, 0, 'tombstone deixa conversation_seq vazia');
    assert.equal(
      store.processedMessages.rows.size,
      1,
      'duas retransmissões preservam somente o tombstone semeado'
    );
    assert.deepEqual(
      store.trace,
      [
        'processed_messages:INSERT',
        'processed_messages:CONFLICT:message_id_primary_key',
        'persistInbound:return:fresh=false',
        'processed_messages:INSERT',
        'processed_messages:CONFLICT:message_id_primary_key',
        'persistInbound:return:fresh=false',
      ],
      'fresh:false retorna imediatamente após o conflito da PK'
    );
    assert.equal(
      handler.__hasBufferForTest(CONVERSATION_KEY),
      false,
      'tombstone não cria buffer'
    );

    // Isola as métricas do caso de tombstone das métricas do inbound novo.
    resetCounters(counters);
    store.trace.length = 0;

    // Caso B: ID não visto no PROD. O primeiro intake cria exatamente as
    // quatro marcas duráveis simuladas; o flush usa seams em memória.
    const freshMessage = textMessage(NEW_MESSAGE_ID, 'fixture novo');
    await handler.handleIncomingMessage(
      freshMessage,
      undefined as CloudContact | undefined,
      config,
      incomingDeps
    );
    assert.equal(
      handler.__hasBufferForTest(CONVERSATION_KEY),
      true,
      'inbound novo deve criar buffer'
    );

    counters.bufferDebounce += 1;
    store.trace.push('buffer/debounce:FLUSH');
    await handler.flushBuffer(CONVERSATION_KEY, createFlushDeps(store, counters));

    assert.equal(counters.processedMessageInsertAttempts, 1, 'inbound novo tenta um INSERT');
    assert.equal(counters.processedMessageConflicts, 0, 'inbound novo não conflita');
    assert.equal(counters.intakeFresh, 1, 'inbound novo tem um intake');
    assert.equal(counters.deliverInbound, 1, 'inbound novo tem uma entrega');
    assert.equal(counters.history, 1, 'inbound novo grava um history');
    assert.equal(counters.conversationSeq, 1, 'inbound novo atualiza uma conversation_seq');
    assert.equal(counters.inboundEventOutbox, 1, 'inbound novo grava um inbound_event_outbox');
    assert.equal(counters.bufferDebounce, 1, 'inbound novo abre um buffer/debounce');
    assert.equal(counters.download, 0, 'inbound textual novo não baixa mídia');
    assert.equal(counters.transcribe, 0, 'inbound textual novo não transcreve mídia');
    assert.equal(counters.model, 1, 'inbound novo chama o modelo uma vez');
    assert.equal(counters.tools, 0, 'fixture novo não chama tools');
    assert.equal(counters.whatsappOutbound, 1, 'inbound novo envia uma resposta');
    assert.equal(counters.erpWrite, 1, 'inbound novo faz um ERP write de entrega');
    assert.equal(store.history.length, 1, 'store tem um history além do tombstone');
    assert.equal(
      store.inboundEventOutbox.size,
      1,
      'store tem um inbound_event_outbox além do tombstone'
    );
    assert.equal(store.conversationSeq.get(CONVERSATION_KEY), 1, 'conversation_seq começa em um');
    assert.equal(
      handler.__hasBufferForTest(CONVERSATION_KEY),
      false,
      'flush limpa o buffer'
    );

    // O mesmo ID novo retransmitido agora conflita; nenhum contador downstream
    // pode subir e nenhum segundo buffer pode ser aberto.
    await handler.handleIncomingMessage(
      freshMessage,
      undefined as CloudContact | undefined,
      config,
      incomingDeps
    );
    assert.equal(counters.intakeFresh, 1, 'replay não cria segundo intake');
    assert.equal(
      counters.processedMessageInsertAttempts,
      2,
      'replay tenta o INSERT novamente'
    );
    assert.equal(counters.processedMessageConflicts, 1, 'replay conflita na PK uma vez');
    assert.equal(counters.intakeDuplicate, 1, 'replay novo conflita uma vez');
    assert.equal(counters.deliverInbound, 1, 'replay não entrega de novo');
    assert.equal(counters.history, 1, 'replay não grava history de novo');
    assert.equal(counters.conversationSeq, 1, 'replay não incrementa conversation_seq');
    assert.equal(counters.inboundEventOutbox, 1, 'replay não grava outbox de novo');
    assert.equal(counters.bufferDebounce, 1, 'replay não abre buffer/debounce');
    assert.equal(counters.download, 0, 'replay não baixa mídia');
    assert.equal(counters.transcribe, 0, 'replay não transcreve mídia');
    assert.equal(counters.model, 1, 'replay não chama modelo de novo');
    assert.equal(counters.tools, 0, 'replay não chama tools');
    assert.equal(counters.whatsappOutbound, 1, 'replay não envia de novo');
    assert.equal(counters.erpWrite, 1, 'replay não faz ERP write de novo');
    assert.equal(
      handler.__hasBufferForTest(CONVERSATION_KEY),
      false,
      'replay não cria buffer'
    );

    assert.equal(
      store.processedMessages.rows.size,
      2,
      'tombstone e inbound novo permanecem como duas linhas de processed_messages'
    );
    assert.equal(
      capturedInfo.some((line) => line.includes(SEEDED_MESSAGE_ID)),
      false,
      'ID sintético tombstonado não aparece no console.info capturado'
    );
    assert.equal(
      capturedInfo.some((line) => line.includes(NEW_MESSAGE_ID)),
      false,
      'ID sintético novo não aparece no console.info capturado'
    );
    assert.equal(
      capturedInfo.filter((line) =>
        line.includes(`messageIdHash=${technicalHash(SEEDED_MESSAGE_ID)}`)
      ).length,
      2,
      'as duas retransmissões tombstonadas preservam o hash técnico'
    );
    assert.equal(
      capturedInfo.filter((line) =>
        line.includes(`messageIdHash=${technicalHash(NEW_MESSAGE_ID)}`)
      ).length,
      1,
      'a retransmissão do inbound novo preserva o hash técnico'
    );

    console.log('smoke ana lab cross-storage dedupe: OK');
  } finally {
    handler.__resetFlushStateForTest();
    console.info = originalConsoleInfo;
  }
}

main().catch(() => {
  // Mensagem deliberadamente genérica: nenhum ID técnico deve aparecer na
  // saída do smoke, inclusive em uma falha de assert.
  console.error('smoke ana lab cross-storage dedupe: FAILED');
  process.exitCode = 1;
});
