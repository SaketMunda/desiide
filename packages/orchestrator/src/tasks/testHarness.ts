// Test-only helper: a TaskManager wired to fakes, plus ways to wait on its events.
import type { ModelAdapter } from '@desiide/models';
import {
  TaskInput,
  type EditProposal,
  type Task,
  type TaskEvent,
  type TaskInputRaw,
  type ToolResult,
} from '@desiide/protocol';
import type { RawToolCall, ToolExecution } from '../tools/runner.ts';
import { pathOnlyContext, type ContextProvider } from './context.ts';
import type { Gate } from './gate.ts';
import {
  createTaskManager,
  type RunTool,
  type TaskManager,
  type TaskManagerOptions,
} from './taskManager.ts';

export const autoGate: Gate = {
  evaluate: () => Promise.resolve({ outcome: 'auto', reasons: [] }),
};

type FakeHandler = (
  call: RawToolCall,
  signal: AbortSignal,
) => ToolExecution | Promise<ToolExecution>;

export function ok(call: RawToolCall, output = 'ok'): ToolExecution {
  return { result: { callId: call.id, ok: true, output, truncated: false, durationMs: 1 } };
}

export function failed(call: RawToolCall, output: string, exitCode = 1): ToolExecution {
  const result: ToolResult = {
    callId: call.id,
    ok: false,
    output,
    truncated: false,
    exitCode,
    durationMs: 1,
    error: { kind: 'failed', message: output, reasons: [] },
  };
  return { result };
}

/** A fake COR-3 runner: `propose_edit` proposes its args as-is, the rest answer `ok`. */
export function fakeTools(handlers: Partial<Record<string, FakeHandler>> = {}) {
  const calls: RawToolCall[] = [];
  let proposals = 0;
  const run: RunTool = async (call, signal) => {
    calls.push(call);
    const handler = handlers[call.tool];
    if (handler) return handler(call, signal);
    if (call.tool === 'propose_edit') {
      const args = call.args as { files: EditProposal['files'] };
      proposals += 1;
      const proposal: EditProposal = { id: `p${proposals}`, taskId: 'unused', files: args.files };
      return { ...ok(call, 'proposed'), proposal };
    }
    return ok(call);
  };
  return { run, calls };
}

export interface HarnessOptions {
  model: ModelAdapter | ((task: Task) => ModelAdapter);
  tools?: RunTool;
  gate?: Gate;
  context?: ContextProvider;
  maxRunning?: number;
  overrides?: Partial<TaskManagerOptions>;
}

export function createHarness(opts: HarnessOptions) {
  const events: TaskEvent[] = [];
  const waiters: Array<{ match: (e: TaskEvent) => boolean; resolve: (e: TaskEvent) => void }> = [];
  let ids = 0;
  const tools = opts.tools ?? fakeTools().run;
  const tasks: TaskManager = createTaskManager({
    emit(event) {
      events.push(event);
      for (const w of [...waiters]) {
        if (w.match(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
    resolveModel: (task) => (typeof opts.model === 'function' ? opts.model(task) : opts.model),
    prepareTools: () => Promise.resolve(tools),
    gate: () => opts.gate ?? autoGate,
    context: opts.context ?? pathOnlyContext,
    newId: () => `id${++ids}`,
    ...(opts.maxRunning === undefined ? {} : { maxRunning: opts.maxRunning }),
    ...opts.overrides,
  });

  function next<T extends TaskEvent['type']>(
    type: T,
    taskId?: string,
    pred: (e: Extract<TaskEvent, { type: T }>) => boolean = () => true,
  ): Promise<Extract<TaskEvent, { type: T }>> {
    const match = (e: TaskEvent): boolean =>
      e.type === type &&
      (taskId === undefined || e.taskId === taskId) &&
      pred(e as Extract<TaskEvent, { type: T }>);
    return new Promise((resolve) => {
      waiters.push({ match, resolve: (e) => resolve(e as Extract<TaskEvent, { type: T }>) });
    });
  }

  return {
    tasks,
    events,
    create: (input: TaskInputRaw) => tasks.create(TaskInput.parse(input)),
    next,
    of: (taskId: string) => events.filter((e) => e.taskId === taskId),
    states: (taskId: string) =>
      events.flatMap((e) => (e.taskId === taskId && e.type === 'state_changed' ? [e.to] : [])),
  };
}
