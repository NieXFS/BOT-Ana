import axios from 'axios';
import type { TenantBotConfig } from '../configProvider';
import { ERP_API_TOKEN } from '../erpApiToken';
import { Sentry } from '../observability/sentry';
import { runtimeErrorKind, safeHttpStatus } from '../observability/safeRuntime';
import {
  classifyAnaResume,
  isExplicitAnaResumeRequest,
  type AnaResumeClassification,
} from './anaResumeClassifier';
import { isAnaConversationalV2Enabled } from './conversationalV2/featureFlag';
import { getHistoryWithTimestamps } from './contextManager';
import { releaseLocalEchoPauseAfterAnaResume } from './pauseService';
import { HUMAN_ECHO_PREFIX } from './humanConversationContext';
import {
  assertExternalWriteAllowed,
  isAnaLabRuntime,
} from '../runtimePolicy';
import type {
  HumanControlDisposition,
  ReceptionistTurnControl,
  ResumeDecisionCode,
} from './receptionistTurnDecision';

const RECEPS_INTERNAL_API_URL =
  process.env.RECEPS_INTERNAL_API_URL ?? 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;
const KEEP_SILENT_REASONS = [
  'PAUSE_ACTIVE',
  'CLASSIFICATION_IN_FLIGHT',
  'OUTBOUND_ECHO_PENDING',
] as const;

export type AnaResumeGateBeginResponse =
  | { action: 'PROCEED' }
  | {
      action: 'KEEP_SILENT';
      reason: (typeof KEEP_SILENT_REASONS)[number];
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
    customerPhone: string,
    explicitAnaResumeRequest: boolean
  ) => Promise<AnaResumeGateBeginResponse>;
  loadHistory: typeof getHistoryWithTimestamps;
  classify: typeof classifyAnaResume;
  finalize: (input: {
    phoneNumberId: string;
    customerPhone: string;
    expectedVersion: number;
    classification: AnaResumeClassification;
  }) => Promise<AnaResumeGateFinalizeResponse>;
  onAnaResumeApplied?: (phoneNumberId: string, customerPhone: string) => void;
}

/**
 * A ativação herda a allowlist única da v2. Sales nunca entra; `*` continua
 * proibido pela fonte `isAnaConversationalV2Enabled`.
 */
export function isAnaResumeGateEnabled(config: TenantBotConfig): boolean {
  if (config.botRole === 'sales') return false;
  return isAnaConversationalV2Enabled(config.tenantSlug);
}

export function parseAnaResumeGateBeginResponse(
  data: unknown
): AnaResumeGateBeginResponse | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.action === 'PROCEED') return { action: 'PROCEED' };
  if (record.action === 'KEEP_SILENT') {
    if (
      record.reason !== 'PAUSE_ACTIVE' &&
      record.reason !== 'CLASSIFICATION_IN_FLIGHT' &&
      record.reason !== 'OUTBOUND_ECHO_PENDING'
    ) {
      return null;
    }
    return {
      action: 'KEEP_SILENT',
      reason: record.reason as (typeof KEEP_SILENT_REASONS)[number],
    };
  }
  if (record.action === 'EVALUATE') {
    if (
      typeof record.expectedVersion !== 'number' ||
      !Number.isFinite(record.expectedVersion) ||
      typeof record.leaseUntil !== 'string' ||
      !record.leaseUntil.trim()
    ) {
      return null;
    }
    return {
      action: 'EVALUATE',
      expectedVersion: record.expectedVersion,
      leaseUntil: record.leaseUntil,
    };
  }
  return null;
}

export function parseAnaResumeGateFinalizeResponse(
  data: unknown
): AnaResumeGateFinalizeResponse | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.applied !== 'boolean') return null;
  if (record.action !== 'PROCEED' && record.action !== 'KEEP_SILENT') return null;
  if (
    record.version !== null &&
    (typeof record.version !== 'number' || !Number.isFinite(record.version))
  ) {
    return null;
  }
  if (record.pausedUntil !== null && typeof record.pausedUntil !== 'string') {
    return null;
  }
  return {
    applied: record.applied,
    action: record.action,
    version: record.version,
    pausedUntil: record.pausedUntil,
  };
}

