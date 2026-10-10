/** Zero-based, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

export interface RenderedLines {
  text: string;
  truncated: boolean;
}

const MAX_LINE_CHARS = 1000;
// Room kept for the two omission markers when the file doesn't fit.
const MARKER_RESERVE = 2 * 96;

/** Splits file text into lines the way read_file does (a trailing newline adds no line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Same `     12\t` prefix as read_file, so line numbers in the context match its output. */
function formatLine(line: string, index: number): string {
  const shown =
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [… line truncated]` : line;
  return `${String(index + 1).padStart(6)}\t${shown}`;
}

function omitted(from: number, to: number): string {
  return `[… lines ${from + 1}-${to + 1} not shown; read_file startLine ${from + 1} endLine ${to + 1}]`;
}

/**
 * Numbered lines in at most `maxChars`. When they don't all fit, keeps a window around `focus`
 * (the selection) or else the top of the file, and marks what was left out on each side.
 */
export function renderLines(
  lines: readonly string[],
  maxChars: number,
  focus?: LineRange,
): RenderedLines {
  const formatted = lines.map(formatLine);
  const cost = formatted.map((l) => l.length + 1);
  const total = cost.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return { text: formatted.join('\n'), truncated: false };

  const budget = maxChars - MARKER_RESERVE;
  if (budget <= 0 || lines.length === 0) return { text: '', truncated: true };
  const last = lines.length - 1;
  const fStart = Math.min(Math.max(focus?.start ?? 0, 0), last);
  const fEnd = Math.min(Math.max(focus?.end ?? fStart, fStart), last);

  let start = fStart;
  let end = fStart - 1;
  let used = 0;
  // The focus itself first, top down.
  while (end < fEnd && used + (cost[end + 1] ?? 0) <= budget) used += cost[++end] ?? 0;
  // Then grow around it, one line below and one above at a time.
  let grew = end >= fEnd;
  while (grew) {
    grew = false;
    if (end < last && used + (cost[end + 1] ?? 0) <= budget) {
      used += cost[++end] ?? 0;
      grew = true;
    }
    if (start > 0 && used + (cost[start - 1] ?? 0) <= budget) {
      used += cost[--start] ?? 0;
      grew = true;
    }
  }
  if (end < start) return { text: '', truncated: true };

  const parts: string[] = [];
  if (start > 0) parts.push(omitted(0, start - 1));
  parts.push(...formatted.slice(start, end + 1));
  if (end < last) parts.push(omitted(end + 1, last));
  return { text: parts.join('\n'), truncated: true };
}
