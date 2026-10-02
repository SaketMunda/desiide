import type { ChoiceResult, NoulResult, ScoreResult } from '../types.ts';

/** A rule's answer plus the labels that explain it. */
export interface Ruled<R> {
  result: R;
  rationale: string[];
}

/**
 * Fixed per-rule probabilities, so the UI looks the same as with Jev. `pYes` is the
 * probability the answer is "yes"; `unknown` answers sit in the middle by construction.
 */
export function noul(answer: NoulResult['answer'], pYes: number, ...rationale: string[]) {
  return { result: { kind: 'noul', answer, pYes }, rationale } satisfies Ruled<NoulResult>;
}

/** 0.8 on the chosen score, the rest spread evenly over the other four. */
export function score(value: number, ...rationale: string[]): Ruled<ScoreResult> {
  const s = Math.max(0, Math.min(4, Math.round(value)));
  const probs = [0, 1, 2, 3, 4].map((i) => (i === s ? 0.8 : 0.05));
  return { result: { kind: 'score', score: s, probs }, rationale };
}

/** `confidence` on the selection, the remainder spread evenly over the other options. */
export function choice(
  selected: string,
  options: readonly string[],
  confidence: number,
  ...rationale: string[]
): Ruled<ChoiceResult> {
  const others = options.filter((o) => o !== selected);
  const pSelected = others.length === 0 ? 1 : confidence;
  const rest = others.length === 0 ? 0 : (1 - confidence) / others.length;
  const probs: Record<string, number> = {};
  for (const o of options) probs[o] = o === selected ? pSelected : rest;
  return { result: { kind: 'choice', selected, probs }, rationale };
}
