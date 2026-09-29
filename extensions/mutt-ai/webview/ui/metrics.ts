/** Probability in [0, 1] → integer percent, clamped. NaN renders as 0. */
export function toPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(1, Math.max(0, p)) * 100);
}

export const MAX_SCORE = 4;

/** Jev scores are ordinal 0–4; out-of-range or fractional input is clamped and rounded. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(MAX_SCORE, Math.max(0, Math.round(score)));
}
