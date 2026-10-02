import type { MentionItem, PromptChip } from '../../shared/messages.ts';

export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Caret position (end of the query). */
  end: number;
  query: string;
}

/**
 * The `@token` the caret is in, if any. `@` must start the text or follow whitespace or an opening
 * bracket/quote, so e-mail addresses and decorators like `foo@bar` don't open the popup.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | undefined {
  for (let i = caret - 1; i >= 0; i--) {
    const c = text[i] ?? '';
    if (c === '@') {
      const before = text[i - 1];
      if (before !== undefined && !/[\s([{"'`]/.test(before)) return undefined;
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (/\s/.test(c)) return undefined;
  }
  return undefined;
}

/** Removes the `@query` that was turned into a chip. Returns the new text and caret. */
export function removeMention(text: string, m: MentionQuery): { text: string; caret: number } {
  const after = text.slice(m.end);
  // Swallow one following space so "fix @app.ts now" doesn't leave a double space.
  const before = text.slice(0, m.start);
  const glued = before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after;
  return { text: before + glued, caret: m.start };
}

const STATIC_ITEMS: readonly MentionItem[] = [
  { kind: 'selection', label: 'selection', detail: 'Current editor selection' },
  { kind: 'diff', label: 'diff', detail: 'Working-tree changes' },
];

/** `@selection` / `@diff` first when they match, then the host's file/folder results. */
export function mentionItems(query: string, results: readonly MentionItem[]): MentionItem[] {
  const q = query.toLowerCase();
  const statics = STATIC_ITEMS.filter((i) => isSubsequence(q, i.label));
  return [...statics, ...results];
}

function isSubsequence(q: string, s: string): boolean {
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) if (s[i] === q[qi]) qi++;
  return qi === q.length;
}

/** History cursor: `index` is null while editing the draft; `stash` keeps that draft. */
export interface HistoryCursor {
  index: number | null;
  stash: string;
}

export const NO_HISTORY: HistoryCursor = { index: null, stash: '' };

/**
 * Moves through history like a shell: up goes older, down goes newer and finally back to the
 * draft that was being typed. Returns undefined when there is nowhere to go.
 */
export function stepHistory(
  history: readonly string[],
  cursor: HistoryCursor,
  direction: 'up' | 'down',
  currentText: string,
): { cursor: HistoryCursor; text: string } | undefined {
  if (history.length === 0) return undefined;
  if (direction === 'up') {
    if (cursor.index === 0) return undefined;
    const index = cursor.index === null ? history.length - 1 : cursor.index - 1;
    const stash = cursor.index === null ? currentText : cursor.stash;
    return { cursor: { index, stash }, text: history[index] ?? '' };
  }
  if (cursor.index === null) return undefined;
  if (cursor.index >= history.length - 1) {
    return { cursor: NO_HISTORY, text: cursor.stash };
  }
  const index = cursor.index + 1;
  return { cursor: { index, stash: cursor.stash }, text: history[index] ?? '' };
}

/** chars/4, the brief's estimate. Chips with unknown size count as zero. */
export function estimateTokens(text: string, chips: readonly PromptChip[]): number {
  const chars = text.length + chips.reduce((sum, c) => sum + (c.chars ?? 0), 0);
  return Math.ceil(chars / 4);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

export function sameChip(a: PromptChip, b: PromptChip): boolean {
  return JSON.stringify(a.ref) === JSON.stringify(b.ref);
}

/** Adds a chip unless an identical one is already attached. */
export function addChip(chips: readonly PromptChip[], chip: PromptChip): PromptChip[] {
  return chips.some((c) => sameChip(c, chip)) ? [...chips] : [...chips, chip];
}

export const EXAMPLE_PROMPTS: readonly string[] = [
  'Explain how this code works and point out edge cases',
  'Find and fix the bug behind the failing test',
  'Add input validation to this function and write unit tests for it',
];
