/**
 * Smoke DETERMINÍSTICO da decisão de pausa (helper PURO `pauseDecision`).
 * Sem rede / DB / OpenAI. Regra: carimbo no FUTURO = pausado; passado / null /
 * inválido = não pausado; pausa GERAL (salão) e da CONVERSA são independentes.
 *
 * Rodar: npx tsx scripts/smoke-pause-decision.ts
 */
import {
  decideEscalationAcknowledgementPause,
  isActiveLocalEchoLatch,
  isActivePause,
  isPausedFromState,
  parseStrictEscalationPause,
  parseStrictHumanPause,
} from '../src/services/pauseDecision';

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

// isPausedFromState (global vs conversa vs auto-pausa programada)
check('todos null = não pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: null, schedulePausedUntil: null }, now) === false);
check('global futuro = pausado', isPausedFromState({ globalPausedUntil: future, conversationPausedUntil: null, schedulePausedUntil: null }, now) === true);
check('conversa futuro = pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: future, schedulePausedUntil: null }, now) === true);
check('schedule (programada) futuro = pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: null, schedulePausedUntil: future }, now) === true);
check('schedule passado = não pausado', isPausedFromState({ globalPausedUntil: null, conversationPausedUntil: null, schedulePausedUntil: past }, now) === false);
check('todos passado = não pausado', isPausedFromState({ globalPausedUntil: past, conversationPausedUntil: past, schedulePausedUntil: past }, now) === false);
check('global passado + conversa futuro = pausado', isPausedFromState({ globalPausedUntil: past, conversationPausedUntil: future, schedulePausedUntil: null }, now) === true);
check('só schedule futuro (resto passado) = pausado', isPausedFromState({ globalPausedUntil: past, conversationPausedUntil: past, schedulePausedUntil: future }, now) === true);
check('todos futuro = pausado', isPausedFromState({ globalPausedUntil: future, conversationPausedUntil: future, schedulePausedUntil: future }, now) === true);
check(
  'technicalMaintenance.paused é autoritativo',
  isPausedFromState(
    {
      globalPausedUntil: null,
      conversationPausedUntil: null,
      schedulePausedUntil: null,
      technicalMaintenance: { enabled: true, paused: true, exempt: false },
    },
    now
  ) === true
);
check(
  'ausência de technicalMaintenance preserva o contrato antigo',
  isPausedFromState(
    { globalPausedUntil: null, conversationPausedUntil: null, schedulePausedUntil: null },
    now
  ) === false
);

const typedUntil = new Date(now + 60_000).toISOString();
check(
  'parser estrito de escalationPause rejeita null/primitivo/incompleto',
  parseStrictEscalationPause(null) === null &&
    parseStrictEscalationPause('active') === null &&
    parseStrictEscalationPause({ active: true, questionId: 'q1', version: 1 }) ===
      null &&
    parseStrictEscalationPause({
      active: true,
      questionId: null,
      version: 1,
      until: typedUntil,
    }) === null
);
check(
  'parser estrito de escalationPause aceita ativo e inativo completos',
  parseStrictEscalationPause({
    active: true,
    questionId: 'q1',
    version: 4,
    until: typedUntil,
  })?.questionId === 'q1' &&
    parseStrictEscalationPause({
      active: false,
      questionId: null,
      version: 0,
      until: null,
    })?.active === false
);
check(
  'parser estrito de humanPause rejeita source inválida e incompleto',
  parseStrictHumanPause({
    active: true,
    source: 'ESCALATION',
    until: typedUntil,
  }) === null &&
    parseStrictHumanPause({ active: false }) === null &&
    parseStrictHumanPause({ active: true, source: 'ECHO' }) === null
);
check(
  'parser estrito de humanPause aceita ECHO/MANUAL e inativo',
  parseStrictHumanPause({
    active: true,
    source: 'ECHO',
    until: typedUntil,
  })?.source === 'ECHO' &&
    parseStrictHumanPause({
      active: true,
      source: 'MANUAL',
      until: typedUntil,
    })?.source === 'MANUAL' &&
    parseStrictHumanPause({ active: false, source: null, until: null })
      ?.active === false
);

const localAck = { active: true, questionId: 'q-ack' };
const idle = {
  globalPausedUntil: null as string | null,
  conversationPausedUntil: null as string | null,
  schedulePausedUntil: null as string | null,
};
check(
  'pause-ack sem campos tipados falha fechado',
  decideEscalationAcknowledgementPause({
    expectedQuestionId: 'q-ack',
    local: localAck,
    state: { ...idle, conversationPausedUntil: typedUntil },
    nowMs: now,
  }) === true
);
check(
  'pause-ack só escalationPause correspondente libera',
  decideEscalationAcknowledgementPause({
    expectedQuestionId: 'q-ack',
    local: localAck,
    state: {
      ...idle,
      conversationPausedUntil: typedUntil,
      escalationPause: {
        active: true,
        questionId: 'q-ack',
        version: 1,
        until: typedUntil,
      },
      humanPause: { active: false, source: null, until: null },
    },
    nowMs: now,
  }) === false
);
check(
  'pause-ack com humanPause simultâneo bloqueia',
  decideEscalationAcknowledgementPause({
    expectedQuestionId: 'q-ack',
    local: localAck,
    state: {
      ...idle,
      conversationPausedUntil: typedUntil,
      escalationPause: {
        active: true,
        questionId: 'q-ack',
        version: 1,
        until: typedUntil,
      },
      humanPause: { active: true, source: 'ECHO', until: typedUntil },
    },
    nowMs: now,
  }) === true
);
check(
  'isPausedFromState trata humanPause.active como pausa ordinária',
  isPausedFromState(
    {
      ...idle,
      humanPause: { active: true, source: 'MANUAL', until: typedUntil },
    },
    now
  ) === true
);

const echoLatchUntil = now + 60_000;
check(
  'isActiveLocalEchoLatch só aceita source ECHO no futuro',
  isActiveLocalEchoLatch({ source: 'ECHO', untilMs: echoLatchUntil }, now) ===
    true &&
    isActiveLocalEchoLatch({ source: 'ECHO', untilMs: now }, now) === false &&
    isActiveLocalEchoLatch(
      { source: 'MANUAL', untilMs: echoLatchUntil },
      now
    ) === false &&
    isActiveLocalEchoLatch(null, now) === false
);
check(
  'pause-ack com latch local ECHO bloqueia mesmo com humanPause inativo',
  decideEscalationAcknowledgementPause({
    expectedQuestionId: 'q-ack',
    local: localAck,
    state: {
      ...idle,
      conversationPausedUntil: typedUntil,
      escalationPause: {
        active: true,
        questionId: 'q-ack',
        version: 1,
        until: typedUntil,
      },
      humanPause: { active: false, source: null, until: null },
    },
    nowMs: now,
    localEchoLatch: { source: 'ECHO', untilMs: echoLatchUntil },
  }) === true
);
check(
  'latch ECHO expirado não bloqueia o ack tipado',
  decideEscalationAcknowledgementPause({
    expectedQuestionId: 'q-ack',
    local: localAck,
    state: {
      ...idle,
      conversationPausedUntil: typedUntil,
      escalationPause: {
        active: true,
        questionId: 'q-ack',
        version: 1,
        until: typedUntil,
      },
      humanPause: { active: false, source: null, until: null },
    },
    nowMs: now,
    localEchoLatch: { source: 'ECHO', untilMs: now - 1 },
  }) === false
);

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) falharam.`);
  process.exit(1);
}
console.log('\n✅ smoke-pause-decision OK');
process.exit(0);
