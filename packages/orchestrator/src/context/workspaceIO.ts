import { SAFE_GIT } from '../tools/commands.ts';
import { runProcess, type ProcessOptions } from '../tools/process.ts';
import { rgWalkArgs } from '../tools/ripgrep.ts';
import { EXCLUSION_TEXT, excludedByName, type Sensitivity } from './filters.ts';

export interface ProcessEnvironment {
  env: NodeJS.ProcessEnv;
  trackProcessGroup?: (pid: number) => () => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LISTING_CAP_BYTES = 8 * 1024 * 1024;
const DIFF_CAP_BYTES = 1024 * 1024;

function options(
  cwd: string,
  pe: ProcessEnvironment,
  signal: AbortSignal,
  capBytes: number,
): ProcessOptions {
  return {
    cwd,
    env: pe.env,
    timeoutMs: pe.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputCapBytes: capBytes,
    capture: 'head',
    signal,
    ...(pe.trackProcessGroup ? { trackProcessGroup: pe.trackProcessGroup } : {}),
  };
}

export interface FileListing {
  /** Root-relative POSIX paths, sorted, gitignored files left out. */
  files: string[];
  truncated: boolean;
}

/**
 * Every file the agent's own tools would see (same rg walk rules as list_files/search), or
 * `undefined` when rg can't run: callers then skip the repo map and the gitignore check.
 */
export async function listFiles(
  root: string,
  rgPath: string,
  ignoreGlobs: readonly string[],
  pe: ProcessEnvironment,
  signal: AbortSignal,
): Promise<FileListing | undefined> {
  const r = await runProcess(
    { kind: 'exec', file: rgPath, args: ['--files', '--sort', 'path', ...rgWalkArgs(ignoreGlobs)] },
    options(root, pe, signal, LISTING_CAP_BYTES),
  );
  signal.throwIfAborted();
  // rg exits 1 when there are no files at all.
  if (r.spawnError !== undefined || r.timedOut || r.exitCode === null || r.exitCode > 1) {
    return undefined;
  }
  const files = r.output.split('\n').filter(Boolean);
  if (r.truncated) files.pop(); // the last path may be cut
  return { files, truncated: r.truncated };
}

export interface DiffResult {
  text: string;
  truncated: boolean;
  /** Paths (new side) the diff touches, excluded ones included. */
  paths: string[];
}

function diffPath(header: string): string | undefined {
  const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(header);
  return m?.[2];
}

/**
 * Drops the hunks of lockfiles, binaries, generated files, and secrets from a unified diff,
 * keeping a one-line note in their place so the model knows they changed.
 */
export function filterDiff(
  diff: string,
  sensitivity: Sensitivity,
): { text: string; paths: string[] } {
  const out: string[] = [];
  const paths: string[] = [];
  const blocks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf('\n') === -1 ? undefined : block.indexOf('\n'));
    const path = diffPath(header);
    if (path === undefined) {
      out.push(block);
      continue;
    }
    paths.push(path);
    const reason = sensitivity.secret(path) ? 'secret' : excludedByName(path);
    out.push(reason ? `${header}\n[${EXCLUSION_TEXT[reason]}]\n` : block);
  }
  return { text: out.join('').replace(/\n+$/, ''), paths };
}

/**
 * `git diff` of the working tree or the index, hardened like git_read: repo config can't make it
 * run a program, and it takes no locks. `undefined` outside a git repository.
 */
export async function gitDiff(
  root: string,
  scope: 'working' | 'staged',
  path: string | undefined,
  sensitivity: Sensitivity,
  pe: ProcessEnvironment,
  signal: AbortSignal,
): Promise<DiffResult | undefined> {
  const args = [
    ...SAFE_GIT,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(scope === 'staged' ? ['--cached'] : []),
    ...(path === undefined ? [] : ['--', path]),
  ];
  const r = await runProcess(
    { kind: 'exec', file: 'git', args },
    {
      ...options(root, pe, signal, DIFF_CAP_BYTES),
      env: { ...pe.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    },
  );
  signal.throwIfAborted();
  if (r.spawnError !== undefined || r.timedOut || r.exitCode !== 0) return undefined;
  let raw = r.output;
  // A cut-off last line could be half a header; drop it.
  if (r.truncated) raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
  const filtered = filterDiff(raw, sensitivity);
  return { ...filtered, truncated: r.truncated };
}
