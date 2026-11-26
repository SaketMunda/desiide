import type { ComponentChildren, JSX } from 'preact';
import { Codicon } from './Codicon.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> {
  variant?: ButtonVariant;
  icon?: string;
  /** Breathe gently to say "this is waiting for you" (unanswered asks only). */
  nudge?: boolean;
  children: ComponentChildren;
}

export function Button({
  variant = 'primary',
  icon,
  nudge = false,
  children,
  type,
  ...rest
}: ButtonProps) {
  const cls = `desiide-button desiide-button--${variant}${nudge ? ' desiide-button--nudge' : ''}`;
  return (
    <button type={type ?? 'button'} class={cls} {...rest}>
      {icon && <Codicon name={icon} />}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> {
  icon: string;
  /** Required: icon-only buttons need an accessible name (STANDARDS: UX & accessibility). */
  label: string;
}

export function IconButton({ icon, label, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      class="desiide-icon-button"
      aria-label={label}
      title={label}
      {...rest}
    >
      <Codicon name={icon} />
    </button>
  );
}
