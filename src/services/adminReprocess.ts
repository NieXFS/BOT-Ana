import type { TenantBotConfig } from '../configProvider';
import { getTenantConfig } from '../configProvider';
import { sendConfiguredReply } from '../messageHandler';
import {
  getHistory,
  HUMAN_ECHO_PREFIX,
  parseConversationKey,
  type Message,
} from './contextManager';
import { buildResetConversationKeys } from './adminReset';
import { getSalesReplyFromHistory } from './salesBrain';
import { clearSalesRecoveryState } from './salesRecovery';

export type AdminReprocessReason =
  | 'sem_inbound'
  | 'config_nao_encontrada'
  | 'brain_failed'
  | 'send_failed'
  | 'ja_respondida';

export type AdminReprocessResult =
  | { replied: true }
  | { replied: false; reason: AdminReprocessReason };

export interface AdminReprocessInput {
  phoneNumberId: string;
  customerPhone: string;
}

export interface AdminReprocessDeps {
  getConfig: (phoneNumberId: string) => Promise<TenantBotConfig | null>;
  getHistory: (conversationKey: string) => Promise<Message[]>;
  generate: typeof getSalesReplyFromHistory;
  send: (
    phone: string,
    replyText: string,
    config: TenantBotConfig
  ) => Promise<void>;
  clearRecovery: (conversationKey: string) => void;
}

const defaultDeps: AdminReprocessDeps = {
  getConfig: getTenantConfig,
  getHistory,
  generate: getSalesReplyFromHistory,
  send: sendConfiguredReply,
  clearRecovery: clearSalesRecoveryState,
};

export function isValidAdminReprocessInput(
  value: unknown
): value is AdminReprocessInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.phoneNumberId === 'string' &&
    input.phoneNumberId.trim().length > 0 &&
    typeof input.customerPhone === 'string' &&
    input.customerPhone.trim().length > 0
  );
}

function prioritizeWhatsappKeys(keys: string[]): string[] {
  return [...keys].sort((left, right) => {
    const leftRaw = /^\d+$/.test(parseConversationKey(left).customerPhone);
    const rightRaw = /^\d+$/.test(parseConversationKey(right).customerPhone);
    return Number(rightRaw) - Number(leftRaw);
  });
}

async function findConversationWithHistory(
  keys: string[],
  readHistory: AdminReprocessDeps['getHistory']
): Promise<{ conversationKey: string; history: Message[] } | null> {
  for (const conversationKey of prioritizeWhatsappKeys(keys)) {
    const history = await readHistory(conversationKey);
    if (history.length > 0) {
      return { conversationKey, history };
    }
  }
  return null;
}

export async function reprocessSalesResponse(
  input: AdminReprocessInput,
  deps: AdminReprocessDeps = defaultDeps
): Promise<AdminReprocessResult> {
  const config = await deps.getConfig(input.phoneNumberId);
  if (!config || !config.isActive || config.botRole !== 'sales') {
    return { replied: false, reason: 'config_nao_encontrada' };
  }

  const candidateKeys = buildResetConversationKeys(
    input.phoneNumberId,
    input.customerPhone
  );
  const conversation = await findConversationWithHistory(
    candidateKeys,
    deps.getHistory
  );
  if (!conversation || !conversation.history.some((message) => message.role === 'user')) {
    return { replied: false, reason: 'sem_inbound' };
  }

  const { conversationKey, history } = conversation;
  const phone = parseConversationKey(conversationKey).customerPhone;

  const lastMessage = history[history.length - 1]!;
  if (
    lastMessage.role === 'assistant' &&
    lastMessage.content.startsWith(HUMAN_ECHO_PREFIX)
  ) {
    return { replied: false, reason: 'ja_respondida' };
  }

  deps.clearRecovery(conversationKey);

  let replyText: string;
  if (lastMessage.role === 'assistant') {
    replyText = lastMessage.content;
  } else {
    try {
      replyText = await deps.generate(
        phone,
        '',
        config,
        { retryPolicy: 'quick' }
      );
    } catch {
      return { replied: false, reason: 'brain_failed' };
    }
  }

  try {
    await deps.send(phone, replyText, config);
  } catch {
    return { replied: false, reason: 'send_failed' };
  }

  return { replied: true };
}
