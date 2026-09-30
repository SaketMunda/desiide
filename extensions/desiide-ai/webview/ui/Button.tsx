import type { ComponentChildren, JSX } from 'preact';
import { Codicon } from './Codicon.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> {
  variant?: ButtonVariant;
  icon?: string;
  children: ComponentChildren;
}

export function Button({ variant = 'primary', icon, children, type, ...rest }: ButtonProps) {
  return (
    <button type={type ?? 'button'} class={`desiide-button desiide-button--${variant}`} {...rest}>
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
