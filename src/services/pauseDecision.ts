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

/** A conversa está pausada agora? (salão OU conversa OU auto-pausa programada). */
export function isPausedFromState(state: PauseState, nowMs: number): boolean {
  return (
    state.technicalMaintenance?.paused === true ||
    isActivePause(state.globalPausedUntil, nowMs) ||
    isActivePause(state.conversationPausedUntil, nowMs) ||
    isActivePause(state.schedulePausedUntil, nowMs) ||
    state.escalation?.active === true
  );
}
