process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import assert from 'node:assert/strict';
import {
  authorizeSalesToolCall,
  buildDeterministicSalesGuardReply,
  buildSafeSalesRecoveryReply,
  classifyEmailConfirmationReply,
  countActionableSalesQuestions,
  ensureSalesSignupUrlInReply,
  hasConfirmedSalesEmail,
  hasSalesSignupUrl,
  inspectSalesReplyActionClaims,
  isDedicatedEmailConfirmationProposal,
  isThinkingOnlyResponse,
  normalizeSalesReplyStyle,
  resolveRequiredCommonSignup,
  resolveConfirmedSalesPrefill,
  resolveSalesCommercialDecision,
  requiresImmediateTerminalHandoff,
  salesToolSucceeded,
  type SalesToolTraceLike,
} from '../src/services/salesGuards';

const ok = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  result: JSON.stringify({ success: true, ...extra }),
});
const fail = (name: string) => ({
  name,
  result: JSON.stringify({ success: false }),
});

console.log('▶ confirmação de e-mail');
const confirmedHistory = [
  {
    role: 'assistant',
    content: 'Só confirma pra mim: maria@clinica.com.br, certo?',
  },
  { role: 'user', content: 'Sim, maria@clinica.com.br está certo.' },
];
assert.equal(
  hasConfirmedSalesEmail('maria@clinica.com.br', confirmedHistory),
  true
);
assert.equal(
  authorizeSalesToolCall({
    toolName: 'sendPrefilledSignup',
    toolInput: { email: 'maria@clinica.com.br' },
    history: confirmedHistory,
  }).ok,
  true
);
console.log('  ✓ proposta + confirmação posterior libera');

assert.equal(
  hasConfirmedSalesEmail('maria@clinica.com.br', [
    { role: 'assistant', content: 'Só confirma esse e-mail certinho.' },
    {
      role: 'user',
      content: 'Sim, maria@clinica.com.br está certo. Pode mandar.',
    },
  ]),
  true
);
console.log('  ✓ repetição exata e explícita pela lead é autoritativa');

assert.equal(
  hasConfirmedSalesEmail('maria@clinica.com.br', [
    {
      role: 'assistant',
      content: 'É *maria@clinica.com.br*, certinho?',
    },
    { role: 'user', content: 'Sim, maria@clinica.com.br está certo.' },
  ]),
  true
);
console.log('  ✓ linguagem natural "certinho" também libera');

const incidentEmail = 'joana@lecs.example.com';
const dedicatedEmailProposal = [
  {
    role: 'assistant',
    content: `Só confirma pra mim: ${incidentEmail}, certo?`,
  },
];
for (const response of [
  'Certo',
  'Certo',
  'Ta certinho',
  'Uai De novo? Já confirmei',
  'Sim pode.',
]) {
  assert.equal(classifyEmailConfirmationReply(response, incidentEmail), true);
  assert.equal(
    hasConfirmedSalesEmail(incidentEmail, [
      ...dedicatedEmailProposal,
      { role: 'user', content: response },
    ]),
    true
  );
}
console.log('  ✓ transcrito de 16/08 libera as cinco confirmações naturais');

const confirmationWithAdjacentFact =
  'certo, mas o nome da clínica é Studio Lia';
assert.equal(
  classifyEmailConfirmationReply(confirmationWithAdjacentFact, incidentEmail),
  true
);
assert.equal(
  hasConfirmedSalesEmail(incidentEmail, [
    ...dedicatedEmailProposal,
    { role: 'user', content: confirmationWithAdjacentFact },
  ]),
  true
);
for (const correction of [
  'certo, mas esse e-mail está errado',
  'certo, mas o e-mail certo é outro@lecs.example.com',
]) {
  assert.equal(classifyEmailConfirmationReply(correction, incidentEmail), false);
  assert.equal(
    hasConfirmedSalesEmail(incidentEmail, [
      ...dedicatedEmailProposal,
      { role: 'user', content: correction },
    ]),
    false
  );
}
console.log(
  '  ✓ confirmação antes de fato adjacente libera sem mascarar correção de e-mail'
);

for (const response of [
  'Sim',
  'sim',
  'isso',
  'ok',
  'confirmo',
  'isso mesmo',
  'perfeito',
  'aham',
  '👍',
  '👌🏽',
  '🆗',
  'tudo certo',
  'correto',
  'beleza',
  'blz',
  'show',
  'fechado',
  'combinado',
  'tá bom',
  'pode sim',
  'não, tá certo',
]) {
  assert.equal(
    hasConfirmedSalesEmail(incidentEmail, [
      ...dedicatedEmailProposal,
      { role: 'user', content: response },
    ]),
    true
  );
}
for (const response of [
  'incerto',
  'showroom',
  'pode',
  '👍🏽 pode me ligar?',
  'não tá certo',
  'não está tudo certo',
  `${incidentEmail} não está correto`,
]) {
  assert.equal(classifyEmailConfirmationReply(response, incidentEmail), false);
}
assert.equal(
  hasConfirmedSalesEmail(incidentEmail, [
    { role: 'user', content: `${incidentEmail} não está correto` },
  ]),
  false
);
assert.equal(
  hasConfirmedSalesEmail(incidentEmail, [
    { role: 'user', content: `Meu e-mail é ${incidentEmail}, tá certinho.` },
  ]),
  true
);
console.log('  ✓ vocabulário de confirmação anterior permanece liberado');

