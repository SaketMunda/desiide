import type { FileMeta, Task, WorkspacePath } from '@desiide/protocol';
import type { ContextProvider, GatherOptions, GatheredContext } from '../tasks/context.ts';
import { createWorkspace, type Workspace } from '../tools/paths.ts';
import { loadProjectConfig } from '../tools/projectConfig.ts';
import { resolveRgPath } from '../tools/ripgrep.ts';
import { buildContextBundle, describeFiles, type ContextBundle } from './bundle.ts';
import { createContextSensitivity, type Sensitivity } from './filters.ts';
import { gitDiff, listFiles } from './workspaceIO.ts';

/** Told to the model in the system prompt whenever the first message carries gathered context. */
export const CONTEXT_GUIDANCE = [
  'The first message includes context Desiide gathered: the files and folders the user attached, ' +
    'their selection, uncommitted changes, open editors, and a repository map, in that priority.',
  'File lines there are prefixed with their number and a tab, like read_file output; the prefix ' +
    'is not part of the file.',
  'It is a snapshot cut to fit a budget. Parts marked "[… not shown]" or "partial" were left out: ' +
    'use read_file, search, list_files, or git_read to get them, and read a file again for its ' +
    'exact current text before proposing an edit you are unsure of.',
].join('\n');

/** Default share of the model's context window the gathered context may take. */
export const CONTEXT_SHARE = 0.25;
export const MAX_CONTEXT_TOKENS = 32_000;
export const MIN_CONTEXT_TOKENS = 2_000;
/** Used when the model's window is unknown. */
export const DEFAULT_CONTEXT_TOKENS = 8_000;

export function contextBudget(modelContextTokens: number | undefined): number {
  if (modelContextTokens === undefined) return DEFAULT_CONTEXT_TOKENS;
  const share = Math.floor(modelContextTokens * CONTEXT_SHARE);
  return Math.max(MIN_CONTEXT_TOKENS, Math.min(MAX_CONTEXT_TOKENS, share));
}

export interface ContextEngineOptions {
  workspaceRoots(): readonly string[] | undefined;
  /** Base env for rg/git; scrubbed per call. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  trackProcessGroup?: (pid: number) => () => void;
  logger?: {
    warn(obj: object, msg?: string): void;
    debug?(obj: object, msg?: string): void;
  };
}

export interface ContextEngine extends ContextProvider {
  /** The full bundle, for callers that need sections or file metadata (Jev state, previews). */
  build(task: Task, signal: AbortSignal, options?: GatherOptions): Promise<ContextBundle>;
}

interface WorkspaceSetup {
  workspace: Workspace;
  sensitivity: Sensitivity;
  ignoreGlobs: readonly string[];
}

/**
 * COR-4's `ContextProvider`: a token-budgeted snapshot of what the user pointed at, plus file
 * metadata. Workspace and project config are read per call, so edits to `.desiide/project.json`
 * apply to the next task.
 */
export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  const env = options.env ?? process.env;
  const pe = {
    env,
    ...(options.trackProcessGroup ? { trackProcessGroup: options.trackProcessGroup } : {}),
  };

  const setup = async (): Promise<WorkspaceSetup | undefined> => {
    const roots = options.workspaceRoots();
    if (!roots?.length) return undefined;
    const workspace = await createWorkspace(roots);
    const loaded = await loadProjectConfig(workspace);
    return {
      workspace,
      sensitivity: createContextSensitivity(loaded.config.sensitiveGlobs),
      ignoreGlobs: loaded.config.ignoreGlobs ?? [],
    };
  };

  const build = async (
    task: Task,
    signal: AbortSignal,
    gather: GatherOptions = {},
  ): Promise<ContextBundle> => {
    const budgetTokens = contextBudget(gather.modelContextTokens);
    const ws = await setup();
    if (!ws) {
      return {
        sections: [],
        text: '',
        tokenEstimate: 0,
        budgetTokens,
        files: [],
        omitted: [],
      };
    }
    const root = ws.workspace.roots[0] ?? '';
    const rgPath = await resolveRgPath(env);
    const listing = rgPath ? await listFiles(root, rgPath, ws.ignoreGlobs, pe, signal) : undefined;
    if (!listing) {
      options.logger?.warn(
        { taskId: task.id, rg: Boolean(rgPath) },
        'workspace listing unavailable; context has no repo map or gitignore check',
      );
    }
    const bundle = await buildContextBundle({
      task,
      workspace: ws.workspace,
      sensitivity: ws.sensitivity,
      listing,
      diff: (scope, path) => gitDiff(root, scope, path, ws.sensitivity, pe, signal),
      budgetTokens,
      signal,
    });
    options.logger?.debug?.(
      {
        taskId: task.id,
        budgetTokens,
        tokenEstimate: bundle.tokenEstimate,
        sections: bundle.sections.length,
        omitted: bundle.omitted.length,
        files: bundle.files.length,
      },
      'context gathered',
    );
    return bundle;
  };

  return {
    build,
    async gather(task, signal, gatherOptions): Promise<GatheredContext> {
      const bundle = await build(task, signal, gatherOptions);
      return bundle.text ? { text: bundle.text, system: CONTEXT_GUIDANCE } : { text: '' };
    },
    async describeFiles(paths: WorkspacePath[], signal: AbortSignal): Promise<FileMeta[]> {
      const ws = await setup();
      if (!ws) return [];
      return describeFiles(ws.workspace, paths, ws.sensitivity, signal);
    },
  };
}
