import assert from 'node:assert/strict';
import {
  isMaintenanceWorkerEligible,
  maintenanceResultIndicatesWork,
  readMaintenanceIntervalMs,
  startMaintenanceScheduler,
  type MaintenanceSchedulerLogEvent,
} from '../src/services/maintenanceScheduler';

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  unrefCalled: boolean;
};

const timers: FakeTimer[] = [];
let nowMs = 1_000;

function fakeSetTimeout(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  const timer: FakeTimer = { callback, delayMs, unrefCalled: false };
  timers.push(timer);
  return timer as unknown as ReturnType<typeof setTimeout>;
}

function fakeClearTimeout(timer: ReturnType<typeof setTimeout>): void {
  const index = timers.indexOf(timer as unknown as FakeTimer);
  if (index >= 0) timers.splice(index, 1);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function fireNextTimer(): Promise<FakeTimer> {
  const timer = timers.shift();
  assert.ok(timer, 'esperava um timer agendado');
  nowMs += timer.delayMs;
  timer.callback();
  await settle();
  return timer;
}

function schedulerOptions(
  worker: string,
  run: () => Promise<unknown>,
  events: MaintenanceSchedulerLogEvent[],
  overrides: Partial<Parameters<typeof startMaintenanceScheduler>[0]> = {}
) {
  return {
    worker,
    enabled: true,
    run: async () => (await run()) as never,
    idleIntervalMs: 200,
    busyIntervalMs: 50,
    errorBackoffMaxMs: 500,
    jitterMs: 10,
    initialDelayMs: 100,
    now: () => nowMs,
    random: () => 0.5,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    unref: (timer: ReturnType<typeof setTimeout>) => {
      (timer as unknown as FakeTimer).unrefCalled = true;
    },
    log: (event: MaintenanceSchedulerLogEvent) => events.push(event),
    errorKind: () => 'synthetic_error',
    ...overrides,
  };
}

async function main(): Promise<void> {
  assert.equal(
    isMaintenanceWorkerEligible({ PROCESS_ROLE: 'worker', RUN_MAINTENANCE_WORKERS: 'true' }),
    true,
    'worker elegível'
  );
  assert.equal(
    isMaintenanceWorkerEligible({ PROCESS_ROLE: 'web', RUN_MAINTENANCE_WORKERS: 'true' }),
    false,
    'réplica web não inicia manutenção'
  );
  assert.equal(
    isMaintenanceWorkerEligible({ PROCESS_ROLE: 'worker', RUN_MAINTENANCE_WORKERS: 'false' }),
    false,
    'kill switch desliga manutenção'
  );
  assert.equal(
    readMaintenanceIntervalMs('TEST_INTERVAL', 600, {
      env: { TEST_INTERVAL: '1' },
      minimumMs: 100,
      maximumMs: 500,
      warn: () => undefined,
    }),
    100,
    'intervalo inválido para Neon é elevado ao piso'
  );
  assert.equal(
    maintenanceResultIndicatesWork({ attempted: 0, providerStatus: { attempted: 0 } }),
    false,
    'resultado vazio é idle'
  );
  assert.equal(
    maintenanceResultIndicatesWork({ attempted: 0, providerStatus: { applied: 1 } }),
    true,
    'trabalho aninhado mantém o worker busy'
  );

  let runCount = 0;
  const disabledEvents: MaintenanceSchedulerLogEvent[] = [];
  const disabled = startMaintenanceScheduler(
    schedulerOptions('disabled-worker', async () => {
      runCount += 1;
    }, disabledEvents, { enabled: false })
  );
  assert.equal(disabled, null, 'worker desabilitado não cria handle');
  assert.equal(runCount, 0, 'worker desabilitado não consulta banco');
  assert.equal(timers.length, 0, 'worker desabilitado não cria timer');
  assert.equal(disabledEvents[0]?.event, 'disabled');

  const idleEvents: MaintenanceSchedulerLogEvent[] = [];
  const idle = startMaintenanceScheduler(
    schedulerOptions('idle-worker', async () => ({ attempted: 0 }), idleEvents)
  );
  assert.ok(idle);
  assert.equal(timers[0]?.delayMs, 105, 'jitter fica dentro do limite no primeiro ciclo');
  assert.equal(timers[0]?.unrefCalled, true, 'timer não mantém o processo vivo');
  await fireNextTimer();
  assert.equal(
    idleEvents.at(-1)?.mode,
    'idle',
    'ausência de backlog agenda ciclo idle'
  );
  assert.equal(timers[0]?.delayMs, 205, 'ciclo idle usa a janela longa + jitter');
  idle?.stop();
  assert.equal(timers.length, 0, 'shutdown cancela o próximo ciclo');

  let busyRuns = 0;
  const busyEvents: MaintenanceSchedulerLogEvent[] = [];
  const busy = startMaintenanceScheduler(
    schedulerOptions('busy-worker', async () => {
      busyRuns += 1;
      return busyRuns === 1 ? { attempted: 2, processed: 1 } : { attempted: 0 };
    }, busyEvents, { runImmediately: true, random: () => 0 })
  );
  await settle();
  assert.equal(busyRuns, 1, 'execução imediata ocorre uma vez');
  assert.equal(busyEvents.at(-1)?.mode, 'busy', 'backlog agenda modo busy');
  assert.equal(timers[0]?.delayMs, 50, 'modo busy usa a janela curta');
  await fireNextTimer();
  assert.equal(busyRuns, 2, 'o segundo ciclo só começa após o primeiro terminar');
  assert.equal(busyEvents.at(-1)?.mode, 'idle', 'backlog esvaziado volta ao idle');
  busy?.stop();

  let failingRuns = 0;
  const failureEvents: MaintenanceSchedulerLogEvent[] = [];
  const failing = startMaintenanceScheduler(
    schedulerOptions('failure-worker', async () => {
      failingRuns += 1;
      throw new Error('synthetic only');
    }, failureEvents, {
      runImmediately: true,
      busyIntervalMs: 10,
      errorBackoffMaxMs: 25,
      jitterMs: 10,
      random: () => 1,
    })
  );
  await settle();
  assert.equal(failingRuns, 1);
  assert.equal(failureEvents.at(-2)?.event, 'failed');
  assert.equal(timers[0]?.delayMs, 10, 'primeiro backoff não passa do teto efetivo');
  await fireNextTimer();
  assert.equal(failingRuns, 2);
  assert.equal(timers[0]?.delayMs, 20, 'backoff dobra antes do teto');
  await fireNextTimer();
  assert.equal(failingRuns, 3);
  assert.equal(timers[0]?.delayMs, 25, 'backoff respeita o teto mesmo com jitter');
  failing?.stop();

  let reportedFailureRuns = 0;
  const reportedFailureEvents: MaintenanceSchedulerLogEvent[] = [];
  const reportedFailure = startMaintenanceScheduler(
    schedulerOptions('reported-failure-worker', async () => {
      reportedFailureRuns += 1;
      if (reportedFailureRuns <= 3) {
        return {
          attempted: 3,
          failed: true,
          failedCount: reportedFailureRuns === 1 ? 2 : 1,
        };
      }
      return { attempted: 0, failedCount: 0 };
    }, reportedFailureEvents, {
      runImmediately: true,
      busyIntervalMs: 10,
      errorBackoffMaxMs: 25,
      jitterMs: 10,
      random: () => 1,
    })
  );
  await settle();
  assert.equal(reportedFailureRuns, 1, 'ciclo com falha capturada começou');
  assert.equal(
    reportedFailureEvents.filter(
      (event) => event.event === 'failed' && event.reason === 'cycle_reported_failure'
    ).length,
    1,
    'failed:true não é classificado como ciclo saudável'
  );
  assert.equal(
    reportedFailureEvents.find((event) => event.event === 'failed')?.counts?.failedCount,
    2,
    'failedCount do worker é preservado na telemetria'
  );
  assert.equal(timers[0]?.delayMs, 10, 'falha capturada usa primeiro backoff');
  await fireNextTimer();
  assert.equal(reportedFailureRuns, 2);
  assert.equal(timers[0]?.delayMs, 20, 'backoff de falha capturada dobra');
  await fireNextTimer();
  assert.equal(reportedFailureRuns, 3);
  assert.equal(timers[0]?.delayMs, 25, 'backoff de falha capturada respeita teto');
  await fireNextTimer();
  assert.equal(reportedFailureRuns, 4, 'o ciclo seguinte tenta a recuperação');
  assert.equal(
    reportedFailureEvents.filter(
      (event) => event.event === 'failed' && event.reason === 'cycle_reported_failure'
    ).length,
    3,
    'as três falhas retornadas foram observadas'
  );
  assert.equal(
    reportedFailureEvents.at(-2)?.event,
    'finished',
    'resultado saudável após falhas registra recuperação'
  );
  assert.equal(reportedFailureEvents.at(-2)?.mode, 'idle');
  assert.equal(reportedFailure?.getState().consecutiveFailures, 0);
  assert.equal(timers[0]?.delayMs, 211, 'recuperação abandona o backoff e volta ao idle');
  reportedFailure?.stop();

  let releaseStopped: (() => void) | undefined;
  let stoppedRuns = 0;
  const stoppedInFlight = startMaintenanceScheduler(
    schedulerOptions('stopped-in-flight-worker', () => {
      stoppedRuns += 1;
      return new Promise<void>((resolve) => {
        releaseStopped = resolve;
      });
    }, [], { runImmediately: true, jitterMs: 0 })
  );
  await settle();
  assert.equal(stoppedRuns, 1, 'worker em voo começou antes do stop');
  assert.equal(stoppedInFlight?.getState().inFlight, true);
  stoppedInFlight?.stop();
  assert.equal(stoppedInFlight?.isActive(), false, 'stop desativa worker em voo');
  releaseStopped?.();
  await settle();
  assert.equal(
    timers.length,
    0,
    'stop durante execução não reagenda depois que a promise resolve'
  );
  assert.equal(stoppedInFlight?.getState().inFlight, false);

  const singletonEvents: MaintenanceSchedulerLogEvent[] = [];
  const first = startMaintenanceScheduler(
    schedulerOptions('singleton-worker', async () => ({ attempted: 0 }), singletonEvents)
  );
  const second = startMaintenanceScheduler(
    schedulerOptions('singleton-worker', async () => ({ attempted: 0 }), singletonEvents)
  );
  assert.strictEqual(first, second, 'duas chamadas para o mesmo worker reutilizam o handle');
  assert.equal(timers.length, 1, 'duas chamadas não criam dois loops');
  first?.stop();

  let releaseFirst: (() => void) | undefined;
  let slowRuns = 0;
  const slowEvents: MaintenanceSchedulerLogEvent[] = [];
  const slow = startMaintenanceScheduler(
    schedulerOptions('slow-worker', () => {
      slowRuns += 1;
      return new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
    }, slowEvents, { runImmediately: true, jitterMs: 0 })
  );
  await settle();
  assert.equal(slowRuns, 1, 'execução lenta começou');
  assert.equal(slow?.getState().inFlight, true, 'execução lenta fica marcada in-flight');
  assert.equal(timers.length, 0, 'execução lenta não agenda ciclo sobreposto');
  releaseFirst?.();
  await settle();
  assert.equal(timers.length, 1, 'só agenda depois da execução lenta');
  await fireNextTimer();
  assert.equal(slowRuns, 2, 'novo ciclo começa após o anterior');
  slow?.stop();
  assert.equal(timers.length, 0);

  assert.equal(
    idleEvents.filter((event) => event.event === 'finished').length,
    1,
    'telemetria registra término com modo e contadores, sem texto livre'
  );
  console.log(
    'smoke:maintenance-scheduler PASS (inclui falha capturada, backoff/teto, recuperação e stop in-flight)'
  );
}

main().catch((error) => {
  console.error('smoke:maintenance-scheduler FAIL', error);
  process.exitCode = 1;
});
