import type { CostRouteState, TaskKind } from '@desiide/protocol';
import type { ScoreResult } from '../types.ts';
import { score, type Ruled } from './answers.ts';

const CHEAP_SUCCESS_BASE: Record<TaskKind, number> = {
  autocomplete: 4,
  explain: 4,
  test_write: 3,
  refactor: 3,
  bug_fix: 2,
  other: 2,
  infra_change: 1,
};

const LARGE_PROJECT_LINES = 250_000;

export function cheapSuccess(state: CostRouteState): Ruled<ScoreResult> {
  let points = CHEAP_SUCCESS_BASE[state.taskType];
  const rationale = [`task_type:${state.taskType}`];
  if (state.filesTouchedCount > 3) {
    points -= state.filesTouchedCount > 10 ? 2 : 1;
    rationale.push(state.filesTouchedCount > 10 ? 'many_files' : 'several_files');
  }
  if (state.projectSizeLines > LARGE_PROJECT_LINES) {
    points -= 1;
    rationale.push('large_project');
  }
  if (state.recentFailures > 0) {
    points -= Math.min(state.recentFailures, 2);
    rationale.push('recent_failures');
  }
  return score(points, ...rationale);
}
