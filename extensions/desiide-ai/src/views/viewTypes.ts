import type { ViewId } from '../../shared/messages.ts';

/** Contributed view ids; must match `contributes.views.desiide` in package.json (checked by a test). */
export const VIEW_TYPES: Record<ViewId, string> = {
  panel: 'desiide.panel',
  decisions: 'desiide.decisions',
};
