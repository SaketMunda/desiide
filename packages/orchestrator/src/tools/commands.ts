import * as z from 'zod';
import { resolveWorkspacePath } from './paths.ts';
import {
  DEFAULT_TIMEOUT_MS,
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from './process.ts';
import { PathArg, defineTool, failure, type ToolContext, type ToolOutput } from './types.ts';

/** Room for heredocs and pipelines. Unrelated to the Jev state cap (MAX_COMMAND_CHARS). */
const MAX_SHELL_COMMAND_CHARS = 10_000;
const CHECKS_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 30_000;
const CHECKS_TAIL_BYTES = 16 * 1024;

function cwdOf(ctx: ToolContext): string {
  const root = ctx.workspace.roots[0];
  if (root === undefined) throw new Error('workspace has no roots');
  return root;
}

function baseOptions(ctx: ToolContext, signal: AbortSignal, timeoutMs: number): ProcessOptions {
  return {
    cwd: cwdOf(ctx),
    env: ctx.env,
    timeoutMs,
    signal,
    ...(ctx.trackProcessGroup ? { trackProcessGroup: ctx.trackProcessGroup } : {}),
  };
}

/** Maps a finished process onto a tool result. A non-zero exit is a failed call, not a thrown error. */
function toOutput(
  r: ProcessResult,
  what: string,
  timeoutMs: number,
  output = r.output,
): ToolOutput {
  const base = {
    output,
    truncated: r.truncated,
    ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}),
  };
  if (r.spawnError !== undefined)
    return failure('failed', `${what} could not start: ${r.spawnError}`);
  if (r.cancelled)
    return { ...base, ok: false, error: { kind: 'cancelled', message: `${what} cancelled` } };
  if (r.timedOut) {
    const message = `${what} timed out after ${Math.round(timeoutMs / 1000)} s; the process group was killed`;
    return { ...base, ok: false, error: { kind: 'timeout', message } };
  }
  if (r.exitCode !== 0) {
    const message = `${what} exited with code ${r.exitCode ?? 'null (killed)'}`;
    return { ...base, ok: false, error: { kind: 'failed', message } };
  }
  return { ...base, ok: true };
}

// ── shell ────────────────────────────────────────────────────────────────────

const ShellArgs = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(MAX_SHELL_COMMAND_CHARS)
    .describe('Shell command, run with /bin/sh at the workspace root.'),
  timeoutMs: z
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe(`Kill the command after this many ms. Default ${DEFAULT_TIMEOUT_MS}.`),
});

export const shellTool = defineTool({
  name: 'shell',
  description:
    'Run a shell command at the workspace root. Credentials are removed from the environment, ' +
    'output is capped to the last 64 KB, and the command and its children are killed on timeout. ' +
    'Not for long-running servers: background processes are killed when the command exits.',
  argsSchema: ShellArgs,
  sideEffect: 'external',
  async run(args, ctx, signal) {
    const timeoutMs = args.timeoutMs ?? ctx.timeouts?.shellMs ?? DEFAULT_TIMEOUT_MS;
    const r = await runProcess(
      { kind: 'shell', command: args.command },
      baseOptions(ctx, signal, timeoutMs),
    );
    return toOutput(r, 'command', timeoutMs, r.output || '(no output)');
  },
});

// ── run_tests / lint ─────────────────────────────────────────────────────────

// Result lines from common runners: vitest/jest "Tests  3 passed", pytest "2 failed, 5 passed",
// go "ok  pkg 0.1s" / "FAIL pkg", cargo "test result: ok. 3 passed".
const SUMMARY_LINE =
  /\b\d+\s+(passed|failed|failing|passing|errors?|warnings?|problems?|skipped)\b|^(ok|FAIL|PASS)\s|test result:/i;

export function summarize(output: string): string[] {
  return output
    .split('\n')
    .slice(-200)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 300 && SUMMARY_LINE.test(l))
    .slice(-8);
}