assert.equal(
  isDedicatedEmailConfirmationProposal(
    `Anotei ${incidentEmail}. Você atende sozinha, certo?`,
    incidentEmail
  ),
  false
);
assert.equal(
  isDedicatedEmailConfirmationProposal(
    `Confirma ${incidentEmail}? Qual é o nome da clínica?`,
    incidentEmail
  ),
  false
);
assert.equal(
  hasConfirmedSalesEmail(incidentEmail, [
    {
      role: 'assistant',
      content: `Anotei ${incidentEmail}. Você atende sozinha, certo?`,
    },
    { role: 'user', content: 'Certo' },
  ]),
  false
);
console.log('  ✓ pergunta frouxa sobre outro assunto não licencia "Certo"');

assert.equal(
  isDedicatedEmailConfirmationProposal(
    'Não é a@x.com, é b@y.com, certo?',
    'b@y.com'
  ),
  false
);
assert.equal(
  hasConfirmedSalesEmail('b@y.com', [
    { role: 'assistant', content: 'Não é a@x.com, é b@y.com, certo?' },
    { role: 'user', content: 'Certo' },
  ]),
  false
);
assert.equal(
  hasConfirmedSalesEmail('a@x.com', [
    { role: 'assistant', content: 'Não é a@x.com, é b@y.com, certo?' },
    { role: 'user', content: 'Certo' },
  ]),
  false
);
console.log('  ✓ proposta com dois endereços não é dedicada');

const ambiguousOneTurnEmails = [
  {
    role: 'user',
    content:
      'Sim, primeiro@lecs.example.com está certo; segundo@lecs.example.com também.',
  },
];
assert.equal(
  hasConfirmedSalesEmail(
    'primeiro@lecs.example.com',
    ambiguousOneTurnEmails
  ),
  false
);
assert.equal(
  hasConfirmedSalesEmail(
    'segundo@lecs.example.com',
    ambiguousOneTurnEmails
  ),
  false
);
console.log('  ✓ fallback de um turno não autoriza mensagem com dois endereços');

const correctionAfterConfirmation = [
  ...dedicatedEmailProposal,
  { role: 'user', content: 'Certo' },
  { role: 'user', content: 'Espera, o e-mail tá errado.' },
];
assert.equal(
  classifyEmailConfirmationReply(
    'Espera, o e-mail tá errado.',
    incidentEmail
  ),
  false
);
assert.equal(
  hasConfirmedSalesEmail(incidentEmail, correctionAfterConfirmation),
  false
);
for (const correction of [
  'O e-mail não confere.',
  'Troquei o e-mail.',
  'Mudou o e-mail.',
]) {
  assert.equal(classifyEmailConfirmationReply(correction, incidentEmail), false);
  assert.equal(
    hasConfirmedSalesEmail(incidentEmail, [
      ...dedicatedEmailProposal,
      { role: 'user', content: 'Certo' },
      { role: 'user', content: correction },
    ]),
    false
  );
}
console.log('  ✓ correção posterior sem novo endereço invalida a confirmação');

for (const response of ['pode deixar pra depois', 'pode me ligar?']) {
  assert.equal(classifyEmailConfirmationReply(response, incidentEmail), false);
  assert.equal(
    hasConfirmedSalesEmail(incidentEmail, [
      ...dedicatedEmailProposal,
      { role: 'user', content: response },
    ]),
    false
  );
}
console.log('  ✓ "pode" não libera pedidos de prazo ou ligação');

const firstTurnOnly = [
  {
    role: 'user',
    content: 'Meu e-mail é maria@clinica.com.br, pode mandar o link.',
  },
];
const firstTurnDecision = authorizeSalesToolCall({
  toolName: 'sendPrefilledSignup',
  toolInput: { email: 'maria@clinica.com.br' },
  history: firstTurnOnly,
});
assert.equal(firstTurnDecision.ok, false);
assert.match(
  firstTurnDecision.ok ? '' : firstTurnDecision.hintMessage,
  /^INTERNAL_HINT:/
);
console.log('  ✓ e-mail informado no mesmo turno não libera');

const correctedWithoutConfirmation = [
  ...confirmedHistory.slice(0, 1),
  {
    role: 'user',
    content: 'Não, corrige: o certo é contato@clinica.com.br.',
  },
];
assert.equal(
  hasConfirmedSalesEmail(
    'contato@clinica.com.br',
    correctedWithoutConfirmation
  ),
  false
);
assert.equal(
  hasConfirmedSalesEmail('maria@clinica.com.br', correctedWithoutConfirmation),
  false
);
console.log('  ✓ correção invalida o e-mail anterior e exige nova confirmação');

