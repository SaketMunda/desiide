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
    <section class={`mutt-card mutt-card--${tone}`}>
      {(title || actions) && (
        <header class="mutt-card__header">
          <div class="mutt-card__title">{title}</div>
          {actions && <div class="mutt-card__actions">{actions}</div>}
        </header>
      )}
      <div class="mutt-card__body">{children}</div>
    </section>
  );
}
