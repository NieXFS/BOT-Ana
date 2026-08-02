process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import assert from 'node:assert/strict';
import {
  authorizeSalesToolCall,
  buildDeterministicSalesGuardReply,
  buildSafeSalesRecoveryReply,
  countActionableSalesQuestions,
  hasConfirmedSalesEmail,
  inspectSalesReplyActionClaims,
  isThinkingOnlyResponse,
  normalizeSalesReplyStyle,
  resolveRequiredCommonSignup,
  resolveConfirmedSalesPrefill,
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
  { role: 'assistant', content: 'Você prefere Flexível ou Fidelidade 12m?' },
  { role: 'user', content: 'Flexível.' },
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
  true
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
  ).safe,
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
    ...confirmedPurchaseHistory,
    { role: 'user', content: 'Também olhei o Pro.' },
  ]),
  null
);
console.log('  ✓ airbag de prefill exige um único e-mail/plano e preserva a trilha');

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
  buildSafeSalesRecoveryReply([ok('sendSignupLink')], 'fallback'),
  /Te mandei o link/
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
  'Prontinho! Te mandei o link do cadastro. Se precisar, fico por aqui com você.'
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

console.log('\n✅ smoke-sales-guards OK');
