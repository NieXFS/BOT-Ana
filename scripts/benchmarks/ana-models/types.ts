import type { ReceptionistRequestUsage } from '../../../src/services/brainService';

export type BenchmarkProvider = 'openai' | 'deepseek';
export type BenchmarkPromptVariant = 'base' | 'anti-verbosity';
export type BenchmarkGuardMode = 'audit' | 'enforce';
export type BenchmarkSuite = 'p0' | 'holdout' | 'all';
export type FixtureMode =
  | 'normal'
  | 'book_failure'
  | 'duplicate'
  | 'duplicate_multiple'
  | 'human_echo';

export interface BenchmarkArm {
  provider: BenchmarkProvider;
  model: string;
  promptVariant: BenchmarkPromptVariant;
  thinking: 'disabled';
  temperature: number;
  maxTokens: number;
}

export interface BenchmarkToolTrace {
  userTurn: number;
  round: number;
  name: string;
  args: Record<string, unknown>;
  argumentsValidJson: boolean;
  result: string;
  runtimeGuard: {
    wouldExecute: boolean;
    blockedBy: Array<
      | 'service_selection'
      | 'booking_confirmation'
      | 'cancellation_intent'
      | 'cancellation_target'
      | 'tool_arguments'
    >;
  };
}

export interface BenchmarkTranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface BenchmarkAssertion {
  id: string;
  severity: 'hard' | 'soft';
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
}

export interface BenchmarkScenarioRun {
  scenarioId: string;
  repetition: number;
  arm: BenchmarkArm;
  transcript: BenchmarkTranscriptEntry[];
  toolTrace: BenchmarkToolTrace[];
  usage: ReceptionistRequestUsage[];
  /** Modelo resolvido pelo runtime compartilhado. Não equivale ao snapshot retornado pelo provider. */
  runtimeModels: string[];
  /**
   * Preenchido somente se uma versão futura do runtime expuser response.model.
   * A API atual de runReceptionistModelLoop não o disponibiliza.
   */
  providerReportedModels: string[];
  exhausted: boolean;
  fixtureState: {
    bookAttempts: number;
    bookEffects: number;
    cancelAttempts: number;
    cancelEffects: number;
    cancelledAppointmentIds: string[];
  };
  runtimeProtection: {
    blockedToolCalls: number;
    allowedToolCalls: number;
    blockedBy: {
      serviceSelection: number;
      bookingConfirmation: number;
      cancellationIntent: number;
      cancellationTarget: number;
      toolArguments: number;
    };
    protectedBookEffects: number;
    protectedCancelEffects: number;
    replyAuthoritativeReadChecks: number;
    replyBlockedByLeakGuard: boolean;
    replyLeakReasons: string[];
    lastReplyLeakReasons: string[];
    /** Resposta bruta apenas submetida ao leak guard; não é replay do runtime. */
    screenedRawFinalReply: string | null;
  };
  providerError?: {
    status?: number;
    code?: string;
    message: string;
  };
  harnessError?: {
    code?: string;
    message: string;
  };
}

export interface BenchmarkScenario {
  id: string;
  priority: 'P0' | 'P1';
  description: string;
  fixtureMode?: FixtureMode;
  initialHistory?: BenchmarkTranscriptEntry[];
  turns: string[];
  evaluate: (run: BenchmarkScenarioRun) => BenchmarkAssertion[];
}

export interface BenchmarkResult extends BenchmarkScenarioRun {
  schemaVersion: 3;
  benchmarkVersion: string;
  runId: string;
  seed: number;
  durationMs: number;
  assertions: BenchmarkAssertion[];
  outcome: 'pass' | 'fail' | 'provider_error' | 'harness_error';
  failureClass: 'none' | 'model' | 'adapter' | 'provider' | 'fixture' | 'harness';
  estimatedCostUsd: number | null;
}

export interface BenchmarkSummaryArm {
  provider: BenchmarkProvider;
  model: string;
  promptVariant: BenchmarkPromptVariant;
  runs: number;
  passed: number;
  failed: number;
  providerErrors: number;
  harnessErrors: number;
  passRate: number;
  hardFailures: number;
  softFailures: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  totalTokens: number;
  totalRequestDurationMs: number;
  totalResolutionDurationMs: number;
  p50RequestMs: number | null;
  p95RequestMs: number | null;
  p50ResolutionMs: number | null;
  p95ResolutionMs: number | null;
  p50SuccessfulResolutionMs: number | null;
  p95SuccessfulResolutionMs: number | null;
  estimatedCostUsd: number | null;
  costPerSuccessfulResolutionUsd: number | null;
}
