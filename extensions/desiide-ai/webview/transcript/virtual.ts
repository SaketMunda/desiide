/** Transcripts longer than this render only the rows near the viewport. */
export const VIRTUALIZE_OVER = 300;
/** Height assumed for a row that hasn't been measured yet. */
export const ESTIMATED_ROW_PX = 64;
/** Extra pixels rendered above and below the viewport. */
export const OVERSCAN_PX = 600;

export interface Window {
  start: number;
  /** Exclusive. */
  end: number;
  /** Spacer heights standing in for the rows not rendered. */
  before: number;
  after: number;
}

/**
 * Which rows to render for a scroll position. `heights[i]` is the measured height of row i, or
 * undefined if it hasn't rendered yet. Linear in the row count, which is fine at transcript sizes
 * (thousands of rows) and keeps the function obviously correct.
 */
export function visibleWindow(
  heights: readonly (number | undefined)[],
  count: number,
  scrollTop: number,
  viewport: number,
  overscan = OVERSCAN_PX,
): Window {
  if (count <= VIRTUALIZE_OVER) return { start: 0, end: count, before: 0, after: 0 };
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewport + overscan;
  let y = 0;
  let start = count;
  let before = 0;
  let end = count;
  for (let i = 0; i < count; i++) {
    const h = heights[i] ?? ESTIMATED_ROW_PX;
    if (start === count && y + h > top) {
      start = i;
      before = y;
    }
    if (y >= bottom) {
      end = i;
      break;
    }
    y += h;
  }
  if (start === count) {
    // Scrolled past the end (rows shrank): show the last rows.
    start = Math.max(0, count - 1);
    before = y - (heights[start] ?? ESTIMATED_ROW_PX);
  }
  let after = 0;
  for (let i = end; i < count; i++) after += heights[i] ?? ESTIMATED_ROW_PX;
  return { start, end: Math.max(end, start + 1), before, after };
}

/** Within this many pixels of the bottom counts as "at the bottom" (keep following the stream). */
export const STICK_PX = 48;

export function isAtBottom(scrollTop: number, viewport: number, scrollHeight: number): boolean {
  return scrollHeight - (scrollTop + viewport) <= STICK_PX;
}
