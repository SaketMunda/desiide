import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, sep } from 'node:path';

/** Canonical (realpath'd) workspace roots. The first root is the default for new files and cwd. */
export interface Workspace {
  readonly roots: readonly string[];
}

export interface ResolvedPath {
  /** Absolute path inside a root (lexical, symlinks not expanded). */
  abs: string;
  /** Canonical root that contains the path. */
  root: string;
  /** Root-relative POSIX path, `.` for the root itself. */
  rel: string;
  exists: boolean;
}

export type PathErrorReason = 'invalid' | 'outside' | 'not_found';

export class PathError extends Error {
  readonly reason: PathErrorReason;
  constructor(reason: PathErrorReason, message: string) {
    super(message);
    this.name = 'PathError';
    this.reason = reason;
  }
}

export async function createWorkspace(roots: readonly string[]): Promise<Workspace> {
  if (roots.length === 0) throw new PathError('invalid', 'workspace has no roots');
  const canonical = await Promise.all(
    roots.map(async (r) => {
      if (!isAbsolute(r)) throw new PathError('invalid', `workspace root must be absolute: ${r}`);
      return realpath(r);
    }),
  );
  return { roots: canonical };
}

// Control and format chars (bidi overrides, zero-width joiners, BOM), line/paragraph separators.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Lookalike slashes that NFKC doesn't fold (division slash, fraction slash, set minus, …).
const LOOKALIKE_SEPARATORS = /[⁄∕∖⧸⧹﹨／＼]/u;

/**
 * Lexical checks on a model-supplied path: POSIX, relative, no `..`, no invisible or lookalike
 * characters. Returns the normalized relative path (`.` for the root).
 */
export function normalizeInput(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) {
    throw new PathError('invalid', 'path must be a non-empty string up to 4096 chars');
  }
  if (HIDDEN_CHARS.test(input)) {
    throw new PathError('invalid', 'path contains control or invisible characters');
  }
  if (LOOKALIKE_SEPARATORS.test(input)) {
    throw new PathError('invalid', 'path contains a lookalike slash character');
  }
  if (input.includes('\\')) {
    throw new PathError('invalid', 'use forward slashes (workspace-relative POSIX path)');
  }
  // Fullwidth dots/slashes fold to ASCII under NFKC; check both forms so they can't smuggle `..`.
  for (const form of [input, input.normalize('NFKC')]) {
    if (form.startsWith('/') || /^[a-zA-Z]:/.test(form) || form.startsWith('~')) {
      throw new PathError('invalid', 'path must be workspace-relative');
    }
    if (form.split('/').some((s) => s === '..')) {
      throw new PathError('outside', 'path must not contain ".."');
    }
  }
  const normalized = posix.normalize(input).replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Canonical location of `abs`, even when it doesn't exist yet: realpath the nearest existing
 * ancestor and append the rest. A dangling symlink anywhere on the way is rejected, because
 * creating the file would write through it.
 */
async function canonicalize(abs: string): Promise<{ real: string; exists: boolean }> {
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    const st = await lstatOrNull(current);
    if (st) {
      let real: string;
      try {
        real = await realpath(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || st.isSymbolicLink()) {
          throw new PathError('outside', 'path goes through a dangling symlink');
        }
        throw err;
      }
      return {
        real: missing.length ? join(real, ...missing.reverse()) : real,
        exists: !missing.length,
      };
    }
    const parent = dirname(current);
    if (parent === current) return { real: abs, exists: false };
    missing.push(basename(current));
    current = parent;
  }
}

/**
 * Resolve a model-supplied path into the workspace. Rejects anything that lexically or through
 * symlinks lands outside every root. With several roots, the first root where the path exists
 * wins; a path that exists nowhere resolves against the first root.
 */
export async function resolveWorkspacePath(
  ws: Workspace,
  input: string,
  opts: { mustExist?: boolean } = {},
): Promise<ResolvedPath> {
  const rel = normalizeInput(input);
  let fallback: ResolvedPath | undefined;
  for (const root of ws.roots) {
    const abs = rel === '.' ? root : join(root, ...rel.split('/'));
    if (!isWithin(root, abs)) throw new PathError('outside', 'path is outside the workspace');
    const { real, exists } = await canonicalize(abs);
    if (!isWithin(root, real)) {
      throw new PathError('outside', 'path resolves outside the workspace (symlink)');
    }
    const resolved: ResolvedPath = { abs, root, rel, exists };
    if (exists) return resolved;
    fallback ??= resolved;
  }
  if (opts.mustExist || fallback === undefined)
    throw new PathError('not_found', `no such file: ${rel}`);
  return fallback;
}
