/**
 * Smoke DETERMINÍSTICO da decisão de atividade da conversa (§8.1) — funções
 * PURAS `decideConversationActivity` + `customerPhoneVariants`. Sem DB/rede/OpenAI.
 *
 * Regra: última mensagem `user` = inbound sem resposta (cliente esperando);
 * `assistant` (resposta da Ana OU echo do humano "[atendente] ") = respondida;
 * fluxoAtivo = atividade dentro da janela (~5 min). customerPhoneVariants gera
 * cru + só-dígitos pra o lookup casar `+5511…` vs wa_id `5511…`.
 *
 * Rodar: npx tsx scripts/smoke-conversation-activity.ts
 */
import {
  decideConversationActivity,
  customerPhoneVariants,
  FLUXO_ATIVO_WINDOW_MS,
} from '../src/services/conversationActivity';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const now = Date.UTC(2026, 5, 28, 12, 0, 0); // âncora fixa (determinístico)
const recent = now - 60_000; // 1 min atrás (dentro da janela de 5 min)
const old = now - 10 * 60_000; // 10 min atrás (fora)

// --- última = user (cliente esperando) -------------------------------------
const a = decideConversationActivity({ lastRole: 'user', lastActivityAtMs: recent }, now);
check('última=user → ultimoInboundSemResposta=true', a.ultimoInboundSemResposta === true);
check('atividade recente → fluxoAtivo=true', a.fluxoAtivo === true);
check('ultimaAtividadeEm = ISO da última atividade', a.ultimaAtividadeEm === new Date(recent).toISOString());

// --- última = assistant (resposta da Ana OU echo "[atendente] ") ------------
const b = decideConversationActivity({ lastRole: 'assistant', lastActivityAtMs: recent }, now);
check('última=assistant → ultimoInboundSemResposta=false', b.ultimoInboundSemResposta === false);
check('assistant recente também é fluxoAtivo=true', b.fluxoAtivo === true);

// --- atividade antiga → fluxoAtivo false (mas ainda reporta o resto) --------
const c = decideConversationActivity({ lastRole: 'user', lastActivityAtMs: old }, now);
check('atividade antiga → fluxoAtivo=false', c.fluxoAtivo === false);
check('atividade antiga ainda reporta ultimoInboundSemResposta=true', c.ultimoInboundSemResposta === true);
check('atividade antiga ainda devolve ultimaAtividadeEm', c.ultimaAtividadeEm === new Date(old).toISOString());

// --- sem histórico (null) → tudo "vazio" -----------------------------------
const d = decideConversationActivity({ lastRole: null, lastActivityAtMs: null }, now);
check('sem histórico → ultimoInboundSemResposta=false', d.ultimoInboundSemResposta === false);
check('sem histórico → ultimaAtividadeEm=null', d.ultimaAtividadeEm === null);
check('sem histórico → fluxoAtivo=false', d.fluxoAtivo === false);

// --- borda da janela (limite inclusivo) ------------------------------------
const e = decideConversationActivity({ lastRole: 'user', lastActivityAtMs: now - FLUXO_ATIVO_WINDOW_MS }, now);
check('exatamente no limite da janela → fluxoAtivo=true (<=)', e.fluxoAtivo === true);
const f = decideConversationActivity({ lastRole: 'user', lastActivityAtMs: now - FLUXO_ATIVO_WINDOW_MS - 1 }, now);
check('1ms além do limite → fluxoAtivo=false', f.fluxoAtivo === false);

// --- customerPhoneVariants -------------------------------------------------
const vCanon = customerPhoneVariants('+5511999998888');
check(
  'variants: canônico +55 inclui cru e só-dígitos (2 variantes)',
  vCanon.includes('+5511999998888') && vCanon.includes('5511999998888') && vCanon.length === 2
);
const vWaId = customerPhoneVariants('5511999998888');
check('variants: wa_id sem + → 1 variante (deduplicada)', vWaId.length === 1 && vWaId[0] === '5511999998888');
check('variants: formatado → inclui só-dígitos', customerPhoneVariants('(11) 99999-8888').includes('11999998888'));
check('variants: vazio/espaços → []', customerPhoneVariants('   ').length === 0);

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) falharam.`);
  process.exit(1);
}
console.log('\n✅ smoke-conversation-activity OK');
process.exit(0);
