import * as z from 'zod';
import { Id, WorkspacePath } from './common.ts';

export const SearchReplace = z.strictObject({
  /** Exact text that must exist in the file when the edit is applied. Empty = create/insert at start. */
  search: z.string(),
  replace: z.string(),
});
export type SearchReplace = z.infer<typeof SearchReplace>;

export const FileEdit = z.strictObject({
  path: WorkspacePath,
  edits: z.array(SearchReplace).min(1),
});
export type FileEdit = z.infer<typeof FileEdit>;

/** Reviewer output from the critique workflow (COR-5, Beta). */
export const Critique = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  issues: z.array(z.string()),
  model: z.string().optional(),
});
export type Critique = z.infer<typeof Critique>;

export const EditProposal = z.object({
  id: Id,
  taskId: Id,
  files: z.array(FileEdit).min(1),
  critique: Critique.optional(),
});
export type EditProposal = z.infer<typeof EditProposal>;

export const FileApplyStatus = z.enum(['applied', 'rejected', 'stale']);
export type FileApplyStatus = z.infer<typeof FileApplyStatus>;

export const FileApplyResult = z.strictObject({
  path: WorkspacePath,
  status: FileApplyStatus,
  /** Optional user-provided reason for a rejection, forwarded to the model. */
  reason: z.string().max(2000).optional(),
});
export type FileApplyResult = z.infer<typeof FileApplyResult>;
