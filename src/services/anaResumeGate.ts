import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind, safeHttpStatus } from '../observability/safeRuntime';
import {
  classifyAnaResume,
  type AnaResumeClassification,
} from './anaResumeClassifier';
import { getHistoryWithTimestamps } from './contextManager';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;
export const ANA_RESUME_GATE_ENABLED_ENV = 'ANA_RESUME_GATE_ENABLED';
export const ANA_RESUME_GATE_TENANTS_ENV = 'ANA_RESUME_GATE_TENANT_SLUGS';
export const ANA_RESUME_GATE_EXCLUDED_TENANTS_ENV =
  'ANA_RESUME_GATE_EXCLUDED_TENANT_SLUGS';

export type AnaResumeGateBeginResponse =
  | { action: 'PROCEED' }
  | {
      action: 'KEEP_SILENT';
      reason: 'PAUSE_ACTIVE' | 'CLASSIFICATION_IN_FLIGHT';
    }
  | { action: 'EVALUATE'; expectedVersion: number; leaseUntil: string };

export interface AnaResumeGateFinalizeResponse {
  applied: boolean;
  action: 'PROCEED' | 'KEEP_SILENT';
  version: number | null;
  pausedUntil: string | null;
}

export interface AnaResumeGateDeps {
  begin: (
    phoneNumberId: string,
    customerPhone: string
  ) => Promise<AnaResumeGateBeginResponse>;
  loadHistory: typeof getHistoryWithTimestamps;
  classify: typeof classifyAnaResume;
  finalize: (input: {
    phoneNumberId: string;
    customerPhone: string;
    expectedVersion: number;
    classification: AnaResumeClassification;
  }) => Promise<AnaResumeGateFinalizeResponse>;
}

export function isAnaResumeGateEnabled(
  config: TenantBotConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (config.botRole === 'sales') return false;
  if (env[ANA_RESUME_GATE_ENABLED_ENV]?.trim().toLowerCase() !== 'true') {
    return false;
  }
  const allowlist = (env[ANA_RESUME_GATE_TENANTS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const excludedTenants = new Set(
    (env[ANA_RESUME_GATE_EXCLUDED_TENANTS_ENV] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );

  // Produção exige escopo explícito: slugs individuais ou `*`. Em DEV, a lista
  // vazia facilita smokes e o harness sintético sem alterar tenants reais.
  if (env.NODE_ENV === 'production' && allowlist.length === 0) return false;
  if (excludedTenants.has(config.tenantSlug)) return false;
  return (
    allowlist.length === 0 ||
    allowlist.includes('*') ||
    allowlist.includes(config.tenantSlug)
  );
}

async function callResumeGate<T>(body: unknown): Promise<T> {
  const { data } = await axios.post<T>(
    `${RECEPS_INTERNAL_API_URL}/api/v1/bot/resume-gate`,
    body,
    {
      headers: {
        Authorization: `Bearer ${ERP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );
  return data;
}

const defaultDeps: AnaResumeGateDeps = {
  begin: (phoneNumberId, customerPhone) =>
    callResumeGate<AnaResumeGateBeginResponse>({
      operation: 'begin',
      phoneNumberId,
      customerPhone,
    }),
  loadHistory: getHistoryWithTimestamps,
  classify: classifyAnaResume,
  finalize: ({
    phoneNumberId,
    customerPhone,
    expectedVersion,
    classification,
  }) =>
    callResumeGate<AnaResumeGateFinalizeResponse>({
      operation: 'finalize',
      phoneNumberId,
      customerPhone,
      expectedVersion,
      decision: classification.decision,
      reasonCode: classification.reasonCode,
      model: classification.model,
      latencyMs: classification.latencyMs,
      contextHash: classification.contextHash,
    }),
};

function capture(
  error: unknown,
  config: TenantBotConfig,
  operation: string
): void {
  Sentry.captureException(new Error('ana resume gate failed closed'), {
    level: 'warning',
    tags: {
      service: 'ana_resume_gate',
      operation,
      phoneNumberId: config.phoneNumberId,
      tenantSlug: config.tenantSlug,
      error_kind: runtimeErrorKind(error),
      http_status: safeHttpStatus(error) ?? 'n/a',
    },
  });
}

/**
 * Retorna true SOMENTE quando este inbound pode seguir ao brain normal. Toda
 * falha de estado, histórico, provider, JSON, finalização ou CAS fica em
 * silêncio. O método não envia WhatsApp nem chama tools de agenda.
 */
export async function shouldAnaResumeForInbound(
  input: {
    config: TenantBotConfig;
    customerPhone: string;
    customerName?: string | null;
  },
  deps: AnaResumeGateDeps = defaultDeps
): Promise<boolean> {
  if (!isAnaResumeGateEnabled(input.config)) return true;

  let begin: AnaResumeGateBeginResponse;
  try {
    begin = await deps.begin(input.config.phoneNumberId, input.customerPhone);
  } catch (error) {
    capture(error, input.config, 'begin');
    return false;
  }

  if (begin.action === 'PROCEED') return true;
  if (begin.action === 'KEEP_SILENT') return false;

  let history: Awaited<ReturnType<typeof getHistoryWithTimestamps>> = [];
  try {
    history = await deps.loadHistory(
      input.config.phoneNumberId,
      input.customerPhone
    );
  } catch (error) {
    capture(error, input.config, 'load_history');
  }

  let classification: AnaResumeClassification;
  try {
    classification = await deps.classify({
      history,
      config: input.config,
      customerName: input.customerName,
    });
  } catch (error) {
    // O classificador normal já converte falhas do provider em UNCERTAIN. Este
    // catch cobre bugs/erros inesperados do próprio módulo e preserva o
    // contrato mais importante: nenhuma falha pode liberar uma resposta.
    capture(error, input.config, 'classify');
    return false;
  }

  try {
    const finalized = await deps.finalize({
      phoneNumberId: input.config.phoneNumberId,
      customerPhone: input.customerPhone,
      expectedVersion: begin.expectedVersion,
      classification,
    });
    if (!finalized.applied) return false;
    return finalized.action === 'PROCEED';
  } catch (error) {
    capture(error, input.config, 'finalize');
    return false;
  }
}
