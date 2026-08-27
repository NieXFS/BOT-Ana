import axios from 'axios';
import { assertExternalWriteAllowed } from '../runtimePolicy';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import { normalizeForMatch } from './salesOpeners';

export const ONBOARDING_SESSION_CACHE_TTL_MS = 60_000;

export type OnboardingDerivedStage =
  | 'services'
  | 'schedule'
  | 'team'
  | 'clinic'
  | 'whatsapp'
  | 'test'
  | 'done';

export interface OnboardingState {
  session: {
    id: string;
    stage: string;
    expiresAt: string;
    status: 'OPEN';
    derivedStage: OnboardingDerivedStage;
  };
  tenant: {
    name: string;
    segment: string | null;
    planSlug: string | null;
    maxProfessionals: number | null;
    professionalsActive: number;
    setupCompletedAt: string | null;
  };
  catalog: {
    servicesCount: number;
    seedServicesCount: number;
    services: Array<{
      id: string;
      name: string;
      durationMinutes: number;
      price: number;
      isSeed: boolean;
    }>;
  };
  schedule: {
    openingTime: string;
    closingTime: string;
    slotIntervalMinutes: number;
    scheduleLocked: boolean;
  };
  whatsapp: {
    connected: boolean;
    coexistence: boolean;
    connectedAt: string | null;
  };
}

export type OnboardingSessionLookup =
  | { kind: 'open'; state: OnboardingState }
  | {
      kind: 'none';
      reason: 'no_session' | 'session_closed';
      message: string;
    }
  | {
      kind: 'blocked';
      reason: 'ambiguous_session';
      message: string;
    }
  | {
      kind: 'unavailable';
      reason: string;
      message: string;
    };

export type OnboardingClaimResult =
  | { success: true; state: OnboardingState }
  | { success: false; reason: string; message: string };

interface CacheEntry {
  expiresAt: number;
  result: OnboardingSessionLookup;
}

const sessionCache = new Map<string, CacheEntry>();

function recepsBaseUrl(): string {
  return (
    process.env.RECEPS_INTERNAL_API_URL ??
    process.env.ERP_BASE_URL ??
    'http://localhost:3000'
  );
}

function requestHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ERP_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function reasonFromError(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'transport_unavailable';
  const data = error.response?.data;
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  return error.response?.status ? `http_${error.response.status}` : 'network';
}

function captureSyntheticFailure(
  operation: string,
  error: unknown
): void {
  const status = axios.isAxiosError(error)
    ? error.response?.status ?? 'network'
    : 'unknown';
  Sentry.captureException(
    new Error(`onboarding-session ${operation} failed (${status})`),
    {
      tags: {
        service: 'onboarding-session',
        operation,
        http_status: status,
      },
    }
  );
}

function lookupForReason(reason: string): OnboardingSessionLookup {
  if (reason === 'no_session') {
    return {
      kind: 'none',
      reason,
      message:
        'Não encontrei uma configuração aberta para este número.',
    };
  }
  if (reason === 'session_closed') {
    return {
      kind: 'none',
      reason,
      message:
        'Essa etapa de configuração já foi encerrada ou expirou.',
    };
  }
  if (reason === 'ambiguous_session') {
    return {
      kind: 'blocked',
      reason,
      message:
        'Não consegui identificar com segurança qual clínica configurar. Vou precisar da ajuda do Victor.',
    };
  }
  return {
    kind: 'unavailable',
    reason,
    message:
      'Não consegui consultar sua configuração agora. Tenta novamente em instantes?',
  };
}

function cacheResult(
  customerPhone: string,
  result: OnboardingSessionLookup,
  now = Date.now()
): OnboardingSessionLookup {
  sessionCache.set(customerPhone, {
    result,
    expiresAt: now + ONBOARDING_SESSION_CACHE_TTL_MS,
  });
  return result;
}

