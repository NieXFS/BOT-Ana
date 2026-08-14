/**
 * Decisão PURA de pausa da Ana (sem rede, sem DB) — testável isoladamente.
 *
 * Regra: um carimbo `pausedUntil` no FUTURO = pausado; passado / null / inválido
 * = NÃO pausado. As três fontes são independentes — qualquer uma no futuro já
 * silencia a Ana:
 *  - GERAL (salão), pausa manual;
 *  - CONVERSA, pausa por-cliente (echo/manual);
 *  - SCHEDULE, auto-pausa PROGRAMADA (intervalo "ex.: almoço"). É uma pausa
 *    SILENCIOSA decidida CENTRALMENTE no Receps (src/lib/bot/ana-active.ts) e
 *    entregue pela `/api/v1/bot/pause-state` — a Ana só consome o carimbo; NÃO
 *    duplica a lógica de fuso/dia-da-semana. (O horário de funcionamento "normal"
 *    segue sendo decidido localmente em messageHandler.isBotActive, que manda a
 *    mensagem de "fora do horário".)
 */
export type HumanPauseSource = 'ECHO' | 'MANUAL';

/** Latch local do echo: só `ECHO` conta; MANUAL/ESCALATION não usam este carimbo. */
export type LocalEchoLatch = {
  source: 'ECHO';
  untilMs: number;
};

export type EscalationPauseReason = {
  active: boolean;
  questionId: string | null;
  version: number;
  until: string | null;
};

export type HumanPauseReason = {
  active: boolean;
  source: HumanPauseSource | null;
  until: string | null;
};

export interface PauseState {
  globalPausedUntil: string | null;
  conversationPausedUntil: string | null;
  schedulePausedUntil: string | null;
  /** Rev. 3: campo aditivo. Ausente (`undefined`) durante rollout = inactive. `null` no fio é valor presente. */
  escalation?: {
    active: boolean;
    questionId: string | null;
    version: number;
  } | null;
  /**
   * Motivo ESCALATION persistido. Ausente (`undefined`) = ERP antigo: o pause-ack
   * falha fechado. `null` no fio é valor presente e inválido.
   */
  escalationPause?: EscalationPauseReason | null;
  /**
   * Motivo humano persistido (ECHO/MANUAL). Ausente (`undefined`) = ERP antigo:
   * o pause-ack falha fechado. `null` no fio é valor presente e inválido.
   */
  humanPause?: HumanPauseReason | null;
  /**
   * Modo técnico global. Campo aditivo: ERP antigo/ausente = não pausa por
   * este motivo. `paused` é a decisão autoritativa deste tenant.
   */
  technicalMaintenance?: {
    enabled: boolean;
    paused: boolean;
    exempt: boolean;
    exemptTenantId?: string | null;
    version?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function parseUntil(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : value;
}

/**
 * Parser fail-closed do campo aditivo `escalationPause`.
 * Ativo exige questionId, version e until; inativo exige questionId/until nulos.
 */
export function parseStrictEscalationPause(
  value: unknown
): EscalationPauseReason | null {
  if (!isRecord(value)) return null;
  if (
    !Object.prototype.hasOwnProperty.call(value, 'active') ||
    !Object.prototype.hasOwnProperty.call(value, 'version') ||
    !Object.prototype.hasOwnProperty.call(value, 'until')
  ) {
    return null;
  }
  if (value.active !== true && value.active !== false) return null;
  const version = parseVersion(value.version);
  if (version === null) return null;
  if (value.active === true) {
    if (typeof value.questionId !== 'string' || !value.questionId.trim()) {
      return null;
    }
    const until = parseUntil(value.until);
    if (!until) return null;
    return {
      active: true,
      questionId: value.questionId.trim(),
      version,
      until,
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'questionId') &&
    value.questionId !== null
  ) {
    return null;
  }
  if (value.until !== null) return null;
  return { active: false, questionId: null, version, until: null };
}

/**
 * Parser fail-closed do campo aditivo `humanPause`.
 * Ativo exige source ECHO|MANUAL e until; inativo exige source/until nulos.
 */
export function parseStrictHumanPause(value: unknown): HumanPauseReason | null {
  if (!isRecord(value)) return null;
  if (
    !Object.prototype.hasOwnProperty.call(value, 'active') ||
    !Object.prototype.hasOwnProperty.call(value, 'until')
  ) {
    return null;
  }
  if (value.active !== true && value.active !== false) return null;
  if (value.active === true) {
    if (value.source !== 'ECHO' && value.source !== 'MANUAL') return null;
    const until = parseUntil(value.until);
    if (!until) return null;
    return { active: true, source: value.source, until };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'source') &&
    value.source !== null
  ) {
    return null;
  }
  if (value.until !== null) return null;
  return { active: false, source: null, until: null };
}

export function hasTypedPauseContract(state: PauseState): boolean {
  return state.escalationPause !== undefined && state.humanPause !== undefined;
}

/** Um carimbo ISO está "pausado agora"? (futuro = sim; null/passado/inválido = não). */
export function isActivePause(
  value: string | null | undefined,
  nowMs: number
): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  return t > nowMs;
}

