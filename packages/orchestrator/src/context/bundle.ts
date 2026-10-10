import type { ContextRef, FileMeta, Range, Task } from '@desiide/protocol';
import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import {
  PathError,
  resolveWorkspacePath,
  type ResolvedPath,
  type Workspace,
} from '../tools/paths.ts';
import { readTextFile } from '../tools/readFile.ts';
import {
  EXCLUSION_TEXT,
  excludedByName,
  type ExclusionReason,
  type Sensitivity,
} from './filters.ts';
import { detectLanguage } from './language.ts';
import { estimateTokens, packTiers, SECTION_SEPARATOR, type PackItem } from './pack.ts';
import { buildRepoMap, renderRepoMap } from './repoMap.ts';
import { renderLines, splitLines, type LineRange } from './truncate.ts';
import type { DiffResult, FileListing } from './workspaceIO.ts';

export type SectionKind =
  'file' | 'folder' | 'selection' | 'diff' | 'open_editor' | 'repo_map' | 'omitted';

export interface ContextSection {
  kind: SectionKind;
  /** The workspace path the section is about, when there is one. */
  path?: string;
  text: string;
  truncated: boolean;
}

/** What the model gets about the task's context, within the token budget. */
export interface ContextBundle {
  sections: ContextSection[];
  /** The rendered context: sections in priority order, joined. */
  text: string;
  /** chars/4 estimate of `text`; never above the budget. */
  tokenEstimate: number;
  budgetTokens: number;
  /** Metadata of every file the context refers to (JEV-1 state, UI-4). Never contents. */
  files: FileMeta[];
  /** Things left out, with why. Also listed for the model in the `omitted` section. */
  omitted: { label: string; reason: string }[];
}

/** Everything the bundle builder reads from the workspace, so tests can swap the I/O. */
export interface BundleInputs {
  task: Task;
  workspace: Workspace;
  sensitivity: Sensitivity;
  /** First root's files, gitignore-aware; `undefined` when ripgrep isn't available. */
  listing: FileListing | undefined;
  diff(scope: 'working' | 'staged', path: string | undefined): Promise<DiffResult | undefined>;
  budgetTokens: number;
  signal: AbortSignal;
}

// Smallest useful slice of a file (~300 tokens); smaller ones are left out instead.
const MIN_FILE_CHARS = 1200;
// A few lines around a selection are useful even when a whole slice of file isn't.
const MIN_FOCUSED_CHARS = 600;
const SELECTION_WINDOW_LINES = 40;
const MAX_FOLDER_FILES = 40;
const MAX_FOLDER_LISTING = 200;
const MAX_OPEN_EDITORS = 10;
const MAX_FILE_METAS = 200;
const MAX_OMITTED_LISTED = 30;
// Share of the budget kept back for the "not included" note.
const OMITTED_RESERVE_SHARE = 0.08;

/** VS Code selections that end at column 0 of a line don't include that line. */
export function selectionLines(range: Range): LineRange {
  const { start, end } = range;
  const endLine = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  return { start: start.line, end: Math.max(start.line, endLine) };
}

/** Line count without reading the whole file into memory. */
export async function countLines(abs: string): Promise<number> {
  let lines = 0;
  let last = -1;
  for await (const chunk of createReadStream(abs) as AsyncIterable<Buffer>) {
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
    if (chunk.length > 0) last = chunk[chunk.length - 1] ?? -1;
  }
  return last !== -1 && last !== 10 ? lines + 1 : lines;
}

interface LoadedFile {
  path: string;
  resolved: ResolvedPath;
  lines: string[];
}

type Loaded =
  | { kind: 'file'; file: LoadedFile }
  | { kind: 'dir'; resolved: ResolvedPath }
  | {
      kind: 'excluded';
      path: string;
      reason: ExclusionReason | 'missing' | 'outside' | 'unreadable';
      detail?: string;
    };

function fileHeader(
  kind: string,
  path: string,
  lines: number,
  partial: boolean,
  extra = '',
): string {
  return `### ${kind}: ${path} (${detectLanguage(path)}, ${lines} line${lines === 1 ? '' : 's'}${extra}${partial ? ', partial' : ''})`;
}

/** A file section that truncates around `focus` to fit. */
function fileItem(
  title: string,
  file: LoadedFile,
  focus: LineRange | undefined,
  extra: string,
  capChars?: number,
): PackItem {
  const full = fileHeader(title, file.path, file.lines.length, false, extra);
  const partial = fileHeader(title, file.path, file.lines.length, true, extra);
  const body = (max: number) => renderLines(file.lines, max, focus);
  const fullBody = body(Number.MAX_SAFE_INTEGER).text;
  const fullChars = Math.min(
    full.length + 1 + fullBody.length,
    capChars ?? Number.MAX_SAFE_INTEGER,
  );
  const render = (maxChars: number): string => {
    if (full.length + 1 + fullBody.length <= maxChars) return `${full}\n${fullBody}`;
    const r = body(maxChars - partial.length - 1);
    return r.text ? `${partial}\n${r.text}` : '';
  };
  return {
    fullChars,
    minChars: Math.min(focus ? MIN_FOCUSED_CHARS : MIN_FILE_CHARS, fullChars),
    render,
  };
}

