import * as z from 'zod';
import { Id } from './common.ts';
import { ReasonLabel } from './reasons.ts';

export const ToolName = z.enum([
  'read_file',
  'list_files',
  'search',
  'propose_edit',
  'shell',
  'run_tests',
  'lint',
  'git_read',
]);
export type ToolName = z.infer<typeof ToolName>;

export const SideEffect = z.enum(['none', 'workspace', 'external']);
export type SideEffect = z.infer<typeof SideEffect>;

export const ToolCall = z.strictObject({
  id: Id,
  tool: ToolName,
  /** Validated per tool by COR-3's `argsSchema`; opaque at the protocol layer. */
  args: z.record(z.string(), z.unknown()),
  sideEffect: SideEffect,
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolErrorKind = z.enum([
  'blocked',
  'rejected',
  'invalid_args',
  'timeout',
  'cancelled',
  'failed',
]);
export type ToolErrorKind = z.infer<typeof ToolErrorKind>;

export const ToolResult = z.object({
  callId: Id,
  ok: z.boolean(),
  /** Output tail, already capped by the tool runner. */
  output: z.string(),
  truncated: z.boolean().default(false),
  exitCode: z.int().optional(),
  durationMs: z.int().nonnegative(),
  error: z
    .object({
      kind: ToolErrorKind,
      message: z.string(),
      reasons: z.array(ReasonLabel).default([]),
    })
    .optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;
