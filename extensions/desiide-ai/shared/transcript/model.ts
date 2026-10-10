import type {
  DecisionRecord,
  EditProposal,
  FileMeta,
  ReasonLabel,
  TaskKind,
  TaskState,
  ToolCall,
  ToolErrorKind,
  ToolResult,
  Usage,
  WorkflowOption,
} from '@desiide/protocol';

/**
 * The view model of one task's transcript, derived from its `task.event` stream by `reducer.ts`.
 * Plain data, never sent over the wire: both sides rebuild it from validated events.
 */

export interface TaskMeta {
  id: string;
  instruction: string;
  kind?: TaskKind;
  state: TaskState;
  workflow?: WorkflowOption;
  /** Model config ids used, in first-use order. */
  models: string[];
  /** Verify→fix attempts: 1 once running, +1 per return from `verifying` to `running`. */
  iteration: number;
  usage: Usage;
  createdAt?: string;
  updatedAt?: string;
  failureReason?: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}

export interface ReasoningBlock {
  text: string;
  startedAt: string;
  /** Set once anything else of the task arrives (the answer text, a tool call…). */
  endedAt?: string;
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  messageId: string;
  /** Markdown, as streamed so far. */
  text: string;
  /** ADR-022: shown collapsed above the answer, plain text. */
  reasoning?: ReasoningBlock;
  startedAt: string;
}

export type ToolStatus = 'running' | 'awaiting_approval' | 'ok' | 'failed' | ToolErrorKind;

export interface ToolItem {
  kind: 'tool';
  id: string;
  callId: string;
  /** Absent when the call never started (e.g. a disallowed tool, refused before running). */
  call?: ToolCall;
  result?: ToolResult;
  status: ToolStatus;
  startedAt: string;
}

/** Rendered by UI-4 (diff review); UI-3 shows a placeholder. */
export interface EditProposalItem {
  kind: 'edit_proposal';
  id: string;
  proposal: EditProposal;
  files: FileMeta[];
}

export type ApprovalResolution = 'approved' | 'rejected' | 'blocked' | 'cancelled';

/** Rendered by UI-4 (approval card); UI-3 shows a placeholder. */
export interface ApprovalItem {
  kind: 'approval';
  id: string;
  approvalId: string;
  call: ToolCall;
  reasons: ReasonLabel[];
  paths: string[];
  decisionId?: string;
  resolution?: ApprovalResolution;
}

/**
 * One gate or routing check: consecutive `decision_made` events of the same pack and state (a
 * risk_gate asks several questions about one action). Rendered by UI-5 (inline decision chip);
 * UI-3 shows a placeholder.
 */
export interface DecisionItem {
  kind: 'decision';
  id: string;
  decisions: DecisionRecord[];
}

export interface ErrorItem {
  kind: 'error';
  id: string;
  /** A `ModelErrorKind` or a task failure reason. */
  errorKind: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  ts: string;
}

/** The task ended (done / failed / cancelled). */
export interface StatusItem {
  kind: 'status';
  id: string;
  state: TaskState;
  reason?: string;
  ts: string;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | EditProposalItem
  | ApprovalItem
  | DecisionItem
  | ErrorItem
  | StatusItem;

export type TranscriptItemKind = TranscriptItem['kind'];

export interface TaskView {
  meta: TaskMeta;
  items: TranscriptItem[];
  /** Item id → position in `items`. */
  index: Record<string, number>;
  /** Highest `seq` applied; -1 before any event. */
  lastSeq: number;
}

export interface TranscriptState {
  tasks: Record<string, TaskView>;
  /** Task ids, oldest first. */
  order: string[];
}

export const EMPTY_TRANSCRIPT: TranscriptState = { tasks: {}, order: [] };
