import { stat } from 'node:fs/promises';
import * as z from 'zod';
import { resolveWorkspacePath } from './paths.ts';
import { runProcess, type ProcessResult } from './process.ts';
import { PathArg, defineTool, failure, type ToolContext } from './types.ts';

const READ_TIMEOUT_MS = 30_000;
const RG_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The ripgrep binary. `DESIIDE_RG_PATH` wins: inside the app the extension points it at the rg that
 * ships with the editor, because the orchestrator bundle can't carry `@vscode/ripgrep`'s binary.
 */
export async function resolveRgPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (env.DESIIDE_RG_PATH) return env.DESIIDE_RG_PATH;
  try {
    const mod: { rgPath: string } = await import('@vscode/ripgrep');
    return mod.rgPath;
  } catch {
    return undefined;
  }
}

/**
 * Walk rules shared by list_files, search, and the context engine: gitignore-aware, skip .git and
 * node_modules plus the project's `ignoreGlobs`.
 */
export function rgWalkArgs(ignoreGlobs: readonly string[] = []): string[] {
  const ignores = ['.git', 'node_modules', ...ignoreGlobs];
  // --no-config: RIPGREP_CONFIG_PATH must not inject flags (e.g. --follow).
  return [
    '--no-config',
    '--hidden',
    '--no-require-git',
    ...ignores.flatMap((g) => ['--glob', `!${g}`]),
  ];
}