function checkTool(name: 'run_tests' | 'lint') {
  const field = name === 'run_tests' ? 'testCommand' : 'lintCommand';
  const label = name === 'run_tests' ? 'tests' : 'lint';
  return defineTool({
    name,
    description:
      name === 'run_tests'
        ? "Run the project's test command (from .desiide/project.json or auto-detected) and report the exit code and a summary."
        : "Run the project's lint command (from .desiide/project.json or auto-detected) and report the exit code and a summary.",
    argsSchema: z.strictObject({}),
    sideEffect: 'external',
    async run(_args, ctx, signal) {
      const command = ctx.projectConfig[field];
      if (!command) {
        return failure(
          'failed',
          `No ${label} command is configured. Add "${field}" to .desiide/project.json, ` +
            `or use shell with an explicit command.`,
        );
      }
      const timeoutMs = ctx.timeouts?.checksMs ?? CHECKS_TIMEOUT_MS;
      const r = await runProcess(
        { kind: 'shell', command },
        { ...baseOptions(ctx, signal, timeoutMs), outputCapBytes: CHECKS_TAIL_BYTES },
      );
      const status =
        r.exitCode === 0
          ? 'passed'
          : r.timedOut
            ? 'timed out'
            : r.cancelled
              ? 'cancelled'
              : 'failed';
      const summary = summarize(r.output);
      const header = [
        `$ ${command}`,
        `${label} ${status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''} in ${(r.durationMs / 1000).toFixed(1)} s`,
        ...(summary.length ? ['Summary:', ...summary.map((l) => `  ${l}`)] : []),
        '--- output (tail) ---',
      ].join('\n');
      return toOutput(r, label, timeoutMs, `${header}\n${r.output}`);
    },
  });
}

export const runTestsTool = checkTool('run_tests');
export const lintTool = checkTool('lint');

// ── git_read ─────────────────────────────────────────────────────────────────

// Revisions like HEAD~2, main..feature, v1.2.0, abc123, HEAD:src/a.ts. No leading "-" (flags).
const GitRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!-)[A-Za-z0-9._/~^@{}:-]+$/, 'not a valid git revision')
  .describe('A git revision, e.g. "HEAD~1", "main..HEAD", or a commit hash.');

const GitReadArgs = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('status') }),
  z.strictObject({
    command: z.literal('diff'),
    staged: z.boolean().default(false).describe('Diff the index instead of the working tree.'),
    ref: GitRef.optional(),
    path: PathArg.optional(),
  }),
  z.strictObject({
    command: z.literal('log'),
    maxCount: z.int().min(1).max(100).default(20),
    path: PathArg.optional(),
  }),
  z.strictObject({ command: z.literal('show'), ref: GitRef, path: PathArg.optional() }),
]);

const GIT_OUTPUT_CAP_BYTES = 64 * 1024;

// Repo config can name programs git runs (fsmonitor, pager, external diff, textconv); a read-only
// tool must not execute them.
export const SAFE_GIT = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=never',
  '-c',
  'diff.external=',
];

export const gitReadTool = defineTool({
  name: 'git_read',
  description:
    'Read-only git: status, diff (working tree or staged, optionally against a ref), log, or show ' +
    'a revision. Commits, pushes, and resets need the shell tool.',
  argsSchema: GitReadArgs,
  sideEffect: 'none',
  async run(args, ctx, signal) {
    const pathspec = async (p: string | undefined): Promise<string[]> =>
      p === undefined ? [] : ['--', (await resolveWorkspacePath(ctx.workspace, p)).rel];

    let gitArgs: string[];
    switch (args.command) {
      case 'status':
        gitArgs = ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'];
        break;
      case 'diff':
        gitArgs = [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          ...(args.staged ? ['--cached'] : []),
          ...(args.ref ? [args.ref] : []),
          ...(await pathspec(args.path)),
        ];
        break;
      case 'log':
        gitArgs = [
          'log',
          `--max-count=${args.maxCount}`,
          '--date=short',
          '--format=%h %ad %an%d %s',
          ...(await pathspec(args.path)),
        ];
        break;
      case 'show':
        gitArgs = [
          'show',
          '--no-ext-diff',
          '--no-textconv',
          args.ref,
          ...(await pathspec(args.path)),
        ];
        break;
    }

    const timeoutMs = ctx.timeouts?.readMs ?? READ_TIMEOUT_MS;
    const r = await runProcess(
      { kind: 'exec', file: 'git', args: [...SAFE_GIT, ...gitArgs] },
      {
        ...baseOptions(ctx, signal, timeoutMs),
        // No credential prompts and no index.lock writes from a read.
        env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        capture: 'head',
        outputCapBytes: GIT_OUTPUT_CAP_BYTES,
      },
    );
    if (r.truncated) {
      return {
        ok: true,
        output: `${r.output}\n[… output truncated at ${GIT_OUTPUT_CAP_BYTES / 1024} KB; narrow with path]`,
        truncated: true,
      };
    }
    const stderr = (r.stderr ?? '').trim();
    const out = toOutput(r, `git ${args.command}`, timeoutMs, r.output || stderr || '(no output)');
    if (!out.ok && out.error && stderr) out.error.message += `: ${stderr.split('\n')[0]}`;
    return out;
  },
});
