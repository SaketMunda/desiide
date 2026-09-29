import type { ComponentChildren } from 'preact';
import type { Tone } from './Badge.tsx';
import { Codicon } from './Codicon.tsx';

export interface ChipProps {
  tone?: Tone;
  icon?: string;
  onClick?: () => void;
  /** Accessible name when the chip is interactive and its text isn't descriptive enough. */
  label?: string;
  children: ComponentChildren;
}

export function Chip({ tone = 'neutral', icon, onClick, label, children }: ChipProps) {
  const content = (
    <>
      {icon && <Codicon name={icon} />}
      <span>{children}</span>
    </>
  );
  const cls = `mutt-chip mutt-tone--${tone}`;
  return onClick ? (
    <button type="button" class={`${cls} mutt-chip--button`} onClick={onClick} aria-label={label}>
      {content}
    </button>
  ) : (
    <span class={cls}>{content}</span>
  );
}
