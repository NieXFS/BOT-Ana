/**
 * Bateria adversarial INDEPENDENTE do lote de conversão da Renata.
 *
 * Escrita pelo orquestrador, não pelo executor, de propósito: em 3 rodadas na
 * noite de 2026-08-16 o smoke escrito pelo próprio executor passou 100% em cima
 * de código defeituoso — quem escreve o código e quem escreve o teste dele
 * compartilham o mesmo ponto cego.
 *
 * Cada caso aqui corresponde a um defeito REAL observado, não a hipótese.
 */
const REPO = process.env.RENATA_REPO ?? `${__dirname}/..`;
const G = require(`${REPO}/src/services/salesGuards`);

type Msg = { role: 'user' | 'assistant'; content: string };
const h = (role: 'user' | 'assistant', content: string): Msg => ({ role, content });

let falhas = 0;
function deve(nome: string, ok: boolean, obs = ''): void {
  if (!ok) falhas += 1;
  console.log(`  ${ok ? 'OK  ' : 'FALHA'} | ${nome.padEnd(56)} ${obs}`);
}
const plano = (hist: Msg[]): string | null =>
  G.resolveSalesCommercialDecision(hist)?.plan ?? null;
const decisao = (hist: Msg[]) => G.resolveSalesCommercialDecision(hist);

console.log('\n--- POLARIDADE: escolha, recusa, pergunta, exploração ---');
deve(
  'compara e depois escolhe => essencial',
  plano([h('user', 'qual a diferença do Pro e do Essencial?'), h('user', 'quero o Essencial')]) === 'essencial'
);
deve(
  '"quero o Pro, não o Essencial" => pro',
  plano([h('user', 'quero o Pro, não o Essencial')]) === 'pro'
);
deve(
  'GRAVE: "não quero o Pro" NÃO resolve para pro',
  plano([h('user', 'quero o Essencial'), h('user', 'não quero o Pro')]) === 'essencial',
  '(mandaria o link do plano recusado)'
);
deve(
  'exploração não sobrescreve escolha',
  plano([h('user', 'quero o Essencial'), h('user', 'também olhei o Pro')]) === 'essencial'
);
deve(
  'pergunta não é escolha',
  plano([h('user', 'quero o Essencial'), h('user', 'o Pro tem prontuário?')]) === 'essencial'
);
deve(
  'recusar o plano vigente limpa a decisão',
  plano([h('user', 'quero o Essencial'), h('user', 'não quero mais o Essencial')]) !== 'essencial'
);

console.log('\n--- FAIL-CLOSED: comparação sem vencedor ---');
deve('só comparação => null', plano([h('user', 'quero o Pro ou o Essencial?')]) === null);
deve('dois planos na mesma fala => null', plano([h('user', 'me explica Pro e Essencial')]) === null);
deve(
  'comparação preserva escolha anterior',
  plano([h('user', 'quero o Essencial'), h('user', 'me explica Pro e Essencial')]) === 'essencial'
);

console.log('\n--- MODALIDADE versionada junto do plano ---');
deve(
  'Anual => track fidelidade',
  decisao([h('user', 'quero o Essencial Anual')])?.track === 'fidelidade'
);
deve(
  'ambíguo ("anual à vista") => null, não chuta',
  decisao([h('user', 'Quero o Essencial anual a vista')]) === null
);
deve(
  'responde "Mensal" depois => resolve essencial+flexivel',
  (() => {
    const d = decisao([
      h('user', 'Quero o Essencial anual a vista'),
      h('assistant', 'Você prefere Mensal ou Anual?'),
      h('user', 'Mensal'),
    ]);
    return d?.plan === 'essencial' && d?.track === 'flexivel';
  })()
);
deve(
  'explica trilha aposentada e "Mensal" => essencial+flexivel',
  (() => {
    const d = decisao([
      h('user', 'quero o Essencial anual a vista'),
      h(
        'assistant',
        'O anual a vista foi aposentado. Voce prefere Mensal ou Anual?'
      ),
      h('user', 'Mensal'),
    ]);
    return d?.plan === 'essencial' && d?.track === 'flexivel';
  })()
);
deve(
  'explica trilha aposentada e "Anual" => essencial+fidelidade',
  (() => {
    const d = decisao([
      h('user', 'quero o Essencial anual a vista'),
      h(
        'assistant',
        'O anual a vista foi aposentado. Voce prefere Mensal ou Anual?'
      ),
      h('user', 'Anual'),
    ]);
    return d?.plan === 'essencial' && d?.track === 'fidelidade';
  })()
);
deve(
  'explica trilha aposentada e "Prefiro ver depois" => null',
  decisao([
    h('user', 'quero o Essencial anual a vista'),
    h(
      'assistant',
      'O anual a vista foi aposentado. Voce prefere Mensal ou Anual?'
    ),
    h('user', 'Prefiro ver depois'),
  ]) === null
);
deve(
  'explica trilha aposentada e "os dois" => null',
  decisao([
    h('user', 'quero o Essencial anual a vista'),
    h(
      'assistant',
      'O anual a vista foi aposentado. Voce prefere Mensal ou Anual?'
    ),
    h('user', 'os dois'),
  ]) === null
);

console.log('\n--- GATE DE E-MAIL: não pode ter regredido ---');
const EMAIL = 'cristina@gmail.com';
const ASK = h('assistant', `Só confirma pra mim: ${EMAIL}, certo?`);
const confirma = (t: string): boolean =>
  G.hasConfirmedSalesEmail(EMAIL, [h('user', EMAIL), ASK, h('user', t)]);
for (const w of ['Certo', 'Ta certinho', 'Sim pode.', 'pode mandar', 'correto', 'beleza', 'fechado', 'tudo certo', '👍']) {
  deve(`"${w}" confirma`, confirma(w));
}
for (const w of ['não tá certo', 'não está correto', 'certo, mas esse e-mail está errado']) {
  deve(`"${w}" NÃO confirma`, !confirma(w));
}
deve('"pode deixar pra depois" não confirma', !confirma('pode deixar pra depois'));
deve('"pode me ligar?" não confirma', !confirma('pode me ligar?'));
deve(
  'ask frouxo (pergunta sobre outra coisa) não confirma',
  !G.hasConfirmedSalesEmail('joana@gmial.com', [
    h('assistant', 'Anotei joana@gmial.com. Você atende sozinha, certo?'),
    h('user', 'Certo'),
  ])
);
deve(
  'primeiro inbound com e-mail + pedido de link não confirma',
  !G.hasConfirmedSalesEmail(EMAIL, [h('user', `meu e-mail é ${EMAIL}, pode mandar o link`)])
);

console.log(falhas ? `\n>>> ${falhas} FALHA(S)\n` : '\n>>> TODOS OS CASOS PASSARAM\n');
if (falhas) process.exit(1);
