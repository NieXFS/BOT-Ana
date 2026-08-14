import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.ERP_API_TOKEN = 'smoke-invalid';

async function main(): Promise<void> {
  const { isOptOutMessage } = await import('../src/services/optOutService');

  for (const message of [
    'e para hoje?',
    'para amanhã?',
    'quero cancelar',
    'posso sair mais cedo?',
    'pode remover o horário?',
  ]) {
    assert.equal(
      isOptOutMessage(message),
      false,
      `não deve executar opt-out: ${message}`
    );
  }

  for (const message of [
    'pare',
    'stop',
    'PARA',
    'me descadastra',
    'não quero mais receber mensagens',
  ]) {
    assert.equal(
      isOptOutMessage(message),
      true,
      `deve executar opt-out: ${message}`
    );
  }

  assert.equal(
    isOptOutMessage('quero cancelar as mensagens'),
    true,
    'verbo ambíguo com contexto explícito de comunicação continua sendo opt-out'
  );
  assert.equal(
    isOptOutMessage('pare?'),
    false,
    'keyword em pergunta não executa opt-out'
  );
  assert.equal(
    isOptOutMessage('não quero mais receber mensagens?'),
    true,
    'frase explícita permanece soberana à guarda interrogativa'
  );

  console.log('smoke opt-out: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