const persistedConfirmation = [
  ...confirmedHistory,
  { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
  { role: 'user', content: 'Mensal.' },
];
assert.equal(
  hasConfirmedSalesEmail('maria@clinica.com.br', persistedConfirmation),
  true
);
assert.equal(
  authorizeSalesToolCall({
    toolName: 'handoffToHuman',
    toolInput: {},
    history: [],
  }).ok,
  true
);
console.log('  ✓ confirmação sobrevive a turnos posteriores sem correção');

console.log('▶ recuperação terminal do cadastro');
const confirmedPurchaseForTerminal = [
  {
    role: 'user',
    content:
      'Quero o Essencial. Sou Luiza, da Clínica Pele. Meu e-mail é luiza@clinicapela.com.br.',
  },
  {
    role: 'user',
    content: 'Sim, luiza@clinicapela.com.br está certo. Pode gerar agora.',
  },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Vou gerar o cadastro agora.',
    [],
    confirmedPurchaseForTerminal
  ).reasons.includes('required_prefill_missing'),
  true
);
const partialSignupRecovery = inspectSalesReplyActionClaims(
  'Prontinho! Te mandei o link do cadastro.',
  [fail('sendPrefilledSignup'), ok('sendSignupLink')],
  confirmedPurchaseForTerminal
);
assert.equal(
  partialSignupRecovery.reasons.includes('terminal_signup_delivery_failed'),
  false
);
assert.equal(requiresImmediateTerminalHandoff(partialSignupRecovery.reasons), false);
const doubleSignupFailure = inspectSalesReplyActionClaims(
  'Os links falharam, vou tentar de novo.',
  [fail('sendPrefilledSignup'), fail('sendSignupLink')],
  confirmedPurchaseForTerminal
);
assert.equal(
  doubleSignupFailure.reasons.includes('terminal_signup_delivery_failed'),
  true
);
assert.equal(requiresImmediateTerminalHandoff(doubleSignupFailure.reasons), true);
console.log('  ✓ sucesso parcial preserva a entrega; falha dupla exige handoff por código');

console.log('▶ link comum após recusa de e-mail');
const commonSignupAfterEmailRefusal = [
  {
    role: 'user',
    content:
      'Quero assinar o Essencial para o Espaço Bela, com duas profissionais.',
  },
  {
    role: 'user',
    content: 'Não quero passar e-mail agora. Manda o link normal mesmo.',
  },
];
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Perfeito, vou preparar seu cadastro.',
    [],
    commonSignupAfterEmailRefusal
  ).reasons,
  ['required_common_signup_missing']
);
assert.deepEqual(resolveRequiredCommonSignup(commonSignupAfterEmailRefusal), {
  plan: 'essencial',
});
const failedRequiredCommonLink = inspectSalesReplyActionClaims(
  'O link falhou, vou tentar de novo.',
  [fail('sendSignupLink')],
  commonSignupAfterEmailRefusal
);
assert.equal(
  failedRequiredCommonLink.reasons.includes('terminal_signup_delivery_failed'),
  true
);
assert.equal(
  requiresImmediateTerminalHandoff(failedRequiredCommonLink.reasons),
  true
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Tudo certo.',
    [ok('sendSignupLink')],
    commonSignupAfterEmailRefusal
  ).reasons.includes('terminal_signup_delivery_failed'),
  false
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Tudo certo.',
    [fail('sendSignupLink'), ok('handoffToHuman')],
    commonSignupAfterEmailRefusal
  ).reasons.includes('terminal_signup_delivery_failed'),
  false
);
const noCommonSignupForCuriosity = [
  { role: 'user', content: 'Não quero passar e-mail agora.' },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Sem problema, podemos conversar por aqui.',
    [],
    noCommonSignupForCuriosity
  ).reasons.includes('required_common_signup_missing'),
  false
);
const noCommonSignupForMultiplePlans = [
  {
    role: 'user',
    content:
      'Não quero passar e-mail. Manda o link normal do Essencial ou do Pro?',
  },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Qual dos dois planos você prefere?',
    [],
    noCommonSignupForMultiplePlans
  ).reasons.includes('required_common_signup_missing'),
  false
);
console.log('  ✓ exige plano único + recusa explícita + pedido de link, escala falha sem entrega e não libera prefill');

console.log('▶ coerência promessa ↔ tool');
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Pronto, já acionei o Victor pra falar com você.',
    []
  ).reasons,
  ['handoff_without_success']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Pronto, já acionei o Victor pra falar com você.',
    [ok('handoffToHuman')]
  ).safe,
  true
);
assert.equal(
  inspectSalesReplyActionClaims('Posso chamar o Victor pra você?', []).safe,
  true
);
console.log('  ✓ handoff afirmado exige success:true; oferta não é ato');

const discountHistory = [
  { role: 'user', content: 'Se fizer o Pro por 180 reais eu fecho hoje.' },
];
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'O preço é fixo, mas posso chamar o Victor se quiser.',
    [],
    discountHistory
  ).reasons,
  ['required_handoff_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Pronto, já acionei o Victor.',
    [ok('handoffToHuman')],
    discountHistory
  ).safe,
  true
);
console.log('  ✓ negociação exige handoff executado, não mera oferta');

const chosenDemoHistory = [
  {
    role: 'assistant',
    content: 'Tenho a demonstração amanhã às 10h30 ou às 15h. Qual fica melhor?',
  },
  { role: 'user', content: 'Pode ser às 15:00.' },
];
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Perfeito, e qual é o nome da clínica?',
    [],
    chosenDemoHistory
  ).reasons,
  ['required_schedule_demo_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Pronto, sua demonstração foi agendada.',
    [ok('scheduleDemo')],
    chosenDemoHistory
  ).safe,
  true
);
console.log('  ✓ horário oferecido e escolhido exige scheduleDemo');

