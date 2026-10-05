import type {
  CostRouteState,
  DecisionRecord,
  JevResult,
  ReasonLabel,
  Task,
  WorkflowOption,
  WorkflowSelectState,
} from '@desiide/protocol';
import { allowedWorkflowOptions } from '../packs/registry.ts';
import type { JevAnswer, JevEngine } from '../types.ts';
import { stateHash } from './gate.ts';

/** Weakest to strongest. A floor moves the choice up this list, never down. */
const RANK: readonly WorkflowOption[] = [
  'local-single',
  'local-cloud-cascade',
  'cloud-single',
  'cloud-with-critique',
];

export interface WorkflowPolicyInput {
  task: Pick<Task, 'id' | 'preference' | 'workflowOverride'>;
  workflowState: WorkflowSelectState;
  costState: CostRouteState;
}

export interface WorkflowPolicyOptions {
  engine: JevEngine;
  newId(): string;
  now?: () => number;
  onDecision?(record: DecisionRecord): void;
}

export interface WorkflowDecision {
  /** Undefined when no configured model can run any workflow. */
  workflow: WorkflowOption | undefined;
  reasons: ReasonLabel[];
  /** The `workflow_select` record, for the Decision panel. */
  decisionId?: string;
}

/**
 * Picks the workflow for a task: the user's explicit choice when it's possible, otherwise Jev's
 * `workflow_select` choice adjusted by policy. Cheap-and-likely tasks go local-first unless the
 * user wants quality; complex tasks or tasks with sensitive files get at least `cloud-single`
 * (`cloud-with-critique` for quality). Every adjustment is a `policy_override:<rule>` label.
 */
export async function decideWorkflow(
  input: WorkflowPolicyInput,
  opts: WorkflowPolicyOptions,
  signal?: AbortSignal,
): Promise<WorkflowDecision> {
  const now = opts.now ?? Date.now;
  const { task, workflowState, costState } = input;
  const allowed = allowedWorkflowOptions(workflowState);
  if (allowed.length === 0) return { workflow: undefined, reasons: ['no_models_configured'] };

  if (task.workflowOverride) {
    if (allowed.includes(task.workflowOverride)) {
      return { workflow: task.workflowOverride, reasons: ['policy_override:user_choice'] };
    }
  }

  const [choice, complexity, cheap] = await Promise.all([
    opts.engine.choice({ state: workflowState, question: 'workflow', options: allowed }, signal),
    opts.engine.score({ state: workflowState, question: 'complexity' }, signal),
    opts.engine.score({ state: costState, question: 'cheap_success' }, signal),
  ]);

  const reasons: ReasonLabel[] = [];
  if (task.workflowOverride) reasons.push(`option_unavailable:${task.workflowOverride}`);
  let workflow = choice.result.selected as WorkflowOption;
  const rank = (w: WorkflowOption): number => RANK.indexOf(w);
  const pick = (candidates: WorkflowOption[]): WorkflowOption | undefined =>
    candidates.find((c) => allowed.includes(c));

  if (
    cheap.result.score >= 3 &&
    task.preference !== 'quality' &&
    rank(workflow) >= rank('cloud-single')
  ) {
    const local = pick(['local-cloud-cascade', 'local-single']);
    if (local) {
      workflow = local;
      reasons.push('policy_override:cheap_success');
    }
  }
  const sensitive = workflowState.filesTouched.some((f) => f.sensitive);
  if (complexity.result.score >= 3 || sensitive) {
    const rule = complexity.result.score >= 3 ? 'complexity_floor' : 'sensitive_floor';
    const floor =
      task.preference === 'quality'
        ? pick(['cloud-with-critique', 'cloud-single'])
        : pick(['cloud-single']);
    if (floor && rank(workflow) < rank(floor)) {
      workflow = floor;
      reasons.push(`policy_override:${rule}`);
    }
  }
  if (!allowed.includes(workflow)) {
    // A misbehaving engine picked something unavailable; fall back to the strongest allowed.
    workflow = allowed.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    reasons.push('policy_override:option_unavailable');
  }

  const log = (
    question: string,
    state: WorkflowSelectState | CostRouteState,
    answer: JevAnswer<JevResult>,
  ): DecisionRecord => {
    const rec: DecisionRecord = {
      id: opts.newId(),
      taskId: task.id,
      pack: state.pack,
      question,
      engine: answer.engine,
      stateHash: stateHash(state),
      state: { ...state },
      result: answer.result,
      workflow,
      reasons,
      latencyMs: Math.max(0, Math.round(answer.latencyMs)),
      ts: new Date(now()).toISOString(),
    };
    try {
      opts.onDecision?.(rec);
    } catch {
      // Logging failures don't change the decision.
    }
    return rec;
  };
  const main = log('workflow', workflowState, choice);
  log('complexity', workflowState, complexity);
  log('cheap_success', costState, cheap);
  return { workflow, reasons, decisionId: main.id };
}
