process.env.DATABASE_URL ||=
  'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type {
  SalesRecoveryDeps,
  ScheduleSalesRecoveryInput,
} from '../src/services/salesRecovery';
import type {
  SalesEventMetadata,
  SalesEventType,
} from '../src/services/salesEvents';

interface FakeJob {
  id: number;
  delayMs: number;
  callback: () => void | Promise<void>;
  cancelled: boolean;
}

class FakeScheduler {
  private nextId = 1;
  readonly jobs: FakeJob[] = [];

  readonly api: SalesRecoveryDeps['scheduler'] = {
    setTimeout: (callback, delayMs) => {
      const job: FakeJob = {
        id: this.nextId++,
        delayMs,
        callback,
        cancelled: false,
      };
      this.jobs.push(job);
      return job;
    },
    clearTimeout: (timer) => {
      (timer as FakeJob).cancelled = true;
    },
  };

  activeJobs(): FakeJob[] {
    return this.jobs.filter((job) => !job.cancelled);
  }

  async runNext(): Promise<void> {
    const job = this.activeJobs()[0];
    if (!job) throw new Error('Nenhum timer ativo.');
    job.cancelled = true;
    await job.callback();
  }
}

const config: TenantBotConfig = {
  tenantSlug: 'receps-vendas',
  botName: 'Renata',
  botRole: 'sales',
  systemPrompt: '',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-5',
  aiTemperature: 0,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN_VENDAS',
  isActive: true,
};

