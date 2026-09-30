import type { ComponentChildren } from 'preact';

export type Tone = 'neutral' | 'ai' | 'jev' | 'auto' | 'confirm' | 'block';

export interface BadgeProps {
  tone?: Tone;
  children: ComponentChildren;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span class={`desiide-badge desiide-tone--${tone}`}>{children}</span>;
}
