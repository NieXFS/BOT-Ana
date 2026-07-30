/**
 * Smoke DETERMINÍSTICO do Guardrail B (service-gate.ts). Função pura, sem rede,
 * sem OpenAI, sem DATABASE_URL — testa o gate contra S1-S5 + edge cases.
 * Rodar: node scripts/smoke-service-gate.ts
 */
import {
  serviceSelectionGate,
  buildServiceAmbiguationHint,
  shouldAskServiceUpfront,
  buildServiceQuestion,
} from '../src/services/service-gate.ts';

const corte = { id: 'svc-corte', name: 'Corte de cabelo' };
const depil = { id: 'svc-depil', name: 'Depilação a Laser' };
const TWO = [corte, depil];

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function expect(name: string, gotOk: boolean, wantOk: boolean, detail?: string) {
  const pass = gotOk === wantOk;
  checks.push({ name, ok: pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name} (esperado ok=${wantOk}, obtido ok=${gotOk})${detail ? ` — ${detail}` : ''}`);
}
const ok = (serviceId: string, services: typeof TWO, msgs: string[]) =>
  serviceSelectionGate(serviceId, services, msgs).ok;

// S1 — histórico velho cheio de depilação + "quero marcar amanhã" (sem serviço) → BLOQUEIA
expect('S1: histórico velho depil + "quero marcar amanhã" → desambigua', ok(depil.id, TWO, [
  'quero marcar depilação a laser', 'obrigado', 'quero marcar depilação de novo',
  'adorei a depilação', 'quero depilação', 'Quero marcar amanhã',
]), false);

// S1b — abridor na msg atual colapsa a janela mesmo com depil recente (dentro do teto)
expect('S1b: opener atual colapsa janela apesar de depil recente → desambigua', ok(depil.id, TWO, [
  'oi', 'quero marcar depilação', 'beleza', 'Quero marcar amanhã',
]), false);

// S2 — mid-flow curto: serviço escolhido há 2 msgs → LIBERA (sem re-perguntar)
expect('S2: "quero cortar o cabelo" → "amanhã" → "15h" → libera', ok(corte.id, TWO, [
  'quero cortar o cabelo', 'amanhã', '15h',
]), true);

// S2b — mid-flow ARRASTADO (6 msgs, conversa fiada): teto=6 ainda pega "cabelo" → LIBERA
expect('S2b: fluxo arrastado (6 msgs) ainda libera via teto=6', ok(corte.id, TWO, [
  'quero cortar o cabelo', 'qual o preço?', 'e demora muito?', 'tem amanhã?', 'pode ser', '15h',
]), true);

// Confirmação não abre uma nova intenção e não pode apagar o serviço escolhido.
expect('S2c: "sim, pode marcar" preserva o serviço da proposta', ok(corte.id, TWO, [
  'quero marcar corte de cabelo amanhã', '15h', 'Sim, pode marcar.',
]), true);
expect('S2d: "perfeito, pode agendar" preserva o serviço da proposta', ok(depil.id, TWO, [
  'quero marcar depilação a laser amanhã', '10h', 'Perfeito, pode agendar.',
]), true);
expect('S2e: pedido por outro atendimento abre intenção nova', ok(corte.id, TWO, [
  'quero marcar corte de cabelo amanhã', 'Sim, quero marcar outro amanhã.',
]), false);
expect('S2f: "quero remarcar" preserva serviço em curso', ok(corte.id, TWO, [
  'quero marcar corte de cabelo amanhã', '15h', 'Quero remarcar.',
]), true);
expect('S2g: "remarca" preserva serviço em curso', ok(depil.id, TWO, [
  'quero marcar depilação a laser', '10h', 'Remarca pra mim.',
]), true);
expect('S2h: "mudar o horário" preserva serviço em curso', ok(corte.id, TWO, [
  'quero corte de cabelo', 'Preciso mudar o horário.',
]), true);
expect('S2i: "trocar o horário" preserva serviço em curso', ok(depil.id, TWO, [
  'quero depilação a laser', 'Quero trocar o horário.',
]), true);
expect('S2j: "outro atendimento" abre intenção nova', ok(corte.id, TWO, [
  'quero corte de cabelo', 'Quero outro atendimento.',
]), false);
expect('S2k: "outro serviço" abre intenção nova', ok(depil.id, TWO, [
  'quero depilação a laser', 'Quero outro serviço.',
]), false);
expect('S2l: "novo agendamento" abre intenção nova', ok(corte.id, TWO, [
  'quero corte de cabelo', 'Quero um novo agendamento.',
]), false);
expect('S2m: "quero marcar também" abre intenção nova', ok(depil.id, TWO, [
  'quero depilação a laser', 'Quero marcar também.',
]), false);

// S3 — serviço nomeado por inteiro na msg atual → LIBERA
expect('S3: "quero marcar uma depilação a laser amanhã" → libera', ok(depil.id, TWO, [
  'quero marcar uma depilação a laser amanhã',
]), true);

// S4 — tenant com 1 serviço só → NUNCA bloqueia
expect('S4: tenant 1 serviço → nunca desambigua', ok(corte.id, [corte], ['Quero marcar amanhã']), true);

// S5 — referência por token distintivo → LIBERA
expect('S5a: "a de laser" → token distintivo (depilação) → libera', ok(depil.id, TWO, ['quero marcar', 'a de laser']), true);
expect('S5b: "o corte" → token distintivo (corte) → libera', ok(corte.id, TWO, ['quero agendar', 'o corte']), true);

// Ambiguidade real: cliente cita tokens de 2 serviços → BLOQUEIA
expect('Ambíguo: "corte ou depilação?" → desambigua', ok(corte.id, TWO, ['quero marcar', 'corte ou depilação?']), false);

// Serviço escolhido NÃO citado (modelo assumiu corte, cliente falou de depil) → BLOQUEIA
expect('Assumido errado: cliente falou depil, modelo escolheu corte → desambigua', ok(corte.id, TWO, [
  'quero marcar uma depilação amanhã',
]), false);

// Edge: serviceId desconhecido → fail-open (libera; deixa "não encontrado" tratar)
expect('Edge: serviceId desconhecido → fail-open', ok('svc-inexistente', TWO, ['quero marcar amanhã']), true);

// Edge: sem mensagens do usuário → fail-open
expect('Edge: userMessages vazio → fail-open', ok(depil.id, TWO, []), true);

// Edge: acento/caixa — "DEPILAÇÃO" maiúsculo com acento na msg atual → libera
expect('Edge: "Quero a DEPILAÇÃO A LASER amanhã" (acento/caixa) → libera', ok(depil.id, TWO, ['Quero a DEPILAÇÃO A LASER amanhã']), true);

// buildServiceAmbiguationHint lista os serviços + é INTERNAL_HINT
const hint = buildServiceAmbiguationHint(TWO);
checks.push({ name: 'hint lista serviços + INTERNAL_HINT', ok: hint.includes('INTERNAL_HINT') && hint.includes('Corte de cabelo') && hint.includes('Depilação a Laser') });
console.log(`${checks[checks.length - 1].ok ? '[PASS]' : '[FAIL]'} hint lista serviços + INTERNAL_HINT`);

// ===== shouldAskServiceUpfront (proativo) =====
const ask = (services: typeof TWO, msgs: string[]) => shouldAskServiceUpfront(services, msgs);
function expectAsk(name: string, got: boolean, want: boolean) {
  const pass = got === want;
  checks.push({ name, ok: pass });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name} (esperado ask=${want}, obtido ask=${got})`);
}
// P1: novo agendamento sem serviço (+ histórico velho depil) → PERGUNTA
expectAsk('P1: "quero marcar amanhã" (hist. depil) → ask', ask(TWO, [
  'quero marcar depilação', 'adorei', 'marcar depilação de novo', 'Quero marcar amanhã',
]), true);
// P2: "quero cortar o cabelo" (sem verbo marcar/agendar; serviço implícito) → NÃO pergunta
expectAsk('P2: "quero cortar o cabelo" → não pergunta (serviço implícito)', ask(TWO, ['quero cortar o cabelo']), false);
// P3: "quero marcar depilação a laser" (novo agendamento COM serviço) → NÃO pergunta
expectAsk('P3: "quero marcar depilação a laser amanhã" → não pergunta', ask(TWO, ['quero marcar depilação a laser amanhã']), false);
expectAsk('P3b: confirmação "sim, pode marcar" preserva serviço → não pergunta', ask(TWO, [
  'quero marcar depilação a laser amanhã', '10h', 'Sim, pode marcar.',
]), false);
// P4: "quero agendar amanhã" (sem serviço) → PERGUNTA
expectAsk('P4: "quero agendar amanhã" → ask', ask(TWO, ['quero agendar amanhã']), true);
// P5: "quero remarcar" (fluxo de agendamento EXISTENTE) → NÃO pergunta serviço
expectAsk('P5: "quero remarcar" → não pergunta (remarcação não é nova escolha)', ask(TWO, ['quero remarcar meu horário']), false);
expectAsk('P5b: remarcação em curso preserva serviço → não pergunta', ask(TWO, [
  'quero marcar corte de cabelo', 'Quero mudar o horário do agendamento.',
]), false);
expectAsk('P5c: "outro serviço" exige nova escolha → pergunta', ask(TWO, [
  'quero marcar corte de cabelo', 'Quero outro serviço.',
]), true);
expectAsk('P5d: "novo agendamento" exige nova escolha → pergunta', ask(TWO, [
  'quero marcar corte de cabelo', 'Quero um novo agendamento.',
]), true);
expectAsk('P5e: "quero marcar também" exige nova escolha → pergunta', ask(TWO, [
  'quero marcar corte de cabelo', 'Quero marcar também.',
]), true);
// P6: "que horas vocês abrem?" (não é intenção de agendamento) → NÃO pergunta
expectAsk('P6: "que horas vocês abrem?" → não pergunta', ask(TWO, ['que horas vocês abrem?']), false);
// P7: tenant 1 serviço → nunca pergunta
expectAsk('P7: 1 serviço → nunca pergunta', shouldAskServiceUpfront([corte], ['quero marcar amanhã']), false);
// FIX bypass-prefixo: serviceId TRUNCADO que resolve por prefixo único → gate
// acha o chosen e bloqueia (antes: chosen=undefined → fail-open → bypass).
expect('FIX#2: serviceId truncado "svc-dep" (prefixo de svc-depil), sem serviço citado → bloqueia', ok('svc-dep', TWO, ['Quero marcar amanhã']), false);

