import type { TenantBotConfig } from '../configProvider';
import { Sentry } from '../observability/sentry';
import type { sendFreeformMessage } from '../whatsappCloudService';
import type { getHistory } from './contextManager';
import type { emitSalesEvent } from './salesEvents';
import type { getSalesConversationReplyFromHistory } from './brainService';
import type { RecoverableSalesConversationRole } from './brainService';
import type { handoffToHuman } from './salesTools';
import type { isConversationPaused } from './pauseService';
import { hasSalesSignupUrl } from './salesGuards';
import { markFollowupPostLink } from './salesFollowups';

export const LAST_RESORT_MESSAGE =
  'Oi! Desculpa a demora — já te respondo direitinho aqui 😊';

const FIRST_ATTEMPT_DELAY_MS = 45_000;
const SECOND_ATTEMPT_DELAY_MS = 3 * 60_000;
const MAX_RECOVERY_ATTEMPTS = 2;

export type RecoveryFailure =
  | { kind: 'brain' }
  | { kind: 'send'; replyText: string };

export interface ScheduleSalesRecoveryInput {
  conversationKey: string;
  phone: string;
  userName: string;
  config: TenantBotConfig;
  failure: RecoveryFailure;
  conversationRole?: RecoverableSalesConversationRole;
}

type TimerHandle = unknown;

export interface SalesRecoveryDeps {
  scheduler: {
    setTimeout: (
      callback: () => void | Promise<void>,
      delayMs: number
    ) => TimerHandle;
    clearTimeout: (timer: TimerHandle) => void;
  };
  clock: { now: () => number };
  getHistory: typeof getHistory;
  regenerate: typeof getSalesConversationReplyFromHistory;
  isPaused: typeof isConversationPaused;
  sendReply: (
    phone: string,
    replyText: string,
    config: TenantBotConfig
  ) => Promise<void>;
  sendPlain: (
    phone: string,
    replyText: string,
    config: TenantBotConfig
  ) => Promise<void>;
  emitEvent: typeof emitSalesEvent;
  handoff: typeof handoffToHuman;
  markPostLink: typeof markFollowupPostLink;
}

interface RecoveryState extends ScheduleSalesRecoveryInput {
  attempt: number;
  running: boolean;
  exhausted: boolean;
  timer: TimerHandle | null;
  startedAtMs: number;
}

const defaultDeps: SalesRecoveryDeps = {
  scheduler: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  },
  clock: { now: () => Date.now() },
  getHistory: async (...args: Parameters<typeof getHistory>) => {
    const { getHistory: loadHistory } = await import('./contextManager');
    return loadHistory(...args);
  },
  regenerate: async (
    ...args: Parameters<typeof getSalesConversationReplyFromHistory>
  ) => {
    const { getSalesConversationReplyFromHistory: regenerate } = await import(
      './brainService'
    );
    return regenerate(...args);
  },
  isPaused: async (...args: Parameters<typeof isConversationPaused>) => {
    const { isConversationPaused: check } = await import(
      './pauseService'
    );
    return check(...args);
  },
  // Import dinâmico evita o ciclo messageHandler -> salesRecovery ->
  // messageHandler durante o carregamento dos módulos.
  sendReply: async (phone, replyText, config) => {
    const { sendConfiguredReply } = await import('../messageHandler');
    await sendConfiguredReply(phone, replyText, config);
  },
  sendPlain: async (...args: Parameters<typeof sendFreeformMessage>) => {
    const { sendFreeformMessage: send } = await import(
      '../whatsappCloudService'
    );
    return send(...args);
  },
  emitEvent: async (...args: Parameters<typeof emitSalesEvent>) => {
    const { emitSalesEvent: emit } = await import('./salesEvents');
    return emit(...args);
  },
  handoff: async (...args: Parameters<typeof handoffToHuman>) => {
    const { handoffToHuman: handoff } = await import('./salesTools');
    return handoff(...args);
  },
  markPostLink: async (...args: Parameters<typeof markFollowupPostLink>) =>
    markFollowupPostLink(...args),
};

