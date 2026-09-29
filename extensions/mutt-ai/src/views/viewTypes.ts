import type { ViewId } from '../../shared/messages.ts';

/** Contributed view ids; must match `contributes.views.mutt` in package.json (checked by a test). */
export const VIEW_TYPES: Record<ViewId, string> = {
  panel: 'mutt.panel',
  decisions: 'mutt.decisions',
};
