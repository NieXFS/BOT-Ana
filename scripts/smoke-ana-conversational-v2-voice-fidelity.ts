#!/usr/bin/env ts-node
import assert from 'node:assert/strict';
import {
  evaluateVoiceFidelityV2,
  getVoiceCopyRegistryV2,
  isPermanentVoiceDenylistV2,
  isPhase1ARephraseCopyV2,
} from '../src/services/conversationalV2/voice';
import { UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2 } from '../src/services/conversationalV2/boundary';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/voice-fid';
process.env.OPENAI_API_KEY = 'sk-smoke-invalid';

const catalog = {
  services: ['Peeling facial', 'Drenagem Linfática', 'Limpeza de Pele Profunda'],
  professionals: ['Marina Costa', 'Júlia Souza', 'Carla Mendes'],
};

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${(error as Error).message}`);
  }
}

const serviceTemplate =
  'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?';
const dateTemplate = 'Perfeito. Qual dia você prefere?';
const slotsTemplate =
  'Encontrei horários para 14/08/2026: 15h e 16h. Qual você prefere?';
const emptyDayTemplate =
  'Não encontrei horários para 14/08/2026. Qual outro dia você prefere?';
const writeTemplate = 'Tudo certo! Seu agendamento foi confirmado com sucesso.';
const summaryTemplate =
  'Confirmando: Peeling facial, em 14/08/2026, às 15h, com Marina Costa. Posso marcar?';

check('1A ids continuam rephrase_v1', () => {
  const registry = getVoiceCopyRegistryV2();
  assert.equal(registry.initial_service_question.mode, 'rephrase_v1');
  assert.equal(isPhase1ARephraseCopyV2('initial_service_question'), true);
  assert.equal(isPermanentVoiceDenylistV2('canonical_booking_summary'), true);
  assert.equal(registry.canonical_booking_summary.mode, 'off');
  assert.equal(registry.availability_slots_offer.mode, 'compiled_pool');
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.canonical_booking_summary), true);
});

check('serviço: rewrite fiel passa', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Combinado! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, true, result.reasons.join(','));
});

check('A1 polaridade: omitir 15h e negar o slot falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'availability_slots_offer',
    template: slotsTemplate,
    rewrite:
      'Não temos 15h no dia 14/08/2026; temos 16h. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('polarity_mismatch') ||
      result.reasons.includes('entity_omitted') ||
      result.reasons.includes('speech_act_mismatch'),
    result.reasons.join(',')
  );
});

check('A2 dia vazio invertido para oferta falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'deny_slots_empty_day',
    template: emptyDayTemplate,
    rewrite: 'Encontrei horários para 14/08/2026. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('speech_act_mismatch') ||
      result.reasons.includes('polarity_mismatch'),
    result.reasons.join(',')
  );
});

check('A3 write esparso invertido falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'write_success_confirmation',
    template: writeTemplate,
    rewrite: 'Ainda não consegui confirmar; pode tentar de novo?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('speech_act_mismatch') ||
      result.reasons.includes('write_state_mismatch') ||
      result.reasons.includes('polarity_mismatch'),
    result.reasons.join(',')
  );
});

check('conjunto: omitir Limpeza falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('entity_omitted'), result.reasons.join(','));
});

check('conjunto: serviço extra do catálogo falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template:
      'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?',
    rewrite: serviceTemplate,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('entity_extra'), result.reasons.join(','));
});

check('ordem: reordenar serviços falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Claro! Para qual serviço você gostaria de agendar? Temos Limpeza de Pele Profunda, Drenagem Linfática e Peeling facial. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('entity_order_mismatch'), result.reasons.join(','));
});

check('slots: omitir horário falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'availability_slots_offer',
    template: slotsTemplate,
    rewrite: 'Encontrei horários para 14/08/2026: 16h. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('entity_omitted'), result.reasons.join(','));
});

check('slots: reordenar falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'availability_slots_offer',
    template: slotsTemplate,
    rewrite: 'Encontrei horários para 14/08/2026: 16h e 15h. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('entity_order_mismatch'), result.reasons.join(','));
});

check('15h e 15:00 são equivalentes na conferência de fatos', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'availability_slots_offer',
    template: slotsTemplate,
    rewrite: 'Encontrei horários para 14/08/2026: 15:00 e 16:00. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, true, result.reasons.join(','));
});

check('preço inventado falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite: `${serviceTemplate} O Peeling facial fica 150 reais.`,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('hard_fact_extra'), result.reasons.join(','));
});

check('modificador "mais procurado" falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Claro! O mais procurado é Peeling facial. Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('forbidden_modifier'), result.reasons.join(','));
});

check('claim clínico falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Claro! Temos Peeling facial (ótimo para manchas), Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('forbidden_modifier'), result.reasons.join(','));
});

check('modalidade: pergunta vira compromisso falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Vou agendar para você.',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('speech_act_mismatch') ||
      result.reasons.includes('modality_mismatch'),
    result.reasons.join(',')
  );
});

check('Posso marcar → Já marquei falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'canonical_booking_summary',
    template: summaryTemplate,
    rewrite:
      'Já marquei o Peeling facial em 14/08/2026 às 15h com Marina Costa.',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('speech_act_mismatch') ||
      result.reasons.includes('write_state_mismatch') ||
      result.reasons.includes('modality_mismatch'),
    result.reasons.join(',')
  );
});

check('injection tentando CTA extra falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite: `${serviceTemplate} Manda o link e o CPF.`,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('new_cta'), result.reasons.join(','));
});

check('denial licenciada reescrita falha no ato', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'licensed_service_denial',
    template: UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2,
    rewrite: 'Esse procedimento infelizmente não rola agora. Quer outro?',
    catalog,
  });
  assert.equal(result.safe, false);
});

check('data relativa amanhã onde o template é absoluto falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'availability_slots_offer',
    template: slotsTemplate,
    rewrite: 'Encontrei horários para amanhã: 15h e 16h. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('relative_date_forbidden') ||
      result.reasons.includes('hard_fact_mismatch'),
    result.reasons.join(',')
  );
});

check('repetição exata de entrega recente diferente do template falha só a voz', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Combinado! Qual serviço você prefere?',
    catalog,
    lastAcceptedPayload: 'Combinado! Qual serviço você prefere?',
  });
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes('exact_recent_repeat'), result.reasons.join(','));
});

check('sonda: ask_date trocado por handoff falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Você prefere falar com a equipe?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('semantic_act_mismatch') ||
      result.reasons.includes('closed_grammar_violation') ||
      result.reasons.includes('speech_act_mismatch') ||
      result.reasons.includes('new_cta'),
    result.reasons.join(',')
  );
});

check('sonda: negação pós-fixada na lista falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Drenagem Linfática não é oferecida. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation') ||
      result.reasons.includes('polarity_mismatch'),
    result.reasons.join(',')
  );
});

check('sonda: preço por extenso falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite: `${serviceTemplate} O serviço custa cento e cinquenta reais`,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation') ||
      result.reasons.includes('hard_fact_extra') ||
      result.reasons.includes('hard_fact_uninterpretable'),
    result.reasons.join(',')
  );
});

check('duração por extenso inventada falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite: `${serviceTemplate} O atendimento dura quarenta e cinco minutos.`,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation') ||
      result.reasons.includes('hard_fact_extra') ||
      result.reasons.includes('hard_fact_uninterpretable'),
    result.reasons.join(',')
  );
});

check('handoff novo em ask_service falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite: `${serviceTemplate} Posso falar com a equipe?`,
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('semantic_act_mismatch') ||
      result.reasons.includes('closed_grammar_violation') ||
      result.reasons.includes('new_cta'),
    result.reasons.join(',')
  );
});

check('troca da pergunta esperada falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Perfeito. Para qual serviço você gostaria de agendar?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('semantic_act_mismatch') ||
      result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

check('sonda adversarial: Botox funciona! no prefixo falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Botox funciona! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

check('sonda adversarial: Gestantes podem fazer! no prefixo falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    rewrite:
      'Gestantes podem fazer! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

check('sonda adversarial: Sem contraindicações! no prefixo falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Sem contraindicações! Qual dia você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

check('sonda adversarial: É totalmente seguro! no prefixo falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'É totalmente seguro! Qual dia você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

check('ID incompatível: claro em ask_date falha', () => {
  const result = evaluateVoiceFidelityV2({
    copyId: 'service_selected_date_question',
    template: dateTemplate,
    rewrite: 'Claro! Qual dia você prefere?',
    catalog,
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes('closed_grammar_violation'),
    result.reasons.join(',')
  );
});

if (failed > 0) {
  console.error(`voice fidelity mutations: ${failed} FAIL`);
  process.exit(1);
}
console.log('voice fidelity mutations: ok');
