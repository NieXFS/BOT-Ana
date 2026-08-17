process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

const assert = require('node:assert/strict') as typeof import('node:assert/strict');
const { assertElicitorMatcherContract } =
  require('../src/services/elicitorMatcher/contract') as typeof import('../src/services/elicitorMatcher/contract');
const {
  extractQuotedElicitorAnswers,
  salesElicitorMatcherContractRows,
} = require('../src/services/salesElicitorMatcherContract') as typeof import('../src/services/salesElicitorMatcherContract');
const { EMAIL_CONFIRMATION_REQUIRED_HINT } =
  require('../src/services/salesGuards') as typeof import('../src/services/salesGuards');
const { HANDOFF_TO_HUMAN_DESCRIPTION, SALES_TOOLS } =
  require('../src/services/salesBrain') as typeof import('../src/services/salesBrain');

const rows = salesElicitorMatcherContractRows();
assert.equal(rows.length, 2, 'contrato sales começa com duas linhas');

const emailRow = rows.find(
  (row) => row.nome === 'confirmação de e-mail × email_confirmation_required'
);
const handoffRow = rows.find(
  (row) => row.nome === 'pedido de humano × handoffToHuman'
);
assert.ok(emailRow, 'linha de confirmação de e-mail');
assert.ok(handoffRow, 'linha de pedido de humano');

assert.equal(
  emailRow.elicitor,
  EMAIL_CONFIRMATION_REQUIRED_HINT,
  'elicitor de e-mail é o hint importado da fonte, não uma cópia colada'
);
assert.equal(
  handoffRow.elicitor,
  SALES_TOOLS.find((tool) => tool.name === 'handoffToHuman')?.description,
  'elicitor de handoff é a descrição viva de handoffToHuman'
);
assert.equal(handoffRow.elicitor, HANDOFF_TO_HUMAN_DESCRIPTION);
assert.equal(handoffRow.respostasNaturaisAutorizam, false);

assert.deepEqual(
  extractQuotedElicitorAnswers(
    'ensine “Certo” e "Tá certinho" na mesma frase'
  ),
  ['Certo', 'Tá certinho']
);

assertElicitorMatcherContract(rows);
console.log('  ✓ linha de e-mail passa nas quatro classes');
console.log('  ✓ linha de handoff documenta a lacuna sem alargar o matcher');
console.log('\n✅ smoke-sales-elicitor-matcher-contract OK');
