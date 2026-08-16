/** Smoke PURO da atribuição por texto de parceira — sem rede, DB ou LLM. */
import { matchPartnerMention } from '../src/services/salesOpeners';
import {
  MAX_PARTNER_ATTRIBUTION_INBOUNDS,
  clearConversationPartnerSlugs,
  getConversationPartnerSlug,
  observePartnerAttributionInbound,
  type PartnerAttributionInboundDeps,
} from '../src/services/salesPartnerState';

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

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }

  console.error(`  ✗ ${label}`);
  failures += 1;
}

function inbound(
  conversationKey: string,
  userMessage: string,
  inboundNumber: number,
  deps: PartnerAttributionInboundDeps
): void {
  observePartnerAttributionInbound(
    {
      conversationKey,
      phoneNumberId: 'PN_SALES',
      customerPhone: 'customer-redacted',
      userMessage,
      isFirstInboundWindow: inboundNumber === 1,
    },
    deps
  );
}

async function settleCapture(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function main(): Promise<void> {
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

  const captures: string[] = [];
  let matcherCalls = 0;
  const successDeps: PartnerAttributionInboundDeps = {
    matchPartnerMention: (message) => {
      matcherCalls += 1;
      return matchPartnerMention(message);
    },
    capturePartnerAttribution: async (_phoneNumberId, _phone, slug) => {
      captures.push(slug);
      return 'attributed';
    },
  };

  const secondMessageKey = 'PN_SALES:second-message';
  inbound(secondMessageKey, 'Oi, queria entender melhor.', 1, successDeps);
  inbound(secondMessageKey, 'Foi indicação da @parceira2.', 2, successDeps);
  await settleCapture();
  assert('detecção na 2ª mensagem carimba', captures.join(',') === 'parceira2');
  assert(
    'detecção tardia não personaliza a saudação',
    getConversationPartnerSlug(secondMessageKey) === null
  );

  const matcherCallsAfterStamp = matcherCalls;
  inbound(secondMessageKey, 'Vim pela @outra.', 3, successDeps);
  await settleCapture();
  assert('conversa carimbada não re-posta', captures.length === 1);
  assert(
    'conversa carimbada não roda a detecção novamente',
    matcherCalls === matcherCallsAfterStamp
  );

  const thirdMessageKey = 'PN_SALES:third-message';
  inbound(thirdMessageKey, 'Olá.', 1, successDeps);
  inbound(thirdMessageKey, 'Quero ver os planos.', 2, successDeps);
  inbound(thirdMessageKey, 'Eu vim através da @parceira3.', 3, successDeps);
  await settleCapture();
  assert('detecção na 3ª mensagem carimba', captures.at(-1) === 'parceira3');
  assert(
    'saudação segue sem origem na detecção da 3ª mensagem',
    getConversationPartnerSlug(thirdMessageKey) === null
  );

  const firstMessageKey = 'PN_SALES:first-message';
  inbound(firstMessageKey, 'Vim pela @parceira1.', 1, successDeps);
  await settleCapture();
  assert(
    'detecção na 1ª janela ainda personaliza a saudação',
    getConversationPartnerSlug(firstMessageKey) === 'parceira1'
  );

  const ceilingKey = 'PN_SALES:ceiling';
  let ceilingMatcherCalls = 0;
  let ceilingCaptureCalls = 0;
  const ceilingDeps: PartnerAttributionInboundDeps = {
    matchPartnerMention: (message) => {
      ceilingMatcherCalls += 1;
      return matchPartnerMention(message);
    },
    capturePartnerAttribution: async () => {
      ceilingCaptureCalls += 1;
      return 'attributed';
    },
  };
  for (let index = 1; index <= MAX_PARTNER_ATTRIBUTION_INBOUNDS; index += 1) {
    inbound(ceilingKey, `Mensagem sem origem ${index}.`, index, ceilingDeps);
  }
  inbound(
    ceilingKey,
    'Só agora: vim pela @tarde_demais.',
    MAX_PARTNER_ATTRIBUTION_INBOUNDS + 1,
    ceilingDeps
  );
  await settleCapture();
  assert(
    'teto limita a regex a 10 inbounds',
    ceilingMatcherCalls === MAX_PARTNER_ATTRIBUTION_INBOUNDS
  );
  assert('menção depois do teto não carimba', ceilingCaptureCalls === 0);

  const discardedCandidateKey = 'PN_SALES:discarded-candidate';
  const discardedCaptures: string[] = [];
  const discardedDeps: PartnerAttributionInboundDeps = {
    matchPartnerMention,
    capturePartnerAttribution: async (_phoneNumberId, _phone, slug) => {
      discardedCaptures.push(slug);
      return slug === 'amiga' ? 'not-attributed' : 'attributed';
    },
  };
  inbound(discardedCandidateKey, 'Oi, quero conhecer.', 1, discardedDeps);
  inbound(discardedCandidateKey, 'Foi indicação da @amiga.', 2, discardedDeps);
  await settleCapture();
  inbound(
    discardedCandidateKey,
    'Lembrei: vim pela @parceira_real.',
    3,
    discardedDeps
  );
  await settleCapture();
  assert(
    'slug descartado pelo Receps não fecha a janela financeira',
    discardedCaptures.join(',') === 'amiga,parceira_real'
  );
  assert(
    'falso-positivo tardio continua sem personalizar a saudação',
    getConversationPartnerSlug(discardedCandidateKey) === null
  );

  const networkFailureKey = 'PN_SALES:network-failure';
  let networkAttempts = 0;
  let responseContinued = false;
  const networkDeps: PartnerAttributionInboundDeps = {
    matchPartnerMention,
    capturePartnerAttribution: async () => {
      networkAttempts += 1;
      if (networkAttempts === 1) return 'failed';
      return 'attributed';
    },
  };
  inbound(networkFailureKey, 'Vim pela @instavel.', 1, networkDeps);
  responseContinued = true;
  await settleCapture();
  assert('falha de rede não interrompe o caminho da resposta', responseContinued);
  inbound(networkFailureKey, 'Podemos continuar?', 2, networkDeps);
  await settleCapture();
  assert('inbound seguinte re-tenta o carimbo sem nova menção', networkAttempts === 2);

  clearConversationPartnerSlugs([
    secondMessageKey,
    thirdMessageKey,
    firstMessageKey,
    ceilingKey,
    discardedCandidateKey,
    networkFailureKey,
  ]);

  if (failures > 0) {
    process.exit(1);
  }

  console.log('\n✅ smoke-renata-partner-mention OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
