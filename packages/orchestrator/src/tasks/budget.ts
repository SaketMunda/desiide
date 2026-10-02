import type { Budget } from '@desiide/protocol';

/** Ends a task as `failed`. `reason` becomes `TaskSummary.failureReason` (a structured label). */
export class TaskFailure extends Error {
  readonly reason: string;
  /** `kind` of the `error` event shown to the user; defaults to `reason`. */
  readonly kind: string;
  readonly retryable: boolean;
  constructor(
    reason: string,
    message: string = reason,
    options: { kind?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'TaskFailure';
    this.reason = reason;
    this.kind = options.kind ?? reason;
    this.retryable = options.retryable ?? false;
  }
}

/** Ends a task as `cancelled`. Used as the abort reason of a task's signal. */
export class TaskCancelled extends Error {
  constructor(message = 'Task cancelled') {
    super(message);
    this.name = 'TaskCancelled';
  }
}

export const LOOP_LIMIT = 3;

export interface BudgetTracker {
  readonly iteration: number;
  readonly toolCalls: number;
  readonly tokens: number;
  /** Counts a model tool call; throws `budget:maxToolCalls` once the limit is passed. */
  countToolCall(): void;
  /** Throws `budget:maxTokens` once input + output tokens pass the limit. */
  addTokens(n: number): void;
  /** Starts the next verify→fix attempt; throws `budget:maxIterations` past the limit. */
  nextIteration(): void;
  /** Throws `loop_detected` when the same call key arrives `LOOP_LIMIT` times in a row. */
  checkRepeat(key: string): void;
}

export function createBudgetTracker(budget: Budget): BudgetTracker {
  let iteration = 1;
  let toolCalls = 0;
  let tokens = 0;
  let lastKey: string | undefined;
  let repeats = 0;
  return {
    get iteration() {
      return iteration;
    },
    get toolCalls() {
      return toolCalls;
    },
    get tokens() {
      return tokens;
    },
    countToolCall() {
      toolCalls += 1;
      if (toolCalls > budget.maxToolCalls) {
        throw new TaskFailure(
          'budget:maxToolCalls',
          `Stopped after ${budget.maxToolCalls} tool calls (the task's budget).`,
        );
      }
    },
    addTokens(n) {
      tokens += n;
      if (tokens > budget.maxTokens) {
        throw new TaskFailure(
          'budget:maxTokens',
          `Stopped after using ${tokens} tokens (budget ${budget.maxTokens}).`,
        );
      }
    },
    nextIteration() {
      if (iteration >= budget.maxIterations) {
        throw new TaskFailure(
          'budget:maxIterations',
          `Checks still failing after ${budget.maxIterations} attempts.`,
        );
      }
      iteration += 1;
    },
    checkRepeat(key) {
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats >= LOOP_LIMIT) {
        throw new TaskFailure(
          'loop_detected',
          `The model made the same tool call ${LOOP_LIMIT} times in a row.`,
        );
      }
    },
  };
}

/**
 * Wall-clock budget that only runs while the task is working: time spent waiting on the user
 * (approvals, edit review) doesn't count, because the budget guards against runaway work, not a
 * user who stepped away.
 */
export interface WallClock {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export function createWallClock(
  limitMs: number,
  onExpire: () => void,
  timers: { now: () => number } = { now: Date.now },
): WallClock {
  let remaining = limitMs;
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const run = (): void => {
    if (stopped || startedAt !== undefined) return;
    startedAt = timers.now();
    timer = setTimeout(() => {
      stopped = true;
      onExpire();
    }, remaining);
  };
  const halt = (): void => {
    if (startedAt === undefined) return;
    clearTimeout(timer);
    remaining = Math.max(0, remaining - (timers.now() - startedAt));
    startedAt = undefined;
  };
  return {
    start: run,
    resume: run,
    pause: halt,
    stop() {
      halt();
      stopped = true;
    },
  };
}

/** Stable key for "same tool + same args": object keys sorted, so key order doesn't matter. */
export function callKey(tool: string, args: unknown): string {
  return `${tool} ${canonicalJson(args)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
