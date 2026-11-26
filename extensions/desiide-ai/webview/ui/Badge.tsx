import type { ComponentChildren } from 'preact';

/**
 * The five state colors (ADR-023) plus neutral. Each state has two names that render the same:
 * done = auto (lime), decision = jev (violet), running = ai (cyan), needs = confirm (amber),
 * blocked = block (red).
 */
export type Tone =
  | 'neutral'
  | 'done'
  | 'decision'
  | 'running'
  | 'needs'
  | 'blocked'
  | 'ai'
  | 'jev'
  | 'auto'
  | 'confirm'
  | 'block';

export interface BadgeProps {
  tone?: Tone;
  children: ComponentChildren;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span class={`desiide-badge desiide-tone--${tone}`}>{children}</span>;
}
