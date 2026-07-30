import assert from 'node:assert/strict';

process.env.ERP_API_TOKEN = 'smoke-only-erp-token';

async function main(): Promise<void> {
  const {
    BoundedLruSet,
    MAX_AUTHORITATIVELY_REJECTED_CONFIGS,
  } = await import('../src/configProvider');

  const small = new BoundedLruSet<string>(3);
  small.add('a').add('b').add('c');
  assert.equal(small.size, 3);

  // A leitura renova "a"; ao inserir "d", "b" é a rejeição menos recente.
  assert.equal(small.has('a'), true);
  small.add('d');
  assert.equal(small.size, 3);
  assert.equal(small.has('a'), true);
  assert.equal(small.has('b'), false);
  assert.equal(small.has('c'), true);
  assert.equal(small.has('d'), true);

  // Uma resposta 2xx continua destravando a chave por delete.
  assert.equal(small.delete('d'), true);
  assert.equal(small.has('d'), false);

  const productionSized = new BoundedLruSet<string>(
    MAX_AUTHORITATIVELY_REJECTED_CONFIGS
  );
  for (
    let index = 0;
    index < MAX_AUTHORITATIVELY_REJECTED_CONFIGS + 25;
    index++
  ) {
    productionSized.add(`phone-${index}`);
  }

  assert.equal(
    productionSized.size,
    MAX_AUTHORITATIVELY_REJECTED_CONFIGS
  );
  assert.equal(productionSized.has('phone-0'), false);
  assert.equal(
    productionSized.has(
      `phone-${MAX_AUTHORITATIVELY_REJECTED_CONFIGS + 24}`
    ),
    true
  );

  console.log(
    `✅ smoke config rejection cache: LRU limitado a ${MAX_AUTHORITATIVELY_REJECTED_CONFIGS} entradas`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