const confirmedPurchaseHistory = [
  {
    role: 'user',
    content: 'Quero contratar o Essencial. Meu e-mail é maria@clinica.com.br.',
  },
  {
    role: 'assistant',
    content: 'Só confirma: maria@clinica.com.br, certo?',
  },
  {
    role: 'user',
    content: 'Sim, maria@clinica.com.br está certo. Pode mandar.',
  },
];
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Perfeito, só um instante.',
    [],
    confirmedPurchaseHistory
  ).reasons,
  ['required_prefill_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Poxa, o prefill falhou; vou te mandar o cadastro normal.',
    [fail('sendPrefilledSignup')],
    confirmedPurchaseHistory
  ).safe,
  true
);
console.log('  ✓ compra com e-mail confirmado exige tentativa real de prefill');

const videoHistory = [
  { role: 'user', content: 'Prefiro assistir ao vídeo curto, pode mandar?' },
];
assert.deepEqual(
  inspectSalesReplyActionClaims('Aqui vai o vídeo.', [], videoHistory).reasons,
  ['required_demo_video_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Te mandei o vídeo da Ana.',
    [ok('sendDemoVideo')],
    videoHistory
  ).safe,
  true
);
console.log('  ✓ pedido explícito de vídeo exige sendDemoVideo');

assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Como você organiza a clínica hoje?',
    [],
    [{ role: 'user', content: 'Como fica a LGPD dos dados das clientes?' }]
  ).reasons,
  ['required_lgpd_answer_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'A Receps trata os dados seguindo a LGPD e a política de privacidade.',
    [],
    [{ role: 'user', content: 'Como fica a LGPD dos dados das clientes?' }]
  ).safe,
  true
);
console.log('  ✓ pergunta LGPD é respondida no mesmo turno');

assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Primeiro me conta como você se organiza hoje.',
    [],
    [{ role: 'user', content: 'Quero ver a Ana funcionando antes de decidir.' }]
  ).reasons,
  ['required_simulation_offer_missing']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Quer ver a Ana? Finge que você é uma cliente sua e pede um horário.',
    [],
    [{ role: 'user', content: 'Quero ver a Ana funcionando antes de decidir.' }]
  ).safe,
  true
);
console.log('  ✓ pedido de prova recebe simulação imediatamente');

assert.equal(
  inspectSalesReplyActionClaims(
    'Te mandei o link aqui embaixo.',
    [fail('sendSignupLink')]
  ).safe,
  false
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Te mandei o link aqui embaixo.',
    [
      {
        name: 'sendSignupLink',
        result: JSON.stringify({ success: false, waitlistHref: 'https://wa.me/x' }),
      },
    ]
  ).safe,
  false
);
assert.equal(
  inspectSalesReplyActionClaims(
    'O link já vem com seus dados, você só cria a senha.',
    [ok('sendSignupLink', { url: 'https://receps.com.br/cadastro' })]
  ).reasons.includes('prefill_claim_without_success'),
  true
);
assert.equal(
  inspectSalesReplyActionClaims(
    'O link já vem com seus dados, você só cria a senha.',
    [ok('sendPrefilledSignup', { url: 'https://receps.com.br/cadastro' })]
  ).reasons.includes('signup_url_missing_from_reply'),
  true
);
assert.equal(
  inspectSalesReplyActionClaims(
    'O link da Fidelidade já vem com seus dados, você só cria a senha.',
    [
      ok('sendPrefilledSignup', {
        url: 'https://receps.com.br/cadastro?track=fidelidade',
        prefilled: false,
      }),
    ]
  ).reasons.includes('prefill_claim_without_success'),
  true
);
console.log('  ✓ link comum nunca licencia promessa de prefill');

const incidentTrace = [
  ok('sendPrefilledSignup', {
    url: 'https://receps.com.br/cadastro?pf=TOKEN_AUTORITATIVO',
    prefilled: true,
  }),
];
const incidentReply =
  'Te mandei o link aqui embaixo. Ele já vem com seus dados — é só criar a senha.';
assert.equal(
  inspectSalesReplyActionClaims(incidentReply, incidentTrace).reasons.includes(
    'signup_url_missing_from_reply'
  ),
  true
);
const closedIncidentReply = ensureSalesSignupUrlInReply(
  incidentReply,
  incidentTrace
);
assert.equal(hasSalesSignupUrl(closedIncidentReply), true);
assert.match(
  closedIncidentReply,
  /\n\nhttps:\/\/receps\.com\.br\/cadastro\?pf=TOKEN_AUTORITATIVO$/
);
assert.equal(
  inspectSalesReplyActionClaims(closedIncidentReply, incidentTrace).safe,
  true
);
assert.equal(
  ensureSalesSignupUrlInReply(
    'Aqui está: https://receps.com.br/cadastro?pf=TOKEN_ERRADO',
    incidentTrace
  ),
  'Aqui está:\n\nhttps://receps.com.br/cadastro?pf=TOKEN_AUTORITATIVO'
);
console.log('  ✓ URL autoritativa fecha o incidente de link anunciado e omitido');

assert.equal(
  inspectSalesReplyActionClaims(
    'Se você me passar o e-mail, o link já vem com seus dados e você só cria a senha.',
    []
  ).safe,
  true
);
assert.equal(
  inspectSalesReplyActionClaims(
    'O link já vem com seus dados e você só cria a senha.',
    [fail('sendPrefilledSignup')]
  ).reasons.includes('prefill_claim_without_success'),
  true
);
console.log('  ✓ benefício futuro não vira entrega; falha real continua protegida');

