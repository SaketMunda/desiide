import { ITEM_RENDERERS, ToolCard } from '../transcript/items.tsx';
import { ApprovalCard, EditReviewCard, makeToolRenderer } from './cards.tsx';

/** UI-4 fills the transcript's review slots (UI-3 `ITEM_RENDERERS`). Imported once by the stream. */
ITEM_RENDERERS.approval = ApprovalCard;
ITEM_RENDERERS.edit_proposal = EditReviewCard;
ITEM_RENDERERS.tool = makeToolRenderer(ToolCard);
