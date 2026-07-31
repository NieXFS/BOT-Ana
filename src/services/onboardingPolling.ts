import type { TenantBotConfig } from '../configProvider';
import { Sentry } from '../observability/sentry';
import { normalizeForMatch } from './salesOpeners';
import {
  getWhatsappStatus,
  type OnboardingWhatsappStatus,
} from './onboardingTools';
import { isConversationPaused } from './pauseService';

export const ONBOARDING_POLL_INTERVAL_MS = 15_000;
export const ONBOARDING_POLL_MAX_CYCLES = 20;
export const ONBOARDING_POLL_MAX_ROUNDS = 2;

type TimerHandle = unknown;

type PollingScheduler = {
  setTimeout: (
    callback: () => void | Promise<void>,
    delayMs: number
  ) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
};

export interface OnboardingPollingDeps {
  scheduler: PollingScheduler;
  getStatus: (
    customerPhone: string
  ) => ReturnType<typeof getWhatsappStatus>;
  isPaused: (
    phoneNumberId: string,
    customerPhone: string
  ) => Promise<boolean>;
  notify: (
    customerPhone: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  handoff: (
    customerPhone: string,
    config: TenantBotConfig
  ) => Promise<void>;
}

type PollingPhase =
  | 'polling'
  | 'waiting_inbound'
  | 'ready'
  | 'handed_off';

interface OnboardingPollingState {
  conversationKey: string;
  customerPhone: string;
  config: TenantBotConfig;
  round: number;
  cycles: number;
  phase: PollingPhase;
  secondRoundAllowed: boolean;
  timer: TimerHandle | null;
}

const defaultDeps: OnboardingPollingDeps = {
  scheduler: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  },
  getStatus: getWhatsappStatus,
  isPaused: isConversationPaused,
  notify: async (customerPhone, text, config) => {
    const [{ sendConfiguredReply }, { addMessage, buildConversationKey }] =
      await Promise.all([
        import('../messageHandler'),
        import('./contextManager'),
      ]);
    await sendConfiguredReply(customerPhone, text, config);
    await addMessage(
      buildConversationKey(config.phoneNumberId, customerPhone),
      'assistant',
      text
    ).catch(() => undefined);
  },
  handoff: async (customerPhone, config) => {
    const [{ handoffToHuman }, { sendConfiguredReply }, context] =
      await Promise.all([
        import('./salesTools'),
        import('../messageHandler'),
        import('./contextManager'),
      ]);
    const text =
      'A conexão ainda não apareceu depois das duas tentativas. Vou chamar o Victor para continuar com você por aqui.';
    await sendConfiguredReply(customerPhone, text, config).catch(() => undefined);
    await context
      .addMessage(
        context.buildConversationKey(
          config.phoneNumberId,
          customerPhone
        ),
        'assistant',
        text
      )
      .catch(() => undefined);
    await handoffToHuman(
      customerPhone,
      config.phoneNumberId,
      'onboarding_es_falhou'
    );
  },
};

let deps = defaultDeps;
const pollingByConversation =
  new Map<string, OnboardingPollingState>();
const esFailureCountByConversation = new Map<string, number>();

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void })?.unref?.();
}

function clearTimer(state: OnboardingPollingState): void {
  if (state.timer === null) return;
  deps.scheduler.clearTimeout(state.timer);
  state.timer = null;
}

function armNextCycle(state: OnboardingPollingState): void {
  clearTimer(state);
  const timer = deps.scheduler.setTimeout(
    () => runPollingCycle(state.conversationKey),
    ONBOARDING_POLL_INTERVAL_MS
  );
  state.timer = timer;
  unrefTimer(timer);
}

function capturePollingFailure(
  operation: string,
  state: OnboardingPollingState,
  error: unknown
): void {
  Sentry.captureException(
    new Error(`onboarding polling ${operation} failed`),
    {
      tags: {
        service: 'onboarding-polling',
        operation,
        phoneNumberId: state.config.phoneNumberId,
        round: state.round,
        cycle: state.cycles,
        error_kind: error instanceof Error ? error.name : typeof error,
      },
    }
  );
}

async function finishReady(
  state: OnboardingPollingState,
  status: OnboardingWhatsappStatus
): Promise<void> {
  clearTimer(state);
  state.phase = 'ready';
  pollingByConversation.delete(state.conversationKey);
  esFailureCountByConversation.delete(state.conversationKey);
  const mode = status.coexistence
    ? ' e o WhatsApp Business continua disponível no celular'
    : '';
  await deps.notify(
    state.customerPhone,
    `Conectou! 🎉 Seu WhatsApp já está pronto${mode}. Agora vamos fazer o primeiro teste ao vivo.`,
    state.config
  );
}

