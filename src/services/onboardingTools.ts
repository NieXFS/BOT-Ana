import axios from 'axios';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import {
  getOnboardingSessionResult,
  invalidateOnboardingSession,
  type OnboardingState,
} from './onboardingSession';
import type { OnboardingWriteTool } from './onboardingConfirmationGate';

export const ONBOARDING_CONNECT_URL =
  'https://app.receps.com.br/atendente-ia';

export interface OnboardingWhatsappStatus {
  ready: boolean;
  connected: boolean;
  coexistence: boolean;
  connectedAt: string | null;
  source: 'EMBEDDED_SIGNUP' | null;
  pollBudgetHint: number;
}

export type OnboardingToolResult =
  | {
      success: true;
      data: Record<string, unknown>;
    }
  | {
      success: false;
      reason: string;
      message: string;
      data?: Record<string, unknown>;
    };

type CaptureSink = (
  error: Error,
  context: {
    operation: string;
    status: number | 'network' | 'unknown';
  }
) => void;

const defaultCaptureSink: CaptureSink = (error, context) => {
  Sentry.captureException(error, {
    tags: {
      service: 'onboarding-tools',
      operation: context.operation,
      http_status: context.status,
    },
  });
};

let captureSink: CaptureSink = defaultCaptureSink;

function recepsBaseUrl(): string {
  return (
    process.env.RECEPS_INTERNAL_API_URL ??
    process.env.ERP_BASE_URL ??
    'http://localhost:3000'
  );
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${ERP_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function errorReason(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'transport_unavailable';
  const data = error.response?.data;
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  if (error.response?.status === 429) return 'rate_limited';
  if (error.response?.status === 401) return 'unauthorized';
  return error.response?.status
    ? `http_${error.response.status}`
    : 'network';
}

function safeErrorData(error: unknown): Record<string, unknown> | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (!data || typeof data !== 'object') return undefined;
  const source = data as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (Array.isArray(source.missing)) {
    safe.missing = source.missing.filter(
      (value): value is string => typeof value === 'string'
    );
  }
  if (source.current && typeof source.current === 'object') {
    safe.current = source.current;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function messageForReason(reason: string): string {
  switch (reason) {
    case 'no_session':
      return 'Não encontrei uma sessão de configuração aberta. Peça o código que aparece na tela de boas-vindas da Receps.';
    case 'session_closed':
      return 'Essa sessão de configuração já foi encerrada ou expirou. Não tente gravar nada.';
    case 'ambiguous_session':
      return 'Há mais de uma sessão possível e não é seguro escolher uma clínica. Encaminhe para o Victor sem tentar gravar.';
    case 'confirmation_required':
      return 'A alteração precisa de uma proposta explícita e de confirmação da cliente em um novo turno.';
    case 'replace_not_allowed':
      return 'Esse serviço-semente não pode ser substituído porque já não é elegível. Ofereça cadastrar um serviço novo ou ajustar pela tela de Serviços.';
    case 'catalog_limit':
      return 'A clínica chegou ao limite de 30 serviços ativos por este fluxo. Oriente o ajuste pela tela de Serviços.';
    case 'schedule_already_set':
      return 'Os bloqueios de agenda do onboarding já foram configurados e não podem ser substituídos sem remoção. Mostre o estado atual e oriente o ajuste fino na Agenda.';
    case 'schedule_unavailable':
      return 'Não foi possível aplicar essa agenda. Revise horários, dias fechados e almoço antes de propor novamente.';
    case 'professional_limit':
      return 'O limite de profissionais do plano foi atingido. Explique o limite e ofereça falar com o Victor sobre o plano adequado.';
    case 'professional_exists':
      return 'Já existe uma pessoa ativa com esse nome na equipe. Consulte o estado antes de propor outra inclusão.';
    case 'not_ready':
      return 'A configuração ainda não pode ser finalizada. Explique somente os itens que o servidor marcou como ausentes.';
    case 'validation_error':
    case 'invalid_json':
      return 'Os dados não passaram na validação. Corrija a proposta e peça uma nova confirmação antes de tentar novamente.';
    case 'rate_limited':
      return 'Foram feitas muitas tentativas seguidas. Aguarde um minutinho antes de tentar novamente.';
    case 'audit_failed':
      return 'A alteração não pôde ser confirmada no Log de Atividades. Não afirme que foi concluída; encaminhe para o Victor.';
    case 'unauthorized':
    case 'auth_unavailable':
      return 'A integração de configuração está indisponível agora. Não tente contornar nem peça dados novamente.';
    case 'internal_error':
    case 'network':
    case 'transport_unavailable':
      return 'Não consegui falar com a Receps agora. Não afirme que a alteração foi salva; tente novamente em instantes.';
    default:
      return 'A Receps recusou essa alteração. Não afirme sucesso; consulte o estado atual e explique que será preciso revisar os dados.';
  }
}

function captureTransportFailure(
  operation: string,
  error: unknown
): void {
  const status = axios.isAxiosError(error)
    ? error.response?.status ?? 'network'
    : 'unknown';
  const synthetic = new Error(
    `onboarding-tools ${operation} failed (${status})`
  );
  synthetic.name = 'OnboardingToolTransportError';
  captureSink(synthetic, { operation, status });
  console.error(
    `❌ [onboarding-tools] falha em ${operation} | status=${status}`
  );
}

function isServerOrTransportFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return true;
  const status = error.response?.status;
  return status === undefined || status >= 500;
}

async function postOnboarding(
  path: string,
  customerPhone: string,
  body: Record<string, unknown>,
  operation: string
): Promise<OnboardingToolResult> {
  try {
    const { data } = await axios.post<Record<string, unknown>>(
      `${recepsBaseUrl()}${path}`,
      {
        customerPhone,
        ...body,
      },
      {
        headers: headers(),
        timeout: 10_000,
      }
    );
    invalidateOnboardingSession(customerPhone);
    return { success: true, data };
  } catch (error) {
    const reason = errorReason(error);
    if (isServerOrTransportFailure(error)) {
      captureTransportFailure(operation, error);
    }
    return {
      success: false,
      reason,
      message: messageForReason(reason),
      data: safeErrorData(error),
    };
  }
}

export async function getOnboardingStateTool(
  customerPhone: string,
  options: { bypassCache?: boolean } = {}
): Promise<OnboardingToolResult> {
  const result = await getOnboardingSessionResult(customerPhone, options);
  if (result.kind === 'open') {
    return {
      success: true,
      data: result.state as unknown as Record<string, unknown>,
    };
  }
  return {
    success: false,
    reason: result.reason,
    message: result.message,
  };
}

export async function getWhatsappStatus(
  customerPhone: string
): Promise<
  | { success: true; status: OnboardingWhatsappStatus }
  | { success: false; reason: string; message: string }
> {
  try {
    const { data } = await axios.get<OnboardingWhatsappStatus>(
      `${recepsBaseUrl()}/api/v1/bot/onboarding/whatsapp-status`,
      {
        params: { customerPhone },
        headers: headers(),
        timeout: 10_000,
      }
    );
    return { success: true, status: data };
  } catch (error) {
    const reason = errorReason(error);
    if (isServerOrTransportFailure(error)) {
      captureTransportFailure('get-whatsapp-status', error);
    }
    return {
      success: false,
      reason,
      message: messageForReason(reason),
    };
  }
}

export async function executeOnboardingWrite(
  tool: OnboardingWriteTool,
  customerPhone: string,
  input: Record<string, unknown>
): Promise<OnboardingToolResult> {
  switch (tool) {
    case 'upsertService':
      return postOnboarding(
        '/api/v1/bot/onboarding/service',
        customerPhone,
        {
          confirmed: true,
          name: input.name,
          durationMin: input.durationMin,
          price: input.price,
          ...(typeof input.replaceServiceId === 'string'
            ? { replaceServiceId: input.replaceServiceId }
            : {}),
        },
        'upsert-service'
      );
    case 'setSchedule':
      return postOnboarding(
        '/api/v1/bot/onboarding/schedule',
        customerPhone,
        {
          confirmed: true,
          openingTime: input.openingTime,
          closingTime: input.closingTime,
          slotIntervalMinutes: input.slotIntervalMinutes,
          ...(Array.isArray(input.closedWeekdays)
            ? { closedWeekdays: input.closedWeekdays }
            : {}),
          ...(input.lunch && typeof input.lunch === 'object'
            ? { lunch: input.lunch }
            : {}),
        },
        'set-schedule'
      );
    case 'addProfessional':
      return postOnboarding(
        '/api/v1/bot/onboarding/professional',
        customerPhone,
        {
          confirmed: true,
          name: input.name,
          ...(typeof input.specialty === 'string'
            ? { specialty: input.specialty }
            : {}),
        },
        'add-professional'
      );
    case 'updateClinicInfo': {
      const allowed = [
        'businessName',
        'phone',
        'address',
        'city',
        'state',
        'zipCode',
      ] as const;
      const fields = Object.fromEntries(
        allowed
          .filter((key) => typeof input[key] === 'string')
          .map((key) => [key, input[key]])
      );
      return postOnboarding(
        '/api/v1/bot/onboarding/clinic-info',
        customerPhone,
        { confirmed: true, ...fields },
        'update-clinic-info'
      );
    }
    case 'completeOnboarding':
      return postOnboarding(
        '/api/v1/bot/onboarding/complete',
        customerPhone,
        { confirmed: true },
        'complete-onboarding'
      );
  }
}

export function connectLinkResult(): OnboardingToolResult {
  return {
    success: true,
    data: {
      url: ONBOARDING_CONNECT_URL,
      message:
        'Envie este link em texto. Se houver uma fala junto, mantenha a fala separada e deixe o link sozinho na parte de texto.',
    },
  };
}

export function stateFromToolResult(
  result: OnboardingToolResult
): OnboardingState | null {
  return result.success
    ? (result.data as unknown as OnboardingState)
    : null;
}

export function __setOnboardingCaptureSinkForTest(
  sink: CaptureSink | null
): void {
  captureSink = sink ?? defaultCaptureSink;
}

