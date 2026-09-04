import {
  CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
  pgConversationalV2StateStore,
  SUCCESSOR_REARM_DEBOUNCE_MS_V2,
  SUCCESSOR_MAX_REPROCESSES_V2,
  type ConversationalV2StateStore,
  type DurableSuccessorBatchV2,
} from './stateStore';
import { Sentry } from '../../observability/sentry';
import { runtimeErrorKind } from '../../observability/safeRuntime';
import {
  DEFAULT_MAINTENANCE_IDLE_INTERVAL_MS,
  DEFAULT_MAINTENANCE_JITTER_MS,
  isMaintenanceWorkerEligible,
  readMaintenanceBoolean,
  readMaintenanceIntervalMs,
  startMaintenanceScheduler,
  type MaintenanceSchedulerHandle,
} from '../maintenanceScheduler';

export { SUCCESSOR_REARM_DEBOUNCE_MS_V2 } from './stateStore';

export interface SuccessorProcessorDepsV2 {
  store?: ConversationalV2StateStore;
  process: (batch: DurableSuccessorBatchV2) => Promise<void>;
  fallback: (batch: DurableSuccessorBatchV2) => Promise<void>;
  now?: () => Date;
}

export type SuccessorProcessResultV2 =
  | 'not_claimed'
  | 'completed'
  | 'rearmed'
  | 'fallback_completed';

/**
 * Reprocesso nomeado e idempotente. O CAS queued -> processing garante que dois
 * sweepers não executem o mesmo lote; falha rearma 12s, no máximo duas vezes.
 */
export async function reprocessSuccessorBatchV2(
  successorTurnId: string,
  deps: SuccessorProcessorDepsV2
): Promise<SuccessorProcessResultV2> {
  const store = deps.store ?? pgConversationalV2StateStore;
  const now = deps.now ?? (() => new Date());
  const batch = await store.claimSuccessor(successorTurnId, now());
  if (!batch) return 'not_claimed';

  if (batch.reprocessCount >= SUCCESSOR_MAX_REPROCESSES_V2) {
    await deps.fallback(batch);
    await store.markSuccessorCompleted(batch.successorTurnId, now());
    return 'fallback_completed';
  }

  try {
    await deps.process(batch);
    await store.markSuccessorCompleted(batch.successorTurnId, now());
    return 'completed';
  } catch {
    const rearmed = await store.rearmSuccessor(
      batch.successorTurnId,
      new Date(now().getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2)
    );
    if (rearmed) return 'rearmed';
    await deps.fallback(batch);
    await store.markSuccessorCompleted(batch.successorTurnId, now());
    return 'fallback_completed';
  }
}

export async function sweepSuccessorBatchesV2(
  deps: SuccessorProcessorDepsV2,
  limit = 25
): Promise<number> {
  const store = deps.store ?? pgConversationalV2StateStore;
  const ready = await store.listReadySuccessors(limit, deps.now?.() ?? new Date());
  let processed = 0;
  for (const batch of ready) {
    const result = await reprocessSuccessorBatchV2(batch.successorTurnId, {
      ...deps,
      store,
    });
    if (result !== 'not_claimed') processed += 1;
  }
  return processed;
}

let successorSweepTimer: MaintenanceSchedulerHandle | null = null;
let successorSweepActive = false;
let successorSweepGeneration = 0;

export function startConversationalV2SuccessorSweep(
  deps: SuccessorProcessorDepsV2,
  requestedIntervalMs = CONVERSATIONAL_V2_SWEEP_INTERVAL_MS
): void {
  if (successorSweepActive) return;
  const enabled =
    isMaintenanceWorkerEligible() &&
    readMaintenanceBoolean('CONVERSATIONAL_V2_SUCCESSOR_SWEEP_ENABLED', true);
  const busyIntervalMs = readMaintenanceIntervalMs(
    'CONVERSATIONAL_V2_SUCCESSOR_SWEEP_BUSY_INTERVAL_MS',
    requestedIntervalMs,
    { minimumMs: 1_000 }
  );
  successorSweepTimer = startMaintenanceScheduler({
    worker: 'conversational-v2-successor',
    enabled,
    run: async () => ({ processed: await sweepSuccessorBatchesV2(deps) }),
    idleIntervalMs: readMaintenanceIntervalMs(
      'CONVERSATIONAL_V2_SUCCESSOR_SWEEP_IDLE_INTERVAL_MS',
      DEFAULT_MAINTENANCE_IDLE_INTERVAL_MS,
      { minimumMs: 10 * 60_000 }
    ),
    busyIntervalMs,
    errorBackoffMaxMs: readMaintenanceIntervalMs(
      'CONVERSATIONAL_V2_SUCCESSOR_SWEEP_ERROR_BACKOFF_MAX_MS',
      6 * 60 * 60_000,
      { minimumMs: 1_000 }
    ),
    jitterMs: readMaintenanceIntervalMs(
      'MAINTENANCE_JITTER_MS',
      DEFAULT_MAINTENANCE_JITTER_MS,
      { minimumMs: 1_000, maximumMs: 5 * 60_000 }
    ),
    runImmediately: true,
    errorKind: runtimeErrorKind,
    onError: (error) => {
      Sentry.captureException(new Error('conversational v2 successor sweep failed'), {
        level: 'warning',
        tags: {
          service: 'conversational_v2',
          operation: 'successor_sweep',
          error_kind: runtimeErrorKind(error),
        },
      });
    },
  });
  successorSweepActive = successorSweepTimer !== null;
  successorSweepGeneration += 1;
}

export function stopConversationalV2SuccessorSweep(): void {
  successorSweepActive = false;
  successorSweepGeneration += 1;
  successorSweepTimer?.stop();
  successorSweepTimer = null;
}

export function stopConversationalV2SuccessorSweepForTest(): void {
  stopConversationalV2SuccessorSweep();
}
