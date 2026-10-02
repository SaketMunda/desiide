import type { ModelRegistry } from '@desiide/models';
import type { ModelRole, Task } from '@desiide/protocol';
import { randomUUID } from 'node:crypto';
import type { Host } from '../host/host.ts';
import { pathOnlyContext, type ContextProvider } from './context.ts';
import { confirmAllGate, type Gate } from './gate.ts';
import { registerTaskHandlers } from './handlers.ts';
import { createTaskManager, type TaskLogger, type TaskManager } from './taskManager.ts';
import { prepareTaskTools } from './tools.ts';

export interface TaskEngineOptions {
  models: ModelRegistry;
  /** JEV-2 passes its `PolicyGate` here. Defaults to asking for everything. */
  gate?: () => Gate;
  /** COR-4 passes its context engine here. */
  context?: ContextProvider;
  logger?: TaskLogger;
  maxRunning?: number;
}

/** Single-model routing until COR-5: `quality` uses the strong model, everything else the cheap one. */
export function roleForTask(task: Task): ModelRole {
  return task.preference === 'quality' ? 'strong' : 'cheap';
}

/** Wires the task engine into the host: the `task.*` / `edits.report` handlers and shutdown. */
export function registerTaskEngine(host: Host, options: TaskEngineOptions): TaskManager {
  const newId = (): string => randomUUID();
  const tasks = createTaskManager({
    emit: (event) => {
      host.notify('task.event', event).catch((err: unknown) => {
        options.logger?.error({ err, taskId: event.taskId }, 'task.event notify failed');
      });
    },
    resolveModel: (task) => options.models.forRole(roleForTask(task)),
    costPerMTok: (id) => options.models.config(id)?.costPerMTok,
    prepareTools: (task) =>
      prepareTaskTools(task, {
        workspaceRoots: () => host.session?.workspaceRoots,
        trackProcessGroup: (pid) => host.trackProcessGroup(pid),
        newId,
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    gate: options.gate ?? (() => confirmAllGate),
    context: options.context ?? pathOnlyContext,
    newId,
    ...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  registerTaskHandlers(host, tasks);
  return tasks;
}
