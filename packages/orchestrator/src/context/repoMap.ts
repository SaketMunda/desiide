import { excludedByName } from './filters.ts';
import { detectLanguage } from './language.ts';

export interface RepoMapOptions {
  /** Directory levels shown; deeper directories appear only as file counts. */
  maxDepth?: number;
  /** Files listed per directory before "… N more files". */
  maxFilesPerDir?: number;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
  total: number;
}

function newDir(): DirNode {
  return { dirs: new Map(), files: [], total: 0 };
}

function buildTree(paths: readonly string[]): DirNode {
  const root = newDir();
  for (const p of paths) {
    const parts = p.split('/');
    const file = parts.pop();
    if (file === undefined) continue;
    let node = root;
    node.total++;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = newDir();
        node.dirs.set(part, child);
      }
      child.total++;
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

// Code-point order, like `rg --sort path`; localeCompare would differ between machines.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderTree(node: DirNode, depth: number, opts: Required<RepoMapOptions>): string[] {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const [name, child] of [...node.dirs].sort(([a], [b]) => byCodePoint(a, b))) {
    lines.push(`${indent}${name}/ (${plural(child.total, 'file')})`);
    if (depth + 1 < opts.maxDepth) lines.push(...renderTree(child, depth + 1, opts));
  }
  const files = [...node.files].sort(byCodePoint);
  for (const f of files.slice(0, opts.maxFilesPerDir)) lines.push(`${indent}${f}`);
  if (files.length > opts.maxFilesPerDir) {
    lines.push(`${indent}… ${plural(files.length - opts.maxFilesPerDir, 'more file')}`);
  }
  return lines;
}

export interface RepoMap {
  header: string;
  lines: string[];
}

/**
 * A summary of the workspace's (already gitignore-filtered) files: a language breakdown and a
 * depth-limited tree. Lockfiles, binaries, and generated files are left out.
 */
export function buildRepoMap(allPaths: readonly string[], options: RepoMapOptions = {}): RepoMap {
  const opts = { maxDepth: options.maxDepth ?? 3, maxFilesPerDir: options.maxFilesPerDir ?? 15 };
  const paths = allPaths.filter((p) => excludedByName(p) === undefined);
  const counts = new Map<string, number>();
  for (const p of paths) {
    const lang = detectLanguage(p);
    if (lang !== 'plaintext') counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts]
    .sort(([a, x], [b, y]) => y - x || byCodePoint(a, b))
    .slice(0, 8)
    .map(([lang, n]) => `${lang} ${n}`)
    .join(', ');
  const header =
    `### Repository map (${plural(paths.length, 'file')}, gitignored files left out` +
    `${languages ? `; ${languages}` : ''}):`;
  return { header, lines: renderTree(buildTree(paths), 0, opts) };
}

/** The map in at most `maxChars`, cut at a line with a pointer to list_files. */
export function renderRepoMap(map: RepoMap, maxChars: number): string {
  const full = [map.header, ...map.lines].join('\n');
  if (full.length <= maxChars) return full;
  const out = [map.header];
  let used = map.header.length;
  const reserve = 64;
  let i = 0;
  for (; i < map.lines.length; i++) {
    const line = map.lines[i] ?? '';
    if (used + line.length + 1 + reserve > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  const more = map.lines.length - i;
  out.push(`[… ${more} more ${more === 1 ? 'entry' : 'entries'}; use list_files]`);
  const text = out.join('\n');
  return text.length <= maxChars ? text : '';
}