async function callResumeGate<T>(body: unknown): Promise<T> {
  assertExternalWriteAllowed();
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
  begin: (phoneNumberId, customerPhone, explicitAnaResumeRequest) =>
    callResumeGate<AnaResumeGateBeginResponse>({
      operation: 'begin',
      phoneNumberId,
      customerPhone,
      explicitAnaResumeRequest,
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
  onAnaResumeApplied: releaseLocalEchoPauseAfterAnaResume,
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

export interface AnaResumeGateEvaluation {
  allowed: boolean;
  disposition: HumanControlDisposition;
  resumeDecision: ResumeDecisionCode;
}

export function turnControlFromResumeEvaluation(
  evaluation: AnaResumeGateEvaluation
): ReceptionistTurnControl {
  return {
    disposition: evaluation.disposition,
    resumeDecision: evaluation.resumeDecision,
  };
}

function silentHuman(
  resumeDecision: ResumeDecisionCode = 'KEEP_SILENT'
): AnaResumeGateEvaluation {
  return {
    allowed: false,
    disposition: 'HUMAN_ACTIVE',
    resumeDecision,
  };
}

/**
 * Avaliação estruturada do chefe de retomada. `allowed` continua sendo o
 * único sinal que libera buffer/brain; disposition/resumeDecision viajam até
 * o compositor de turno para não contradizer RESUME_ANA.
 */
export async function evaluateAnaResumeForInbound(
  input: {
    config: TenantBotConfig;
    customerPhone: string;
    customerName?: string | null;
    inboundText?: string | null;
  },
  deps: Partial<AnaResumeGateDeps> = {}
): Promise<AnaResumeGateEvaluation> {
  const resolved: AnaResumeGateDeps = { ...defaultDeps, ...deps };
  if (!isAnaResumeGateEnabled(input.config)) {
    return {
      allowed: true,
      disposition: 'NO_ACTIVE_TAKEOVER',
      resumeDecision: 'GATE_DISABLED',
    };
  }

  const explicitAnaResumeRequest = isExplicitAnaResumeRequest(
    input.inboundText ?? ''
  );

  // O resume-gate produtivo é um POST mutável no ERP. No LAB-1, a autoridade
  // mínima vem do histórico isolado: sem echo humano, prossegue; depois de echo,
  // permanece silenciosa até pedido explícito pela Ana. Não há HTTP nem promessa
  // de alterar a pausa produtiva.
  if (isAnaLabRuntime()) {
    let history: Awaited<ReturnType<typeof getHistoryWithTimestamps>>;
    try {
      history = await resolved.loadHistory(
        input.config.phoneNumberId,
        input.customerPhone
      );
    } catch (error) {
      capture(error, input.config, 'lab_load_history');
      return silentHuman('KEEP_SILENT');
    }
    const lastHumanIndex = history.reduce(
      (last, entry, index) =>
        entry.role === 'assistant' && entry.content.startsWith(HUMAN_ECHO_PREFIX)
          ? index
          : last,
      -1
    );
    if (lastHumanIndex < 0) {
      return {
        allowed: true,
        disposition: 'NO_ACTIVE_TAKEOVER',
        resumeDecision: 'PROCEED',
      };
    }
    const anaAnsweredAfterHuman = history
      .slice(lastHumanIndex + 1)
      .some(
        (entry) =>
          entry.role === 'assistant' &&
          !entry.content.startsWith(HUMAN_ECHO_PREFIX)
      );
    if (anaAnsweredAfterHuman) {
      return {
        allowed: true,
        disposition: 'NO_ACTIVE_TAKEOVER',
        resumeDecision: 'PROCEED',
      };
    }
    if (explicitAnaResumeRequest) {
      resolved.onAnaResumeApplied?.(
        input.config.phoneNumberId,
        input.customerPhone
      );
      return {
        allowed: true,
        disposition: 'RESUME_APPROVED',
        resumeDecision: 'RESUME_ANA',
      };
    }
    return silentHuman('KEEP_SILENT');
  }

  let beginRaw: unknown;
  try {
    beginRaw = await resolved.begin(
      input.config.phoneNumberId,
      input.customerPhone,
      explicitAnaResumeRequest
    );
  } catch (error) {
    capture(error, input.config, 'begin');
    return silentHuman('KEEP_SILENT');
  }

  const begin = parseAnaResumeGateBeginResponse(beginRaw);
  if (!begin) {
    capture(new Error('ana resume gate failed closed'), input.config, 'begin');
    return silentHuman('KEEP_SILENT');
  }

  if (begin.action === 'PROCEED') {
    return {
      allowed: true,
      disposition: 'NO_ACTIVE_TAKEOVER',
      resumeDecision: 'PROCEED',
    };
  }
  if (begin.action === 'KEEP_SILENT') return silentHuman('KEEP_SILENT');

  let history: Awaited<ReturnType<typeof getHistoryWithTimestamps>>;
  try {
    history = await resolved.loadHistory(
      input.config.phoneNumberId,
      input.customerPhone
    );
  } catch (error) {
    capture(error, input.config, 'load_history');
    return silentHuman('KEEP_SILENT');
  }

  let classification: AnaResumeClassification;
  try {
    classification = await resolved.classify({
      history,
      config: input.config,
      customerName: input.customerName,
    });
  } catch (error) {
    // O classificador normal já converte falhas do provider em UNCERTAIN. Este
    // catch cobre bugs/erros inesperados do próprio módulo e preserva o
    // contrato mais importante: nenhuma falha pode liberar uma resposta.
    capture(error, input.config, 'classify');
    return silentHuman('UNCERTAIN');
  }

  try {
    const finalized = parseAnaResumeGateFinalizeResponse(
      await resolved.finalize({
        phoneNumberId: input.config.phoneNumberId,
        customerPhone: input.customerPhone,
        expectedVersion: begin.expectedVersion,
        classification,
      })
    );
    if (!finalized) {
      capture(new Error('ana resume gate failed closed'), input.config, 'finalize');
      return silentHuman('KEEP_SILENT');
    }
    if (
      !finalized.applied ||
      finalized.action !== 'PROCEED' ||
      classification.decision !== 'RESUME_ANA'
    ) {
      return silentHuman(
        classification.decision === 'RESUME_ANA'
          ? 'KEEP_SILENT'
          : classification.decision
      );
    }
    resolved.onAnaResumeApplied?.(
      input.config.phoneNumberId,
      input.customerPhone
    );
    return {
      allowed: true,
      disposition: 'RESUME_APPROVED',
      resumeDecision: 'RESUME_ANA',
    };
  } catch (error) {
    capture(error, input.config, 'finalize');
    return silentHuman('KEEP_SILENT');
  }
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
    inboundText?: string | null;
  },
  deps: Partial<AnaResumeGateDeps> = {}
): Promise<boolean> {
  return (await evaluateAnaResumeForInbound(input, deps)).allowed;
}
