/** Smoke PURO da atribuição por texto de parceira — sem rede, DB ou LLM. */
import { matchPartnerMention } from '../src/services/salesOpeners';

let failures = 0;

function check(
  label: string,
  input: string,
  expected: string | null
): void {
  const actual = matchPartnerMention(input);
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    return;
  }

  console.error(
    `  ✗ ${label}: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`
  );
  failures += 1;
}

check(
  'CTA canônico',
  'Oi! Vim pela @fulana e quero ver como a Receps atenderia as clientes da minha clínica.',
  'fulana'
);
check('vim pelo sem arroba', 'VIM PELO fulano.', 'fulano');
check('venho pela', 'Oi, venho pela @fulana.sp!', 'fulana.sp');
check('venho pelo sem arroba', 'Venho pelo fulano_01', 'fulano_01');
check('vim através da', 'Eu vim através da @fulana.', 'fulana');
check('vim atraves do', 'Vim atraves do fulano', 'fulano');
check(
  'vim pelo perfil da com pontuação',
  'Oi! Vim, pelo perfil da: @fulana; quero conhecer.',
  'fulana'
);
check('indicação da', 'Foi indicação da @fulana.', 'fulana');
check('indicacao do sem arroba', 'Cheguei por indicacao do fulano.', 'fulano');
check('a parceira indicou', 'A @fulana indicou a Receps.', 'fulana');
check('a parceira indicou sem arroba', 'A fulana indicou vocês.', 'fulana');

check(
  'negativo: frase sem indicador de origem',
  'Oi! Quero ver como a Receps atenderia as clientes da minha clínica.',
  null
);
check('negativo: slug com maiúscula', 'Vim pela @Fulana', null);
check('negativo: slug com acento', 'Vim pela @fulána', null);
check('negativo: slug com hífen', 'Vim pela @fulana-sp', null);
check('negativo: slug com 1 char', 'Vim pela @f', null);
check('negativo: slug com 31 chars', `Vim pela @${'a'.repeat(31)}`, null);
check('negativo: payload HTML', 'Vim pela @<script>', null);
check('negativo: string vazia', '', null);
check('negativo: só fala vim', 'vim', null);

if (failures > 0) {
  process.exit(1);
}

console.log('\n✅ smoke-renata-partner-mention OK');
