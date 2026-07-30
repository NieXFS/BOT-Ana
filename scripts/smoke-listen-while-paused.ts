/**
 * Smoke DETERMINÍSTICO da "escuta enquanto pausada" (§8.2 / INV-10). Sem DB/rede
 * — deps injetadas. Prova:
 *   - pausada + inbound do cliente → grava role `user` com o texto (messageHandler);
 *   - recordInboundWhilePaused é à prova de falha (recorder lança → NÃO propaga);
 *   - echo do humano (texto) → grava role `assistant` com prefixo "[atendente] "
 *     + o corpo (echoHandler);
 *   - echo não-texto → placeholder curto prefixado;
 *   - echo retransmitido (mesmo message id) → NÃO grava 2x (dedup por id);
 *   - a PAUSA é disparada por cliente.
 *
 * Env dummy ANTES dos imports: contextManager exige DATABASE_URL no load (o Pool
 * do pg é lazy — não conecta — e nunca é usado, deps injetadas). NODE_ENV=dev pra
 * erpApiToken (transitivo via echoHandler→pauseService) não lançar.
 *
 * Rodar: npx tsx scripts/smoke-listen-while-paused.ts
 */
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { EchoDeps } from '../src/echoHandler';
import type { PausedRecordDeps } from '../src/messageHandler';

const config: TenantBotConfig = {
  tenantSlug: 'smoke-tenant',
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
  botActiveStart: '08:00',
  botActiveEnd: '20:00',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'tok',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-SMOKE',
  isActive: true,
};