function textItem(lines: readonly string[], cutNote: (more: number) => string): PackItem {
  const full = lines.join('\n');
  return {
    fullChars: full.length,
    minChars: Math.min(MIN_FILE_CHARS / 2, full.length),
    render(maxChars) {
      if (full.length <= maxChars) return full;
      const out: string[] = [];
      let used = 0;
      let i = 0;
      for (; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (used + line.length + 1 + 100 > maxChars) break;
        out.push(line);
        used += line.length + 1;
      }
      if (out.length === 0) return '';
      out.push(cutNote(lines.length - i));
      const text = out.join('\n');
      return text.length <= maxChars ? text : '';
    },
  };
}

interface Candidate {
  kind: SectionKind;
  path?: string;
  item: PackItem;
  /** Label for the "not included" note if packing leaves it out. */
  label: string;
}

export async function buildContextBundle(inputs: BundleInputs): Promise<ContextBundle> {
  const { task, workspace, sensitivity, listing, signal } = inputs;
  const listed = listing && !listing.truncated ? new Set(listing.files) : undefined;
  const firstRoot = workspace.roots[0];
  const omitted: { label: string; reason: string }[] = [];
  const metaPaths = new Set<string>();
  const loadedText = new Map<string, number>();

  const noteMeta = (path: string): void => {
    if (metaPaths.size < MAX_FILE_METAS) metaPaths.add(path);
  };

  const load = async (path: string): Promise<Loaded> => {
    signal.throwIfAborted();
    let resolved: ResolvedPath;
    try {
      resolved = await resolveWorkspacePath(workspace, path, { mustExist: true });
    } catch (err) {
      if (err instanceof PathError) {
        return {
          kind: 'excluded',
          path,
          reason: err.reason === 'not_found' ? 'missing' : 'outside',
        };
      }
      throw err;
    }
    const rel = resolved.rel;
    const read = await readTextFile(resolved.abs).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : String(err),
    }));
    if ('error' in read && read.error.startsWith('is a directory'))
      return { kind: 'dir', resolved };
    noteMeta(rel);
    if (sensitivity.secret(rel)) return { kind: 'excluded', path: rel, reason: 'secret' };
    const byName = excludedByName(rel);
    if (byName) return { kind: 'excluded', path: rel, reason: byName };
    if (listed && resolved.root === firstRoot && !listed.has(rel)) {
      return { kind: 'excluded', path: rel, reason: 'gitignored' };
    }
    if ('error' in read) {
      const reason = read.error.startsWith('binary') ? 'binary' : 'unreadable';
      return { kind: 'excluded', path: rel, reason, detail: read.error };
    }
    const lines = splitLines(read.text);
    loadedText.set(rel, lines.length);
    return { kind: 'file', file: { path: rel, resolved, lines } };
  };

  const exclude = (l: Extract<Loaded, { kind: 'excluded' }>): void => {
    const reason =
      l.reason === 'missing'
        ? 'not found'
        : l.reason === 'outside'
          ? 'outside the workspace'
          : l.reason === 'unreadable'
            ? (l.detail ?? 'could not be read')
            : EXCLUSION_TEXT[l.reason];
    omitted.push({ label: l.path, reason });
  };

  const refs = task.context.refs;
  const selections = refs.filter(
    (r): r is Extract<ContextRef, { type: 'selection' }> => r.type === 'selection',
  );
  const included = new Set<string>();

  // ── Tier 1: files and folders the user attached, in their order; then their test files ──
  const tier1: Candidate[] = [];
  const mergedSelections = new Set<ContextRef>();
  // Contents of an attached folder's files: after the explicit asks (refs, selections, diffs), so a
  // big folder can't crowd those out.
  const folderFiles: Candidate[] = [];
  const addFile = (
    tier: Candidate[],
    file: LoadedFile,
    title: string,
    focus?: LineRange,
    extra = '',
  ): void => {
    included.add(file.path);
    tier.push({
      kind: 'file',
      path: file.path,
      label: file.path,
      item: fileItem(title, file, focus, extra),
    });
  };

  const explicitPaths: { path: string; asFolder: boolean }[] = [
    ...refs.flatMap((r) =>
      r.type === 'file' || r.type === 'folder'
        ? [{ path: r.path, asFolder: r.type === 'folder' }]
        : [],
    ),
    ...task.context.tests.map((path) => ({ path, asFolder: false })),
  ];
  for (const { path } of explicitPaths) {
    const loaded = await load(path);
    if (loaded.kind === 'excluded') {
      exclude(loaded);
      continue;
    }
    if (loaded.kind === 'file') {
      if (included.has(loaded.file.path)) continue;
      const sel = selections.find((s) => posix.normalize(s.path) === loaded.file.path);
      if (sel) mergedSelections.add(sel);
      const focus = sel ? selectionLines(sel.range) : undefined;
      const extra = focus ? `, selection lines ${focus.start + 1}-${focus.end + 1}` : '';
      addFile(tier1, loaded.file, 'File', focus, extra);
      continue;
    }
    // A folder: list what's in it, then add its files' contents in path order.
    const dir = loaded.resolved;
    if (!listed || dir.root !== firstRoot) {
      omitted.push({ label: `${dir.rel}/`, reason: 'folder listing unavailable; use list_files' });
      continue;
    }
    const prefix = dir.rel === '.' ? '' : `${dir.rel}/`;
    const inFolder = (listing?.files ?? []).filter((f) => f.startsWith(prefix));
    const shown = inFolder.slice(0, MAX_FOLDER_LISTING);
    const listingLines = [
      `### Folder: ${dir.rel === '.' ? '.' : prefix} (${inFolder.length} file${inFolder.length === 1 ? '' : 's'})`,
      ...shown.map((f) => `- ${f}`),
    ];
    if (inFolder.length > shown.length)
      listingLines.push(`[… ${inFolder.length - shown.length} more; use list_files]`);
    tier1.push({
      kind: 'folder',
      path: dir.rel,
      label: `${prefix || '.'} (listing)`,
      item: textItem(listingLines, (more) => `[… ${more} more; use list_files]`),
    });
    let added = 0;
    for (const f of inFolder) {
      if (added >= MAX_FOLDER_FILES) {
        omitted.push({
          label: `${prefix}…`,
          reason: `only the first ${MAX_FOLDER_FILES} files of the folder are shown`,
        });
        break;
      }
      if (included.has(f)) continue;
      // Quietly skip what a folder naturally contains; it's in the listing above.
      if (excludedByName(f) || sensitivity.secret(f)) continue;
      const l = await load(f);
      if (l.kind !== 'file') continue;
      addFile(folderFiles, l.file, 'File');
      added++;
    }
  }

  // ── Tier 2: selections ──
  const tier2: Candidate[] = [];
  for (const sel of selections) {
    if (mergedSelections.has(sel)) continue;
    const loaded = await load(sel.path);
    if (loaded.kind !== 'file') {
      if (loaded.kind === 'excluded') exclude(loaded);
      continue;
    }
    const focus = selectionLines(sel.range);
    const file = loaded.file;
    // The selection plus some lines around it is enough; the rest of the file is a read away.
    const windowChars = file.lines
      .slice(
        Math.max(0, focus.start - SELECTION_WINDOW_LINES),
        focus.end + 1 + SELECTION_WINDOW_LINES,
      )
      .reduce((n, l) => n + Math.min(l.length, 1000) + 8, 0);
    const extra = `, lines ${focus.start + 1}-${focus.end + 1}`;
    tier2.push({
      kind: 'selection',
      path: file.path,
      label: `${file.path} lines ${focus.start + 1}-${focus.end + 1}`,
      item: fileItem('Selection', file, focus, extra, windowChars + 400),
    });
    included.add(file.path);
  }

  // ── Tier 3: diffs (the ones asked for, or else the uncommitted changes) ──
  const tier3: Candidate[] = [];
  const diffRefs = refs.filter(
    (r): r is Extract<ContextRef, { type: 'diff' }> => r.type === 'diff',
  );
  const implicit = diffRefs.length === 0;
  const diffAsks = implicit ? [{ scope: 'working' as const, path: undefined }] : diffRefs;
  for (const ask of diffAsks) {
    signal.throwIfAborted();
    const d = await inputs.diff(ask.scope, ask.path);
    const label = `${ask.scope === 'staged' ? 'staged' : 'uncommitted'} changes${ask.path ? ` in ${ask.path}` : ''}`;
    if (d === undefined) {
      if (!implicit)
        omitted.push({ label, reason: 'git diff unavailable (not a git repository?)' });
      continue;
    }
    for (const p of d.paths) noteMeta(p);
    if (d.text.trim() === '') {
      if (!implicit) omitted.push({ label, reason: 'no changes' });
      continue;
    }
    const title = `### Diff: ${label}${implicit ? ' (working tree)' : ''}`;
    const lines = [title, ...d.text.split('\n')];
    if (d.truncated) lines.push('[… diff cut at 1 MB; use git_read diff with a path]');
    tier3.push({
      kind: 'diff',
      label,
      ...(ask.path ? { path: ask.path } : {}),
      item: textItem(lines, () => '[… rest of the diff not shown; use git_read diff with a path]'),
    });
  }

  // ── Tier 4: open editors, most recent first ──
  const tier4: Candidate[] = [];
  for (const path of task.context.openEditors.slice(0, MAX_OPEN_EDITORS)) {
    if (included.has(path)) continue;
    const loaded = await load(path);
    if (loaded.kind !== 'file') {
      if (loaded.kind === 'excluded') exclude(loaded);
      continue;
    }
    if (included.has(loaded.file.path)) continue;
    included.add(loaded.file.path);
    tier4.push({
      kind: 'open_editor',
      path: loaded.file.path,
      label: loaded.file.path,
      item: fileItem('Open editor', loaded.file, undefined, ''),
    });
  }

  // ── Tier 5: repository map ──
  const tier5: Candidate[] = [];
  if (listing) {
    const map = buildRepoMap(listing.files);
    tier5.push({
      kind: 'repo_map',
      label: 'repository map',
      item: {
        fullChars: [map.header, ...map.lines].join('\n').length,
        minChars: 400,
        render: (max) => renderRepoMap(map, max),
      },
    });
  }

  // ── Pack ──
  const budgetChars = inputs.budgetTokens * 4;
  // Enough for a heading and a few entries even on a small budget.
  const omittedReserve = Math.floor(
    Math.max(budgetChars * OMITTED_RESERVE_SHARE, Math.min(400, budgetChars * 0.25)),
  );
  const tiers = [tier1, tier2, tier3, folderFiles, tier4, tier5];
  const packed = packTiers(
    tiers.map((t) => t.map((c) => c.item)),
    budgetChars - omittedReserve,
  );

  const sections: ContextSection[] = [];
  tiers.forEach((tier, t) => {
    tier.forEach((c, i) => {
      const text = packed.rendered[t]?.[i];
      if (text === undefined) {
        omitted.push({ label: c.label, reason: 'did not fit the context budget' });
        return;
      }
      sections.push({
        kind: c.kind,
        ...(c.path === undefined ? {} : { path: c.path }),
        text,
        truncated: text.length < c.item.render(Number.MAX_SAFE_INTEGER).length,
      });
    });
  });

  const omittedText = renderOmitted(omitted, omittedReserve - SECTION_SEPARATOR.length);
  if (omittedText) sections.push({ kind: 'omitted', text: omittedText, truncated: false });

  const text = sections.map((s) => s.text).join(SECTION_SEPARATOR);
  const files = await describeFiles(workspace, [...metaPaths], sensitivity, signal, loadedText);
  return {
    sections,
    text,
    tokenEstimate: estimateTokens(text.length),
    budgetTokens: inputs.budgetTokens,
    files,
    omitted,
  };
}

