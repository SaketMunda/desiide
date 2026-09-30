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
    <div class="desiide-empty">
      <div class="desiide-empty__icon">
        <Codicon name={icon} />
      </div>
      <h2 class="desiide-empty__title">{title}</h2>
      {description && <p class="desiide-empty__description">{description}</p>}
      {action && <div class="desiide-empty__action">{action}</div>}
    </div>
  );
}