const checks: { name: string; ok: boolean }[] = [];
function expect(name: string, cond: boolean) {
  checks.push({ name, ok: cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main() {
  const { recordInboundWhilePaused } = await import('../src/messageHandler');
  const { handleSmbMessageEchoes, parseEchoMessages, HUMAN_ECHO_PREFIX } =
    await import('../src/echoHandler');

  // === A) inbound do cliente enquanto pausada → grava role `user` ============
  const recorded: { key: string; role: string; content: string }[] = [];
  const recDeps: PausedRecordDeps = {
    recordMessage: async (key, role, content) => {
      recorded.push({ key, role, content });
    },
  };
  await recordInboundWhilePaused(
    'PN-SMOKE:5511CUST',
    'quero remarcar pra sexta',
    config,
    recDeps
  );
  expect('A) inbound gravado 1x', recorded.length === 1);
  expect('A) role = user', recorded[0]?.role === 'user');
  expect('A) conteúdo = texto do cliente', recorded[0]?.content === 'quero remarcar pra sexta');
  expect('A) conversationKey correto', recorded[0]?.key === 'PN-SMOKE:5511CUST');

  // === B) à prova de falha: recorder lança → não propaga ====================
  let threw = false;
  try {
    await recordInboundWhilePaused('PN:5511', 'oi', config, {
      recordMessage: async () => {
        throw new Error('DB down (simulado)');
      },
    });
  } catch {
    threw = true;
  }
  expect('B) erro do recorder NÃO propaga (à prova de falha)', threw === false);

  // === C) echo do humano (texto) → grava role assistant com prefixo =========
  const echoRecorded: { key: string; role: string; content: string }[] = [];
  const pausedFor: { pnid: string; phone: string }[] = [];
  const processedIds = new Set<string>(); // simula a tabela processed_messages
  let failRecordOnce = false;
  const echoDeps: EchoDeps = {
    pauseConversation: async (pnid, phone) => {
      pausedFor.push({ pnid, phone });
    },
    markEchoProcessed: async (id) => {
      if (processedIds.has(id)) return false; // retransmissão
      processedIds.add(id);
      return true;
    },
    unmarkEcho: async (id) => {
      processedIds.delete(id);
    },
    recordMessage: async (key, role, content) => {
      if (failRecordOnce) {
        failRecordOnce = false;
        throw new Error('DB blip (simulado)');
      }
      echoRecorded.push({ key, role, content });
    },
  };

  const textEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      {
        from: '5511BIZ',
        to: '5511CUST',
        id: 'wamid.echo1',
        type: 'text',
        text: { body: 'ok, te espero às 15h' },
      },
    ],
  };
  await handleSmbMessageEchoes(textEcho, undefined, echoDeps);
  expect('C) echo de texto gravado 1x', echoRecorded.length === 1);
  expect('C) role = assistant', echoRecorded[0]?.role === 'assistant');
  expect(
    'C) content começa com "[atendente] "',
    echoRecorded[0]?.content.startsWith(HUMAN_ECHO_PREFIX) === true
  );
  expect('C) content inclui o corpo do humano', echoRecorded[0]?.content.includes('ok, te espero às 15h') === true);
  expect('C) conversationKey = PNID:cliente', echoRecorded[0]?.key === 'PNID_1:5511CUST');
  expect('C) pausa disparada 1x', pausedFor.length === 1);

  // === D) echo retransmitido (mesmo id) → NÃO grava 2x ======================
  await handleSmbMessageEchoes(textEcho, undefined, echoDeps);
  expect('D) retransmissão NÃO grava de novo (total ainda 1)', echoRecorded.length === 1);

  // === E) echo não-texto → placeholder curto prefixado =====================
  echoRecorded.length = 0;
  const imgEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [{ to: '5511CUST2', id: 'wamid.echo2', type: 'image' }],
  };
  await handleSmbMessageEchoes(imgEcho, undefined, echoDeps);
  expect('E) echo de imagem gravado', echoRecorded.length === 1);
  expect(
    'E) placeholder prefixado',
    echoRecorded[0]?.content === `${HUMAN_ECHO_PREFIX}enviou uma imagem`
  );

  // === G) gravação falha → marca desfeita → retransmissão recupera =========
  // (à prova de perda: o echo é o contexto do §8.2; um blip de DB na 1ª entrega
  // não pode sumir com ele — a retransmissão da Meta tem que re-gravar.)
  echoRecorded.length = 0;
  const recoverEcho = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [
      { to: '5511CUST3', id: 'wamid.echo3', type: 'text', text: { body: 'pode confirmar?' } },
    ],
  };
  failRecordOnce = true;
  await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // record lança → unmark
  expect('G) gravação falhou na 1ª entrega (nada gravado ainda)', echoRecorded.length === 0);
  expect('G) id desmarcado (idempotência liberada p/ re-tentar)', processedIds.has('wamid.echo3') === false);
  await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // retransmissão → grava
  expect('G) retransmissão recupera o echo (gravado 1x)', echoRecorded.length === 1);
  expect('G) id remarcado após sucesso (não re-grava de novo)', processedIds.has('wamid.echo3') === true);
  await handleSmbMessageEchoes(recoverEcho, undefined, echoDeps); // 3ª entrega = noop
  expect('G) entrega seguinte é noop (sem gravação dupla)', echoRecorded.length === 1);

  // === F) parseEchoMessages (puro) =========================================
  const parsed = parseEchoMessages(textEcho);
  expect('F) parse: 1 mensagem', parsed.length === 1);
  expect('F) parse: messageId extraído', parsed[0]?.messageId === 'wamid.echo1');
  expect(
    'F) parse: content prefixado com o corpo',
    parsed[0]?.content === `${HUMAN_ECHO_PREFIX}ok, te espero às 15h`
  );

  const noId = {
    metadata: { phone_number_id: 'PNID_1' },
    message_echoes: [{ to: '5511X', type: 'text', text: { body: 'oi' } }],
  };
  expect('F) parse: echo sem id é omitido (sem dedup possível)', parseEchoMessages(noId).length === 0);
  expect('F) parse: null → []', parseEchoMessages(null).length === 0);
  expect(
    'F) parse: sem phoneNumberId nem fallback → []',
    parseEchoMessages({ message_echoes: [{ to: 'X', id: 'i', type: 'text' }] }).length === 0
  );
  expect(
    'F) parse: usa fallback phoneNumberId',
    parseEchoMessages(
      { message_echoes: [{ to: 'X', id: 'i', type: 'text', text: { body: 'a' } }] },
      'FB'
    )[0]?.phoneNumberId === 'FB'
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    console.error('❌ FALHOU:', failed.map((c) => c.name).join(' | '));
    process.exit(1);
  }
  console.log('✅ smoke-listen-while-paused OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ erro inesperado no smoke:', e);
  process.exit(1);
});
