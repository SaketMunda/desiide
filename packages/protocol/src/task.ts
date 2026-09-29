import { z } from 'zod';
import { Id, IsoDateTime, WorkspacePath } from './common.ts';
import { ContextRef } from './context.ts';
import { ToolName } from './tools.ts';

export const TaskKind = z.enum([
  'autocomplete',
  'refactor',
  'bug_fix',
  'test_write',
  'infra_change',
  'explain',
  'other',
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const Preference = z.enum(['cheap', 'balance', 'quality']);
export type Preference = z.infer<typeof Preference>;

/** The routing options Jev's workflow_select chooses between. */
export const WorkflowOption = z.enum([
  'local-single',
  'cloud-single',
  'local-cloud-cascade',
  'cloud-with-critique',
]);
export type WorkflowOption = z.infer<typeof WorkflowOption>;

export const TaskContext = z.strictObject({
  refs: z.array(ContextRef).default([]),
  /** Open editor paths, most recently used first. */
  openEditors: z.array(WorkspacePath).default([]),
  /** Test files the user pointed at, if any. */
  tests: z.array(WorkspacePath).default([]),
});
export type TaskContext = z.infer<typeof TaskContext>;
export type TaskContextInput = z.input<typeof TaskContext>;

export const SuccessCriteria = z.strictObject({
  testsPass: z.boolean().optional(),
  lintClean: z.boolean().optional(),
  userApproval: z.boolean().default(true),
});
export type SuccessCriteria = z.infer<typeof SuccessCriteria>;

export const DEFAULT_BUDGET = {
  maxIterations: 8,
  maxToolCalls: 40,
  maxTokens: 200_000,
  wallClockMs: 600_000,
} as const;

export const Budget = z.strictObject({
  maxIterations: z.int().positive().default(DEFAULT_BUDGET.maxIterations),
  maxToolCalls: z.int().positive().default(DEFAULT_BUDGET.maxToolCalls),
  maxTokens: z.int().positive().default(DEFAULT_BUDGET.maxTokens),
  wallClockMs: z.int().positive().default(DEFAULT_BUDGET.wallClockMs),
});
export type Budget = z.infer<typeof Budget>;

export const DEFAULT_ALLOWED_TOOLS: readonly ToolName[] = [
  'read_file',
  'list_files',
  'search',
  'propose_edit',
  'git_read',
];

const taskFields = {
  kind: TaskKind,
  instruction: z.string().trim().min(1).max(20_000),
  context: TaskContext.prefault({}),
  allowedTools: z
    .array(ToolName)
    .min(1)
    .default(() => [...DEFAULT_ALLOWED_TOOLS]),
  success: SuccessCriteria.prefault({}),
  budget: Budget.prefault({}),
  preference: Preference.default('balance'),
  workflowOverride: WorkflowOption.optional(),
};

/** `task.create` params: the extension omits `id`; the orchestrator assigns it. */
export const TaskInput = z.strictObject(taskFields);
export type TaskInput = z.infer<typeof TaskInput>;
/** What a client may send (defaults not yet applied). */
export type TaskInputRaw = z.input<typeof TaskInput>;

export const Task = z.strictObject({ id: Id, ...taskFields });
export type Task = z.infer<typeof Task>;

export const TaskState = z.enum([
  'queued',
  'planning',
  'running',
  'awaiting_approval',
  'verifying',
  'done',
  'failed',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled'];

export const Usage = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** Estimate; absent when the model has no configured cost. */
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const TaskSummary = z.object({
  id: Id,
  kind: TaskKind,
  instruction: z.string(),
  state: TaskState,
  workflow: WorkflowOption.optional(),
  /** Model config ids used so far, in order. */
  models: z.array(Id).default([]),
  iteration: z.int().nonnegative(),
  usage: Usage,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Structured failure reason for `failed`, e.g. `loop_detected`, `budget:maxIterations`. */
  failureReason: z.string().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;
