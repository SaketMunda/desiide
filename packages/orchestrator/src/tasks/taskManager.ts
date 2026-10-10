import { ModelError, type ModelAdapter } from '@desiide/models';
import {
  TERMINAL_TASK_STATES,
  WorkspacePath,
  type CostPerMTok,
  type DecisionRecord,
  type EditProposal,
  type FileApplyResult,
  type FileMeta,
  type Task,
  type TaskEvent,
  type TaskInput,
  type TaskState,
  type TaskSummary,
} from '@desiide/protocol';
import type { RawToolCall, ToolExecution } from '../tools/runner.ts';
import {
  runAgentLoop,
  type ApprovalAnswer,
  type ApprovalRequest,
  type TaskEventBody,
} from './agentLoop.ts';
import { TaskCancelled, TaskFailure, createWallClock } from './budget.ts';
import type { ContextProvider } from './context.ts';
import type { Gate } from './gate.ts';

export type RunTool = (call: RawToolCall, signal: AbortSignal) => Promise<ToolExecution>;

/** Structural subset of pino. */
export interface TaskLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface TaskManagerOptions {
  /** Delivers events to the client (`host.notify('task.event', …)`). Must not throw. */
  emit(event: TaskEvent): void;
  /** Picks the model for a task. A thrown `ModelError` fails the task with its hint. */
  resolveModel(task: Task): ModelAdapter;
  costPerMTok?(modelId: string): CostPerMTok | undefined;
  /** Builds the per-task tool runner; may throw `TaskFailure` (e.g. no test command). */
  prepareTools(task: Task, signal: AbortSignal): Promise<RunTool>;
  /** Read on every task start, so a gate swapped in later (JEV-2) applies to new tasks. */
  gate(): Gate;
  context: ContextProvider;
  /** Tasks running at once; the rest wait in `queued`. */
  maxRunning?: number;
  /** Finished tasks kept for `task.list`. */
  maxRetained?: number;
  newId(): string;
  now?: () => number;
  logger?: TaskLogger;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`No task with id "${taskId}"`);
    this.name = 'TaskNotFoundError';
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending approval or proposal with id "${id}"`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class InvalidReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReportError';
  }
}

export interface TaskManager {
  create(input: TaskInput): TaskSummary;
  /** `false` when the task had already finished. */
  cancel(taskId: string): boolean;
  list(): TaskSummary[];
  get(taskId: string): TaskSummary;
  approve(taskId: string, approvalId: string, scope: 'once' | 'task'): void;
  reject(taskId: string, approvalId: string, reason?: string): void;
  reportEdits(taskId: string, proposalId: string, files: FileApplyResult[]): void;
  /** Resolves when the task reaches a terminal state. */
  settled(taskId: string): Promise<TaskSummary>;
  cancelAll(reason: string): Promise<void>;
  /**
   * Emits `decision_made` in the decision's task stream, so it lands before the
   * `approval_required` it explains. Ignored for unknown or task-less decisions.
   */
  publishDecision(record: DecisionRecord): void;
}

interface PendingEdits {
  paths: string[];
  results: Map<string, FileApplyResult>;
  resolve(results: FileApplyResult[]): void;
}

interface TaskRun {
  task: Task;
  summary: TaskSummary;
  seq: number;
  controller: AbortController;
  approvals: Map<string, (answer: ApprovalAnswer) => void>;
  edits: Map<string, PendingEdits>;
  done: Promise<void>;
  markDone(): void;
}

const isTerminal = (s: TaskState): boolean => TERMINAL_TASK_STATES.includes(s);

/** Rejects with the signal's reason once it aborts, so no wait outlives its task. */
function untilAborted<T>(signal: AbortSignal, executor: (resolve: (v: T) => void) => () => void) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const cleanup = executor((v) => {
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    });
    function onAbort(): void {
      cleanup();
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createTaskManager(opts: TaskManagerOptions): TaskManager {
  const now = opts.now ?? Date.now;
  const maxRunning = opts.maxRunning ?? 2;
  const maxRetained = opts.maxRetained ?? 100;
  const runs = new Map<string, TaskRun>();
  const queue: TaskRun[] = [];
  let running = 0;

  const iso = (): string => new Date(now()).toISOString();

  function find(taskId: string): TaskRun {
    const run = runs.get(taskId);
    if (!run) throw new TaskNotFoundError(taskId);
    return run;
  }

  function emit(run: TaskRun, body: TaskEventBody): void {
    const event = { ...body, taskId: run.task.id, seq: run.seq++, ts: iso() } as TaskEvent;
    if (event.type === 'usage') {
      const u = run.summary.usage;
      u.inputTokens += event.usage.inputTokens;
      u.outputTokens += event.usage.outputTokens;
      if (event.usage.costUsd !== undefined) u.costUsd = (u.costUsd ?? 0) + event.usage.costUsd;
    }
    try {
      opts.emit(event);
    } catch (err) {
      opts.logger?.error({ err, taskId: run.task.id }, 'task event delivery failed');
    }
  }

  function setState(run: TaskRun, to: TaskState, reason?: string): void {
    const from = run.summary.state;
    if (from === to && run.seq > 0) return;
    run.summary.state = to;
    run.summary.updatedAt = iso();
    emit(run, {
      type: 'state_changed',
      from: run.seq === 0 ? null : from,
      to,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  function finish(run: TaskRun, to: 'done' | 'failed' | 'cancelled', failure?: TaskFailure): void {
    if (isTerminal(run.summary.state)) return;
    if (failure) {
      run.summary.failureReason = failure.reason;
      emit(run, {
        type: 'error',
        kind: failure.kind,
        message: failure.message,
        retryable: failure.retryable,
      });
    }
    setState(run, to, failure?.reason);
    run.markDone();
    prune();
  }

  function prune(): void {
    const finished = [...runs.values()].filter((r) => isTerminal(r.summary.state));
    for (const r of finished.slice(0, Math.max(0, finished.length - maxRetained))) {
      runs.delete(r.task.id);
    }
  }

  function pump(): void {
    while (running < maxRunning) {
      const next = queue.shift();
      if (!next) return;
      running += 1;
      void start(next).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  async function start(run: TaskRun): Promise<void> {
    const { signal } = run.controller;
    const clock = createWallClock(
      run.task.budget.wallClockMs,
      () =>
        run.controller.abort(
          new TaskFailure(
            'budget:wallClockMs',
            `Stopped after ${Math.round(run.task.budget.wallClockMs / 1000)} s of work (the task's time budget).`,
          ),
        ),
      { now },
    );
    clock.start();
    try {
      setState(run, 'planning');
      const model = opts.resolveModel(run.task);
      run.summary.models.push(model.id);
      const runTool = await opts.prepareTools(run.task, signal);
      const costPerMTok = opts.costPerMTok?.(model.id);
      await runAgentLoop({
        task: run.task,
        model,
        gate: opts.gate(),
        context: opts.context,
        runTool,
        signal,
        newId: opts.newId,
        now,
        ...(costPerMTok ? { costPerMTok } : {}),
        io: {
          emit: (body) => emit(run, body),
          setState: (to) => setState(run, to),
          setIteration: (n) => {
            run.summary.iteration = n;
          },
          requestApproval: (req, s) => waitForUser(run, s, clock, approvalWait(run, req)),
          requestEditReport: (proposal, files, s) =>
            waitForUser(run, s, clock, editWait(run, proposal, files)),
        },
      });
      finish(run, 'done');
    } catch (err) {
      const cause: unknown = signal.aborted ? signal.reason : err;
      if (cause instanceof TaskFailure) {
        finish(run, 'failed', cause);
      } else if (signal.aborted) {
        finish(run, 'cancelled');
      } else if (cause instanceof ModelError) {
        const message = cause.hint ? `${cause.message} ${cause.hint}` : cause.message;
        finish(run, 'failed', new TaskFailure('model_unavailable', message, { kind: cause.kind }));
      } else {
        opts.logger?.error({ err: cause, taskId: run.task.id }, 'task crashed');
        finish(
          run,
          'failed',
          new TaskFailure(
            'internal_error',
            'Desiide hit an internal error. See the log for details.',
          ),
        );
      }
    } finally {
      clock.stop();
      // Nothing may wait on a finished task.
      if (!signal.aborted) run.controller.abort(new TaskCancelled('task finished'));
    }
  }

  type Wait<T> = (resolve: (v: T) => void) => () => void;

  async function waitForUser<T>(
    run: TaskRun,
    signal: AbortSignal,
    clock: { pause(): void; resume(): void },
    wait: Wait<T>,
  ): Promise<T> {
    setState(run, 'awaiting_approval');
    clock.pause();
    try {
      return await untilAborted(signal, wait);
    } finally {
      clock.resume();
    }
  }

  function approvalWait(run: TaskRun, req: ApprovalRequest): Wait<ApprovalAnswer> {
    return (resolve) => {
      const approvalId = opts.newId();
      run.approvals.set(approvalId, resolve);
      emit(run, {
        type: 'approval_required',
        approvalId,
        call: req.call,
        outcome: 'confirm',
        reasons: req.reasons,
        ...(req.decisionId === undefined ? {} : { decisionId: req.decisionId }),
        paths: pathsOf(req.call.args),
      });
      return () => run.approvals.delete(approvalId);
    };
  }

  function editWait(
    run: TaskRun,
    proposal: EditProposal,
    files: FileMeta[],
  ): Wait<FileApplyResult[]> {
    return (resolve) => {
      run.edits.set(proposal.id, {
        paths: proposal.files.map((f) => f.path),
        results: new Map(),
        resolve,
      });
      emit(run, { type: 'edit_proposed', proposal, files });
      return () => run.edits.delete(proposal.id);
    };
  }

  function answer(taskId: string, approvalId: string, value: ApprovalAnswer): void {
    const run = find(taskId);
    const resolve = run.approvals.get(approvalId);
    if (!resolve) throw new ApprovalNotFoundError(approvalId);
    run.approvals.delete(approvalId);
    resolve(value);
  }

  return {
    publishDecision(record) {
      const run = record.taskId === null ? undefined : runs.get(record.taskId);
      if (run) emit(run, { type: 'decision_made', decision: record });
    },
    create(input) {
      const id = opts.newId();
      const task: Task = { id, ...input };
      const ts = iso();
      let markDone = (): void => {};
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      const run: TaskRun = {
        task,
        summary: {
          id,
          kind: task.kind,
          instruction: task.instruction,
          state: 'queued',
          models: [],
          iteration: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: ts,
          updatedAt: ts,
          ...(task.workflowOverride ? { workflow: task.workflowOverride } : {}),
        },
        seq: 0,
        controller: new AbortController(),
        approvals: new Map(),
        edits: new Map(),
        done,
        markDone: () => markDone(),
      };
      runs.set(id, run);
      setState(run, 'queued');
      queue.push(run);
      const snapshot = structuredClone(run.summary);
      pump();
      return snapshot;
    },

    cancel(taskId) {
      const run = find(taskId);
      if (isTerminal(run.summary.state)) return false;
      const queued = queue.indexOf(run);
      if (queued >= 0) {
        queue.splice(queued, 1);
        finish(run, 'cancelled');
      } else {
        run.controller.abort(new TaskCancelled());
      }
      return true;
    },

    list: () => [...runs.values()].map((r) => structuredClone(r.summary)),

    get: (taskId) => structuredClone(find(taskId).summary),

    approve: (taskId, approvalId, scope) => answer(taskId, approvalId, { approved: true, scope }),

    reject: (taskId, approvalId, reason) =>
      answer(taskId, approvalId, {
        approved: false,
        ...(reason === undefined ? {} : { reason }),
      }),

    reportEdits(taskId, proposalId, files) {
      const run = find(taskId);
      const pending = run.edits.get(proposalId);
      if (!pending) throw new ApprovalNotFoundError(proposalId);
      const unknown = files.filter((f) => !pending.paths.includes(f.path));
      if (unknown.length > 0) {
        throw new InvalidReportError(
          `Not in proposal ${proposalId}: ${unknown.map((f) => f.path).join(', ')}`,
        );
      }
      for (const f of files) pending.results.set(f.path, f);
      if (pending.results.size < pending.paths.length) return;
      run.edits.delete(proposalId);
      pending.resolve(pending.paths.map((p) => pending.results.get(p) as FileApplyResult));
    },

    async settled(taskId) {
      const run = find(taskId);
      await run.done;
      return structuredClone(run.summary);
    },

    async cancelAll(reason) {
      const active = [...runs.values()].filter((r) => !isTerminal(r.summary.state));
      queue.length = 0;
      for (const run of active) {
        if (run.summary.state === 'queued') finish(run, 'cancelled');
        else run.controller.abort(new TaskCancelled(reason));
      }
      await Promise.all(active.map((r) => r.done));
    },
  };
}

/** Paths an action touches, for the approval card. Only `path`-like string args count. */
function pathsOf(args: Record<string, unknown>): string[] {
  const path = WorkspacePath.safeParse(args.path);
  return path.success ? [path.data] : [];
}
