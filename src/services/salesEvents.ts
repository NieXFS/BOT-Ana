import axios from 'axios';
import { Sentry } from '../observability/sentry';
import { ERP_API_TOKEN } from '../erpApiToken';

/**
 * Telemetria de VENDAS da Renata (Workstream C). Todas as escritas são
 * best-effort: nunca propagam falha para o caminho crítico da conversa e nunca
 * registram telefone, nome ou conteúdo de mensagem em logs/Sentry.
 */

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

export interface CtwaReferral {
  source_id?: string;
  source_type?: string;
  source_url?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

export type SalesEventType =
  | 'primeira_resposta'
  | 'link_enviado'
  | 'followup_enviado'
  | 'reabriu';

export type SalesEventMetadata = Record<string, string | number | boolean | null>;

function capture(
  error: unknown,
  operation: string,
  phoneNumberId: string,
  type?: SalesEventType
): void {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  // Não entrega o AxiosError cru ao Sentry: ele pode carregar config.data com
  // customerPhone. O erro sintético preserva operação/status sem anexar PII.
  const sanitizedError = new Error(
    `sales-events ${operation} failed${status ? ` (HTTP ${status})` : ''}`
  );
  Sentry.captureException(sanitizedError, {
    tags: {
      service: 'sales-events',
      operation,
      phoneNumberId,
      ...(type ? { type } : {}),
    },
  });
  console.error(
    `❌ [sales-events] falha em ${operation}${status ? ` (HTTP ${status})` : ''}`
  );
}

/** Captura a atribuição CTWA sem alterar o status atual do lead. Nunca lança. */
export async function captureReferral(
  phoneNumberId: string,
  customerPhone: string,
  referral: CtwaReferral
): Promise<void> {
  if (!referral.ctwa_clid) return;

  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/sales-lead`,
      {
        customerPhone,
        ctwaClid: referral.ctwa_clid,
        adSourceId: referral.source_id,
        adHeadline: referral.headline,
      },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
  } catch (error) {
    capture(error, 'capture-referral', phoneNumberId);
  }
}

/** Emite um marco do funil de vendas. Nunca lança. */
export async function emitSalesEvent(
  phoneNumberId: string,
  customerPhone: string,
  type: SalesEventType,
  metadata?: SalesEventMetadata
): Promise<void> {
  try {
    await axios.post(
      `${RECEPS_INTERNAL_API_URL}/api/v1/bot/sales-event`,
      { customerPhone, type, metadata },
      {
        headers: {
          Authorization: `Bearer ${ERP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
  } catch (error) {
    capture(error, 'emit-event', phoneNumberId, type);
  }
}
