import {
  TERMINAL_TASK_STATES,
  type TaskEvent,
  type TaskInput,
  type TaskSummary,
  type ToolCall,
  type ToolResult,
} from '@desiide/protocol';
import type { ExtensionToWebview, TaskRecord } from '../../shared/messages.ts';
import { appendCompacted } from '../../shared/transcript/compact.ts';

/** How often queued events go to the webview: about one animation frame. */
export const FLUSH_MS = 16;
/** Tasks kept for the task list; the oldest finished ones are dropped first. */
export const MAX_TASKS = 30;

interface Entry {
  id: string;
  summary?: TaskSummary;
  /** The `task.create` params, for Retry. Absent for tasks this window didn't create. */
  params?: TaskInput;
  events: TaskEvent[];
  terminal: boolean;
}

export interface TaskStoreOptions {
  post(message: ExtensionToWebview): void;
  /** Injected for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  maxTasks?: number;
}

export interface ToolOutput {
  call?: ToolCall;
  result: ToolResult;
}

/**
 * Host-side memory of this window's tasks: summary, create params and a compacted event log per
 * task. Forwards new events to the panel in batches (one post per ~frame instead of one per
 * token) and replays everything when the panel reloads. No `vscode` import.
 */
export class TaskStore {
  private readonly entries = new Map<string, Entry>();
  private queue: TaskEvent[] = [];
  private timer: { cancel(): void } | undefined;
  private readonly schedule: NonNullable<TaskStoreOptions['schedule']>;
  private readonly maxTasks: number;

  constructor(private readonly opts: TaskStoreOptions) {
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      });
    this.maxTasks = opts.maxTasks ?? MAX_TASKS;
  }

  /** A task was created from this window (Prompt Box or Retry). */
  created(summary: TaskSummary, params?: TaskInput): void {
    const entry = this.entry(summary.id);
    entry.summary = summary;
    if (params) entry.params = params;
    this.opts.post({ type: 'tasks.summary', summary, retryable: entry.params !== undefined });
    this.prune();
  }

  /** Authoritative summaries from `task.list`, for tasks this store knows. */
  refresh(summaries: readonly TaskSummary[]): void {
    for (const summary of summaries) {
      const entry = this.entries.get(summary.id);
      if (!entry) continue;
      entry.summary = summary;
      this.opts.post({ type: 'tasks.summary', summary, retryable: entry.params !== undefined });
    }
  }

  /** Returns true when the event ended its task (the caller may refresh summaries). */
  onEvent(event: TaskEvent): boolean {
    const entry = this.entry(event.taskId);
    appendCompacted(entry.events, event);
    this.queue.push(event);
    this.timer ??= this.schedule(() => this.flush(), FLUSH_MS);
    const ended =
      event.type === 'state_changed' && TERMINAL_TASK_STATES.includes(event.to) && !entry.terminal;
    if (ended) {
      entry.terminal = true;
      this.prune();
    }
    return ended;
  }

  /** Send queued events now (also called before a snapshot so nothing is sent twice). */
  flush(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    this.opts.post({ type: 'tasks.events', events });
  }

  /** Everything retained, oldest first: the panel (re)loaded. Pending events are included. */
  snapshot(): TaskRecord[] {
    this.timer?.cancel();
    this.timer = undefined;
    this.queue = [];
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      ...(e.summary ? { summary: e.summary } : {}),
      events: e.events,
      retryable: e.params !== undefined,
    }));
  }

  params(taskId: string): TaskInput | undefined {
    return this.entries.get(taskId)?.params;
  }

  /** The retained output of one tool call, with the call when it started. */
  toolOutput(taskId: string, callId: string): ToolOutput | undefined {
    const events = this.entries.get(taskId)?.events ?? [];
    let call: ToolCall | undefined;
    for (const e of events) {
      if (e.type === 'tool_call_started' && e.call.id === callId) call = e.call;
      if (e.type === 'approval_required' && e.call.id === callId) call ??= e.call;
      if (e.type === 'tool_call_finished' && e.result.callId === callId) {
        return { ...(call ? { call } : {}), result: e.result };
      }
    }
    return undefined;
  }

  dispose(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.queue = [];
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, events: [], terminal: false };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Over the limit: drop the oldest finished tasks. Running ones are never dropped. */
  private prune(): void {
    const excess = this.entries.size - this.maxTasks;
    if (excess <= 0) return;
    const dropped: string[] = [];
    for (const entry of this.entries.values()) {
      if (dropped.length >= excess) break;
      if (entry.terminal) dropped.push(entry.id);
    }
    if (dropped.length === 0) return;
    for (const id of dropped) this.entries.delete(id);
    this.queue = this.queue.filter((e) => !dropped.includes(e.taskId));
    this.opts.post({ type: 'tasks.removed', taskIds: dropped });
  }
}
