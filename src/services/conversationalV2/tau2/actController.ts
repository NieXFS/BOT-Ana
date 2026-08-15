import type { Tau2Task, Tau2UserMode } from './types';

export function oracleActsForTaskV2(task: Tau2Task): readonly string[] {
  if (task.oracle_acts && task.oracle_acts.length > 0) {
    return task.oracle_acts;
  }
  return [task.user_scenario.first_act];
}

export function nextOracleActV2(
  task: Tau2Task,
  turnIndex: number
): string | null {
  return oracleActsForTaskV2(task)[turnIndex] ?? null;
}

export function validateControllerActV2(input: {
  mode: Tau2UserMode;
  chosenAct: string;
  allowedActs: readonly string[];
}): { ok: true } | { ok: false; reason: 'act_not_in_controller' } {
  if (input.mode !== 'oracle_user' && input.mode !== 'fixed_user_replay') {
    return { ok: false, reason: 'act_not_in_controller' };
  }
  return input.allowedActs.includes(input.chosenAct)
    ? { ok: true }
    : { ok: false, reason: 'act_not_in_controller' };
}
