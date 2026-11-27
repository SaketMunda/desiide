import type { FileEdit, SearchReplace } from '@desiide/protocol';

/**
 * Search/replace blocks, re-validated against the file as it is *now* (UI-4, ADR-004). Same rules
 * as the orchestrator's `propose_edit` check (COR-3): blocks apply in order, each search must match
 * exactly once, an empty search inserts at the start (or creates the file). Pure, so the host
 * applies and the webview previews with the same code.
 */

export type BlockProblem = 'search_not_found' | 'search_ambiguous' | 'file_not_found';

export type BlockResult =
  | { ok: true; text: string; created: boolean }
  | { ok: false; problem: BlockProblem; editIndex: number };

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count++;
    if (count > 1) return count;
  }
  return count;
}

/** `content` is the current text (an open, possibly dirty buffer wins over disk); null = no file. */
export function applyBlocks(content: string | null, edits: readonly SearchReplace[]): BlockResult {
  let current = content ?? '';
  for (const [editIndex, edit] of edits.entries()) {
    if (edit.search === '') {
      current = edit.replace + current;
      continue;
    }
    if (content === null) return { ok: false, problem: 'file_not_found', editIndex };
    const n = occurrences(current, edit.search);
    if (n === 0) return { ok: false, problem: 'search_not_found', editIndex };
    if (n > 1) return { ok: false, problem: 'search_ambiguous', editIndex };
    current = current.replace(edit.search, () => edit.replace);
  }
  return { ok: true, text: current, created: content === null };
}

/**
 * The smallest single replacement turning `before` into `after` (common prefix and suffix kept),
 * so cursors, folds and markers outside the change stay put. Offsets are into `before`.
 */
export function minimalReplace(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

const lines = (s: string): string[] => {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
};

/**
 * +/− line counts for the review card, from the blocks alone (no file content needed): lines shared
 * by a block's search and replace at either end don't count.
 */
export function editStats(file: FileEdit): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const edit of file.edits) {
    const a = lines(edit.search);
    const b = lines(edit.replace);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
      tail++;
    }
    removed += a.length - head - tail;
    added += b.length - head - tail;
  }
  return { added, removed };
}
