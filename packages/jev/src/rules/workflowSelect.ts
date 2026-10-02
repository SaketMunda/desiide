import type { TaskKind, WorkflowOption, WorkflowSelectState } from '@desiide/protocol';
import type { ChoiceResult, ScoreResult } from '../types.ts';
import { choice, score, type Ruled } from './answers.ts';

const COMPLEXITY_BASE: Record<TaskKind, number> = {
  autocomplete: 0,
  explain: 0,
  test_write: 1,
  refactor: 1,
  bug_fix: 1,
  other: 1,
  infra_change: 2,
};

const LARGE_DIFF_LINES = 200;

function fileCount(state: WorkflowSelectState): number {
  return state.filesTouched.length + (state.truncatedCount ?? 0);
}

function hasSensitive(state: WorkflowSelectState): boolean {
  return state.filesTouched.some((f) => f.sensitive);
}

export function complexity(state: WorkflowSelectState): Ruled<ScoreResult> {
  let points = COMPLEXITY_BASE[state.taskType];
  const rationale = [`task_type:${state.taskType}`];
  const files = fileCount(state);
  if (files > 3) {
    points += files > 10 ? 2 : 1;
    rationale.push(files > 10 ? 'many_files' : 'several_files');
  }
  if (state.estimatedDiffSize > LARGE_DIFF_LINES) {
    points += 1;
    rationale.push('large_diff');
  }
  if (hasSensitive(state)) {
    points += 1;
    rationale.push('sensitive_file');
  }
  return score(points, ...rationale);
}

export function escalationNeed(state: WorkflowSelectState): Ruled<ScoreResult> {
  const c = complexity(state).result.score;
  let points = 0;
  const rationale: string[] = [];
  if (c >= 3) {
    points += 2;
    rationale.push('high_complexity');
  } else if (c === 2) {
    points += 1;
    rationale.push('medium_complexity');
  }
  if (state.lastRunStatus === 'failed') {
    points += 2;
    rationale.push('last_run_failed');
  }
  if (hasSensitive(state)) {
    points += 1;
    rationale.push('sensitive_file');
  }
  if (rationale.length === 0) rationale.push('low_complexity');
  return score(points, ...rationale);
}

type Ordered = readonly [WorkflowOption, ...WorkflowOption[]];

/** Preferred workflows in order; the first one that's available wins. */
const PREFERENCE_ORDER = {
  quality: ['cloud-with-critique', 'cloud-single', 'local-cloud-cascade', 'local-single'],
  needsCloud: ['cloud-single', 'cloud-with-critique', 'local-cloud-cascade', 'local-single'],
  cheap: ['local-single', 'local-cloud-cascade', 'cloud-single', 'cloud-with-critique'],
  balance: ['local-cloud-cascade', 'local-single', 'cloud-single', 'cloud-with-critique'],
} as const satisfies Record<string, Ordered>;

export function workflowChoice(
  state: WorkflowSelectState,
  options: readonly string[],
): Ruled<ChoiceResult> {
  const c = complexity(state).result.score;
  let order: Ordered;
  let why: string;
  if (state.userPreference === 'quality') {
    [order, why] = [PREFERENCE_ORDER.quality, 'prefers_quality'];
  } else if (state.lastRunStatus === 'failed') {
    [order, why] = [PREFERENCE_ORDER.needsCloud, 'last_run_failed'];
  } else if (hasSensitive(state)) {
    [order, why] = [PREFERENCE_ORDER.needsCloud, 'sensitive_file'];
  } else if (c >= 3) {
    [order, why] = [PREFERENCE_ORDER.needsCloud, 'high_complexity'];
  } else if (state.userPreference === 'cheap') {
    [order, why] = [PREFERENCE_ORDER.cheap, 'prefers_cheap'];
  } else {
    [order, why] = [PREFERENCE_ORDER.balance, c <= 1 ? 'low_complexity' : 'balanced_default'];
  }
  const wanted = order[0];
  // Options are validated non-empty upstream; fall back to the first option defensively.
  const selected: string = order.find((o) => options.includes(o)) ?? options[0] ?? wanted;
  return selected === wanted
    ? choice(selected, options, 0.85, why)
    : choice(selected, options, 0.7, why, `option_unavailable:${wanted}`);
}
