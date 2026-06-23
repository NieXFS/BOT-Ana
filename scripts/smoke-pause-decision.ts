/**
 * Smoke DETERMINÍSTICO da decisão de pausa (helper PURO `pauseDecision`).
 * Sem rede / DB / OpenAI. Regra: carimbo no FUTURO = pausado; passado / null /
 * inválido = não pausado; pausa GERAL (salão) e da CONVERSA são independentes.
 *
 * Rodar: npx tsx scripts/smoke-pause-decision.ts
 */
import { isActivePause, isPausedFromState } from '../src/services/pauseDecision';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const now = Date.UTC(2026, 5, 22, 12, 0, 0); // âncora fixa (determinístico)
const future = new Date(now + 60_000).toISOString();
const past = new Date(now - 60_000).toISOString();

// isActivePause
check('futuro = pausado', isActivePause(future, now) === true);
check('passado = não pausado', isActivePause(past, now) === false);
check('exatamente agora = não pausado (estritamente futuro)', isActivePause(new Date(now).toISOString(), now) === false);
check('null = não pausado', isActivePause(null, now) === false);
check('undefined = não pausado', isActivePause(undefined, now) === false);
check('string vazia = não pausado', isActivePause('', now) === false);
check('data inválida = não pausado', isActivePause('not-a-date', now) === false);

// isPausedFromState (global vs conversa)
check('ambos null = não pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: null }, now) === false);
check('global futuro = pausado', isPausedFromState({ globalPausedUntil: future, conversationPausedUntil: null }, now) === true);
check('conversa futuro = pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: future }, now) === true);
check('ambos passado = não pausado', isPausedFromState({ globalPausedUntil: past, conversationPausedUntil: past }, now) === false);
check('global passado + conversa futuro = pausado', isPausedFromState({ globalPausedUntil: past, conversationPausedUntil: future }, now) === true);
check('ambos futuro = pausado', isPausedFromState({ globalPausedUntil: future, conversationPausedUntil: future }, now) === true);

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) falharam.`);
  process.exit(1);
}
console.log('\n✅ smoke-pause-decision OK');
process.exit(0);
