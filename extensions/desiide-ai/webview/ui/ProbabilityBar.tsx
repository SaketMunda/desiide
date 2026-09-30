import type { Tone } from './Badge.tsx';
import { toPercent } from './metrics.ts';

export interface ProbabilityBarProps {
  label: string;
  /** Probability in [0, 1]. */
  value: number;
  tone?: Tone;
}

export function ProbabilityBar({ label, value, tone = 'jev' }: ProbabilityBarProps) {
  const pct = toPercent(value);
  return (
    <div class="desiide-prob">
      <div class="desiide-prob__row">
        <span class="desiide-prob__label">{label}</span>
        <span class="desiide-prob__value">{pct}%</span>
      </div>
      <div
        class={`desiide-prob__track desiide-tone--${tone}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
      >
        <div class="desiide-prob__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
