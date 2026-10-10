/** Token estimate used for every budget here: about four characters per token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export interface PackItem {
  /** Size of the complete rendering. */
  fullChars: number;
  /** Below this a truncated rendering isn't worth showing, and the item is left out instead. */
  minChars: number;
  /** Renders in at most `maxChars` characters (`maxChars >= min(fullChars, minChars)`). */
  render(maxChars: number): string;
}

/**
 * Splits `budget` over items given in priority order. Items that fit their fair share get all
 * they need; the larger ones share the rest equally. If that share drops below an item's minimum,
 * the lowest-priority starved item is left out (0) and the rest are recomputed, so the first
 * items always win.
 */
export function allocate(items: readonly PackItem[], budget: number): number[] {
  const dropped = new Set<number>();
  for (;;) {
    const alloc = items.map(() => 0);
    const active = items.map((_, i) => i).filter((i) => !dropped.has(i));
    // Water-filling: smallest first, each takes min(need, equal share of what's left).
    const bySize = [...active].sort(
      (a, b) => (items[a]?.fullChars ?? 0) - (items[b]?.fullChars ?? 0) || a - b,
    );
    let left = budget;
    bySize.forEach((i, k) => {
      const fair = Math.floor(left / (bySize.length - k));
      const give = Math.min(items[i]?.fullChars ?? 0, Math.max(fair, 0));
      alloc[i] = give;
      left -= give;
    });
    const starved = active.filter((i) => {
      const item = items[i];
      return item !== undefined && (alloc[i] ?? 0) < Math.min(item.fullChars, item.minChars);
    });
    const victim = starved.at(-1);
    if (victim === undefined) return alloc;
    dropped.add(victim);
  }
}

/** Separator between sections in the rendered context. */
export const SECTION_SEPARATOR = '\n\n';

export interface PackResult {
  /** Rendered sections per tier, `undefined` where an item was left out. */
  rendered: (string | undefined)[][];
  /** Characters used, separators included. */
  usedChars: number;
}

/**
 * Packs tiers in priority order: a tier gets what earlier tiers left over. Every rendered section
 * is charged its separator, so the joined text never exceeds `budgetChars`.
 */
export function packTiers(
  tiers: readonly (readonly PackItem[])[],
  budgetChars: number,
): PackResult {
  const sep = SECTION_SEPARATOR.length;
  let left = budgetChars;
  const rendered = tiers.map((items) => {
    const charged = items.map((item) => ({
      fullChars: item.fullChars + sep,
      minChars: item.minChars + sep,
      render: item.render,
    }));
    const alloc = allocate(charged, left);
    return items.map((item, i) => {
      const a = alloc[i] ?? 0;
      if (a <= sep) return undefined;
      const text = item.render(a - sep);
      if (text.length === 0 || text.length > a - sep) return undefined;
      left -= text.length + sep;
      return text;
    });
  });
  return { rendered, usedChars: budgetChars - left };
}
