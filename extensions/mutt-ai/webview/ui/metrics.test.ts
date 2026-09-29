import { describe, expect, it } from 'vitest';
import { clampScore, toPercent } from './metrics.ts';

describe('toPercent', () => {
  it.each([
    [0, 0],
    [0.054, 5],
    [0.5, 50],
    [1, 100],
    [1.2, 100],
    [-0.1, 0],
    [Number.NaN, 0],
  ])('%d → %d%%', (p, pct) => expect(toPercent(p)).toBe(pct));
});

describe('clampScore', () => {
  it.each([
    [0, 0],
    [3, 3],
    [2.6, 3],
    [7, 4],
    [-1, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('%d → %d', (s, out) => expect(clampScore(s)).toBe(out));
});