let deps: SalesRecoveryDeps = defaultDeps;
const recoveryByConversation = new Map<string, RecoveryState>();

function unrefTimer(timer: TimerHandle): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer?.unref?.();
}

function clearTimer(state: RecoveryState): void {
  if (state.timer === null) return;
  deps.scheduler.clearTimeout(state.timer);
  state.timer = null;
}

function armTimer(state: RecoveryState, delayMs: number): void {
  clearTimer(state);
  const timer = deps.scheduler.setTimeout(
    () => runRecoveryAttempt(state.conversationKey),
    delayMs
  );
  state.timer = timer;
  unrefTimer(timer);
}

function captureRecoveryError(
  operation: string,
  state: RecoveryState,
  error: unknown
): void {
  const synthetic = new Error(`sales recovery ${operation} failed`);
  synthetic.name = 'SalesRecoveryError';
  Sentry.captureException(synthetic, {
    tags: {
      service: 'sales-recovery',
      operation,
      phoneNumberId: state.config.phoneNumberId,
      tenantSlug: state.config.tenantSlug,
      attempt: state.attempt,
      error_kind: error instanceof Error ? error.name : typeof error,
    },
    contexts: {
      sales_recovery: {
        failure_kind: state.failure.kind,
        attempt: state.attempt,
        exhausted: state.exhausted,
        started_at_ms: state.startedAtMs,
      },
    },
  });
}

function emitFailureEvent(state: RecoveryState): void {
  void deps
    .emitEvent(
      state.config.phoneNumberId,
      state.phone,
      'falha_resposta',
      { kind: state.failure.kind, attempt: 0 }
    )
    .catch(() => undefined);
}

function emitRecoveredEvent(
  state: RecoveryState,
  via: 'reexecucao' | 'novo_inbound'
): void {
  void deps
    .emitEvent(
      state.config.phoneNumberId,
      state.phone,
      'recuperado_auto',
      { via, attempt: state.attempt }
    )
    .catch(() => undefined);
}

async function exhaustRecovery(state: RecoveryState): Promise<void> {
  if (recoveryByConversation.get(state.conversationKey) !== state) return;

  state.exhausted = true;
  clearTimer(state);

  try {
    await deps.sendPlain(state.phone, LAST_RESORT_MESSAGE, state.config);
  } catch (error) {
    captureRecoveryError('last_resort_send', state, error);
  }

  try {
    const handoff = await deps.handoff(
      state.phone,
      state.config.phoneNumberId,
      'falha_resposta'
    );
    if (!handoff.success) {
      captureRecoveryError('handoff_unconfirmed', state, new Error('unconfirmed'));
    }
  } catch (error) {
    captureRecoveryError('handoff', state, error);
  }
}

function scheduleNextOrExhaust(state: RecoveryState): Promise<void> | void {
  if (recoveryByConversation.get(state.conversationKey) !== state) return;
  if (state.attempt >= MAX_RECOVERY_ATTEMPTS) {
    return exhaustRecovery(state);
  }
  armTimer(state, SECOND_ATTEMPT_DELAY_MS);
}

