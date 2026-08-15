/**
 * Smoke DETERMINÍSTICO dos leitores do histórico de conversas da Ana usados
 * pelos endpoints GET /internal/conversations e /internal/conversation-messages
 * (painel interno do Receps). Cobre as funções PURAS + o mapeamento de shape com
 * um pool INJETADO (fake). Sem DB / rede / OpenAI.
 *
 * PII: os fixtures são SINTÉTICOS — nunca há telefone/conteúdo real aqui.
 *
 * Padrão pós-ESM: o contextManager LANÇA no load sem DATABASE_URL (o Pool do pg
 * é lazy, não conecta). Setar dummies ANTES do import dinâmico.
 *
 * Rodar: npx tsx scripts/smoke-conversations-endpoint.ts
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@localhost:5432/smoke';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-smoke-dummy';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const cm = await import('../src/services/contextManager');
  const {
    parseConversationKey,
    escapeLikePattern,
    truncatePreview,
    clampConversationsLimit,
    clampConversationsOffset,
    listConversations,
    getHistoryWithTimestamps,
    CONVERSATIONS_DEFAULT_LIMIT,
    CONVERSATIONS_MAX_LIMIT,
    HUMAN_ECHO_PREFIX,
  } = cm;

  // --- parseConversationKey --------------------------------------------------
  const k1 = parseConversationKey('123456:5511999998888');
  check('parseKey normal → phoneNumberId', k1.phoneNumberId === '123456');
  check('parseKey normal → customerPhone', k1.customerPhone === '5511999998888');
  const k2 = parseConversationKey('123456:');
  check('parseKey sufixo vazio → customerPhone "" (phoneNumberId ok)', k2.customerPhone === '' && k2.phoneNumberId === '123456');
  const k3 = parseConversationKey('123456:55:11:9');
  check('parseKey múltiplos ":" → split só no primeiro', k3.phoneNumberId === '123456' && k3.customerPhone === '55:11:9');
  const k4 = parseConversationKey('semdoispontos');
  check('parseKey sem ":" → customerPhone "" (fallback seguro)', k4.customerPhone === '' && k4.phoneNumberId === 'semdoispontos');

  // --- escapeLikePattern -----------------------------------------------------
  check('escapeLike %', escapeLikePattern('a%b') === 'a\\%b');
  check('escapeLike _', escapeLikePattern('a_b') === 'a\\_b');
  check('escapeLike \\', escapeLikePattern('a\\b') === 'a\\\\b');
  check('escapeLike combinado %_\\', escapeLikePattern('%_\\') === '\\%\\_\\\\');
  check('escapeLike sem metachar inalterado', escapeLikePattern('123456:') === '123456:');

  // --- truncatePreview -------------------------------------------------------
  check('truncate 200→120', truncatePreview('x'.repeat(200)).length === 120);
  check('truncate curto inalterado', truncatePreview('oi') === 'oi');
  check('truncate exatamente 120 inalterado', truncatePreview('y'.repeat(120)).length === 120);

  // --- clamp limit/offset ----------------------------------------------------
  check('limit undefined → default 20', clampConversationsLimit(undefined) === CONVERSATIONS_DEFAULT_LIMIT);
  check('limit 1000 → teto 50', clampConversationsLimit(1000) === CONVERSATIONS_MAX_LIMIT);
  check('limit 0 → default', clampConversationsLimit(0) === CONVERSATIONS_DEFAULT_LIMIT);
  check('limit 10 → 10', clampConversationsLimit(10) === 10);
  check('offset undefined → 0', clampConversationsOffset(undefined) === 0);
  check('offset -5 → 0', clampConversationsOffset(-5) === 0);
  check('offset 40 → 40', clampConversationsOffset(40) === 40);

  // --- listConversations: mapeamento de shape com pool injetado --------------
  const listCalls: { text: string; params: unknown[] }[] = [];
  const fakeListQuery = async (text: string, params: unknown[]) => {
    listCalls.push({ text, params });
    if (text.includes('COUNT(DISTINCT')) {
      return { rows: [{ total: 7 }] };
    }
    return {
      rows: [
        {
          conversationKey: '123456:5511999998888',
          messageCount: 30,
          lastActivityAt: new Date('2026-07-22T12:00:00.000Z'),
          lastRole: 'assistant',
          lastContent: 'z'.repeat(200),
        },
        {
          conversationKey: '123456:5511777776666',
          messageCount: 3,
          lastActivityAt: '2026-07-22T10:00:00.000Z',
          lastRole: 'user',
          lastContent: 'quero agendar',
        },
      ],
    };
  };

  const listed = await listConversations('123456', 1000, -3, fakeListQuery);
  // A 1ª chamada é a query paginada; a 2ª é o COUNT (ordem síncrona no Promise.all).
  const pageCall = listCalls.find((c) => !c.text.includes('COUNT(DISTINCT'));
  const countCall = listCalls.find((c) => c.text.includes('COUNT(DISTINCT'));
  check('list: 2 queries emitidas (página + total)', listCalls.length === 2 && !!pageCall && !!countCall);
  check('list: clamp nos params da página (limit 50, offset 0)', pageCall!.params[1] === 50 && pageCall!.params[2] === 0);
  check('list: likePattern = prefixo + % nas 2 queries', pageCall!.params[0] === '123456:%' && countCall!.params[0] === '123456:%');
  check('list: total vem do 2º query', listed.total === 7);
  check('list: 2 conversas mapeadas', listed.conversations.length === 2);
  check('list: customerPhone = sufixo do key', listed.conversations[0].customerPhone === '5511999998888' && listed.conversations[1].customerPhone === '5511777776666');
  check('list: lastActivityAt ISO a partir de Date', listed.conversations[0].lastActivityAt === '2026-07-22T12:00:00.000Z');
  check('list: lastActivityAt ISO a partir de string', listed.conversations[1].lastActivityAt === '2026-07-22T10:00:00.000Z');
  check('list: preview truncado a 120', listed.conversations[0].lastPreview.length === 120);
  check('list: preview curto inalterado', listed.conversations[1].lastPreview === 'quero agendar');
  check('list: lastRole preservado (assistant/user)', listed.conversations[0].lastRole === 'assistant' && listed.conversations[1].lastRole === 'user');
  check('list: messageCount numérico', listed.conversations[0].messageCount === 30 && listed.conversations[1].messageCount === 3);

  const humanCtx = await import('../src/services/humanConversationContext');
  const clauseVisible = 'A drenagem linfática é uma técnica manual suave.';
  const licensedEnvelope = humanCtx.historyContentForAcceptedAssistant(
    clauseVisible,
    [
      {
        order: 0,
        start: 0,
        end: clauseVisible.length,
        serviceId: 'svc-drenagem',
        serviceName: 'Drenagem Linfática',
        sourceHash: 'a'.repeat(64),
        clauseIds: ['drenagem-what'],
        facets: ['WHAT_IT_IS'],
      },
    ]
  );
  const licensedListQuery = async (text: string) => {
    if (text.includes('COUNT(DISTINCT')) return { rows: [{ total: 1 }] };
    return {
      rows: [
        {
          conversationKey: '123456:5511999998888',
          messageCount: 2,
          lastActivityAt: new Date('2026-07-22T12:00:00.000Z'),
          lastRole: 'assistant',
          lastContent: licensedEnvelope,
        },
      ],
    };
  };
  const licensedListed = await listConversations(
    '123456',
    20,
    0,
    licensedListQuery
  );
  check(
    'list: preview de catálogo licenciado mostra a cláusula, não o envelope',
    licensedListed.conversations[0].lastPreview === clauseVisible
  );
  check(
    'list: preview não vaza JSON de proveniência',
    !licensedListed.conversations[0].lastPreview.includes('"visibleText"')
  );

  // listConversations com LIKE metachar no phoneNumberId → escapado no pattern.
  const listCalls2: { text: string; params: unknown[] }[] = [];
  const fakeEmptyList = async (text: string, params: unknown[]) => {
    listCalls2.push({ text, params });
    return { rows: text.includes('COUNT(DISTINCT') ? [{ total: 0 }] : [] };
  };
  const listed2 = await listConversations('a_b%c', undefined, undefined, fakeEmptyList);
  check('list: phoneNumberId com metachar é escapado', listCalls2[0].params[0] === 'a\\_b\\%c:%');
  check('list: página vazia → total 0 e conversas []', listed2.total === 0 && listed2.conversations.length === 0);

  // --- getHistoryWithTimestamps: shape + tolerância ao formato do telefone ----
  const msgCalls: { text: string; params: unknown[] }[] = [];
  const fakeMsgQuery = async (text: string, params: unknown[]) => {
    msgCalls.push({ text, params });
    return {
      rows: [
        { role: 'user', content: 'oi', createdAt: new Date('2026-07-22T09:00:00.000Z') },
        { role: 'assistant', content: `${HUMAN_ECHO_PREFIX}já te respondo`, createdAt: '2026-07-22T09:01:00.000Z' },
      ],
    };
  };

  const msgs = await getHistoryWithTimestamps('123456', '+5511999998888', fakeMsgQuery);
  check('messages: 2 itens mapeados', msgs.length === 2);
  check('messages: role/content preservados', msgs[0].role === 'user' && msgs[0].content === 'oi');
  check('messages: createdAt ISO a partir de Date', msgs[0].createdAt === '2026-07-22T09:00:00.000Z');
  check('messages: createdAt ISO a partir de string', msgs[1].createdAt === '2026-07-22T09:01:00.000Z');
  check('messages: prefixo [atendente] preservado no payload', msgs[1].content.startsWith(HUMAN_ECHO_PREFIX));
  const anyKeys = msgCalls[0].params[0];
  check(
    'messages: variantes do telefone (cru + só-dígitos) no ANY()',
    Array.isArray(anyKeys) &&
      (anyKeys as string[]).includes('123456:+5511999998888') &&
      (anyKeys as string[]).includes('123456:5511999998888')
  );

  // Conversa inexistente (telefone vazio) → [] SEM tocar o DB.
  const callsBefore = msgCalls.length;
  const emptyMsgs = await getHistoryWithTimestamps('123456', '   ', fakeMsgQuery);
  check('messages: telefone vazio → [] sem query', emptyMsgs.length === 0 && msgCalls.length === callsBefore);

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-conversations-endpoint OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke falhou com exceção:', err);
  process.exit(1);
});
