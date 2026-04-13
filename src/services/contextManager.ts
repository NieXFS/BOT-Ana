import fs from 'fs';
import path from 'path';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type ConversationStore = Record<string, Message[]>;

const HISTORY_FILE = path.resolve(process.cwd(), 'historico_conversas.json');
const MAX_MESSAGES = 15;

// ─── File helpers ──────────────────────────────────────────────────────────────
function readStore(): ConversationStore {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as ConversationStore;
    }
  } catch {
    // file corrupt — start fresh
  }
  return {};
}

function writeStore(store: ConversationStore): void {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export function buildConversationKey(phoneNumberId: string, phone: string): string {
  return `${phoneNumberId}:${phone}`;
}

export function addMessage(
  conversationKey: string,
  role: 'user' | 'assistant',
  content: string
): void {
  const store = readStore();

  if (!store[conversationKey]) store[conversationKey] = [];

  store[conversationKey].push({ role, content });

  // Keep only the last MAX_MESSAGES entries to prevent unbounded growth
  if (store[conversationKey].length > MAX_MESSAGES) {
    store[conversationKey] = store[conversationKey].slice(-MAX_MESSAGES);
  }

  writeStore(store);
}

export function getHistory(conversationKey: string): Message[] {
  return readStore()[conversationKey] ?? [];
}

export function hasConversation(conversationKey: string): boolean {
  const history = readStore()[conversationKey];
  return Array.isArray(history) && history.length > 0;
}