assert.equal(
  inspectSalesReplyActionClaims(
    'O Essencial custa R$ 159,99.',
    [],
    [],
    { priceAuthorityText: 'Essencial: R$ 159,99.' }
  ).safe,
  true
);
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'O plano custa R$ 99,90.',
    [],
    [{ role: 'user', content: 'Eu vi o valor de 99,99.' }],
    { priceAuthorityText: 'Plano pausado: R$ 99,99.' }
  ).reasons,
  ['unconfigured_price']
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Esse plano de R$ 99,99 está pausado e não aceita novas assinaturas.',
    [],
    [{ role: 'user', content: 'Quero só a Ana de 99,99.' }],
    { priceAuthorityText: 'Essencial: R$ 159,99.' }
  ).safe,
  true
);
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Esse plano de R$ 99,90 está pausado e não aceita novas assinaturas.',
    [],
    [{ role: 'user', content: 'Quero só a Ana de 99,99.' }],
    { priceAuthorityText: 'Essencial: R$ 159,99.' }
  ).reasons,
  ['unconfigured_price']
);
console.log('  ✓ preço citado em recusa é preservado; alteração ou invenção é bloqueada');

const correctedPrefill = resolveConfirmedSalesPrefill(
  confirmedPurchaseHistory
);
assert.deepEqual(correctedPrefill, {
  email: 'maria@clinica.com.br',
  plan: 'essencial',
  track: 'flexivel',
});
assert.deepEqual(
  resolveConfirmedSalesPrefill([
    {
      role: 'user',
      content:
        'Quero contratar o Essencial no Anual. Meu e-mail é maria@clinica.com.br.',
    },
    {
      role: 'assistant',
      content: 'Só confirma: maria@clinica.com.br, certo?',
    },
    {
      role: 'user',
      content: 'Sim, maria@clinica.com.br está certo. Pode mandar.',
    },
  ]),
  {
    email: 'maria@clinica.com.br',
    plan: 'essencial',
    track: 'fidelidade',
  }
);
assert.deepEqual(
  resolveConfirmedSalesPrefill([
    {
      role: 'user',
      content:
        'Quero contratar o Essencial na Fidelidade. Meu e-mail é maria@clinica.com.br.',
    },
    {
      role: 'assistant',
      content: 'Só confirma: maria@clinica.com.br, certo?',
    },
    {
      role: 'user',
      content: 'Sim, maria@clinica.com.br está certo. Pode mandar.',
    },
  ]),
  {
    email: 'maria@clinica.com.br',
    plan: 'essencial',
    track: 'fidelidade',
  }
);
assert.equal(
  resolveConfirmedSalesPrefill([
    {
      role: 'user',
      content:
        'Estou entre o Essencial Mensal e o Anual. Meu e-mail é maria@clinica.com.br.',
    },
    {
      role: 'assistant',
      content: 'Só confirma: maria@clinica.com.br, certo?',
    },
    {
      role: 'user',
      content: 'Sim, maria@clinica.com.br está certo.',
    },
  ]),
  null
);
assert.equal(
  resolveConfirmedSalesPrefill([
    {
      role: 'user',
      content:
        'Quero o Essencial anual à vista. Meu e-mail é maria@clinica.com.br.',
    },
    {
      role: 'assistant',
      content: 'Só confirma: maria@clinica.com.br, certo?',
    },
    {
      role: 'user',
      content: 'Sim, maria@clinica.com.br está certo.',
    },
  ]),
  null
);
assert.equal(
  resolveConfirmedSalesPrefill([
    ...confirmedPurchaseHistory,
    { role: 'user', content: 'Também olhei o Pro.' },
  ]),
  null
);
console.log('  ✓ airbag de prefill mapeia Mensal/Anual, aceita aliases antigos e falha fechado');

const pausedPlanHistory = [
  { role: 'user', content: 'Quero só a Ana de 99,99. Manda o link.' },
];
assert.deepEqual(
  inspectSalesReplyActionClaims(
    'Quer ver a Ana funcionando?',
    [],
    pausedPlanHistory
  ).reasons,
  ['required_paused_plan_explanation_missing']
);
assert.match(
  buildDeterministicSalesGuardReply(
    ['required_paused_plan_explanation_missing'],
    pausedPlanHistory
  ) ?? '',
  /atualização.*não aceita novas assinaturas/i
);
assert.equal(
  inspectSalesReplyActionClaims(
    'Só confirma pra mim: ana@studioluz.com, certo?',
    [],
    [
      {
        role: 'user',
        content:
          'Quero o Essencial. Sou Ana, do Studio Luz, e trabalho sozinha.',
      },
    ]
  ).reasons.includes('required_paused_plan_explanation_missing'),
  false
);
console.log('  ✓ plano pausado tem resposta terminal determinística sem preço');

for (const [reply, trace] of [
  ['Te mandei o vídeo da Ana.', []],
  ['Sua demonstração foi agendada.', []],
  ['INTERNAL_HINT: use a ferramenta.', []],
] as Array<[string, SalesToolTraceLike[]]>) {
  assert.equal(inspectSalesReplyActionClaims(reply, trace).safe, false);
}
assert.equal(
  inspectSalesReplyActionClaims(
    'Te mandei o vídeo da Ana.',
    [ok('sendDemoVideo')]
  ).safe,
  true
);
console.log('  ✓ vídeo, demo e hint interno são bloqueados sem evidência');