function runRg(
  args: string[],
  cwd: string,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<ProcessResult> {
  const opts = {
    cwd,
    env: ctx.env,
    timeoutMs: ctx.timeouts?.readMs ?? READ_TIMEOUT_MS,
    outputCapBytes: RG_OUTPUT_CAP_BYTES,
    capture: 'head' as const,
    signal,
    ...(ctx.trackProcessGroup ? { trackProcessGroup: ctx.trackProcessGroup } : {}),
  };
  return runProcess({ kind: 'exec', file: ctx.rgPath, args }, opts);
}

function processFailure(r: ProcessResult, what: string): ReturnType<typeof failure> | undefined {
  if (r.cancelled) return failure('cancelled', `${what} cancelled`);
  if (r.timedOut) return failure('timeout', `${what} timed out; narrow the path or query`);
  if (r.spawnError !== undefined)
    return failure('failed', `${what} could not start: ${r.spawnError}`);
  return undefined;
}

// ── list_files ────────────────────────────────────────────────────────────────

const ListFilesArgs = z.strictObject({
  path: PathArg.default('.').describe('Directory to list, workspace-relative. Default: the root.'),
  depth: z
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('How many directory levels to descend. Default 3.'),
  limit: z
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe('Maximum number of files returned. Default 500.'),
});

export const listFilesTool = defineTool({
  name: 'list_files',
  description:
    'List files under a workspace directory, sorted by path. Respects .gitignore and skips .git ' +
    'and node_modules. Use depth to go deeper and path to narrow down.',
  argsSchema: ListFilesArgs,
  sideEffect: 'none',
  async run(args, ctx, signal) {
    const resolved = await resolveWorkspacePath(ctx.workspace, args.path, { mustExist: true });
    if (!(await stat(resolved.abs)).isDirectory()) {
      return { ok: true, output: resolved.rel };
    }
    const target = resolved.rel === '.' ? [] : ['--', resolved.rel];
    const r = await runRg(
      [
        '--files',
        '--sort',
        'path',
        '--max-depth',
        String(args.depth),
        ...rgWalkArgs(ctx.projectConfig.ignoreGlobs),
        ...target,
      ],
      resolved.root,
      ctx,
      signal,
    );
    const failed = processFailure(r, 'list_files');
    if (failed) return failed;
    // rg exits 1 when nothing matched (empty dir or all ignored).
    if (r.exitCode !== null && r.exitCode > 1) {
      return failure(
        'failed',
        `list_files failed: ${(r.stderr ?? '').trim() || `rg exit ${r.exitCode}`}`,
      );
    }
    const all = r.output.split('\n').filter(Boolean);
    if (r.truncated) all.pop(); // the last line may be cut mid-path
    const files = all.slice(0, args.limit);
    const more = all.length > args.limit || r.truncated;
    if (files.length === 0) return { ok: true, output: `${resolved.rel}: no files` };
    const note = more ? `\n[… more files not shown; narrow path, lower depth, or raise limit]` : '';
    return { ok: true, output: files.join('\n') + note, truncated: more };
  },
});

// ── search ───────────────────────────────────────────────────────────────────

const RgMatch = z.object({
  type: z.literal('match'),
  data: z.object({
    path: z.object({ text: z.string() }),
    lines: z.object({ text: z.string() }),
    line_number: z.int().nullable(),
  }),
});

const MAX_MATCH_LINE_CHARS = 500;

const SearchArgs = z.strictObject({
  query: z.string().min(1).max(1000).describe('Text to find. Literal unless regex is true.'),
  regex: z.boolean().default(false).describe('Treat query as a Rust-style regular expression.'),
  path: PathArg.default('.').describe(
    'Directory or file to search in. Default: the whole workspace.',
  ),
  glob: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".'),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('Default: case-insensitive unless the query has an uppercase letter.'),
  maxResults: z.int().min(1).max(500).default(100).describe('Maximum matching lines. Default 100.'),
});

export const searchTool = defineTool({
  name: 'search',
  description:
    'Search file contents in the workspace (ripgrep). Returns "path:line: text" for each match. ' +
    'Respects .gitignore and skips .git and node_modules.',
  argsSchema: SearchArgs,
  sideEffect: 'none',
  async run(args, ctx, signal) {
    const resolved = await resolveWorkspacePath(ctx.workspace, args.path, { mustExist: true });
    const caseFlag =
      args.caseSensitive === undefined
        ? '--smart-case'
        : args.caseSensitive
          ? '--case-sensitive'
          : '--ignore-case';
    const rgArgs = [
      '--json',
      '--sort',
      'path',
      '--max-filesize',
      '2M',
      '--max-count',
      // One extra so a single file at the cap still shows that more exist.
      String(args.maxResults + 1),
      caseFlag,
      ...(args.regex ? [] : ['--fixed-strings']),
      ...rgWalkArgs(ctx.projectConfig.ignoreGlobs),
      ...(args.glob ? ['--glob', args.glob] : []),
      // -e keeps a query like "--files" from being read as a flag.
      '-e',
      args.query,
      ...(resolved.rel === '.' ? [] : ['--', resolved.rel]),
    ];
    const r = await runRg(rgArgs, resolved.root, ctx, signal);
    const failed = processFailure(r, 'search');
    if (failed) return failed;

    const matches: string[] = [];
    let more = r.truncated;
    for (const line of r.output.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      let parsed: z.infer<typeof RgMatch>;
      try {
        parsed = RgMatch.parse(JSON.parse(line));
      } catch {
        continue; // cut off by the output cap, or a non-UTF-8 path
      }
      if (matches.length >= args.maxResults) {
        more = true;
        break;
      }
      let text = parsed.data.lines.text.replace(/\r?\n$/, '');
      if (text.length > MAX_MATCH_LINE_CHARS)
        text = `${text.slice(0, MAX_MATCH_LINE_CHARS)} [… cut]`;
      matches.push(`${parsed.data.path.text}:${parsed.data.line_number ?? '?'}: ${text}`);
    }

    const stderr = (r.stderr ?? '').trim();
    if (r.exitCode === 2 && matches.length === 0) {
      const kind = /regex parse error|error parsing glob/i.test(stderr) ? 'invalid_args' : 'failed';
      return failure(kind, `search failed: ${stderr || 'rg exit 2'}`);
    }
    if (matches.length === 0) return { ok: true, output: 'No matches.' };
    const note = more ? `\n[… more matches not shown; narrow the query, path, or glob]` : '';
    return { ok: true, output: matches.join('\n') + note, truncated: more };
  },
});
