/**
 * Subsequence fuzzy match for @-mentions, tuned for paths: a match in the file name beats one in
 * the directories, and consecutive or word-boundary matches beat scattered ones.
 * Returns `undefined` when `query` isn't a subsequence of `path` (case-insensitive).
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;

  // Prefer matching inside the file name: try it on its own first.
  const inName = matchFrom(q, p, path, nameStart);
  if (inName !== undefined) return inName + 100 - Math.min(path.length, 100) / 10;
  const anywhere = matchFrom(q, p, path, 0);
  return anywhere === undefined ? undefined : anywhere - Math.min(path.length, 100) / 10;
}

function matchFrom(q: string, lower: string, original: string, from: number): number | undefined {
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = from; i < lower.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;
    score += 1;
    if (i === prev + 1) score += 5;
    if (i === from || isBoundary(original, i)) score += 8;
    prev = i;
    qi++;
  }
  return qi === q.length ? score : undefined;
}

function isBoundary(s: string, i: number): boolean {
  const before = s[i - 1];
  if (before === undefined) return true;
  if ('/\\._- '.includes(before)) return true;
  // camelCase hump
  const c = s[i] ?? '';
  return before === before.toLowerCase() && c !== c.toLowerCase();
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Top `limit` items by score (ties keep input order). */
export function rankBy<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit: number,
): T[] {
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score !== undefined) ranked.push({ item, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map((r) => r.item);
}
