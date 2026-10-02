import type { ToolCall } from '@desiide/protocol';
import * as z from 'zod';
import type { RiskAction } from './builders.ts';

export interface ToolCallAction extends RiskAction {
  /** Workspace paths named in the args, so the caller can look up their `FileMeta`. */
  paths: string[];
}

export interface ToolCallActionOptions {
  /** Project test/lint commands (`.desiide/project.json`), shown to Jev for `run_tests`/`lint`. */
  testCommand?: string;
  lintCommand?: string;
}

// Tool args are opaque at the protocol layer (COR-3 validates them per tool). These schemas
// read only the metadata we need and ignore everything else, e.g. edit search/replace text.
const CommandArgs = z.object({ command: z.string() });
const PathArgs = z.object({ path: z.string() });
const EditArgs = z.object({ files: z.array(z.object({ path: z.string() })) });

const INSTALL =
  /^(npm\s+(i|install|add)|pnpm\s+(i|install|add)|yarn(\s+add)?|pip3?\s+install|cargo\s+add|go\s+get|bun\s+(i|install|add))(\s|$)/;

function classifyShell(command: string): RiskAction['actionType'] {
  const cmd = command.trim();
  if (/^git\s+push(\s|$)/.test(cmd)) return 'git_push';
  if (/^git\s+commit(\s|$)/.test(cmd)) return 'git_commit';
  if (INSTALL.test(cmd)) return 'install_dependency';
  return 'run_command';
}

/** Maps a COR-3 tool call onto risk_gate's action vocabulary. */
export function actionFromToolCall(
  call: ToolCall,
  options: ToolCallActionOptions = {},
): ToolCallAction {
  switch (call.tool) {
    case 'shell': {
      const args = CommandArgs.safeParse(call.args);
      // Unparseable args stay `run_command` without a command, which the rules answer `unknown`.
      if (!args.success) return { actionType: 'run_command', paths: [] };
      return {
        actionType: classifyShell(args.data.command),
        command: args.data.command,
        paths: [],
      };
    }
    case 'run_tests':
      return withCommand('run_tests', options.testCommand);
    case 'lint':
      return withCommand('lint', options.lintCommand);
    case 'propose_edit': {
      const args = EditArgs.safeParse(call.args);
      const paths = args.success ? [...new Set(args.data.files.map((f) => f.path))] : [];
      return args.success
        ? { actionType: 'apply_edit', editFileCount: paths.length, paths }
        : { actionType: 'apply_edit', paths };
    }
    case 'git_read': {
      const args = CommandArgs.safeParse(call.args);
      const sub = args.success && /^[a-z]+$/.test(args.data.command) ? args.data.command : null;
      return sub ? { actionType: 'run_command', command: `git ${sub}`, paths: [] } : other([]);
    }
    case 'read_file':
    case 'list_files':
    case 'search': {
      const args = PathArgs.safeParse(call.args);
      return other(args.success ? [args.data.path] : []);
    }
  }
}

function withCommand(
  actionType: 'run_tests' | 'lint',
  command: string | undefined,
): ToolCallAction {
  return command === undefined ? { actionType, paths: [] } : { actionType, command, paths: [] };
}

function other(paths: string[]): ToolCallAction {
  return { actionType: 'other', paths };
}