console.log('▶ retry thinking-only e recuperação');
assert.equal(
  isThinkingOnlyResponse({
    stopReason: 'max_tokens',
    contentTypes: ['thinking'],
    text: '',
  }),
  true
);
assert.equal(
  isThinkingOnlyResponse({
    stopReason: 'end_turn',
    contentTypes: ['text'],
    text: 'Resposta.',
  }),
  false
);
assert.deepEqual(
  inspectSalesReplyActionClaims('', []).reasons,
  ['empty_response']
);
assert.equal(salesToolSucceeded([fail('handoffToHuman')], 'handoffToHuman'), false);
assert.match(
  buildSafeSalesRecoveryReply([ok('handoffToHuman')], 'fallback'),
  /já acionei o Victor/
);
assert.match(
  buildSafeSalesRecoveryReply(
    [ok('sendSignupLink', { url: 'https://receps.com.br/cadastro?plan=pro' })],
    'fallback'
  ),
  /Te mandei o link[\s\S]*https:\/\/receps\.com\.br\/cadastro\?plan=pro/
);
assert.equal(
  buildSafeSalesRecoveryReply(
    [
      ok('sendPrefilledSignup', {
        url: 'https://receps.com.br/cadastro?track=fidelidade',
        prefilled: false,
      }),
    ],
    'fallback'
  ),
  'Prontinho! Te mandei o link do cadastro. Se precisar, fico por aqui com você.\n\nhttps://receps.com.br/cadastro?track=fidelidade'
);
assert.equal(buildSafeSalesRecoveryReply([], 'fallback'), 'fallback');
console.log(
  '  ✓ vazio/thinking-only são distinguidos e só success:true licencia recuperação'
);

console.log('▶ normalização WhatsApp');
assert.equal(
  normalizeSalesReplyStyle('**Pro** 😊\n\nTudo certo! 🎉'),
  '*Pro* 😊\n\nTudo certo!'
);
console.log('  ✓ negrito vira asterisco simples e só um emoji permanece');

console.log('▶ checker semântico de perguntas');
assert.equal(countActionableSalesQuestions('Tudo bem?'), 1);
assert.equal(
  countActionableSalesQuestions('Tudo bem? Qual é o nome da clínica?'),
  1
);
assert.equal(
  countActionableSalesQuestions('Quer ver? Quantas profissionais atendem aí?'),
  1
);
assert.equal(
  countActionableSalesQuestions(
    'Qual é o nome da clínica? E quantas profissionais atendem aí?'
  ),
  2
);
console.log('  ✓ retórica curta não mascara duas perguntas substantivas');