export async function getOnboardingSessionResult(
  customerPhone: string,
  options: { bypassCache?: boolean; now?: number } = {}
): Promise<OnboardingSessionLookup> {
  const now = options.now ?? Date.now();
  const cached = sessionCache.get(customerPhone);
  if (
    !options.bypassCache &&
    cached &&
    cached.expiresAt > now
  ) {
    return cached.result;
  }

  try {
    const { data } = await axios.get<OnboardingState>(
      `${recepsBaseUrl()}/api/v1/bot/onboarding/session`,
      {
        params: { customerPhone },
        headers: requestHeaders(),
        timeout: 10_000,
      }
    );
    return cacheResult(customerPhone, { kind: 'open', state: data }, now);
  } catch (error) {
    const reason = reasonFromError(error);
    const result = lookupForReason(reason);
    if (result.kind === 'unavailable') {
      captureSyntheticFailure('get-session', error);
      return result;
    }
    return cacheResult(customerPhone, result, now);
  }
}

export async function getOnboardingSession(
  customerPhone: string
): Promise<OnboardingState | null> {
  const result = await getOnboardingSessionResult(customerPhone);
  return result.kind === 'open' ? result.state : null;
}

export function invalidateOnboardingSession(
  customerPhone: string
): void {
  sessionCache.delete(customerPhone);
}

/**
 * Código opaco de dez caracteres. Aceita o prefixo ONB e separadores de espaço
 * ou hífen, mas devolve apenas a forma canônica sem prefixo. O chamador nunca
 * deve logar o retorno.
 */
export function matchOnboardingClaimCode(text: string): string | null {
  const normalized = normalizeForMatch(text);
  const match =
    /(?:^|\s)(?:onb[\s-]*)?([a-hj-np-z2-9]{5})[\s-]*([a-hj-np-z2-9]{5})(?=$|\s|[.,!?;:])/i.exec(
      normalized
    );
  return match ? `${match[1]}${match[2]}`.toUpperCase() : null;
}

/**
 * Só cobre a borda do /bem-vindo quando o texto pré-preenchido foi apagado.
 * Não transforma uma conversa comum de vendas em onboarding.
 */
export function matchOnboardingIntentWithoutCode(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return (
    /\b(?:configurar|configuracao|onboarding)\b/.test(normalized) &&
    /\b(?:clinica|receps|conta|boas vindas)\b/.test(normalized)
  );
}

function claimMessageForReason(reason: string): string {
  switch (reason) {
    case 'invalid_code':
      return 'Esse código não foi aceito. Confere o código que aparece na tela de boas-vindas da Receps e me manda de novo?';
    case 'code_already_claimed':
      return 'Esse código já foi usado por outro número. Abra a tela de boas-vindas da Receps para conferir o código atual ou peça ajuda ao Victor.';
    case 'ambiguous_session':
      return 'Já existe outra configuração aberta para este número. Não vou alterar nenhuma clínica até o Victor conferir.';
    case 'rate_limited':
      return 'Fizemos muitas tentativas seguidas. Aguarde um minutinho e tente novamente.';
    case 'unauthorized':
    case 'auth_unavailable':
    case 'internal_error':
      return 'Não consegui validar o código agora. Tenta novamente em instantes?';
    default:
      return 'Não consegui validar o código agora. Confere o valor na tela de boas-vindas e tenta novamente?';
  }
}

export async function claimOnboardingSession(
  customerPhone: string,
  code: string
): Promise<OnboardingClaimResult> {
  try {
    assertExternalWriteAllowed();
    const { data } = await axios.post<OnboardingState>(
      `${recepsBaseUrl()}/api/v1/bot/onboarding/claim`,
      { customerPhone, code },
      {
        headers: requestHeaders(),
        timeout: 10_000,
      }
    );
    invalidateOnboardingSession(customerPhone);
    return { success: true, state: data };
  } catch (error) {
    const reason = reasonFromError(error);
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    if (!status || status >= 500) {
      captureSyntheticFailure('claim', error);
    }
    return {
      success: false,
      reason,
      message: claimMessageForReason(reason),
    };
  }
}

export function __resetOnboardingSessionCacheForTest(): void {
  sessionCache.clear();
}
