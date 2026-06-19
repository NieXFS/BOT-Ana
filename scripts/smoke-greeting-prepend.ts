/**
 * FIX 1 (saudação dobrada) — smoke DETERMINÍSTICO, sem rede/OpenAI/DB.
 *
 * Prova que:
 *  - replyAlreadyGreets() detecta abertura com saudação/oferta de ajuda e ignora
 *    o resto da frase.
 *  - maybePrependGreeting() NÃO cola a saudação na frente quando a resposta já
 *    saúda (evita "Como posso ajudar" duplicado), mas CONTINUA prependando
 *    quando a resposta NÃO saúda (ex.: cliente perguntou preço direto).
 *
 * Rodar: npx tsx scripts/smoke-greeting-prepend.ts
 */
// Env dummy ANTES de carregar o módulo: brainService importa contextManager, que
// exige DATABASE_URL no load. O Pool do pg é lazy (não conecta) e nunca é usado.
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

import type { TenantBotConfig } from '../src/configProvider';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const GREETING = 'Olá! Sou a Ana, sua assistente. Como posso te ajudar hoje?';
const config = {
  greetingMessage: GREETING,
  botName: 'Ana',
} as unknown as TenantBotConfig;

async function main() {
  const { replyAlreadyGreets, maybePrependGreeting } = await import(
    '../src/services/brainService'
  );

  // ===== replyAlreadyGreets =====
  record(
    'replyAlreadyGreets("Boa noite! Como posso te ajudar?") → true',
    replyAlreadyGreets('Boa noite! Como posso te ajudar?') === true
  );
  record(
    'replyAlreadyGreets("Olá! Tudo bem?") → true (saudação no início)',
    replyAlreadyGreets('Olá! Tudo bem?') === true
  );
  record(
    'replyAlreadyGreets("Como posso ajudar você hoje?") → true (oferta de ajuda)',
    replyAlreadyGreets('Como posso ajudar você hoje?') === true
  );
  record(
    'replyAlreadyGreets("Claro, o Peeling custa R$ 220.") → false',
    replyAlreadyGreets('Claro, o Peeling custa R$ 220.') === false
  );
  record(
    'replyAlreadyGreets só olha o início — "boa noite" após os ~80 chars não conta',
    replyAlreadyGreets(
      'Consigo sim agendar o seu Peeling Facial para amanhã de manhã, sem nenhum problema mesmo, e te desejo uma boa noite.'
    ) === false
  );

  // ===== maybePrependGreeting =====
  const repliesAlreadyGreets = maybePrependGreeting(
    'Boa noite! Como posso te ajudar?',
    true,
    config
  );
  record(
    'maybePrependGreeting NÃO dobra quando o reply já saúda',
    repliesAlreadyGreets === 'Boa noite! Como posso te ajudar?',
    repliesAlreadyGreets
  );

  const repliesNoGreeting = maybePrependGreeting(
    'Claro, o Peeling custa R$ 220.',
    true,
    config
  );
  record(
    'maybePrependGreeting prepende quando o reply NÃO saúda (preço direto)',
    repliesNoGreeting.startsWith(GREETING) &&
      repliesNoGreeting.includes('Peeling custa'),
    repliesNoGreeting
  );

  record(
    'maybePrependGreeting não prepende fora do 1º contato',
    maybePrependGreeting('Claro, o Peeling custa R$ 220.', false, config) ===
      'Claro, o Peeling custa R$ 220.'
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