console.log('▶ decisão comercial versionada');
function userTurns(texts: string[]) {
  return texts.map((content) => ({ role: 'user' as const, content }));
}
function decided(history: Array<{ role: string; content: string }>) {
  return resolveSalesCommercialDecision(history);
}
function decidedPlan(history: Array<{ role: string; content: string }>) {
  return decided(history)?.plan ?? null;
}
assert.equal(
  decidedPlan(
    userTurns(['qual a diferença do Pro e do Essencial?', 'quero o Essencial'])
  ),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['quero o Pro, não o Essencial'])),
  'pro'
);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'não quero o Pro'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'também olhei o Pro'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'o Pro tem prontuário?'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['quero o Pro ou o Essencial?'])),
  null
);
assert.equal(decidedPlan(userTurns(['vou pensar no Pro'])), null);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'quero saber mais sobre o Pro'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['não tenho dúvidas, quero o Pro'])),
  'pro'
);
assert.equal(
  decidedPlan(userTurns(['quero comparar Pro e Essencial'])),
  null
);
assert.equal(
  decidedPlan(
    userTurns(['quero o Essencial', 'quero comparar Pro e Essencial'])
  ),
  'essencial'
);
assert.equal(decidedPlan(userTurns(['não quero o Pro'])), null);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'o Anual tem desconto?']))
    ?.track,
  'flexivel'
);
assert.deepEqual(
  decided(userTurns(['quero o Essencial Mensal', 'não quero fidelidade'])),
  { plan: 'essencial', track: 'flexivel', evidenceIndex: 0 }
);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'não quero o Mensal'])),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'quero o Essencial' },
  ])?.evidenceIndex,
  2
);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro, quero o Essencial'])),
  'essencial'
);
assert.equal(
  decided(userTurns(['quero o Essencial', 'quero Anual, não Mensal']))?.track,
  'fidelidade'
);
assert.equal(
  decided(userTurns(['quero o Essencial', 'quero Mensal, não Anual']))?.track,
  'flexivel'
);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'Mensal ou Anual?']))?.track,
  'flexivel'
);
assert.equal(decidedPlan(userTurns(['não quero assinar o Pro'])), null);
assert.equal(decidedPlan(userTurns(['não vou contratar o Pro'])), null);
assert.equal(decidedPlan(userTurns(['não dá para contratar o Pro'])), null);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro, não o Essencial'])),
  null
);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro nem o Essencial'])),
  null
);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'não quero o Pro nem o Essencial'])),
  null
);
assert.equal(
  decided(userTurns(['quero o Essencial', 'não quero assinar Anual']))?.track,
  'flexivel'
);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'não quero Anual, não Mensal'])),
  null
);
assert.equal(decidedPlan(userTurns(['Pro'])), 'pro');
assert.equal(decidedPlan(userTurns(['o Essencial'])), 'essencial');
assert.equal(decidedPlan(userTurns(['Pro?'])), null);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'quero informações sobre o Pro'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['quero uma explicação do Pro'])),
  null
);
assert.equal(
  decidedPlan(userTurns(['não tenho dúvidas quero o Pro'])),
  'pro'
);
assert.equal(
  decidedPlan(userTurns(['não tenho objeção, prefiro o Essencial'])),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['não tenho objeção prefiro o Essencial'])),
  'essencial'
);
assert.equal(decidedPlan(userTurns(['não sei se quero o Pro'])), null);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'não sei se quero o Pro'])),
  'essencial'
);
assert.equal(decidedPlan(userTurns(['ainda não decidi o Pro'])), null);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'ainda não decidi o Pro'])),
  'essencial'
);
assert.equal(
  decidedPlan(
    userTurns(['quero o Essencial', 'não quero saber mais sobre o Pro'])
  ),
  'essencial'
);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'não sei se quero Anual']))
    ?.track,
  'flexivel'
);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro e quero o Essencial'])),
  'essencial'
);
assert.equal(
  decidedPlan(
    userTurns(['quero o Pro', 'não quero o Pro e quero o Essencial'])
  ),
  'essencial'
);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro e não quero o Essencial'])),
  null
);
assert.equal(
  decidedPlan(
    userTurns(['quero o Essencial', 'não quero o Pro e não quero o Essencial'])
  ),
  null
);
assert.equal(
  decidedPlan(userTurns(['não quero o Pro e nem o Essencial'])),
  null
);
assert.equal(
  decidedPlan(
    userTurns(['quero o Essencial', 'não quero o Pro e nem o Essencial'])
  ),
  null
);
assert.equal(
  decidedPlan(userTurns(['quero o Pro e não o Essencial'])),
  'pro'
);
assert.equal(decidedPlan(userTurns(['quero o Pro e o Essencial'])), null);
assert.equal(
  decidedPlan(userTurns(['quero o Essencial', 'quero o Pro e o Essencial'])),
  'essencial'
);
assert.equal(
  decided(
    userTurns(['quero o Essencial Anual', 'não quero Anual e quero Mensal'])
  )?.track,
  'flexivel'
);
assert.equal(
  decided(userTurns(['quero o Essencial Mensal', 'Anual e Mensal']))?.track,
  'flexivel'
);
assert.equal(decided(userTurns(['Anual e Mensal'])), null);
assert.equal(
  decided(userTurns(['Quero o Essencial anual a vista'])),
  null
);
assert.deepEqual(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
    { role: 'user', content: 'Mensal' },
  ]),
  { plan: 'essencial', track: 'flexivel', evidenceIndex: 2 }
);
assert.deepEqual(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'assistant', content: 'Mensal ou Anual?' },
    { role: 'user', content: 'Mensal' },
  ]),
  { plan: 'essencial', track: 'flexivel', evidenceIndex: 2 }
);
assert.deepEqual(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
    { role: 'user', content: 'Anual' },
  ]),
  { plan: 'essencial', track: 'fidelidade', evidenceIndex: 2 }
);
assert.equal(
  decided(userTurns(['Quero o Essencial anual a vista', 'Mensal'])),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    {
      role: 'assistant',
      content: 'Só confirma: maria@clinica.com.br, certo?',
    },
    { role: 'user', content: 'Mensal' },
  ]),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'user', content: 'não quero o Essencial' },
    { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
    { role: 'user', content: 'Mensal' },
  ]),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
    { role: 'user', content: 'Mensal ou Anual?' },
  ]),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    { role: 'assistant', content: 'Você prefere Mensal ou Anual?' },
    { role: 'user', content: 'quero comparar Mensal e Anual' },
  ]),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    {
      role: 'assistant',
      content:
        'No Mensal o valor é recorrente e no Anual há fidelidade. Ficou claro?',
    },
    { role: 'user', content: 'Mensal' },
  ]),
  null
);
assert.equal(
  decided([
    { role: 'user', content: 'Quero o Essencial anual a vista' },
    {
      role: 'assistant',
      content: 'Você prefere Mensal ou Anual? Qual o nome da clínica?',
    },
    { role: 'user', content: 'Mensal' },
  ]),
  null
);
console.log(
  '  ✓ polaridade: escolha, recusa, exploração, pergunta e comparação'
);
console.log(
  '  ✓ anual à vista isolado fica null; resposta à pergunta direta recompõe'
);

console.log('▶ airbag requiresPrefilledSignup');
const dedicatedPlusCerto = [
  {
    role: 'user',
    content: 'Quero o Essencial. Meu e-mail é maria@clinica.com.br.',
  },
  {
    role: 'assistant',
    content: 'Só confirma: maria@clinica.com.br, certo?',
  },
  { role: 'user', content: 'Certo' },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Perfeito, só um instante.',
    [],
    dedicatedPlusCerto
  ).reasons.includes('required_prefill_missing'),
  true
);
assert.deepEqual(resolveConfirmedSalesPrefill(dedicatedPlusCerto), {
  email: 'maria@clinica.com.br',
  plan: 'essencial',
  track: 'flexivel',
});
console.log('  ✓ acende com proposta dedicada + "Certo" no turno imediatamente anterior');