async function exhaustRound(
  state: OnboardingPollingState
): Promise<void> {
  clearTimer(state);
  if (state.round >= ONBOARDING_POLL_MAX_ROUNDS) {
    state.phase = 'handed_off';
    try {
      await deps.handoff(state.customerPhone, state.config);
    } catch (error) {
      capturePollingFailure('handoff', state, error);
    }
    return;
  }

  state.phase = 'waiting_inbound';
  state.secondRoundAllowed = false;
  try {
    await deps.notify(
      state.customerPhone,
      'Ainda não apareceu como conectado por aqui. Você conseguiu terminar todas as etapas na tela? Me avisa quando concluir que eu confiro mais uma vez.',
      state.config
    );
  } catch (error) {
    capturePollingFailure('exhausted-notice', state, error);
  }
}

async function runPollingCycle(
  conversationKey: string
): Promise<void> {
  const state = pollingByConversation.get(conversationKey);
  if (!state || state.phase !== 'polling') return;
  state.timer = null;

  try {
    if (
      await deps.isPaused(
        state.config.phoneNumberId,
        state.customerPhone
      )
    ) {
      cancelOnboardingPolling(conversationKey);
      return;
    }

    state.cycles += 1;
    const result = await deps.getStatus(state.customerPhone);
    if (result.success && result.status.ready) {
      await finishReady(state, result.status);
      return;
    }

    if (state.cycles >= ONBOARDING_POLL_MAX_CYCLES) {
      await exhaustRound(state);
      return;
    }
    armNextCycle(state);
  } catch (error) {
    capturePollingFailure('cycle', state, error);
    if (state.cycles >= ONBOARDING_POLL_MAX_CYCLES) {
      await exhaustRound(state);
    } else {
      armNextCycle(state);
    }
  }
}

export type StartPollingResult =
  | 'started'
  | 'already_polling'
  | 'waiting_inbound'
  | 'max_rounds';

export function startOnboardingPolling(
  conversationKey: string,
  customerPhone: string,
  config: TenantBotConfig
): StartPollingResult {
  const existing = pollingByConversation.get(conversationKey);
  if (!existing) {
    const state: OnboardingPollingState = {
      conversationKey,
      customerPhone,
      config,
      round: 1,
      cycles: 0,
      phase: 'polling',
      secondRoundAllowed: false,
      timer: null,
    };
    pollingByConversation.set(conversationKey, state);
    armNextCycle(state);
    return 'started';
  }

  existing.customerPhone = customerPhone;
  existing.config = config;
  if (existing.phase === 'polling') return 'already_polling';
  if (
    existing.round >= ONBOARDING_POLL_MAX_ROUNDS &&
    existing.phase !== 'ready'
  ) {
    return 'max_rounds';
  }
  if (!existing.secondRoundAllowed) return 'waiting_inbound';

  existing.round += 1;
  existing.cycles = 0;
  existing.phase = 'polling';
  existing.secondRoundAllowed = false;
  armNextCycle(existing);
  return 'started';
}

/** Só retoma uma rodada criada anteriormente por `sendConnectLink`. */
export function resumeOnboardingPolling(
  conversationKey: string,
  customerPhone: string,
  config: TenantBotConfig
): StartPollingResult {
  if (!pollingByConversation.has(conversationKey)) {
    return 'waiting_inbound';
  }
  return startOnboardingPolling(
    conversationKey,
    customerPhone,
    config
  );
}

export function matchesEmbeddedSignupFinished(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return /\b(?:terminei|finalizei|conclui|conectei|ficou pronto|deu certo|ja fiz|feito)\b/.test(
    normalized
  );
}

/**
 * Novo inbound sempre cancela a rodada ativa. Uma segunda rodada só fica
 * habilitada quando esse inbound diz deterministicamente que o fluxo terminou.
 */
export function noteOnboardingInbound(
  conversationKey: string,
  text: string
): void {
  const state = pollingByConversation.get(conversationKey);
  if (!state) return;
  if (state.phase === 'polling') {
    clearTimer(state);
    state.phase = 'waiting_inbound';
  }
  if (
    state.round < ONBOARDING_POLL_MAX_ROUNDS &&
    matchesEmbeddedSignupFinished(text)
  ) {
    state.secondRoundAllowed = true;
  }
}

