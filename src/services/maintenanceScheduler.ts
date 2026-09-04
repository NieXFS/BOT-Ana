/**
 * Scheduler comum para tarefas de recuperação que consultam o Postgres.
 *
 * O caminho normal das features é orientado por eventos; este módulo só agenda
 * a recuperação de fatos que já foram persistidos. A execução seguinte só é
 * criada depois que a anterior termina, portanto não há sobreposição mesmo
 * quando uma consulta ou uma chamada HTTP demora mais que o intervalo.
 */

export const DEFAULT_MAINTENANCE_IDLE_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_MAINTENANCE_BUSY_INTERVAL_MS = 60_000;
export const DEFAULT_MAINTENANCE_ERROR_BACKOFF_MAX_MS = 30 * 60_000;
export const DEFAULT_MAINTENANCE_JITTER_MS = 60_000;
export const MIN_MAINTENANCE_IDLE_INTERVAL_MS = 10 * 60_000;
export const MAX_MAINTENANCE_JITTER_MS = 5 * 60_000;

export type MaintenanceScheduleMode = 'idle' | 'busy' | 'error';

export interface MaintenanceCycleResult {
  attempted?: number;
  processed?: number;
  delivered?: number;
  acknowledged?: number;
  confirmed?: number;
  reconciled?: number;
  unknownMarked?: number;
  successorsReady?: number;
  sent?: number;
  queued?: number;
  failedCount?: number;
  remaining?: number;
  busy?: boolean;
  /** Permite integrar um ciclo que já captura o erro internamente. */
  failed?: boolean;
}

export interface MaintenanceSchedulerLogEvent {
  worker: string;
  event: 'disabled' | 'scheduled' | 'started' | 'finished' | 'failed' | 'stopped';
  mode?: MaintenanceScheduleMode;
  reason?: string;
  delayMs?: number;
  durationMs?: number;
  failureCount?: number;
  busy?: boolean;
  counts?: Record<string, number>;
  errorKind?: string;
}

export interface MaintenanceSchedulerState {
  active: boolean;
  timerScheduled: boolean;
  inFlight: boolean;
  consecutiveFailures: number;
  lastMode: MaintenanceScheduleMode | null;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const SCHEDULER_REGISTRY_KEY = Symbol.for(
  'receps.maintenance.scheduler.registry.v1'
);

function schedulerRegistry(): Map<string, MaintenanceSchedulerHandle> {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[SCHEDULER_REGISTRY_KEY] as
    | Map<string, MaintenanceSchedulerHandle>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, MaintenanceSchedulerHandle>();
  globals[SCHEDULER_REGISTRY_KEY] = created;
  return created;
}

export interface MaintenanceSchedulerOptions {
  worker: string;
  enabled: boolean;
  run: () => Promise<MaintenanceCycleResult | void>;
  idleIntervalMs: number;
  busyIntervalMs: number;
  errorBackoffMaxMs: number;
  jitterMs?: number;
  initialDelayMs?: number;
  runImmediately?: boolean;
  now?: () => number;
  random?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  unref?: (timer: TimerHandle) => void;
  log?: (event: MaintenanceSchedulerLogEvent) => void;
  errorKind?: (error: unknown) => string;
  onError?: (error: unknown) => void;
}

export interface MaintenanceSchedulerHandle {
  stop(): void;
  isActive(): boolean;
  getState(): MaintenanceSchedulerState;
}

/**
 * Cancela todos os schedulers registrados neste processo.
 *
 * O shutdown do processo combinado usa esta fronteira antes de fechar o HTTP:
 * além dos workers conhecidos pelo webhook, ela também cobre workers opcionais
 * carregados por módulos V2 e qualquer worker novo que use a casca comum. A
 * cópia do registro é importante porque `stop()` remove o próprio handle do
 * mapa.
 */
export function stopAllMaintenanceSchedulers(): void {
  const registry = schedulerRegistry();
  for (const handle of [...registry.values()]) {
    handle.stop();
  }
}

const COUNT_KEYS = [
  'attempted',
  'processed',
  'delivered',
  'acknowledged',
  'confirmed',
  'reconciled',
  'unknownMarked',
  'successorsReady',
  'sent',
  'queued',
  'failedCount',
  'remaining',
] as const;

function defaultLog(event: MaintenanceSchedulerLogEvent): void {
  try {
    console.info(`[maintenance] ${JSON.stringify(event)}`);
  } catch {
    // Observability cannot make a recovery worker fail.
  }
}

function normalizedBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
    return false;
  }
  return fallback;
}

