import type { ComponentChildren } from 'preact';
import { Codicon } from './Codicon.tsx';

export interface EmptyStateProps {
  icon: string;
  title: string;
  description?: ComponentChildren;
  action?: ComponentChildren;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div class="mutt-empty">
      <div class="mutt-empty__icon">
        <Codicon name={icon} />
      </div>
      <h2 class="mutt-empty__title">{title}</h2>
      {description && <p class="mutt-empty__description">{description}</p>}
      {action && <div class="mutt-empty__action">{action}</div>}
    </div>
  );
}
