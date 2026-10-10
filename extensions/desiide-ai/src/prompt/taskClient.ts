import {
  RpcErrorCode,
  TERMINAL_TASK_STATES,
  type TaskEvent,
  type TaskInput,
  type TaskState,
  type TaskSummary,
} from '@desiide/protocol';
import { ResponseError } from 'vscode-jsonrpc';
import type { Disposable } from '../orchestrator/client.ts';

/** The slice of the orchestrator the Prompt Box and the task stream need. */
export interface TaskClient {
  create(params: TaskInput, signal?: AbortSignal): Promise<TaskSummary>;
  cancel(taskId: string): Promise<boolean>;
  /** Summaries of the tasks the engine still retains. */
  list(): Promise<TaskSummary[]>;
  onEvent(listener: (event: TaskEvent) => void): Disposable;
}

/** What `OrchestratorClient` offers; kept structural so tests don't spawn anything. */
export interface RequestClient {
  request(
    method: 'task.create',
    params: TaskInput,
    signal?: AbortSignal,
  ): Promise<{ task: TaskSummary }>;
  request(method: 'task.cancel', params: { taskId: string }): Promise<{ cancelled: boolean }>;
  request(method: 'task.list', params: Record<string, never>): Promise<{ tasks: TaskSummary[] }>;
  onEvent(listener: (event: TaskEvent) => void): Disposable;
}

export function orchestratorTaskClient(client: RequestClient): TaskClient {
  return {
    create: async (params, signal) => (await client.request('task.create', params, signal)).task,
    cancel: async (taskId) => (await client.request('task.cancel', { taskId })).cancelled,
    list: async () => (await client.request('task.list', {})).tasks,
    onEvent: (listener) => client.onEvent(listener),
  };
}

export const MOCK_ID_PREFIX = 'mock-';

/**
 * UI-2's mock strategy: accepts the validated payload, reports the task as running until it is
 * cancelled, and emits the same `state_changed` events the real engine would.
 */
export class MockTaskClient implements TaskClient {
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly states = new Map<string, { state: TaskState; seq: number }>();
  private readonly summaries = new Map<string, TaskSummary>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(params: TaskInput): Promise<TaskSummary> {
    const id = `${MOCK_ID_PREFIX}${++this.counter}`;
    const ts = this.now().toISOString();
    this.states.set(id, { state: 'queued', seq: 0 });
    // Emit after returning, like the real engine (the id is known before events arrive).
    queueMicrotask(() => this.transition(id, 'running'));
    const summary: TaskSummary = {
      id,
      kind: params.kind,
      instruction: params.instruction,
      state: 'queued',
      ...(params.workflowOverride ? { workflow: params.workflowOverride } : {}),
      models: [],
      iteration: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: ts,
      updatedAt: ts,
    };
    this.summaries.set(id, summary);
    return Promise.resolve(summary);
  }

  list(): Promise<TaskSummary[]> {
    return Promise.resolve(
      [...this.summaries.values()].map((s) => ({
        ...s,
        state: this.states.get(s.id)?.state ?? s.state,
      })),
    );
  }

  cancel(taskId: string): Promise<boolean> {
    const entry = this.states.get(taskId);
    if (!entry || TERMINAL_TASK_STATES.includes(entry.state)) return Promise.resolve(false);
    this.transition(taskId, 'cancelled', 'user');
    return Promise.resolve(true);
  }

  onEvent(listener: (event: TaskEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private transition(taskId: string, to: TaskState, reason?: string): void {
    const entry = this.states.get(taskId);
    if (!entry || TERMINAL_TASK_STATES.includes(entry.state)) return;
    const from = entry.state;
    entry.state = to;
    entry.seq++;
    const event: TaskEvent = {
      type: 'state_changed',
      taskId,
      seq: entry.seq,
      ts: this.now().toISOString(),
      from,
      to,
      ...(reason ? { reason } : {}),
    };
    for (const l of this.listeners) l(event);
  }
}

export function isNotImplemented(err: unknown): boolean {
  return err instanceof ResponseError && err.code === RpcErrorCode.NotImplemented;
}

/**
 * Uses the real orchestrator; if it answers `task.create` with NotImplemented (no task engine yet,
 * COR-2), switches to the mock for the rest of the session and reports that once.
 */
export class FallbackTaskClient implements TaskClient {
  private useMock = false;

  constructor(
    private readonly real: TaskClient,
    private readonly mock: TaskClient,
    private readonly onFallback: () => void,
  ) {}

  get mocked(): boolean {
    return this.useMock;
  }

  async create(params: TaskInput, signal?: AbortSignal): Promise<TaskSummary> {
    if (this.useMock) return this.mock.create(params, signal);
    try {
      return await this.real.create(params, signal);
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      this.useMock = true;
      this.onFallback();
      return this.mock.create(params, signal);
    }
  }

  cancel(taskId: string): Promise<boolean> {
    return (taskId.startsWith(MOCK_ID_PREFIX) ? this.mock : this.real).cancel(taskId);
  }

  list(): Promise<TaskSummary[]> {
    return this.useMock ? this.mock.list() : this.real.list();
  }

  onEvent(listener: (event: TaskEvent) => void): Disposable {
    const a = this.real.onEvent(listener);
    const b = this.mock.onEvent(listener);
    return {
      dispose: () => {
        a.dispose();
        b.dispose();
      },
    };
  }
}
