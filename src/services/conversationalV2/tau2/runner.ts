import { nextOracleActV2, oracleActsForTaskV2, validateControllerActV2 } from './actController';
import { passAt1, passAt4 } from './passK';
import { evaluateTau2RewardV2 } from './reward';
import {
  cloneInitialStateV2,
  expectedCanonicalStateV2,
} from './stateProjection';
import type {
  Tau2ArmId,
  Tau2CanonicalState,
  Tau2Reward,
  Tau2Task,
  Tau2UserMode,
} from './types';

export interface Tau2TurnExecutionV2 {
  readonly payload: string;
  readonly actual: Tau2CanonicalState;
  readonly wrote: boolean;
}

export interface Tau2TrialRecordV2 {
  readonly taskId: string;
  readonly armId: Tau2ArmId;
  readonly trialId: number;
  readonly userActs: readonly string[];
  readonly deliveredPayloads: readonly string[];
  readonly actual: Tau2CanonicalState;
  readonly expected: Tau2CanonicalState;
  readonly reward: Tau2Reward;
  readonly controllerErrors: number;
}

export async function runTau2TrialV2(input: {
  task: Tau2Task;
  armId: Tau2ArmId;
  trialId: number;
  mode?: Tau2UserMode;
  applyUserAct: (input: {
    act: string;
    turnIndex: number;
    initialState: Tau2Task['initial_state'];
  }) => Promise<Tau2TurnExecutionV2>;
}): Promise<Tau2TrialRecordV2> {
  const mode = input.mode ?? 'oracle_user';
  const initialState = cloneInitialStateV2(input.task.initial_state);
  const allowedActs = oracleActsForTaskV2(input.task);
  const userActs: string[] = [];
  const deliveredPayloads: string[] = [];
  let actual: Tau2CanonicalState = expectedCanonicalStateV2(initialState, {});
  let controllerErrors = 0;
  let turnIndex = 0;
  while (true) {
    const act = nextOracleActV2(input.task, turnIndex);
    if (!act) break;
    const allowed = validateControllerActV2({
      mode,
      chosenAct: act,
      allowedActs,
    });
    if (!allowed.ok) controllerErrors += 1;
    userActs.push(act);
    const turn = await input.applyUserAct({
      act,
      turnIndex,
      initialState,
    });
    deliveredPayloads.push(turn.payload);
    actual = turn.actual;
    turnIndex += 1;
    if (turn.wrote) break;
  }
  const expected = expectedCanonicalStateV2(
    initialState,
    input.task.evaluation_criteria.target_state
  );
  const reward = evaluateTau2RewardV2({
    actual,
    expected,
    envAssertions: input.task.evaluation_criteria.env_assertions,
    communicateInfo: input.task.evaluation_criteria.communicate_info,
    deliveredPayloads,
  });
  return {
    taskId: input.task.id,
    armId: input.armId,
    trialId: input.trialId,
    userActs,
    deliveredPayloads,
    actual,
    expected,
    reward,
    controllerErrors,
  };
}

export function aggregatePassKByTaskV2(
  records: readonly Tau2TrialRecordV2[]
): Array<{
  taskId: string;
  armId: Tau2ArmId;
  trials: number;
  successes: number;
  pass1: number;
  pass4: number;
}> {
  const grouped = new Map<string, Tau2TrialRecordV2[]>();
  for (const record of records) {
    const key = `${record.taskId}\0${record.armId}`;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  return [...grouped.values()]
    .map((trials) => {
      const first = trials[0]!;
      const successes = trials.filter((trial) => trial.reward.reward === 1).length;
      return {
        taskId: first.taskId,
        armId: first.armId,
        trials: trials.length,
        successes,
        pass1: passAt1(successes, trials.length),
        pass4: passAt4(successes, trials.length),
      };
    })
    .sort((left, right) => {
      const task = left.taskId.localeCompare(right.taskId);
      return task !== 0 ? task : left.armId.localeCompare(right.armId);
    });
}

export function macroPassKFromTasksV2(
  perTask: readonly { pass1: number; pass4: number }[]
): { pass1: number; pass4: number } {
  if (perTask.length === 0) return { pass1: 0, pass4: 0 };
  return {
    pass1: perTask.reduce((sum, entry) => sum + entry.pass1, 0) / perTask.length,
    pass4: perTask.reduce((sum, entry) => sum + entry.pass4, 0) / perTask.length,
  };
}
