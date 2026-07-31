/**
 * Barreira B3 do lado Ana. Puro/offline: prova proposta no turno anterior +
 * confirmação inequívoca atual e o reuso do detector já coberto pelas 52
 * confirmações do bookingConfirmationGate.
 */
import {
  authorizeOnboardingWrite,
  clearPendingOnboardingProposal,
  getPendingOnboardingProposal,
  invalidateProposalForInbound,
  rememberProposalFromReply,
  __resetOnboardingConfirmationGateForTest,
} from '../src/services/onboardingConfirmationGate';
import { isExplicitBookingConfirmation } from '../src/services/bookingConfirmationGate';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function main(): void {
  const key = 'PNID:5516999990000';
  const service = {
    name: 'Limpeza de pele',
    durationMin: 60,
    price: 180,
  };
  let writes = 0;

  console.log('▶ sem proposta não chama a tool');
  __resetOnboardingConfirmationGateForTest();
  const noProposal = authorizeOnboardingWrite({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    currentUserMessage: 'confirmo',
  });
  if (noProposal.ok) writes += 1;
  check(
    'bloqueia mesmo com confirmação quando não houve proposta',
    !noProposal.ok && noProposal.reason === 'proposal_required'
  );
  check('contador de escrita segue zero', writes === 0);

  console.log('▶ proposta explícita + confirmação libera');
  const remembered = rememberProposalFromReply({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    reply:
      'Vou cadastrar Limpeza de pele, com 60 minutos e preço de R$ 180. Confirma?',
  });
  check('proposta material foi reconhecida', remembered);
  check(
    'estado pendente é first-write-wins',
    rememberProposalFromReply({
      conversationKey: key,
      tool: 'addProfessional',
      toolInput: { name: 'Outra pessoa' },
      reply: 'Posso cadastrar Outra pessoa como profissional, confirma?',
    }) &&
      getPendingOnboardingProposal(key)?.tool === 'upsertService'
  );
  const confirmed = authorizeOnboardingWrite({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    currentUserMessage: 'confirmo',
  });
  if (confirmed.ok) writes += 1;
  check('confirmação coloquial inequívoca libera', confirmed.ok);
  check('tool seria chamada exatamente uma vez', writes === 1);
  check(
    'proposta é consumida antes do I/O',
    getPendingOnboardingProposal(key) === null
  );

  console.log('▶ hesitação, adversativa e correção invalidam');
  rememberProposalFromReply({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    reply:
      'Vou cadastrar Limpeza de pele, 60 minutos, por R$ 180. Confirma?',
  });
  invalidateProposalForInbound(key, 'acho que pode');
  const hesitant = authorizeOnboardingWrite({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    currentUserMessage: 'acho que pode',
  });
  check(
    'hesitação invalida e volta a exigir proposta',
    !hesitant.ok && hesitant.reason === 'proposal_required'
  );

  rememberProposalFromReply({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    reply:
      'Vou cadastrar Limpeza de pele, 60 minutos, por R$ 180. Confirma?',
  });
  invalidateProposalForInbound(key, 'sim, mas troca o preço para 160');
  const adversative = authorizeOnboardingWrite({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    currentUserMessage: 'sim, mas troca o preço para 160',
  });
  check(
    'adversativa/correção invalida a proposta',
    !adversative.ok && adversative.reason === 'proposal_required'
  );
  check('nenhuma escrita adicional', writes === 1);

  console.log('▶ proposta precisa casar byte-semanticamente com a tool');
  rememberProposalFromReply({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: service,
    reply:
      'Vou cadastrar Limpeza de pele, 60 minutos, por R$ 180. Confirma?',
  });
  const mismatch = authorizeOnboardingWrite({
    conversationKey: key,
    tool: 'upsertService',
    toolInput: { ...service, price: 181 },
    currentUserMessage: 'confirmo',
  });
  check(
    'mudança de argumento exige nova proposta',
    !mismatch.ok && mismatch.reason === 'proposal_mismatch'
  );

  console.log('▶ reuso real do bookingConfirmationGate');
  check(
    'detector compartilhado aceita "fechado"',
    isExplicitBookingConfirmation('fechado')
  );
  check(
    'detector compartilhado rejeita "pode ser" ambíguo',
    !isExplicitBookingConfirmation('pode ser')
  );
  check(
    'detector compartilhado rejeita "beleza, mas..."',
    !isExplicitBookingConfirmation('beleza, mas muda o horário')
  );

  clearPendingOnboardingProposal(key);
  if (failures > 0) {
    throw new Error(
      `smoke-onboarding-gate falhou: ${failures} check(s)`
    );
  }
  console.log('\n✅ smoke-onboarding-gate OK');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
