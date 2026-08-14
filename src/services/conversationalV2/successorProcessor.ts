import {
  CONVERSATIONAL_V2_SWEEP_INTERVAL_MS,
  nextConversationalV2SweepDelayMs,
  pgConversationalV2StateStore,
  SUCCESSOR_REARM_DEBOUNCE_MS_V2,
  SUCCESSOR_MAX_REPROCESSES_V2,
  type ConversationalV2StateStore,
  type DurableSuccessorBatchV2,
} from './stateStore';

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

let successorSweepTimer: NodeJS.Timeout | null = null;
let successorSweepActive = false;
let successorSweepGeneration = 0;

export function startConversationalV2SuccessorSweep(
  deps: SuccessorProcessorDepsV2,
  requestedIntervalMs = CONVERSATIONAL_V2_SWEEP_INTERVAL_MS
): void {
  if (successorSweepActive) return;
  successorSweepActive = true;
  const generation = ++successorSweepGeneration;
  let nextDelayMs = nextConversationalV2SweepDelayMs(
    requestedIntervalMs,
    true,
    requestedIntervalMs
  );
  const run = async (): Promise<void> => {
    let succeeded = false;
    try {
      await sweepSuccessorBatchesV2(deps);
      succeeded = true;
    } catch {
      // Recuperação de crash permanece fail-closed e aplica backoff.
    }
    if (
      !successorSweepActive ||
      generation !== successorSweepGeneration
    ) return;
    nextDelayMs = nextConversationalV2SweepDelayMs(
      nextDelayMs,
      succeeded,
      requestedIntervalMs
    );
    successorSweepTimer = setTimeout(() => void run(), nextDelayMs);
    successorSweepTimer.unref?.();
  };
  // Uma execução imediata no boot; recorrência só depois de ela terminar.
  void run();
}

export function stopConversationalV2SuccessorSweepForTest(): void {
  successorSweepActive = false;
  successorSweepGeneration += 1;
  if (successorSweepTimer) clearTimeout(successorSweepTimer);
  successorSweepTimer = null;
}