export function readMaintenanceBoolean(
  name: string,
  fallback = true,
  env: Record<string, string | undefined> = process.env
): boolean {
  return normalizedBoolean(env[name], fallback);
}

export function readMaintenanceIntervalMs(
  name: string,
  fallback: number,
  options: {
    minimumMs?: number;
    maximumMs?: number;
    env?: Record<string, string | undefined>;
    warn?: (message: string) => void;
  } = {}
): number {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`[maintenance] ${name} inválido; usando o default configurado.`);
    return fallback;
  }

  const minimumMs = options.minimumMs ?? 1_000;
  const maximumMs = options.maximumMs ?? Number.MAX_SAFE_INTEGER;
  const clamped = Math.min(maximumMs, Math.max(minimumMs, Math.floor(parsed)));
  if (clamped !== parsed) {
    warn(`[maintenance] ${name} fora dos limites; valor foi ajustado.`);
  }
  return clamped;
}

/**
 * No runtime combinado, `worker` identifica a única instância que pode ser
 * dona das recuperações e ainda pode servir o webhook. Uma instância `web`
 * continua atendendo HTTP, mas não inicia timers de manutenção. O default
 * `worker` preserva o comportamento anterior para invocações diretas.
 */
export function isMaintenanceWorkerEligible(
  env: Record<string, string | undefined> = process.env
): boolean {
  const role = env.PROCESS_ROLE?.trim().toLowerCase() || 'worker';
  return (
    role === 'worker' &&
    readMaintenanceBoolean('RUN_MAINTENANCE_WORKERS', true, env)
  );
}

function numericCounts(result: unknown): Record<string, number> {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of COUNT_KEYS) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      counts[key] = value;
    }
  }

  const providerStatus = record.providerStatus;
  if (providerStatus && typeof providerStatus === 'object') {
    const nested = providerStatus as Record<string, unknown>;
    for (const [key, value] of [
      ['providerAttempted', nested.attempted],
      ['providerApplied', nested.applied],
      ['providerUnmatched', nested.unmatched],
    ] as const) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        counts[key] = value;
      }
    }
  }
  return counts;
}

