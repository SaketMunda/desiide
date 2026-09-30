import { MAX_SCORE, clampScore } from './metrics.ts';

export interface ScoreDotsProps {
  label: string;
  /** Ordinal 0–4. */
  score: number;
}

export function ScoreDots({ label, score }: ScoreDotsProps) {
  const s = clampScore(score);
  return (
    <span class="desiide-score" role="img" aria-label={`${label}: ${s} of ${MAX_SCORE}`}>
      {Array.from({ length: MAX_SCORE }, (_, i) => (
        <span key={i} class={`desiide-score__dot${i < s ? ' desiide-score__dot--on' : ''}`} />
      ))}
    </span>
  );
}
