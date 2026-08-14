import {
  pool,
  parseConversationKey,
} from './contextManager';
import { customerPhoneVariants } from './conversationActivity';
import { clearConversationPartnerSlugs } from './salesPartnerState';
import { clearConversationAdHeadlines } from './salesAdState';
import { clearSalesRecoveryState } from './salesRecovery';
import { clearPendingOnboardingProposals } from './onboardingConfirmationGate';

export type AdminResetInput = {
  phoneNumberId: string;
  customerPhone: string;
  dryRun?: boolean;
};

export type AdminResetCounts = { history: number; followups: number };

export interface AdminResetDeps {
  countHistory: (keys: string[]) => Promise<number>;
  countFollowups: (keys: string[]) => Promise<number>;
  deleteHistory: (keys: string[]) => Promise<number>;
  deleteFollowups: (keys: string[]) => Promise<number>;
  clearOnboardingPollingStates?: (keys: string[]) => Promise<void>;
  clearResolvedSalesConversationRoles?: (keys: string[]) => Promise<void>;
  invalidateOnboardingSession?: (customerPhone: string) => Promise<void>;
}

/**
 * Chaves de conversa a apagar. O Receps manda o telefone CANÔNICO (`+55DDDNUM`)
 * e a Ana guarda o wa_id CRU (`55DDDNUM`) — `customerPhoneVariants` cobre esse
 * par. Acrescentamos o `+<dígitos>` porque a variante canônica NÃO é derivada de
 * um telefone formatado (`+55 16 99751-0032` → só o próprio texto + os dígitos):
 * se algum dia chegar formatado aqui, o reset apagaria ZERO linhas em silêncio.
 * Ampliar as candidatas é seguro — são igualdades num `ANY($1)`, e o conjunto
 * inteiro pertence à MESMA conversa. Não mexemos no `customerPhoneVariants`
 * compartilhado (a recepcionista o usa).
 */
export function buildResetConversationKeys(
  phoneNumberId: string,
  customerPhone: string
): string[] {
  const variants = new Set(customerPhoneVariants(customerPhone));
  const digits = customerPhone.replace(/\D/g, '');
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
  }
  const prefix = phoneNumberId.trim();
  return [...variants].map((variant) => `${prefix}:${variant}`);
}

async function countHistory(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ana_conversation_history
      WHERE "conversationKey" = ANY($1)`,
    [keys]
  );
  return Number(rows[0]?.count ?? 0);
}

async function countFollowups(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sales_followups
      WHERE conversation_key = ANY($1)`,
    [keys]
  );
  return Number(rows[0]?.count ?? 0);
}

async function deleteHistory(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await pool.query(
    `DELETE FROM ana_conversation_history WHERE "conversationKey" = ANY($1)`,
    [keys]
  );
  return result.rowCount ?? 0;
}

async function deleteFollowups(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await pool.query(
    `DELETE FROM sales_followups WHERE conversation_key = ANY($1)`,
    [keys]
  );
  return result.rowCount ?? 0;
}

const defaultDeps: AdminResetDeps = {
  countHistory,
  countFollowups,
  deleteHistory,
  deleteFollowups,
  clearOnboardingPollingStates: async (keys) => {
    const { clearOnboardingPollingStates } = await import(
      './onboardingPolling'
    );
    clearOnboardingPollingStates(keys);
  },
  clearResolvedSalesConversationRoles: async (keys) => {
    const { clearResolvedSalesConversationRoles } = await import(
      './brainService'
    );
    clearResolvedSalesConversationRoles(keys);
  },
  invalidateOnboardingSession: async (customerPhone) => {
    const { invalidateOnboardingSession } = await import(
      './onboardingSession'
    );
    invalidateOnboardingSession(customerPhone);
  },
};

/** `processed_messages` deliberadamente não faz parte deste reset. */
export async function resetAdminConversation(
  input: AdminResetInput,
  deps: AdminResetDeps = defaultDeps
): Promise<AdminResetCounts> {
  const keys = buildResetConversationKeys(input.phoneNumberId, input.customerPhone);
  if (keys.length === 0) return { history: 0, followups: 0 };

  if (input.dryRun === true) {
    const [history, followups] = await Promise.all([
      deps.countHistory(keys),
      deps.countFollowups(keys),
    ]);
    return { history, followups };
  }

  const history = await deps.deleteHistory(keys);
  const followups = await deps.deleteFollowups(keys);
  clearConversationPartnerSlugs(keys);
  clearConversationAdHeadlines(keys);
  clearPendingOnboardingProposals(keys);
  await deps.clearOnboardingPollingStates?.(keys);
  await deps.clearResolvedSalesConversationRoles?.(keys);
  for (const key of keys) {
    clearSalesRecoveryState(key);
    await deps.invalidateOnboardingSession?.(
      parseConversationKey(key).customerPhone
    );
  }
  return { history, followups };
}
