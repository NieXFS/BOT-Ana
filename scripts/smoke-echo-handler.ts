/**
 * Smoke DETERMINÍSTICO do parser/handler de smb_message_echoes (Coexistence).
 * Sem rede: a chamada de pausa é injetada (deps). Prova que, dado um payload de
 * smb_message_echoes conforme a doc da Meta (value.metadata.phone_number_id +
 * value.message_echoes[] com `to` = cliente), o parser extrai phoneNumberId +
 * cliente e o handler dispara a pausa; payload malformado = noop.
 *
 * NODE_ENV=development ANTES do import: erpApiToken (transitivo via pauseService)
 * não lança em dev; nunca fazemos chamada real (deps mockadas / parser puro).
 *
 * Rodar: npx tsx scripts/smoke-echo-handler.ts
 */
process.env.NODE_ENV = 'development';

const checks: { name: string; ok: boolean }[] = [];
function expect(name: string, cond: boolean) {
  checks.push({ name, ok: cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
}

async function main() {
  const { parseEchoTargets, handleSmbMessageEchoes, isEchoChange } = await import(
    '../src/echoHandler'
  );

  // isEchoChange
  expect('isEchoChange("smb_message_echoes") = true', isEchoChange('smb_message_echoes') === true);
  expect('isEchoChange("messages") = false', isEchoChange('messages') === false);
  expect('isEchoChange(undefined) = false', isEchoChange(undefined) === false);

  // Payload conforme a doc da Meta: customer = `to`.
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511000000000', phone_number_id: 'PNID_123' },
    message_echoes: [
      { from: '5511BIZ', to: '5511CUST1', id: 'wamid.1', timestamp: '1', type: 'text', text: { body: 'oi' } },
    ],
  };

  const t1 = parseEchoTargets(value);
  expect('parse: 1 alvo', t1.length === 1);
  expect('parse: phoneNumberId vem do metadata', t1[0]?.phoneNumberId === 'PNID_123');
  expect('parse: customerPhone = campo `to`', t1[0]?.customerPhone === '5511CUST1');

  // Dois clientes distintos.
  const value2 = {
    metadata: { phone_number_id: 'PNID_123' },
    message_echoes: [
      { to: 'CUST_A', type: 'text' },
      { to: 'CUST_B', type: 'image' },
    ],
  };
  expect('parse: 2 clientes distintos = 2 alvos', parseEchoTargets(value2).length === 2);

  // Dedup do mesmo cliente no mesmo payload.
  const valueDup = {
    metadata: { phone_number_id: 'PNID_123' },
    message_echoes: [
      { to: 'CUST_A', type: 'text' },
      { to: 'CUST_A', type: 'text' },
    ],
  };
  expect('parse: dedup do mesmo cliente → 1', parseEchoTargets(valueDup).length === 1);

  // Fallback do phoneNumberId.
  const valueNoMeta = { message_echoes: [{ to: 'CUST_X', type: 'text' }] };
  expect('parse: usa fallback phoneNumberId', parseEchoTargets(valueNoMeta, 'FALLBACK_PNID')[0]?.phoneNumberId === 'FALLBACK_PNID');
  expect('parse: sem phoneNumberId nem fallback → []', parseEchoTargets(valueNoMeta).length === 0);

  // Echo sem `to` (ou vazio) é ignorado.
  const valueNoTo = {
    metadata: { phone_number_id: 'PNID_123' },
    message_echoes: [{ type: 'text' }, { to: '   ' }, { to: 'CUST_OK', type: 'text' }],
  };
  const tNoTo = parseEchoTargets(valueNoTo);
  expect('parse: echo sem `to`/vazio ignorado, sobra 1', tNoTo.length === 1 && tNoTo[0]?.customerPhone === 'CUST_OK');

  // Malformados.
  expect('parse: null → []', parseEchoTargets(null).length === 0);
  expect('parse: string → []', parseEchoTargets('x').length === 0);
  expect('parse: message_echoes ausente → []', parseEchoTargets({ metadata: { phone_number_id: 'PNID_123' } }).length === 0);

  // Handler dispara a pausa (deps mockadas).
  const calls: { phoneNumberId: string; customerPhone: string }[] = [];
  const mockDeps = {
    pauseConversation: async (phoneNumberId: string, customerPhone: string) => {
      calls.push({ phoneNumberId, customerPhone });
    },
  };
  await handleSmbMessageEchoes(value, undefined, mockDeps);
  expect('handler: 1 chamada de pausa', calls.length === 1);
  expect('handler: args corretos (phoneNumberId + cliente)', calls[0]?.phoneNumberId === 'PNID_123' && calls[0]?.customerPhone === '5511CUST1');

  // Handler com payload malformado = noop.
  calls.length = 0;
  await handleSmbMessageEchoes({ foo: 'bar' }, undefined, mockDeps);
  expect('handler: payload malformado = noop', calls.length === 0);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passaram.`);
  if (failed.length > 0) {
    console.error('❌ FALHOU:', failed.map((c) => c.name).join(' | '));
    process.exit(1);
  }
  console.log('✅ smoke-echo-handler OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ erro inesperado no smoke:', e);
  process.exit(1);
});
