import type { Task } from '@desiide/protocol';
import { createWorkspace } from '../tools/paths.ts';
import { loadProjectConfig } from '../tools/projectConfig.ts';
import { resolveRgPath } from '../tools/ripgrep.ts';
import { executeToolCall } from '../tools/runner.ts';
import type { ToolContext } from '../tools/types.ts';
import { TaskFailure } from './budget.ts';
import type { RunTool, TaskLogger } from './taskManager.ts';

export interface ToolEnvironment {
  workspaceRoots(): readonly string[] | undefined;
  trackProcessGroup?: (pid: number) => () => void;
  newId(): string;
  env?: NodeJS.ProcessEnv;
  logger?: TaskLogger;
}

const RG_TOOLS = ['list_files', 'search'] as const;

/**
 * Builds the COR-3 tool context for a task and checks up front what would otherwise fail on every
 * call: a missing ripgrep or a success check with no command.
 */
export async function prepareTaskTools(task: Task, envs: ToolEnvironment): Promise<RunTool> {
  const roots = envs.workspaceRoots();
  if (!roots || roots.length === 0) {
    throw new TaskFailure('no_workspace', 'Open a folder to run a Desiide task.');
  }
  const workspace = await createWorkspace(roots);
  const loaded = await loadProjectConfig(workspace);
  for (const warning of loaded.warnings) {
    envs.logger?.warn({ taskId: task.id, warning }, 'project config warning');
  }
  const env = envs.env ?? process.env;
  const rgPath = await resolveRgPath(env);
  if (!rgPath && RG_TOOLS.some((t) => task.allowedTools.includes(t))) {
    throw new TaskFailure(
      'ripgrep_missing',
      'Desiide could not find ripgrep, which list_files and search need. ' +
        'Set DESIIDE_RG_PATH to an rg binary, or restart Desiide.',
    );
  }
  const missing = [
    task.success.testsPass && !loaded.config.testCommand ? 'testCommand' : undefined,
    task.success.lintClean && !loaded.config.lintCommand ? 'lintCommand' : undefined,
  ].filter((m) => m !== undefined);
  if (missing.length > 0) {
    throw new TaskFailure(
      'no_check_command',
      `This task must pass checks, but no ${missing.join(' / ')} was found. ` +
        `Add it to .desiide/project.json.`,
    );
  }
  const ctx: ToolContext = {
    workspace,
    taskId: task.id,
    projectConfig: loaded.config,
    env,
    // Unused when the task has no rg tools (checked above).
    rgPath: rgPath ?? '',
    newId: envs.newId,
    ...(envs.trackProcessGroup ? { trackProcessGroup: envs.trackProcessGroup } : {}),
  };
  return (call, signal) => executeToolCall(call, ctx, signal);
}
