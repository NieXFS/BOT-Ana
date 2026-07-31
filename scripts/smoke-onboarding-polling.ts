/**
 * Polling determinístico do Embedded Signup. Scheduler falso: zero timers
 * reais, zero HTTP/DB/WhatsApp.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.ERP_API_TOKEN =
  process.env.ERP_API_TOKEN ?? 'smoke-onboarding-token';

type Scheduled = {
  id: number;
  delayMs: number;
  callback: () => void | Promise<void>;
};

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const polling = await import(
    '../src/services/onboardingPolling'
  );
  const config = {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'manual',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.4,
    aiMaxTokens: 700,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PNID',
    isActive: true,
  };
  const key = 'PNID:5516999990000';
  const phone = '5516999990000';

  let nextId = 1;
  const timers = new Map<number, Scheduled>();
  const delays: number[] = [];
  let paused = false;
  let ready = false;
  let statusCalls = 0;
  const notices: string[] = [];
  let handoffs = 0;

  const scheduler = {
    setTimeout(
      callback: () => void | Promise<void>,
      delayMs: number
    ): { id: number; unref: () => void } {
      const id = nextId++;
      timers.set(id, { id, delayMs, callback });
      delays.push(delayMs);
      return { id, unref: () => undefined };
    },
    clearTimeout(handle: unknown): void {
      const id = (handle as { id?: number })?.id;
      if (typeof id === 'number') timers.delete(id);
    },
  };

  async function fireNext(): Promise<void> {
    const scheduled = [...timers.values()][0];
    if (!scheduled) throw new Error('nenhum timer para disparar');
    timers.delete(scheduled.id);
    await scheduled.callback();
  }

  function installDeps(): void {
    polling.__setOnboardingPollingDepsForTest({
      scheduler,
      getStatus: async () => {
        statusCalls += 1;
        return {
          success: true,
          status: {
            ready,
            connected: ready,
            coexistence: false,
            connectedAt: ready ? new Date().toISOString() : null,
            source: ready ? 'EMBEDDED_SIGNUP' : null,
            pollBudgetHint: 20,
          },
        };
      },
      isPaused: async () => paused,
      notify: async (_to, text) => {
        notices.push(text);
      },
      handoff: async () => {
        handoffs += 1;
      },
    });
  }

  function reset(): void {
    polling.__resetOnboardingPollingForTest();
    timers.clear();
    delays.length = 0;
    paused = false;
    ready = false;
    statusCalls = 0;
    notices.length = 0;
    handoffs = 0;
    installDeps();
  }

  console.log('▶ intervalo, teto e duas rodadas');
  reset();
  check(
    'sendConnectLink inicia a primeira rodada',
    polling.startOnboardingPolling(key, phone, config) ===
      'started'
  );
  for (
    let cycle = 0;
    cycle < polling.ONBOARDING_POLL_MAX_CYCLES;
    cycle += 1
  ) {
    await fireNext();
  }
  const afterRoundOne =
    polling.__getOnboardingPollingStateForTest(key);
  check(
    'cada ciclo usa intervalo exato de 15s',
    delays.length === polling.ONBOARDING_POLL_MAX_CYCLES &&
      delays.every(
        (delay) => delay === polling.ONBOARDING_POLL_INTERVAL_MS
      )
  );
  check(
    'primeira rodada faz exatamente 20 consultas e para',
    statusCalls === 20 &&
      afterRoundOne?.phase === 'waiting_inbound' &&
      timers.size === 0
  );
  check(
    'ao esgotar pergunta em vez de continuar consultando',
    notices.length === 1 &&
      notices[0].includes('conseguiu terminar')
  );
  check(
    'não inicia segunda rodada sem novo inbound concluído',
    polling.resumeOnboardingPolling(key, phone, config) ===
      'waiting_inbound'
  );

  polling.noteOnboardingInbound(key, 'Terminei tudo por aqui');
  check(
    'inbound de conclusão habilita a segunda rodada',
    polling.resumeOnboardingPolling(key, phone, config) ===
      'started'
  );
  for (
    let cycle = 0;
    cycle < polling.ONBOARDING_POLL_MAX_CYCLES;
    cycle += 1
  ) {
    await fireNext();
  }
  const afterRoundTwo =
    polling.__getOnboardingPollingStateForTest(key);
  check(
    'segunda rodada também respeita 20 ciclos',
    statusCalls === 40 &&
      afterRoundTwo?.round === 2 &&
      afterRoundTwo.phase === 'handed_off'
  );
  check(
    'depois de duas rodadas faz um único handoff',
    handoffs === 1 && timers.size === 0
  );
  check(
    'terceira rodada é bloqueada em código',
    polling.startOnboardingPolling(key, phone, config) ===
      'max_rounds'
  );

  console.log('▶ cancelamento por novo inbound');
  reset();
  polling.startOnboardingPolling(key, phone, config);
  polling.noteOnboardingInbound(key, 'Tenho uma dúvida antes');
  const afterInbound =
    polling.__getOnboardingPollingStateForTest(key);
  check(
    'novo inbound cancela timer ativo',
    afterInbound?.phase === 'waiting_inbound' &&
      !afterInbound.secondRoundAllowed &&
      timers.size === 0
  );

  console.log('▶ cancelamento por pausa');
  reset();
  polling.startOnboardingPolling(key, phone, config);
  paused = true;
  await fireNext();
  check(
    'pausa remove estado e não consulta status',
    polling.__getOnboardingPollingStateForTest(key) === null &&
      statusCalls === 0 &&
      timers.size === 0
  );

  console.log('▶ cancelamento por ready:true');
  reset();
  polling.startOnboardingPolling(key, phone, config);
  ready = true;
  await fireNext();
  check(
    'ready encerra polling no primeiro ciclo',
    statusCalls === 1 &&
      polling.__getOnboardingPollingStateForTest(key) === null &&
      timers.size === 0
  );
  check(
    'ready gera confirmação uma única vez',
    notices.length === 1 && notices[0].startsWith('Conectou!')
  );

  console.log('▶ reset não deixa timer vazando');
  reset();
  polling.startOnboardingPolling(key, phone, config);
  check('timer armado antes do reset', timers.size === 1);
  polling.__resetOnboardingPollingForTest();
  check(
    'reset limpa Map e timer',
    timers.size === 0 &&
      polling.__getOnboardingPollingStateForTest(key) === null
  );

  if (failures > 0) {
    throw new Error(
      `smoke-onboarding-polling falhou: ${failures} check(s)`
    );
  }
  console.log('\n✅ smoke-onboarding-polling OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

