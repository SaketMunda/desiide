import {
  buildCostRouteState,
  buildWorkflowSelectState,
  decideWorkflow,
  stateHash,
  type AvailableModel,
  type JevAnswer,
  type JevEngine,
  type PathRedactor,
} from '@desiide/jev';
import type { ModelAdapter } from '@desiide/models';
import type {
  DecisionRecord,
  FileMeta,
  JevResult,
  ReasonLabel,
  Task,
  WorkflowOption,
  WorkflowSelectState,
} from '@desiide/protocol';
import {
  EscalationRequested,
  type AgentLoopOptions,
  type EscalationTrigger,
} from '../tasks/agentLoop.ts';
import { TaskFailure, createBudgetTracker } from '../tasks/budget.ts';
import { planFor, runnableOptions, type RoleModels, type WorkflowPlan } from './roles.ts';

/** What a workflow may add to one model's agent loop. */
export type LoopExtras = Pick<AgentLoopOptions, 'history' | 'handoff' | 'budget' | 'escalateOn'>;

/** One task, as the task manager hands it to the workflow engine. */
export interface WorkflowRun {
  task: Task;
  signal: AbortSignal;
  /** Runs one model through the agent loop with the task's IO, gate, and tools. */
  runLoop(model: ModelAdapter, extras: LoopExtras): Promise<void>;
  /** Records the chosen workflow on the task summary. */
  setWorkflow(workflow: WorkflowOption): void;
  /** How the previous task ended, and how many recent ones failed (routing state). */
  lastRunStatus: WorkflowSelectState['lastRunStatus'];
  recentFailures: number;
}

export interface WorkflowEngineDeps {
  roles(): RoleModels;
  /** The policy's engine (rules, or Jev once configured). */
  engine(): JevEngine;
  /** The decision log + task stream (JEV-4 / UI-5). */
  onDecision(record: DecisionRecord): void;
  /** COR-4 metadata for the task's files (never contents, ADR-005). */
  describeFiles(paths: string[], signal: AbortSignal): Promise<FileMeta[]>;
  /** Routing metadata for these models. */
  availableModels(ids: string[], signal: AbortSignal): Promise<AvailableModel[]>;
  redactor?(): PathRedactor | undefined;
  newId(): string;
  now?: () => number;
  logger?: { warn(obj: object, msg?: string): void };
}

export interface WorkflowEngine {
  /**
   * Throws `TaskFailure('model_unavailable')` when no workflow can run with the configured roles.
   * Called before tool setup, so "set up a model" is the first thing a new user is told.
   */
  assertRunnable(): void;
  run(run: WorkflowRun): Promise<void>;
}

/** `escalation_need` at or above this sends a cascade straight to the strong model. */
export const ESCALATION_NEED_THRESHOLD = 3;

/** The conversation the strong model continues, and why it's there. */
export function escalationHandoff(trigger: EscalationTrigger): string {
  const why =
    trigger.kind === 'verification_failed'
      ? 'the checks failed (above)'
      : "its edit didn't parse or didn't match the files (see the tool result above)";
  return [
    'You are taking over this task from a smaller model, which got stuck: ' + why + '.',
    'The conversation so far is its attempt. Edits the user applied are already in the workspace; re-read files before editing them.',
    'Fix what failed and finish the task.',
  ].join(' ');
}

const noModel = (): TaskFailure =>
  new TaskFailure(
    'model_unavailable',
    'No model can run this task. Assign a model to desiide.roles.cheap or desiide.roles.strong in settings.',
  );

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * COR-5: picks the task's workflow (JEV-2 `decideWorkflow`, offered only what the configured roles
 * can run) and runs it. `single` is one agent loop; `cascade` runs the cheap model and hands the
 * same conversation to the strong one, at most once, when checks fail, an edit fails, or Jev
 * expects it to need help (`escalation_need`).
 */
