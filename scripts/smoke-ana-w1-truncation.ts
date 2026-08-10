import { createHash } from 'crypto';

process.env.DATABASE_URL ??= 'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.RECEPS_IA_DIRECT_DATABASE_URL ??=
  'postgresql://dummy:dummy@127.0.0.1:1/dummy';
process.env.ERP_API_TOKEN ??= 'smoke-erp-token';
process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';

export {};

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  checks.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const content = await import('../src/services/inboundContent');
  const wave2 = await import('../src/services/anaWave2Store');
  const outbox = await import('../src/services/inboundOutbox');
  const handler = await import('../src/messageHandler');

  const exact = 'a'.repeat(4_000);
  const exactResult = content.truncateForW1(exact);
  check(
    '4.000 UTF-16 permanece FINAL byte-exato',
    !exactResult.truncated &&
      exactResult.originalLength === 4_000 &&
      Buffer.from(exactResult.text).equals(Buffer.from(exact))
  );

  for (const length of [4_001, 4_096]) {
    const original = 'b'.repeat(length);
    const result = content.truncateForW1(original);
    check(
      `${length} UTF-16 vira TRUNCATED com originalLength do original`,
      result.truncated &&
        result.text === original.slice(0, 4_000) &&
        result.text.length === 4_000 &&
        result.originalLength === length
    );
  }

  const exactEmoji = `${'c'.repeat(3_998)}😀`;
  const exactEmojiResult = content.truncateForW1(exactEmoji);
  check(
    'emoji completo encerrando a unidade 4.000 continua FINAL',
    exactEmojiResult.text === exactEmoji &&
      exactEmojiResult.text.length === 4_000 &&
      !exactEmojiResult.truncated
  );

  const boundaryEmoji = `${'d'.repeat(3_999)}😀`;
  const boundaryResult = content.truncateForW1(boundaryEmoji);
  const lastUnit = boundaryResult.text.charCodeAt(boundaryResult.text.length - 1);
  check(
    'emoji na fronteira recua para 3.999 sem high surrogate órfão',
    boundaryResult.truncated &&
      boundaryResult.originalLength === 4_001 &&
      boundaryResult.text === 'd'.repeat(3_999) &&
      !(lastUnit >= 0xd800 && lastUnit <= 0xdbff)
  );

  const normalizedCases = [
    handler.normalizeInboundContent({
      from: 'fixture',
      id: 'text',
      timestamp: '1',
      type: 'text',
      text: { body: boundaryEmoji },
    }),
    handler.normalizeInboundContent({
      from: 'fixture',
      id: 'button',
      timestamp: '1',
      type: 'button',
      button: { text: boundaryEmoji, payload: 'fixture' },
    }),
    handler.normalizeInboundContent({
      from: 'fixture',
      id: 'list',
      timestamp: '1',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { title: boundaryEmoji } },
    }),
  ];
  check(
    'texto, button e list truncam antes do history W1',
    normalizedCases.every(
      (entry) =>
        entry.contentStatus === 'truncated' &&
        entry.content === boundaryResult.text &&
        entry.contentOriginalLength === boundaryEmoji.length
    )
  );

  const finalPayload = outbox.serializeInboundDeliveryPayload({
    messageId: 'wamid-final-smoke',
    phoneNumberId: 'pnid-truncation-smoke',
    conversationKey: 'pnid-truncation-smoke:5511000000000',
    receivedAt: new Date(0),
    messageType: 'text',
    contentStatus: 'final',
    content: exact,
    contentOriginalLength: exact.length,
    attempts: 0,
    nextRetryAt: new Date(0),
    deliveredAt: null,
    terminalAt: null,
    failureCode: null,
  });
  check(
    'W1 FINAL inclui contentOriginalLength igual ao recorte',
    finalPayload.contentStatus === 'final' &&
      finalPayload.contentLength === 4_000 &&
      finalPayload.contentOriginalLength === 4_000 &&
      finalPayload.contentHash === sha256(exact)
  );

  const payload = outbox.serializeInboundDeliveryPayload({
    messageId: 'wamid-truncation-smoke',
    phoneNumberId: 'pnid-truncation-smoke',
    conversationKey: 'pnid-truncation-smoke:5511000000000',
    receivedAt: new Date(0),
    messageType: 'text',
    contentStatus: 'truncated',
    content: boundaryResult.text,
    contentOriginalLength: boundaryResult.originalLength,
    attempts: 0,
    nextRetryAt: new Date(0),
    deliveredAt: null,
    terminalAt: null,
    failureCode: null,
  });
  check(
    'W1 usa hash/length do recorte e originalLength do original',
    payload.contentStatus === 'truncated' &&
      payload.contentText === boundaryResult.text &&
      payload.contentLength === boundaryResult.text.length &&
      payload.contentOriginalLength === boundaryResult.originalLength &&
      payload.contentHash === sha256(boundaryResult.text)
  );

  const emptyPayload = outbox.serializeInboundDeliveryPayload({
    messageId: 'wamid-no-text-smoke',
    phoneNumberId: 'pnid-truncation-smoke',
    conversationKey: 'pnid-truncation-smoke:5511000000000',
    receivedAt: new Date(0),
    messageType: 'audio',
    contentStatus: 'transcription_failed',
    content: '',
    contentOriginalLength: null,
    attempts: 0,
    nextRetryAt: new Date(0),
    deliveredAt: null,
    terminalAt: null,
    failureCode: null,
  });
  check(
    'transcription_failed mantém os quatro campos de conteúdo null',
    emptyPayload.contentText === null &&
      emptyPayload.contentHash === null &&
      emptyPayload.contentLength === null &&
      emptyPayload.contentOriginalLength === null
  );
  const noTextPayload = outbox.serializeInboundDeliveryPayload({
    ...{
      messageId: 'wamid-no-text-2-smoke',
      phoneNumberId: 'pnid-truncation-smoke',
      conversationKey: 'pnid-truncation-smoke:5511000000000',
      receivedAt: new Date(0),
      messageType: 'other' as const,
      contentStatus: 'no_text' as const,
      content: '',
      contentOriginalLength: null,
      attempts: 0,
      nextRetryAt: new Date(0),
      deliveredAt: null,
      terminalAt: null,
      failureCode: null,
    },
  });
  check(
    'no_text também mantém os quatro campos de conteúdo null',
    noTextPayload.contentText === null &&
      noTextPayload.contentHash === null &&
      noTextPayload.contentLength === null &&
      noTextPayload.contentOriginalLength === null
  );

  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const fakeClient = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (/UPDATE ana_conversation_history/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE inbound_event_outbox/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: null, rows: [] };
    },
  };
  const longAudio = `${'e'.repeat(3_999)}😀${'f'.repeat(96)}`;
  await wave2.finalizeInboundContentWithClient(
    fakeClient as never,
    'wamid-audio-atomic',
    'final',
    longAudio
  );
  const historyUpdate = queries.find((entry) =>
    /UPDATE ana_conversation_history/.test(entry.sql)
  );
  const outboxUpdate = queries.find((entry) =>
    /UPDATE inbound_event_outbox/.test(entry.sql)
  );
  check(
    'áudio longo finaliza TRUNCATED dentro de uma única transação',
    queries[0]?.sql === 'BEGIN' &&
      queries.at(-1)?.sql === 'COMMIT' &&
      historyUpdate?.params?.[1] === 'e'.repeat(3_999) &&
      outboxUpdate?.params?.[1] === 'truncated' &&
      outboxUpdate?.params?.[2] === longAudio.length &&
      queries.filter((entry) => entry.sql === 'BEGIN').length === 1 &&
      queries.filter((entry) => entry.sql === 'COMMIT').length === 1
  );

  await import('../src/services/conversationOrder').then((order) =>
    order.closeConversationOrderPoolForSmoke()
  );
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : typeof error);
  process.exitCode = 1;
});