const conversationKey = 'PN_VENDAS:5516999990000';
const baseInput: ScheduleSalesRecoveryInput = {
  conversationKey,
  phone: '5516999990000',
  userName: 'Lead',
  config,
  failure: { kind: 'brain' },
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
  const recovery = await import('../src/services/salesRecovery');

  // Sucesso da reexecução -----------------------------------------------------
  {
    const scheduler = new FakeScheduler();
    const events: Array<{
      type: SalesEventType;
      metadata?: SalesEventMetadata;
    }> = [];
    const sent: string[] = [];
    const plain: string[] = [];
    let brainCalls = 0;
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      clock: { now: () => 1_000 },
      getHistory: async () => [{ role: 'user', content: 'quero conhecer' }],
      regenerate: async () => {
        brainCalls += 1;
        return 'Resposta natural da Renata';
      },
      sendReply: async (_phone, text) => {
        sent.push(text);
      },
      sendPlain: async (_phone, text) => {
        plain.push(text);
      },
      emitEvent: async (_pnid, _phone, type, metadata) => {
        events.push({ type, metadata });
      },
      handoff: async () => ({ success: true, message: 'ok' }),
    });

    recovery.scheduleSalesRecovery(baseInput);
    check(
      'primeira tentativa agenda em +45s',
      scheduler.activeJobs()[0]?.delayMs === 45_000
    );
    check(
      'falha_resposta emitido ao iniciar incidente',
      events.filter((event) => event.type === 'falha_resposta').length === 1
    );
    await scheduler.runNext();
    check(
      'reexecução envia resposta natural sem desculpas',
      brainCalls === 1 &&
        sent[0] === 'Resposta natural da Renata' &&
        !sent[0]?.toLowerCase().includes('desculp')
    );
    check('último recurso não é usado no sucesso', plain.length === 0);
    check(
      'sucesso emite recuperado_auto via reexecucao',
      events.some(
        (event) =>
          event.type === 'recuperado_auto' &&
          event.metadata?.via === 'reexecucao' &&
          event.metadata?.attempt === 1
      )
    );
    check(
      'estado é limpo depois do sucesso',
      recovery.__getSalesRecoveryStateForTest(conversationKey) === null
    );
    recovery.__resetSalesRecoveryForTest();
  }

  // Duas falhas -> texto puro + handoff + estado exhausted -------------------
  {
    const scheduler = new FakeScheduler();
    const events: SalesEventType[] = [];
    const plain: string[] = [];
    const handoffs: string[] = [];
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      getHistory: async () => [{ role: 'user', content: 'oi' }],
      regenerate: async () => {
        throw new Error('Anthropic indisponível');
      },
      sendReply: async () => undefined,
      sendPlain: async (_phone, text) => {
        plain.push(text);
      },
      emitEvent: async (_pnid, _phone, type) => {
        events.push(type);
      },
      handoff: async (_phone, _pnid, reason) => {
        handoffs.push(reason);
        return { success: true, message: 'ok' };
      },
    });

    recovery.scheduleSalesRecovery(baseInput);
    await scheduler.runNext();
    check(
      'segunda tentativa agenda +3min após a primeira falhar',
      scheduler.activeJobs()[0]?.delayMs === 180_000
    );
    await scheduler.runNext();
    check(
      'esgotamento envia LAST_RESORT_MESSAGE em plain',
      plain.length === 1 && plain[0] === recovery.LAST_RESORT_MESSAGE
    );
    check(
      'esgotamento chama handoffToHuman com falha_resposta',
      handoffs.join(',') === 'falha_resposta'
    );
    check(
      'estado permanece exhausted',
      recovery.__getSalesRecoveryStateForTest(conversationKey)?.exhausted === true
    );
    check(
      'falha_resposta sai exatamente 1x no incidente',
      events.filter((type) => type === 'falha_resposta').length === 1
    );
    recovery.scheduleSalesRecovery(baseInput);
    const replacementState =
      recovery.__getSalesRecoveryStateForTest(conversationKey);
    check(
      'novo schedule substitui incidente exhausted por estado novo',
      replacementState?.attempt === 0 &&
        replacementState.running === false &&
        replacementState.exhausted === false &&
        replacementState.kind === 'brain'
    );
    check(
      'novo incidente emite segundo falha_resposta',
      events.filter((type) => type === 'falha_resposta').length === 2
    );
    check(
      'novo incidente rearma primeira tentativa em +45s',
      scheduler.activeJobs().length === 1 &&
        scheduler.activeJobs()[0]?.delayMs === 45_000
    );
    recovery.__resetSalesRecoveryForTest();
  }

  // Cancelamento por inbound novo --------------------------------------------
  {
    const scheduler = new FakeScheduler();
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      emitEvent: async () => undefined,
    });
    recovery.scheduleSalesRecovery(baseInput);
    recovery.cancelSalesRecovery(conversationKey);
    check(
      'cancelSalesRecovery mata timer e estado',
      scheduler.activeJobs().length === 0 &&
        recovery.__getSalesRecoveryStateForTest(conversationKey) === null
    );
    recovery.__resetSalesRecoveryForTest();
  }

  // Guarda de corrida: assistant já respondeu --------------------------------
  {
    const scheduler = new FakeScheduler();
    const events: SalesEventType[] = [];
    let brainCalls = 0;
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      getHistory: async () => [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'já respondido' },
      ],
      regenerate: async () => {
        brainCalls += 1;
        return 'não deveria';
      },
      emitEvent: async (_pnid, _phone, type) => {
        events.push(type);
      },
    });
    recovery.scheduleSalesRecovery(baseInput);
    await scheduler.runNext();
    check(
      'assistant no fim cancela sem gastar brain',
      brainCalls === 0 &&
        recovery.__getSalesRecoveryStateForTest(conversationKey) === null
    );
    check(
      'guarda não emite recuperado_auto',
      !events.includes('recuperado_auto')
    );
    recovery.__resetSalesRecoveryForTest();
  }

  // Falha de envio: reenvia texto persistido, sem brain ----------------------
  {
    const scheduler = new FakeScheduler();
    const sent: string[] = [];
    let brainCalls = 0;
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      regenerate: async () => {
        brainCalls += 1;
        return 'não deveria';
      },
      sendReply: async (_phone, text) => {
        sent.push(text);
      },
      emitEvent: async () => undefined,
    });
    recovery.scheduleSalesRecovery({
      ...baseInput,
      failure: { kind: 'send', replyText: 'resposta já persistida' },
    });
    await scheduler.runNext();
    check(
      'kind send só reenvia replyText',
      brainCalls === 0 && sent.join(',') === 'resposta já persistida'
    );
    recovery.__resetSalesRecoveryForTest();
  }

  // Callback duplicado não executa duas tentativas em paralelo ---------------
  {
    const scheduler = new FakeScheduler();
    let releaseBrain!: () => void;
    const brainGate = new Promise<void>((resolve) => {
      releaseBrain = resolve;
    });
    let runningBrains = 0;
    let maxRunningBrains = 0;
    let brainCalls = 0;
    let sends = 0;
    recovery.__setSalesRecoveryDepsForTest({
      scheduler: scheduler.api,
      getHistory: async () => [{ role: 'user', content: 'oi' }],
      regenerate: async () => {
        brainCalls += 1;
        runningBrains += 1;
        maxRunningBrains = Math.max(maxRunningBrains, runningBrains);
        await brainGate;
        runningBrains -= 1;
        return 'resposta';
      },
      sendReply: async () => {
        sends += 1;
      },
      emitEvent: async () => undefined,
    });
    recovery.scheduleSalesRecovery(baseInput);
    const callback = scheduler.activeJobs()[0]!.callback;
    const firstRun = Promise.resolve(callback());
    await Promise.resolve();
    const duplicateRun = Promise.resolve(callback());
    releaseBrain();
    await Promise.all([firstRun, duplicateRun]);
    check(
      'duas ativações simultâneas não rodam em paralelo',
      brainCalls === 1 && maxRunningBrains === 1 && sends === 1
    );
    recovery.__resetSalesRecoveryForTest();
  }

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }
  console.log('\n✅ smoke-sales-recovery OK');
}

main().catch((error) => {
  console.error('❌ smoke-sales-recovery falhou:', error);
  process.exitCode = 1;
});