const dedicatedThenBlankThenCerto = [
  {
    role: 'user',
    content: 'Quero o Essencial. Meu e-mail é maria@clinica.com.br.',
  },
  {
    role: 'assistant',
    content: 'Só confirma: maria@clinica.com.br, certo?',
  },
  { role: 'assistant', content: '   ' },
  { role: 'user', content: 'Certo' },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Perfeito, só um instante.',
    [],
    dedicatedThenBlankThenCerto
  ).reasons.includes('required_prefill_missing'),
  false
);
console.log('  ✓ não acende com turno intermediário vazio entre proposta e Certo');

const staleConfirmationLoosePlan = [
  {
    role: 'user',
    content: 'Quero o Essencial. Meu e-mail é maria@clinica.com.br.',
  },
  {
    role: 'assistant',
    content: 'Só confirma: maria@clinica.com.br, certo?',
  },
  { role: 'user', content: 'Certo' },
  { role: 'assistant', content: 'Qual é o nome da clínica?' },
  { role: 'user', content: 'Studio Lia' },
  { role: 'assistant', content: 'Quantas profissionais atendem aí?' },
  { role: 'user', content: 'Duas' },
  { role: 'assistant', content: 'Perfeito, e o horário de funcionamento?' },
  { role: 'user', content: 'O Essencial atende bem a gente.' },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Combinado, fico por aqui.',
    [],
    staleConfirmationLoosePlan
  ).reasons.includes('required_prefill_missing'),
  false
);
console.log('  ✓ não acende com confirmação antiga + menção solta de plano');

const onlyRenataNamedThePlan = [
  { role: 'user', content: 'Meu e-mail é maria@clinica.com.br.' },
  {
    role: 'assistant',
    content:
      'O Essencial cabe bem aí. Só confirma: maria@clinica.com.br, certo?',
  },
  { role: 'user', content: 'Certo' },
];
assert.equal(
  inspectSalesReplyActionClaims(
    'Perfeito, só um instante.',
    [],
    onlyRenataNamedThePlan
  ).reasons.includes('required_prefill_missing'),
  true
);
assert.deepEqual(resolveConfirmedSalesPrefill(onlyRenataNamedThePlan), {
  email: 'maria@clinica.com.br',
  plan: 'essencial',
  track: 'flexivel',
});
console.log('  ✓ acende mesmo quando só a Renata nomeou o plano');

const onlyRenataNamedEssencialAnual = [
  { role: 'user', content: 'Meu e-mail é maria@clinica.com.br.' },
  {
    role: 'assistant',
    content:
      'O Essencial Anual cabe bem aí. Só confirma: maria@clinica.com.br, certo?',
  },
  { role: 'user', content: 'Certo' },
];
assert.deepEqual(resolveSalesCommercialDecision(onlyRenataNamedEssencialAnual), {
  plan: 'essencial',
  track: 'fidelidade',
  evidenceIndex: 1,
});
assert.deepEqual(
  resolveConfirmedSalesPrefill(onlyRenataNamedEssencialAnual),
  {
    email: 'maria@clinica.com.br',
    plan: 'essencial',
    track: 'fidelidade',
  }
);
console.log('  ✓ fallback dedicado da Renata preserva Anual/fidelidade');

console.log('▶ authorizeSalesToolCall contra a decisão vigente');
const matchingPrefill = authorizeSalesToolCall({
  toolName: 'sendPrefilledSignup',
  toolInput: {
    email: 'maria@clinica.com.br',
    plan: 'essencial',
    track: 'flexivel',
  },
  history: confirmedPurchaseHistory,
});
assert.equal(matchingPrefill.ok, true);
const divergentPlan = authorizeSalesToolCall({
  toolName: 'sendPrefilledSignup',
  toolInput: {
    email: 'maria@clinica.com.br',
    plan: 'pro',
    track: 'flexivel',
  },
  history: confirmedPurchaseHistory,
});
assert.equal(divergentPlan.ok, false);
assert.equal(
  divergentPlan.ok ? '' : divergentPlan.reason,
  'commercial_decision_mismatch'
);
const divergentTrack = authorizeSalesToolCall({
  toolName: 'sendSignupLink',
  toolInput: { plan: 'essencial', track: 'fidelidade' },
  history: confirmedPurchaseHistory,
});
assert.equal(divergentTrack.ok, false);
assert.equal(
  divergentTrack.ok ? '' : divergentTrack.reason,
  'commercial_decision_mismatch'
);
const commercialArgsWithoutDecision = authorizeSalesToolCall({
  toolName: 'sendSignupLink',
  toolInput: { plan: 'pro', track: 'fidelidade' },
  history: [{ role: 'user', content: 'Oi, quero entender o produto.' }],
});
assert.equal(commercialArgsWithoutDecision.ok, false);
assert.equal(
  commercialArgsWithoutDecision.ok ? '' : commercialArgsWithoutDecision.reason,
  'commercial_decision_mismatch'
);
for (const toolInput of [
  { plan: 123 },
  { plan: '' },
  { track: {} },
] as Array<Record<string, unknown>>) {
  const invalidCommercial = authorizeSalesToolCall({
    toolName: 'sendSignupLink',
    toolInput,
    history: confirmedPurchaseHistory,
  });
  assert.equal(invalidCommercial.ok, false);
  assert.equal(
    invalidCommercial.ok ? '' : invalidCommercial.reason,
    'commercial_decision_mismatch'
  );
}
console.log('  ✓ argumentos divergentes de plano/track são rejeitados');

console.log('\n✅ smoke-sales-guards OK');