// FIX nomes hierárquicos: "Corte" ⊂ "Corte e Barba". Cliente diz o específico,
// modelo escolhe o específico → LIBERA (não falso-bloqueia).
const NESTED = [{ id: 'n-corte', name: 'Corte' }, { id: 'n-cb', name: 'Corte e Barba' }];
expect('FIX#3a: "quero marcar corte e barba" + escolhe "Corte e Barba" → libera (não falso-bloqueia)', serviceSelectionGate('n-cb', NESTED, ['quero marcar corte e barba']).ok, true);
expect('FIX#3b: "quero marcar corte e barba" mas escolhe só "Corte" (errado) → desambigua', serviceSelectionGate('n-corte', NESTED, ['quero marcar corte e barba']).ok, false);
expect('FIX#3c: "quero marcar corte" (só Corte) + escolhe "Corte" → libera', serviceSelectionGate('n-corte', NESTED, ['quero marcar corte']).ok, true);

// buildServiceQuestion lista os serviços de forma neutra
const q = buildServiceQuestion(TWO);
checks.push({ name: 'buildServiceQuestion lista os 2 serviços (neutro)', ok: q.includes('Corte de cabelo') && q.includes('Depilação a Laser') && /qual|prefere/i.test(q) });
console.log(`${checks[checks.length - 1].ok ? '[PASS]' : '[FAIL]'} buildServiceQuestion lista os 2 serviços (neutro) — ${q}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? '✅ TODOS OS CHECKS PASSARAM' : `❌ ${failed.length} CHECK(S) FALHARAM`} (${checks.length} no total)`);
process.exit(failed.length === 0 ? 0 : 1);
