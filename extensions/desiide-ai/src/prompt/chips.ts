import { WorkspacePath, type Range } from '@desiide/protocol';
import type { PromptChip } from '../../shared/messages.ts';
import { basename } from './fileIndex.ts';

/** `app.ts:12-30` (1-based). A selection ending at column 0 doesn't count that last line. */
export function selectionLabel(path: string, range: Range): string {
  const start = range.start.line + 1;
  const endLine =
    range.end.character === 0 && range.end.line > range.start.line
      ? range.end.line
      : range.end.line + 1;
  return `${basename(path)}:${start === endLine ? start : `${start}-${endLine}`}`;
}

export type ChipResult = { ok: true; chip: PromptChip } | { ok: false; message: string };

const OUTSIDE = 'Only files inside the open workspace can be attached.';

export function selectionChip(path: string | undefined, range: Range, chars: number): ChipResult {
  if (path === undefined || !WorkspacePath.safeParse(path).success)
    return { ok: false, message: OUTSIDE };
  if (range.start.line === range.end.line && range.start.character === range.end.character) {
    return { ok: false, message: 'Select some code in the editor first.' };
  }
  return {
    ok: true,
    chip: {
      ref: { type: 'selection', path, range },
      label: selectionLabel(path, range),
      detail: path,
      chars,
    },
  };
}

export function fileChip(path: string, chars: number | undefined): ChipResult {
  if (!WorkspacePath.safeParse(path).success) return { ok: false, message: OUTSIDE };
  return {
    ok: true,
    chip: {
      ref: { type: 'file', path },
      label: basename(path),
      detail: path,
      ...(chars === undefined ? {} : { chars }),
    },
  };
}

export function folderChip(path: string): ChipResult {
  if (!WorkspacePath.safeParse(path).success) return { ok: false, message: OUTSIDE };
  return {
    ok: true,
    chip: { ref: { type: 'folder', path }, label: `${basename(path)}/`, detail: path },
  };
}

export const DIFF_CHIP: PromptChip = {
  ref: { type: 'diff', scope: 'working' },
  label: 'working changes',
  detail: 'Uncommitted changes in the working tree',
};

/**
 * One glob of everything to skip when listing files: the user's `files.exclude` and
 * `search.exclude` (keys set to `true`) plus dependency and VCS folders.
 */
export function excludeGlob(...settings: Array<Record<string, unknown> | undefined>): string {
  const globs = new Set(['**/node_modules/**', '**/.git/**']);
  for (const map of settings) {
    for (const [glob, on] of Object.entries(map ?? {})) {
      // `{when: …}` conditions can't be expressed in one glob; skip rather than over-exclude.
      if (on === true && !glob.includes('{')) globs.add(glob);
    }
  }
  return `{${[...globs].join(',')}}`;
}
