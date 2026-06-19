/**
 * FIX 3 (elegibilidade profissional↔serviço) — smoke DETERMINÍSTICO do
 * buildServicesBlock(), sem rede/OpenAI/DB.
 *
 * Casos:
 *  (1) serviço com 1 profissional habilitado → o texto lista esse profissional
 *      por serviço e NÃO repete o bloco global "PROFISSIONAIS DISPONÍVEIS".
 *  (2) serviço com 0 habilitados (interseção vazia) → o texto traz o aviso
 *      explícito de indisponibilidade.
 *  (3) sem professionalIds (ERP antigo) → cai no formato global antigo
 *      (lista de serviços + bloco "PROFISSIONAIS DISPONÍVEIS").
 *
 * Rodar: npx tsx scripts/smoke-services-block-eligibility.ts
 */
// Env dummy ANTES de carregar o módulo: brainService importa contextManager, que
// exige DATABASE_URL no load. O Pool do pg é lazy (não conecta) e nunca é usado.
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

import type { ServicesResult } from '../src/services/calendarService';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const vitin = { id: 'prof-vitin', name: 'Vitin' };
const ana = { id: 'prof-ana', name: 'Ana Paula' };

async function main() {
  const { buildServicesBlock } = await import('../src/services/brainService');

  // ===== Caso 1: 1 habilitado por serviço =====
  const result1: ServicesResult = {
    success: true,
    professionals: [vitin, ana],
    services: [
      {
        id: 'svc-peeling',
        name: 'Peeling Facial',
        durationMinutes: 45,
        price: 220,
        priceFormatted: 'R$ 220,00',
        professionalIds: ['prof-vitin'],
      },
    ],
  };
  const block1 = buildServicesBlock(result1);
  record(
    '(1) lista o profissional habilitado (Vitin) por serviço',
    /Profissionais habilitados:.*Vitin.*prof-vitin/.test(block1),
    block1
  );
  record(
    '(1) NÃO inclui Ana Paula no serviço (não habilitada)',
    !block1.includes('Ana Paula')
  );
  record(
    '(1) modo elegibilidade NÃO repete bloco global "PROFISSIONAIS DISPONÍVEIS"',
    !block1.includes('PROFISSIONAIS DISPONÍVEIS')
  );

  // ===== Caso 2: 0 habilitados (interseção vazia) =====
  const result2: ServicesResult = {
    success: true,
    professionals: [vitin, ana],
    services: [
      {
        id: 'svc-orfao',
        name: 'Serviço Sem Profissional',
        durationMinutes: 30,
        price: 100,
        priceFormatted: 'R$ 100,00',
        professionalIds: ['prof-inexistente'],
      },
    ],
  };
  const block2 = buildServicesBlock(result2);
  record(
    '(2) interseção vazia → aviso "NENHUM no momento"',
    block2.includes('NENHUM no momento') &&
      /NÃO ofereça horários nem agende/.test(block2),
    block2
  );

  // ===== Caso 3: sem professionalIds → formato global antigo =====
  const result3: ServicesResult = {
    success: true,
    professionals: [vitin, ana],
    services: [
      {
        id: 'svc-corte',
        name: 'Corte de cabelo',
        durationMinutes: 40,
        price: 80,
        priceFormatted: 'R$ 80,00',
        // sem professionalIds
      },
    ],
  };
  const block3 = buildServicesBlock(result3);
  record(
    '(3) fallback inclui bloco global "PROFISSIONAIS DISPONÍVEIS"',
    block3.includes('PROFISSIONAIS DISPONÍVEIS')
  );
  record(
    '(3) fallback lista os profissionais globais (Vitin e Ana Paula)',
    block3.includes('Vitin') && block3.includes('Ana Paula')
  );
  record(
    '(3) fallback NÃO usa o rótulo por-serviço "Profissionais habilitados"',
    !block3.includes('Profissionais habilitados')
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${failed.length === 0 ? '✅ TODOS OS CHECKS PASSARAM' : `❌ ${failed.length} CHECK(S) FALHARAM`} (${checks.length} no total)`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
