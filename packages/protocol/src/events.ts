import * as z from 'zod';
import { Id, IsoDateTime, WorkspacePath } from './common.ts';
import { FileMeta } from './context.ts';
import { EditProposal } from './edits.ts';
import { DecisionRecord } from './jev.ts';
import { ModelErrorKind } from './models.ts';
import { PolicyOutcome, ReasonLabel } from './reasons.ts';
import { TaskState, Usage } from './task.ts';
import { ToolCall, ToolResult } from './tools.ts';

/**
 * Event payloads are tolerant (plain `z.object`, unknown fields stripped) so the orchestrator can
 * add fields without breaking older clients. Unknown event *types* are surfaced by
 * `parseTaskEvent` for the client to ignore.
 */
const envelope = {
  taskId: Id,
  /** Monotonic per task, starting at 0. Lets clients detect gaps and order events. */
  seq: z.int().nonnegative(),
  ts: IsoDateTime,
};

export const StateChangedEvent = z.object({
  ...envelope,
  type: z.literal('state_changed'),
  from: TaskState.nullable(),
  to: TaskState,
  reason: z.string().optional(),
});

export const TextDeltaEvent = z.object({
  ...envelope,
  type: z.literal('text_delta'),
  messageId: Id,
  delta: z.string(),
});

export const ToolCallStartedEvent = z.object({
  ...envelope,
  type: z.literal('tool_call_started'),
  call: ToolCall,
});

export const ToolCallFinishedEvent = z.object({
  ...envelope,
  type: z.literal('tool_call_finished'),
  result: ToolResult,
});

export const EditProposedEvent = z.object({
  ...envelope,
  type: z.literal('edit_proposed'),
  proposal: EditProposal,
  /** Metadata for the files in the proposal (e.g. `sensitive` flag for UI-4). */
  files: z.array(FileMeta).default([]),
});

export const ApprovalRequiredEvent = z.object({
  ...envelope,
  type: z.literal('approval_required'),
  approvalId: Id,
  call: ToolCall,
  /** Always `confirm` today; blocked calls finish with a `blocked` tool error instead. */
  outcome: PolicyOutcome.extract(['confirm']),
  reasons: z.array(ReasonLabel),
  decisionId: Id.optional(),
  /** Paths the action touches, when known. */
  paths: z.array(WorkspacePath).default([]),
});

export const DecisionMadeEvent = z.object({
  ...envelope,
  type: z.literal('decision_made'),
  decision: DecisionRecord,
});

export const UsageEvent = z.object({
  ...envelope,
  type: z.literal('usage'),
  modelId: Id,
  usage: Usage,
});

export const ErrorEvent = z.object({
  ...envelope,
  type: z.literal('error'),
  kind: z.union([ModelErrorKind, z.string().min(1)]),
  message: z.string(),
  retryable: z.boolean().default(false),
  retryAfterMs: z.int().nonnegative().optional(),
});

export const TaskEvent = z.discriminatedUnion('type', [
  StateChangedEvent,
  TextDeltaEvent,
  ToolCallStartedEvent,
  ToolCallFinishedEvent,
  EditProposedEvent,
  ApprovalRequiredEvent,
  DecisionMadeEvent,
  UsageEvent,
  ErrorEvent,
]);
export type TaskEvent = z.infer<typeof TaskEvent>;
export type TaskEventType = TaskEvent['type'];

export const TASK_EVENT_TYPES = TaskEvent.options.map((o) => o.shape.type.value);

export type ParsedTaskEvent =
  | { status: 'known'; event: TaskEvent }
  | { status: 'unknown'; type: string }
  | { status: 'invalid'; error: z.ZodError };

/** Parse a `task.event` payload. Unknown `type`s are not errors: callers log and ignore them. */
export function parseTaskEvent(raw: unknown): ParsedTaskEvent {
  const head = z.object({ type: z.string() }).safeParse(raw);
  if (head.success && !(TASK_EVENT_TYPES as readonly string[]).includes(head.data.type)) {
    return { status: 'unknown', type: head.data.type };
  }
  const parsed = TaskEvent.safeParse(raw);
  return parsed.success
    ? { status: 'known', event: parsed.data }
    : { status: 'invalid', error: parsed.error };
}

export const LogNotification = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  ts: IsoDateTime,
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type LogNotification = z.infer<typeof LogNotification>;