export function maintenanceResultIndicatesWork(result: unknown): boolean {
  if (result === true) return true;
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.busy === true) return true;
  if (typeof record.remaining === 'number' && record.remaining > 0) return true;
  return Object.values(numericCounts(result)).some((value) => value > 0);
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function startMaintenanceScheduler(
  options: MaintenanceSchedulerOptions
): MaintenanceSchedulerHandle | null {
  const log = options.log ?? defaultLog;
  if (!options.enabled) {
    log({ worker: options.worker, event: 'disabled', reason: 'disabled_by_config' });
    return null;
  }

  const registry = schedulerRegistry();
  const existing = registry.get(options.worker);
  if (existing?.isActive()) return existing;
  if (existing) registry.delete(options.worker);

  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const scheduleTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const unref = options.unref ?? ((timer) => (timer as NodeJS.Timeout).unref?.());
  const jitterMs = Math.max(0, Math.floor(options.jitterMs ?? DEFAULT_MAINTENANCE_JITTER_MS));

  let active = true;
  let timer: TimerHandle | null = null;
  let inFlight = false;
  let consecutiveFailures = 0;
  let lastMode: MaintenanceScheduleMode | null = null;

  const schedule = (
    mode: MaintenanceScheduleMode,
    baseDelayMs: number,
    reason: string,
    maximumDelayMs?: number
  ): void => {
    if (!active) return;
    const safeBaseDelayMs = Math.max(0, Math.floor(baseDelayMs));
    const jitter = jitterMs > 0
      ? Math.floor(boundedRandom(random) * (jitterMs + 1))
      : 0;
    const delayMs = Math.min(
      safeBaseDelayMs + jitter,
      maximumDelayMs ?? Number.MAX_SAFE_INTEGER
    );
    lastMode = mode;
    timer = scheduleTimer(() => {
      timer = null;
      void runCycle();
    }, delayMs);
    unref(timer);
    log({
      worker: options.worker,
      event: 'scheduled',
      mode,
      reason,
      delayMs,
    });
  };

  const runCycle = async (): Promise<void> => {
    if (!active || inFlight) return;
    inFlight = true;
    const startedAt = now();
    log({ worker: options.worker, event: 'started' });
    try {
      const result = await options.run();
      const durationMs = Math.max(0, now() - startedAt);
      const counts = numericCounts(result);
      const resultFailed =
        Boolean(result && typeof result === 'object' && (result as MaintenanceCycleResult).failed);
      if (resultFailed) {
        consecutiveFailures += 1;
        const backoffMs = Math.min(
          Math.max(1, options.errorBackoffMaxMs),
          Math.max(1, options.busyIntervalMs) * 2 ** Math.min(consecutiveFailures - 1, 30)
        );
        log({
          worker: options.worker,
          event: 'failed',
          mode: 'error',
          reason: 'cycle_reported_failure',
          durationMs,
          failureCount: consecutiveFailures,
          delayMs: backoffMs,
          counts,
        });
        schedule('error', backoffMs, 'error_backoff', backoffMs);
      } else {
        consecutiveFailures = 0;
        const busy = maintenanceResultIndicatesWork(result);
        log({
          worker: options.worker,
          event: 'finished',
          mode: busy ? 'busy' : 'idle',
          reason: busy ? 'work_found' : 'no_work',
          durationMs,
          busy,
          counts,
        });
        schedule(
          busy ? 'busy' : 'idle',
          busy ? options.busyIntervalMs : options.idleIntervalMs,
          busy ? 'work_found' : 'no_work'
        );
      }
    } catch (error) {
      consecutiveFailures += 1;
      const durationMs = Math.max(0, now() - startedAt);
      const backoffMs = Math.min(
        Math.max(1, options.errorBackoffMaxMs),
        Math.max(1, options.busyIntervalMs) * 2 ** Math.min(consecutiveFailures - 1, 30)
      );
      log({
        worker: options.worker,
        event: 'failed',
        mode: 'error',
        reason: 'run_rejected',
        durationMs,
        failureCount: consecutiveFailures,
        delayMs: backoffMs,
        errorKind: options.errorKind?.(error) ?? 'unknown',
      });
      try {
        options.onError?.(error);
      } catch {
        // A Sentry/logging failure must not stop recovery scheduling.
      }
      schedule('error', backoffMs, 'error_backoff', backoffMs);
    } finally {
      inFlight = false;
    }
  };

  const handle: MaintenanceSchedulerHandle = {
    stop(): void {
      if (!active) return;
      active = false;
      if (registry.get(options.worker) === handle) {
        registry.delete(options.worker);
      }
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      log({ worker: options.worker, event: 'stopped', reason: 'shutdown' });
    },
    isActive(): boolean {
      return active;
    },
    getState(): MaintenanceSchedulerState {
      return {
        active,
        timerScheduled: timer !== null,
        inFlight,
        consecutiveFailures,
        lastMode,
      };
    },
  };
  registry.set(options.worker, handle);

  if (options.runImmediately) {
    void runCycle();
  } else {
    schedule(
      'idle',
      options.initialDelayMs ?? options.idleIntervalMs,
      'initial'
    );
  }

  return handle;
}
