import { Id, WorkspacePath } from '@desiide/protocol';
import * as z from 'zod';

/**
 * Review state of edit proposals (UI-4). The event stream says what was proposed; only the host
 * knows what the user did with it, so it sends this alongside the transcript.
 */

export const FileReviewStatus = z.enum(['pending', 'applied', 'rejected', 'stale']);
export type FileReviewStatus = z.infer<typeof FileReviewStatus>;

export const ProposalReviewState = z.enum([
  /** Waiting for the user. */
  'pending',
  /** Accepted files are being written. */
  'applying',
  /** Reported to the orchestrator. */
  'done',
  /** The task ended before the user answered; nothing can be applied any more. */
  'expired',
]);
export type ProposalReviewState = z.infer<typeof ProposalReviewState>;

export const ProposalReview = z.object({
  taskId: Id,
  proposalId: Id,
  state: ProposalReviewState,
  files: z.array(z.object({ path: WorkspacePath, status: FileReviewStatus })),
  /** Why the last apply attempt failed (the proposal stays pending), shown on the card. */
  error: z.string().max(2000).optional(),
});
export type ProposalReview = z.infer<typeof ProposalReview>;

/** One per-file answer in a review submission. */
export const FileDecision = z.strictObject({ path: WorkspacePath, accept: z.boolean() });
export type FileDecision = z.infer<typeof FileDecision>;

/** The answer to a gated action (COR-2 `task.approve` scope `once` / `task`, or `task.reject`). */
export const ApprovalAnswer = z.enum(['once', 'task', 'reject']);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

export const reviewKey = (taskId: string, proposalId: string): string => `${taskId}/${proposalId}`;
