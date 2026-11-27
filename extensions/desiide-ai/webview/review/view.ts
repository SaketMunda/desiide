import type { Critique, DecisionRecord, ReasonLabel, ToolCall } from '@desiide/protocol';
import { editStats } from '../../shared/review/blocks.ts';
import type {
  ApprovalAnswer,
  FileReviewStatus,
  ProposalReview,
  ProposalReviewState,
} from '../../shared/review/model.ts';
import type {
  ApprovalItem,
  EditProposalItem,
  TaskView,
  ToolItem,
} from '../../shared/transcript/model.ts';

/**
 * View models of the review & approval cards (UI-4). Pure, so what a card offers (above all: a
 * blocked action offers nothing to click) is tested here, not only in the markup.
 */

export interface ReasonView {
  label: ReasonLabel;
  text: string;
}

/** Host-translated text (JEV-2 `describeReason`), else a generic rendering of the label. */
export function reasonViews(
  labels: readonly ReasonLabel[],
  texts: Readonly<Record<string, string>>,
): ReasonView[] {
  return labels.map((label) => ({
    label,
    text: Object.hasOwn(texts, label) ? (texts[label] ?? label) : label.replace(/[_:]/g, ' '),
  }));
}

const TOOL_TITLES: Record<string, string> = {
  shell: 'Run a command',
  run_tests: 'Run the tests',
  lint: 'Run the linter',
  read_file: 'Read a file',
  list_files: 'List files',
  search: 'Search the workspace',
  git_read: 'Read git history',
  propose_edit: 'Propose an edit',
};

/** The action in full: the exact command for shell, else the call's arguments. */
export function actionText(call: ToolCall | undefined): string {
  if (!call) return '';
  const command = call.args['command'];
  if (call.tool === 'shell' && typeof command === 'string') return command;
  const path = call.args['path'];
  if (typeof path === 'string' && Object.keys(call.args).length === 1) return path;
  const args = Object.keys(call.args).length > 0 ? ` ${JSON.stringify(call.args)}` : '';
  return `${call.tool}${args}`;
}

function cwdOf(call: ToolCall | undefined): string {
  const cwd = call?.args['cwd'];
  return typeof cwd === 'string' && cwd !== '' && cwd !== '.' ? cwd : 'workspace root';
}

export type ApprovalStatus = 'waiting' | 'sending' | NonNullable<ApprovalItem['resolution']>;

export interface ApprovalCardView {
  title: string;
  command: string;
  cwd: string;
  outcome: 'confirm';
  reasons: ReasonView[];
  /** The gate's decision records (UI-5 shows the full decision). */
  decisions: DecisionRecord[];
  decisionId?: string;
  actions: ApprovalAnswer[];
  status: ApprovalStatus;
}

/** Every decision record of the check that produced `decisionId`. */
export function decisionsFor(
  view: TaskView | undefined,
  decisionId: string | undefined,
): DecisionRecord[] {
  if (!view || !decisionId) return [];
  for (const item of view.items) {
    if (item.kind === 'decision' && item.decisions.some((d) => d.id === decisionId)) {
      return item.decisions;
    }
  }
  return [];
}

export function approvalCardView(
  item: ApprovalItem,
  ctx: {
    live: boolean;
    reasons: Readonly<Record<string, string>>;
    view?: TaskView;
    sent?: ApprovalAnswer;
  },
): ApprovalCardView {
  let status: ApprovalStatus = item.resolution ?? (ctx.sent ? 'sending' : 'waiting');
  // A task that ended while asking: the question is gone.
  if (status === 'waiting' && !ctx.live) status = 'cancelled';
  return {
    title: TOOL_TITLES[item.call.tool] ?? item.call.tool,
    command: actionText(item.call),
    cwd: cwdOf(item.call),
    outcome: 'confirm',
    reasons: reasonViews(item.reasons, ctx.reasons),
    decisions: decisionsFor(ctx.view, item.decisionId),
    ...(item.decisionId === undefined ? {} : { decisionId: item.decisionId }),
    actions: status === 'waiting' ? ['once', 'task', 'reject'] : [],
    status,
  };
}

export interface BlockedCardView {
  title: string;
  command: string;
  reasons: ReasonView[];
  message: string;
  /** Always empty: blocked actions can't be overridden in Alpha. */
  actions: readonly never[];
}

/** A blocked tool call (deny-list, a disallowed tool…); null for any other tool card. */
export function blockedCardView(
  item: ToolItem,
  reasons: Readonly<Record<string, string>>,
): BlockedCardView | null {
  if (item.status !== 'blocked') return null;
  return {
    title: TOOL_TITLES[item.call?.tool ?? ''] ?? item.call?.tool ?? 'Action',
    command: actionText(item.call),
    reasons: reasonViews(item.result?.error?.reasons ?? [], reasons),
    message: item.result?.error?.message ?? 'Blocked by policy.',
    actions: [],
  };
}

export interface ProposalFileView {
  path: string;
  added: number;
  removed: number;
  sensitive: boolean;
  status: FileReviewStatus;
}

export interface ProposalCardView {
  files: ProposalFileView[];
  added: number;
  removed: number;
  critique?: Critique;
  state: ProposalReviewState;
  /** The user can still accept or reject files. */
  canAnswer: boolean;
  error?: string;
}

export function proposalCardView(
  item: EditProposalItem,
  review: ProposalReview | undefined,
  live: boolean,
): ProposalCardView {
  const sensitive = new Set(item.files.filter((f) => f.sensitive).map((f) => f.path));
  const status = new Map(review?.files.map((f) => [f.path, f.status]));
  // No review state yet (it follows the event by a message) means pending; a finished task can't
  // take an answer any more.
  const state: ProposalReviewState = review?.state ?? (live ? 'pending' : 'expired');
  const files = item.proposal.files.map((f) => {
    const stats = editStats(f);
    return {
      path: f.path,
      ...stats,
      sensitive: sensitive.has(f.path),
      status: status.get(f.path) ?? 'pending',
    };
  });
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    ...(item.proposal.critique ? { critique: item.proposal.critique } : {}),
    state,
    canAnswer: state === 'pending' && live,
    ...(review?.error ? { error: review.error } : {}),
  };
}

/** The primary button's label for the current selection. */
export function applyLabel(accepted: number, total: number): string {
  if (accepted === total) return total === 1 ? 'Accept' : 'Accept all';
  if (accepted === 0) return 'Reject all';
  return `Apply ${accepted} of ${total}`;
}

/**
 * Card keyboard (UI-4): Cmd/Ctrl+Enter approves the focused card, Esc or Backspace rejects. Keys
 * pressed in a text field (the reject reason) belong to the field.
 */
export function cardKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  inField: boolean;
}): 'approve' | 'reject' | null {
  if (e.inField) return null;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return 'approve';
  if (e.key === 'Escape' || e.key === 'Backspace') return 'reject';
  return null;
}

/**
 * True when an approval card of the task shows this decision check itself (its probability chip),
 * so the transcript's standalone decision row would repeat it.
 */
export function shownByApproval(
  view: TaskView | undefined,
  decisionIds: readonly string[],
): boolean {
  if (!view) return false;
  return view.items.some(
    (item) =>
      item.kind === 'approval' &&
      item.decisionId !== undefined &&
      decisionIds.includes(item.decisionId),
  );
}