export function markOnboardingWhatsappReady(
  conversationKey: string
): void {
  const state = pollingByConversation.get(conversationKey);
  if (state) clearTimer(state);
  pollingByConversation.delete(conversationKey);
  esFailureCountByConversation.delete(conversationKey);
}

export function cancelOnboardingPolling(
  conversationKey: string
): void {
  const state = pollingByConversation.get(conversationKey);
  if (state) clearTimer(state);
  pollingByConversation.delete(conversationKey);
}

export type EmbeddedSignupFailureKind =
  | 'resource_unavailable'
  | 'verification_code'
  | 'asset_not_found'
  | 'generic';

export function matchEmbeddedSignupFailure(
  text: string
): EmbeddedSignupFailureKind | null {
  const normalized = normalizeForMatch(text);
  if (
    /\b(?:recurso indisponivel|atualizando detalhes adicionais|nao esta disponivel)\b/.test(
      normalized
    )
  ) {
    return 'resource_unavailable';
  }
  if (
    /\b(?:redirect uri|verification code|codigo de verificacao|codigo invalido)\b/.test(
      normalized
    )
  ) {
    return 'verification_code';
  }
  if (
    /\b(?:nao aparece|nao encontrei|nao acho).*(?:conta|numero|whatsapp)|(?:conta|numero|whatsapp).*(?:nao aparece|nao encontrei|nao acho)\b/.test(
      normalized
    )
  ) {
    return 'asset_not_found';
  }
  if (
    /\b(?:deu erro|falhou|nao funcionou|travou|nao consegui conectar)\b/.test(
      normalized
    )
  ) {
    return 'generic';
  }
  return null;
}

function guidanceForFailure(
  kind: EmbeddedSignupFailureKind
): string {
  switch (kind) {
    case 'resource_unavailable':
      return 'Vamos tentar mais uma vez: feche a janela da Meta, abra novamente pelo link da Receps e entre com a conta do Facebook que administra o WhatsApp Business. Você não precisa ser tester do app.';
    case 'verification_code':
      return 'Feche a janela e recomece pelo botão de conexão dentro da Receps. Não copie nem reutilize o código da tentativa anterior; o fluxo abre uma nova validação.';
    case 'asset_not_found':
      return 'Confere se o WhatsApp Business do celular está atualizado e se essa conta do Facebook administra o negócio. Depois abra o link de novo e escolha conectar o WhatsApp Business existente.';
    case 'generic':
      return 'Feche a janela da Meta, volte ao link de conexão da Receps e tente novamente do começo. Se aparecer uma mensagem específica, me diga só o texto do erro.';
  }
}

export function recordEmbeddedSignupFailure(
  conversationKey: string,
  text: string
):
  | { matched: false }
  | {
      matched: true;
      attempts: number;
      handoff: boolean;
      message: string;
    } {
  const kind = matchEmbeddedSignupFailure(text);
  if (!kind) return { matched: false };
  const attempts =
    (esFailureCountByConversation.get(conversationKey) ?? 0) + 1;
  esFailureCountByConversation.set(conversationKey, attempts);
  return {
    matched: true,
    attempts,
    handoff: attempts >= 2,
    message:
      attempts >= 2
        ? 'A conexão falhou de novo. Vou chamar o Victor para continuar com você por aqui, sem pedir que repita tudo.'
        : guidanceForFailure(kind),
  };
}

export function clearOnboardingPollingStates(
  conversationKeys: string[]
): void {
  for (const conversationKey of conversationKeys) {
    cancelOnboardingPolling(conversationKey);
    esFailureCountByConversation.delete(conversationKey);
  }
}

export function __setOnboardingPollingDepsForTest(
  overrides: Partial<OnboardingPollingDeps>
): void {
  deps = {
    ...defaultDeps,
    ...overrides,
    scheduler: overrides.scheduler ?? defaultDeps.scheduler,
  };
}

export function __getOnboardingPollingStateForTest(
  conversationKey: string
): {
  round: number;
  cycles: number;
  phase: PollingPhase;
  secondRoundAllowed: boolean;
} | null {
  const state = pollingByConversation.get(conversationKey);
  return state
    ? {
        round: state.round,
        cycles: state.cycles,
        phase: state.phase,
        secondRoundAllowed: state.secondRoundAllowed,
      }
    : null;
}

export function __resetOnboardingPollingForTest(): void {
  for (const key of pollingByConversation.keys()) {
    cancelOnboardingPolling(key);
  }
  esFailureCountByConversation.clear();
  deps = defaultDeps;
}
