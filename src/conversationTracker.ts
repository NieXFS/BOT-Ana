const WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 horas

interface ConversationWindow {
  lastMessageAt: number;
}

class ConversationTracker {
  private readonly windows = new Map<string, ConversationWindow>();

  /** Chamado quando um cliente envia qualquer mensagem — abre/renova a janela de 24h */
  markActive(conversationKey: string): void {
    this.windows.set(conversationKey, { lastMessageAt: Date.now() });
  }

  /** Retorna true se o cliente enviou mensagem nas últimas 24 horas */
  isWindowOpen(conversationKey: string): boolean {
    const entry = this.windows.get(conversationKey);
    if (!entry) return false;
    return Date.now() - entry.lastMessageAt < WINDOW_MS;
  }
}

export const conversationTracker = new ConversationTracker();
