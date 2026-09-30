import type { ComponentChildren } from 'preact';
import type { Tone } from './Badge.tsx';

export interface CardProps {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  tone?: Tone;
  children: ComponentChildren;
}

export function Card({ title, actions, tone = 'neutral', children }: CardProps) {
  return (
    <section class={`desiide-card desiide-card--${tone}`}>
      {(title || actions) && (
        <header class="desiide-card__header">
          <div class="desiide-card__title">{title}</div>
          {actions && <div class="desiide-card__actions">{actions}</div>}
        </header>
      )}
      <div class="desiide-card__body">{children}</div>
    </section>
  );
}