export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const now = deps.now ?? Date.now;

  async function select(run: WorkflowRun, roles: RoleModels) {
    const { task, signal } = run;
    const options = runnableOptions(roles);
    if (options.length === 0) throw noModel();
    const paths = unique(
      task.context.refs.flatMap((r) =>
        r.type === 'file' || r.type === 'selection' ? [r.path] : [],
      ),
    );
    const files = paths.length > 0 ? await deps.describeFiles(paths, signal) : [];
    const modelIds = unique(Object.values(roles).flatMap((m) => (m ? [m.id] : [])));
    const redactor = deps.redactor?.();
    const workflowState = buildWorkflowSelectState(
      {
        task,
        context: { files },
        // A rough guess from the attached files; nothing better is known before the model runs.
        estimatedDiffSize: Math.min(
          500,
          files.reduce((n, f) => n + Math.min(f.sizeLines, 50), 0),
        ),
        lastRunStatus: run.lastRunStatus,
        models: await deps.availableModels(modelIds, signal),
      },
      redactor ? { redactor } : {},
    );
    const costState = buildCostRouteState({
      task,
      context: { files },
      projectSizeLines: files.reduce((n, f) => n + f.sizeLines, 0),
      recentFailures: run.recentFailures,
    });
    const decision = await decideWorkflow(
      { task, workflowState, costState, options },
      { engine: deps.engine(), newId: deps.newId, now, onDecision: deps.onDecision },
      signal,
    );
    const plan = decision.workflow ? planFor(decision.workflow, roles) : undefined;
    if (!plan) {
      // decideWorkflow only returns offered options; this is a defect, not a user problem.
      throw new TaskFailure('model_unavailable', 'No workflow could run this task.');
    }
    return { plan, workflowState };
  }

  function record(
    taskId: string,
    workflowState: WorkflowSelectState,
    workflow: WorkflowOption,
    question: string,
    answer: Pick<JevAnswer<JevResult>, 'engine' | 'result' | 'latencyMs'>,
    reasons: ReasonLabel[],
  ): void {
    const rec: DecisionRecord = {
      id: deps.newId(),
      taskId,
      pack: workflowState.pack,
      question,
      engine: answer.engine,
      stateHash: stateHash(workflowState),
      state: { ...workflowState },
      result: answer.result,
      workflow,
      reasons,
      latencyMs: Math.max(0, Math.round(answer.latencyMs)),
      ts: new Date(now()).toISOString(),
    };
    try {
      deps.onDecision(rec);
    } catch (err) {
      deps.logger?.warn({ err }, 'decision sink failed');
    }
  }

  async function cascade(
    run: WorkflowRun,
    plan: WorkflowPlan & { escalateTo: ModelAdapter },
    workflowState: WorkflowSelectState,
  ): Promise<void> {
    const { task, signal } = run;
    const escalate = (kind: string) =>
      record(
        task.id,
        workflowState,
        plan.workflow,
        'escalate',
        { engine: 'rules', result: { kind: 'noul', answer: 'yes', pYes: 1 }, latencyMs: 0 },
        ['escalated', `escalated:${kind}`],
      );
    // One conversation and one set of budgets across both models.
    const history: NonNullable<LoopExtras['history']> = [];
    const budget = createBudgetTracker(task.budget);

    const need = await deps
      .engine()
      .score({ state: workflowState, question: 'escalation_need' }, signal)
      .catch((err: unknown) => {
        signal.throwIfAborted();
        deps.logger?.warn({ err }, 'escalation_need unavailable; starting on the cheap model');
        return undefined;
      });
    const high = need !== undefined && need.result.score >= ESCALATION_NEED_THRESHOLD;
    if (need) {
      record(
        task.id,
        workflowState,
        plan.workflow,
        'escalation_need',
        need,
        high ? ['escalated:escalation_need'] : [],
      );
    }
    if (high) {
      escalate('escalation_need');
      await run.runLoop(plan.escalateTo, { history, budget });
      return;
    }

    try {
      await run.runLoop(plan.first, { history, budget, escalateOn: () => true });
      return;
    } catch (err) {
      if (!(err instanceof EscalationRequested)) throw err;
      escalate(err.trigger.kind);
      // Once: the strong model has no escalation hook.
      await run.runLoop(plan.escalateTo, {
        history,
        budget,
        handoff: escalationHandoff(err.trigger),
      });
    }
  }

  return {
    assertRunnable() {
      if (runnableOptions(deps.roles()).length === 0) throw noModel();
    },
    async run(run) {
      const roles = deps.roles();
      const { plan, workflowState } = await select(run, roles);
      run.setWorkflow(plan.workflow);
      if (plan.escalateTo) {
        await cascade(run, { ...plan, escalateTo: plan.escalateTo }, workflowState);
      } else {
        await run.runLoop(plan.first, {});
      }
    },
  };
}
