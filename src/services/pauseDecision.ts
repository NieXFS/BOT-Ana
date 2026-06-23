/**
 * Decisão PURA de pausa da Ana (sem rede, sem DB) — testável isoladamente.
 *
 * Regra: um carimbo `pausedUntil` no FUTURO = pausado; passado / null / inválido
 * = NÃO pausado. A pausa GERAL (salão) e a pausa da CONVERSA são independentes:
 * qualquer uma no futuro já silencia a Ana.
 */
export interface PauseState {
  globalPausedUntil: string | null;
  conversationPausedUntil: string | null;
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

/** A conversa está pausada agora, considerando salão (global) OU a conversa? */
export function isPausedFromState(state: PauseState, nowMs: number): boolean {
  return (
    isActivePause(state.globalPausedUntil, nowMs) ||
    isActivePause(state.conversationPausedUntil, nowMs)
  );
}