async function runRecoveryAttempt(conversationKey: string): Promise<void> {
  const state = recoveryByConversation.get(conversationKey);
  if (!state || state.running || state.exhausted) return;

  state.running = true;
  state.timer = null;
  state.attempt += 1;

  try {
    if (
      await deps.isPaused(
        state.config.phoneNumberId,
        state.phone
      )
    ) {
      cancelSalesRecovery(conversationKey);
      return;
    }

    if (state.failure.kind === 'brain') {
      let history: Awaited<ReturnType<typeof getHistory>>;
      try {
        history = await deps.getHistory(conversationKey);
      } catch (error) {
        captureRecoveryError('history_guard', state, error);
        await scheduleNextOrExhaust(state);
        return;
      }

      const lastMessage = history.at(-1);
      if (!lastMessage || lastMessage.role !== 'user') {
        cancelSalesRecovery(conversationKey);
        return;
      }

      let replyText: string;
      try {
        replyText = await deps.regenerate(
          state.phone,
        state.userName,
        state.config,
        {
          retryPolicy: 'patient',
          expectedConversationRole:
            state.conversationRole ?? 'sales',
        }
      );
      } catch (error) {
        captureRecoveryError('brain', state, error);
        await scheduleNextOrExhaust(state);
        return;
      }

      if (recoveryByConversation.get(conversationKey) !== state) return;
      state.failure = { kind: 'send', replyText };
    }

    if (
      await deps.isPaused(
        state.config.phoneNumberId,
        state.phone
      )
    ) {
      cancelSalesRecovery(conversationKey);
      return;
    }

    try {
      await deps.sendReply(
        state.phone,
        state.failure.replyText,
        state.config
      );
      if (hasSalesSignupUrl(state.failure.replyText)) {
        await deps.markPostLink(
          state.config.phoneNumberId,
          state.phone
        ).catch(() => undefined);
      }
    } catch (error) {
      captureRecoveryError('send', state, error);
      await scheduleNextOrExhaust(state);
      return;
    }

    if (recoveryByConversation.get(conversationKey) !== state) return;
    emitRecoveredEvent(state, 'reexecucao');
    clearSalesRecoveryState(conversationKey);
  } finally {
    state.running = false;
  }
}

export function scheduleSalesRecovery(
  input: ScheduleSalesRecoveryInput
): void {
  const existing = recoveryByConversation.get(input.conversationKey);
  if (existing) {
    if (!existing.exhausted) return;
    clearTimer(existing);
    recoveryByConversation.delete(input.conversationKey);
  }

  const state: RecoveryState = {
    ...input,
    attempt: 0,
    running: false,
    exhausted: false,
    timer: null,
    startedAtMs: deps.clock.now(),
  };
  recoveryByConversation.set(input.conversationKey, state);
  emitFailureEvent(state);
  armTimer(state, FIRST_ATTEMPT_DELAY_MS);
}

/**
 * Inbound novo substitui um recovery agendado. Um incidente já esgotado fica
 * marcado até a resposta normal ser entregue, para `recuperado_auto` poder
 * limpar a flag do Receps.
 */
export function cancelSalesRecovery(conversationKey: string): void {
  const state = recoveryByConversation.get(conversationKey);
  if (!state || state.exhausted) return;
  clearTimer(state);
  recoveryByConversation.delete(conversationKey);
}

export function notifySalesReplyDelivered(
  conversationKey: string,
  via: 'novo_inbound'
): void {
  const state = recoveryByConversation.get(conversationKey);
  if (!state) return;
  emitRecoveredEvent(state, via);
  clearSalesRecoveryState(conversationKey);
}

export function clearSalesRecoveryState(conversationKey: string): void {
  const state = recoveryByConversation.get(conversationKey);
  if (!state) return;
  clearTimer(state);
  recoveryByConversation.delete(conversationKey);
}

// Seams determinísticos dos smokes. Nunca usados pelo runtime de produção.
export function __setSalesRecoveryDepsForTest(
  overrides: Partial<SalesRecoveryDeps>
): void {
  deps = {
    ...defaultDeps,
    ...overrides,
    scheduler: overrides.scheduler ?? defaultDeps.scheduler,
    clock: overrides.clock ?? defaultDeps.clock,
  };
}

export function __getSalesRecoveryStateForTest(
  conversationKey: string
): { attempt: number; running: boolean; exhausted: boolean; kind: RecoveryFailure['kind'] } | null {
  const state = recoveryByConversation.get(conversationKey);
  return state
    ? {
        attempt: state.attempt,
        running: state.running,
        exhausted: state.exhausted,
        kind: state.failure.kind,
      }
    : null;
}

export function __resetSalesRecoveryForTest(): void {
  for (const state of recoveryByConversation.values()) {
    clearTimer(state);
  }
  recoveryByConversation.clear();
  deps = defaultDeps;
}
