import * as z from 'zod';
import { Range, WorkspacePath } from './common.ts';

export const ContextRef = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), path: WorkspacePath }),
  z.strictObject({ type: z.literal('folder'), path: WorkspacePath }),
  z.strictObject({ type: z.literal('selection'), path: WorkspacePath, range: Range }),
  z.strictObject({
    type: z.literal('diff'),
    scope: z.enum(['working', 'staged']),
    path: WorkspacePath.optional(),
  }),
]);
export type ContextRef = z.infer<typeof ContextRef>;

/** File metadata only, never contents (ADR-005). Built by COR-4, consumed by JEV-1 and UI-4. */
export const FileMeta = z.strictObject({
  path: WorkspacePath,
  sizeLines: z.int().nonnegative(),
  language: z.string().min(1).max(64),
  sensitive: z.boolean(),
});
export type FileMeta = z.infer<typeof FileMeta>;