function renderOmitted(
  omitted: readonly { label: string; reason: string }[],
  maxChars: number,
): string {
  if (omitted.length === 0 || maxChars <= 0) return '';
  const lines = [
    '### Not included (use read_file, list_files, search, or git_read if you need them)',
  ];
  let used = lines[0]?.length ?? 0;
  let shown = 0;
  for (const o of omitted.slice(0, MAX_OMITTED_LISTED)) {
    const line = `- ${o.label}: ${o.reason}`;
    if (used + line.length + 1 + 40 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < omitted.length) lines.push(`- … and ${omitted.length - shown} more`);
  const text = lines.join('\n');
  return text.length <= maxChars && shown > 0 ? text : '';
}

/**
 * `FileMeta` for workspace paths, metadata only. Paths that don't resolve (not created yet, or
 * outside the workspace) still get a language and sensitivity, with 0 lines.
 */
export async function describeFiles(
  workspace: Workspace,
  paths: readonly string[],
  sensitivity: Sensitivity,
  signal: AbortSignal,
  knownLines: ReadonlyMap<string, number> = new Map(),
): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  for (const path of new Set(paths)) {
    signal.throwIfAborted();
    let sizeLines = knownLines.get(path);
    if (sizeLines === undefined) {
      sizeLines = 0;
      try {
        const r = await resolveWorkspacePath(workspace, path, { mustExist: true });
        sizeLines = await countLines(r.abs);
      } catch {
        // Missing, outside, or a directory: metadata without a size.
      }
    }
    out.push({
      path,
      sizeLines,
      language: detectLanguage(path),
      sensitive: sensitivity.sensitive(path),
    });
  }
  return out;
}
