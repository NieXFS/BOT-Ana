import { pauseConversationByEcho } from './services/pauseService';

export interface EchoTarget {
  phoneNumberId: string;
  customerPhone: string;
}

export interface EchoDeps {
  pauseConversation: (phoneNumberId: string, customerPhone: string) => Promise<void>;
}

const defaultEchoDeps: EchoDeps = { pauseConversation: pauseConversationByEcho };

/** A Meta envia o campo "smb_message_echoes" em change.field (Coexistence). */
export function isEchoChange(field: unknown): boolean {
  return field === 'smb_message_echoes';
}

/**
 * Parser PURO e defensivo do `change.value` de smb_message_echoes.
 *
 * Shape (Meta): `value.metadata.phone_number_id` + `value.message_echoes[]`, em
 * que cada echo tem `from` (número do salão) e `to` (número do CLIENTE). Como a
 * Ana envia pelo Cloud API (não pelo app), todo smb_message_echoes = ação humana
 * pelo app → o número a pausar é o `to`.
 *
 * Defensivo: ignora payload sem objeto, sem `phone_number_id` (com fallback do
 * env), e echo sem `to`. Deduplica por cliente (1 pausa por cliente por payload).
 */
export function parseEchoTargets(
  value: unknown,
  fallbackPhoneNumberId?: string
): EchoTarget[] {
  if (!value || typeof value !== 'object') return [];

  const v = value as {
    metadata?: { phone_number_id?: unknown };
    message_echoes?: unknown;
  };

  const rawPhoneId =
    typeof v.metadata?.phone_number_id === 'string'
      ? v.metadata.phone_number_id.trim()
      : '';
  const phoneNumberId = rawPhoneId || (fallbackPhoneNumberId ?? '').trim();
  if (!phoneNumberId) return [];

  const echoes = Array.isArray(v.message_echoes) ? v.message_echoes : [];
  const targets: EchoTarget[] = [];
  const seen = new Set<string>();

  for (const echo of echoes) {
    if (!echo || typeof echo !== 'object') continue;
    const to = (echo as { to?: unknown }).to;
    const customerPhone = typeof to === 'string' ? to.trim() : '';
    if (!customerPhone) continue;
    if (seen.has(customerPhone)) continue;
    seen.add(customerPhone);
    targets.push({ phoneNumberId, customerPhone });
  }

  return targets;
}

/**
 * Processa um `change.value` de smb_message_echoes: pausa cada conversa cujo dono
 * respondeu pelo app. Qualquer tipo de echo (texto, edição, etc.) conta como
 * ação humana → pausa (o mais simples e seguro; não filtra por type). NUNCA
 * lança — erros das chamadas ao Receps já são capturados no pauseService.
 */
export async function handleSmbMessageEchoes(
  value: unknown,
  fallbackPhoneNumberId?: string,
  deps: EchoDeps = defaultEchoDeps
): Promise<void> {
  const targets = parseEchoTargets(value, fallbackPhoneNumberId);
  for (const target of targets) {
    await deps.pauseConversation(target.phoneNumberId, target.customerPhone);
  }
}
