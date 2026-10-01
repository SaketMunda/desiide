import type { ToolName } from '@desiide/protocol';
import { gitReadTool, lintTool, runTestsTool, shellTool } from './commands.ts';
import { proposeEditTool } from './proposeEdit.ts';
import { readFileTool } from './readFile.ts';
import { listFilesTool, searchTool } from './ripgrep.ts';
import type { Tool, ToolSpec } from './types.ts';

export const TOOLS: { readonly [N in ToolName]: Tool } = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search: searchTool,
  propose_edit: proposeEditTool,
  shell: shellTool,
  run_tests: runTestsTool,
  lint: lintTool,
  git_read: gitReadTool,
};

/** Model-facing specs for the tools a task allows (`Task.allowedTools`), in a stable order. */
export function toolSpecs(allowed: readonly ToolName[]): ToolSpec[] {
  const set = new Set(allowed);
  return Object.values(TOOLS)
    .filter((t) => set.has(t.name))
    .map((t) => t.spec);
}