/** Latch local tipado ECHO ainda está no futuro? Source ≠ ECHO nunca bloqueia por aqui. */
export function isActiveLocalEchoLatch(
  latch: { source?: unknown; untilMs?: unknown } | null | undefined,
  nowMs: number
): boolean {
  return (
    latch?.source === 'ECHO' &&
    typeof latch.untilMs === 'number' &&
    Number.isFinite(latch.untilMs) &&
    latch.untilMs > nowMs
  );
}

/** A conversa está pausada agora? (salão OU conversa OU auto-pausa programada). */
export function isPausedFromState(state: PauseState, nowMs: number): boolean {
  return (
    state.technicalMaintenance?.paused === true ||
    isActivePause(state.globalPausedUntil, nowMs) ||
    isActivePause(state.conversationPausedUntil, nowMs) ||
    isActivePause(state.schedulePausedUntil, nowMs) ||
    state.escalation?.active === true ||
    state.escalationPause?.active === true ||
    state.humanPause?.active === true
  );
}

/**
 * Pause-ack: só ignora a pausa ESCALATION cujo questionId casa. Qualquer
 * humanPause.active bloqueia. Latch local tipado ECHO (write-through do echo,
 * preservado se o POST ao ERP falhar) também bloqueia. Sem os dois campos
 * tipados no wire (ERP antigo) falha fechado — o agregado
 * `conversationPausedUntil` não tem origem.
 */
export function decideEscalationAcknowledgementPause(input: {
  expectedQuestionId: string;
  local: { active: boolean; questionId: string | null } | null;
  state: PauseState | null;
  nowMs: number;
  localEchoLatch?: LocalEchoLatch | null;
}): boolean {
  const expected = input.expectedQuestionId.trim();
  if (!expected) return true;
  if (!input.local?.active || input.local.questionId !== expected) return true;
  if (isActiveLocalEchoLatch(input.localEchoLatch, input.nowMs)) return true;
  if (!input.state) return true;
  if (input.state.technicalMaintenance?.paused === true) return true;
  if (!hasTypedPauseContract(input.state)) return true;

  const escalationPause = parseStrictEscalationPause(input.state.escalationPause);
  const humanPause = parseStrictHumanPause(input.state.humanPause);
  if (!escalationPause || !humanPause) return true;
  if (humanPause.active) return true;

  if (escalationPause.active) {
    if (escalationPause.questionId !== expected) return true;
    return isPausedFromState(
      {
        ...input.state,
        conversationPausedUntil: null,
        escalation: {
          active: false,
          questionId: null,
          version: escalationPause.version,
        },
        escalationPause: {
          active: false,
          questionId: null,
          version: escalationPause.version,
          until: null,
        },
      },
      input.nowMs
    );
  }

  return isPausedFromState(input.state, input.nowMs);
}
