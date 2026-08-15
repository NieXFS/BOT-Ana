import { wilsonInterval } from './passK';
import type { Tau2Task, Tau2UserMode } from './types';

export const TAU2_SIMULATOR_LABELS_V2 = [
  'ok',
  'unknown_task',
  'empty_user_act',
  'act_not_in_controller',
  'oracle_sequence_mismatch',
  'empty_agent_payload',
] as const;

export type Tau2SimulatorAuditLabelV2 = (typeof TAU2_SIMULATOR_LABELS_V2)[number];

export interface Tau2SimulatorAuditV2 {
  readonly mode: Tau2UserMode;
  readonly transcriptsAudited: number;
  readonly totalTranscripts: number;
  readonly requiredAudits: number;
  readonly totalErrorRate: number;
  readonly criticalErrorRate: number;
  readonly wilson: { low: number; high: number };
  readonly inconclusive: boolean;
  readonly labeled: readonly Tau2LabeledTranscriptV2[];
}

export interface Tau2SessionTranscriptV2 {
  readonly taskId: string;
  readonly armId: string;
  readonly trialId: number;
  readonly userActs: readonly string[];
  readonly agentPayloads: readonly string[];
}

export interface Tau2LabeledTranscriptV2 {
  readonly taskId: string;
  readonly armId: string;
  readonly trialId: number;
  readonly labels: readonly Tau2SimulatorAuditLabelV2[];
  readonly failed: boolean;
  readonly critical: boolean;
}

const CRITICAL_LABELS = new Set<Tau2SimulatorAuditLabelV2>([
  'unknown_task',
  'empty_user_act',
  'act_not_in_controller',
  'oracle_sequence_mismatch',
  'empty_agent_payload',
]);

export function requiredSimulatorAuditCountV2(totalTranscripts: number): number {
  const total = Math.max(0, Math.floor(totalTranscripts));
  return Math.max(30, Math.ceil(total * 0.2));
}

export function selectTranscriptsForAuditV2<T>(
  transcripts: readonly T[],
  seed = 1
): T[] {
  const required = requiredSimulatorAuditCountV2(transcripts.length);
  if (transcripts.length === 0) return [];
  const take = Math.min(required, transcripts.length);
  const ranked = transcripts.map((item, index) => ({
    item,
    rank: ((index + 1) * 1103515245 + seed) >>> 0,
  }));
  ranked.sort((left, right) => left.rank - right.rank);
  return ranked.slice(0, take).map((entry) => entry.item);
}

export function labelSimulatorTranscriptV2(input: {
  transcript: Tau2SessionTranscriptV2;
  task?: Tau2Task | null;
  mode?: Tau2UserMode;
}): Tau2LabeledTranscriptV2 {
  const labels = new Set<Tau2SimulatorAuditLabelV2>();
  const transcript = input.transcript;
  if (!input.task) {
    labels.add('unknown_task');
  } else {
    const oracleActs = oracleActsOf(input.task);
    const allowedActs = new Set(oracleActs);
    if (transcript.userActs.some((act) => !act.trim())) {
      labels.add('empty_user_act');
    }
    if (transcript.userActs.some((act) => !allowedActs.has(act))) {
      labels.add('act_not_in_controller');
    }
    if (!sameActSequence(transcript.userActs, oracleActs)) {
      labels.add('oracle_sequence_mismatch');
    }
  }
  if (
    transcript.agentPayloads.length === 0 ||
    transcript.agentPayloads.some((payload) => !payload.trim())
  ) {
    labels.add('empty_agent_payload');
  }
  const failed = labels.size > 0;
  if (!failed) labels.add('ok');
  const critical = [...labels].some((label) => CRITICAL_LABELS.has(label));
  return {
    taskId: transcript.taskId,
    armId: transcript.armId,
    trialId: transcript.trialId,
    labels: [...labels],
    failed,
    critical,
  };
}

/**
 * Simulador restrito: o controlador escolhe o ato; o LLM só verbaliza.
 * Cobertura < max(30, 20%) ou zero auditorias → inconclusivo.
 * Erro crítico >5% também inconclusivo — nunca remove trial silenciosamente.
 * Contagens vêm dos rótulos derivados dos transcripts — nunca de failCount manual.
 */
export function auditSimulatorTranscriptsV2(input: {
  mode: Tau2UserMode;
  transcripts: readonly Tau2SessionTranscriptV2[];
  tasks: readonly Tau2Task[];
  seed?: number;
}): Tau2SimulatorAuditV2 {
  const sampled = selectTranscriptsForAuditV2(input.transcripts, input.seed ?? 1);
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const labeled = sampled.map((transcript) =>
    labelSimulatorTranscriptV2({
      transcript,
      task: byId.get(transcript.taskId) ?? null,
      mode: input.mode,
    })
  );
  return summarizeSimulatorAuditV2({
    mode: input.mode,
    labeled,
    totalTranscripts: input.transcripts.length,
  });
}

export function summarizeSimulatorAuditV2(input: {
  mode: Tau2UserMode;
  labeled: readonly Tau2LabeledTranscriptV2[];
  totalTranscripts: number;
}): Tau2SimulatorAuditV2 {
  const audited = Math.max(input.labeled.length, 0);
  const total = Math.max(input.totalTranscripts, audited);
  const required = requiredSimulatorAuditCountV2(total);
  const critical = input.labeled.filter((entry) => entry.critical).length;
  const totalErrors = input.labeled.filter((entry) => entry.failed).length;
  const criticalRate = audited === 0 ? 1 : critical / audited;
  const totalRate = audited === 0 ? 1 : totalErrors / audited;
  const coverageInconclusive = audited < required;
  return {
    mode: input.mode,
    transcriptsAudited: audited,
    totalTranscripts: total,
    requiredAudits: required,
    totalErrorRate: totalRate,
    criticalErrorRate: criticalRate,
    wilson: wilsonInterval(Math.max(audited - critical, 0), Math.max(audited, 1)),
    inconclusive: coverageInconclusive || criticalRate > 0.05 || audited === 0,
    labeled: [...input.labeled],
  };
}

export function replayIncompatibleResultV2(): 'replay_incompatible' {
  return 'replay_incompatible';
}

function oracleActsOf(task: Tau2Task): readonly string[] {
  if (task.oracle_acts && task.oracle_acts.length > 0) {
    return task.oracle_acts;
  }
  return [task.user_scenario.first_act];
}

function sameActSequence(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((act, index) => act === expected[index])
  );
}
