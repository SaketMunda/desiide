import { describeReason } from '@desiide/jev';
import {
  TERMINAL_TASK_STATES,
  type EditProposal,
  type FileApplyResult,
  type ReasonLabel,
  type TaskEvent,
  type ToolCall,
} from '@desiide/protocol';
import { applyBlocks } from '../../shared/review/blocks.ts';
import {
  reviewKey,
  type ApprovalAnswer,
  type FileDecision,
  type FileReviewStatus,
  type ProposalReview,
} from '../../shared/review/model.ts';

/** One file's new content. `before` null = the file doesn't exist yet (create it). */
export interface FileChange {
  path: string;
  before: string | null;
  after: string;
}

/** The editor side of applying edits; `vscodeWorkspace.ts` implements it with a WorkspaceEdit. */
export interface ReviewWorkspace {
  /** Current text per path: the open buffer when there is one (dirty or not), else disk. null = no file. */
  read(paths: readonly string[]): Promise<Map<string, string | null>>;
  /**
   * Apply every change as ONE edit (one undo step). A path whose text no longer equals `before` is
   * returned in `conflicts`, and then nothing is applied.
   */
  apply(
    changes: readonly FileChange[],
    label: string,
  ): Promise<{ applied: boolean; conflicts: string[] }>;
}

/** The orchestrator calls UI-4 makes (COR-2). */
export interface ReviewRpc {
  report(taskId: string, proposalId: string, files: FileApplyResult[]): Promise<void>;
  approve(taskId: string, approvalId: string, scope: 'once' | 'task'): Promise<void>;
  reject(taskId: string, approvalId: string, reason?: string): Promise<void>;
}

/** Something waiting for the user: drives the view badge, status bar and notification. */
export interface PendingItem {
  kind: 'approval' | 'review';
  taskId: string;
  /** `approvalId` or `proposalId`. */
  id: string;
  /** Short text for a notification, e.g. "Run `npm install`". */
  label: string;
}

export type Outcome = { ok: true } | { ok: false; error: string };

interface Proposal {
  review: ProposalReview;
  proposal: EditProposal;
}

interface Approval {
  taskId: string;
  approvalId: string;
  call: ToolCall;
  /** An answer is on its way; a second click is ignored. */
  answering: boolean;
}

export interface ReviewServiceOptions {
  workspace: ReviewWorkspace;
  rpc: ReviewRpc;
  describe?: (label: ReasonLabel) => string;
  /** Finished proposals kept for the cards (pending ones are always kept). */
  maxProposals?: number;
}

const MAX_PROPOSALS = 200;
/** A file can change between the read and the apply; re-plan this many times before calling it stale. */
const APPLY_ATTEMPTS = 2;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function actionLabel(call: ToolCall): string {
  const command = call.args['command'];
  if (call.tool === 'shell' && typeof command === 'string') {
    const one = command.replace(/\s+/g, ' ').trim();
    return `Run \`${one.length > 60 ? `${one.slice(0, 59)}…` : one}\``;
  }
  if (call.tool === 'run_tests') return 'Run the tests';
  if (call.tool === 'lint') return 'Run the linter';
  const path = call.args['path'];
  return typeof path === 'string' ? `${call.tool} ${path}` : call.tool;
}

/**
 * Host side of review & approval (UI-4), without `vscode`: follows the event stream for proposals
 * and gated actions, applies accepted files through `ReviewWorkspace` (re-validating every search
 * block against the current text), and reports each answer to the orchestrator.
 */
export class ReviewService {
  private readonly proposals = new Map<string, Proposal>();
  private readonly approvals = new Map<string, Approval>();
  private readonly reasonText = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly describe: (label: ReasonLabel) => string;
  private readonly maxProposals: number;

  constructor(private readonly opts: ReviewServiceOptions) {
    this.describe = opts.describe ?? describeReason;
    this.maxProposals = opts.maxProposals ?? MAX_PROPOSALS;
  }

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  onEvent(e: TaskEvent): void {
    switch (e.type) {
      case 'edit_proposed': {
        const key = reviewKey(e.taskId, e.proposal.id);
        if (this.proposals.has(key)) return;
        this.proposals.set(key, {
          proposal: e.proposal,
          review: {
            taskId: e.taskId,
            proposalId: e.proposal.id,
            state: 'pending',
            files: e.proposal.files.map((f) => ({ path: f.path, status: 'pending' })),
          },
        });
        this.prune();
        break;
      }
      case 'approval_required':
        this.addReasons(e.reasons);
        this.approvals.set(e.approvalId, {
          taskId: e.taskId,
          approvalId: e.approvalId,
          call: e.call,
          answering: false,
        });
        break;
      // `tool_call_started` comes before `approval_required` for the same call (UI-3), so only
      // the finish tells us the engine is done with an approval.
      case 'tool_call_finished':
        this.addReasons(e.result.error?.reasons ?? []);
        this.dropApproval(e.taskId, e.result.callId);
        break;
      case 'state_changed':
        if (!TERMINAL_TASK_STATES.includes(e.to)) return;
        for (const [id, a] of this.approvals) if (a.taskId === e.taskId) this.approvals.delete(id);
        for (const p of this.proposals.values()) {
          if (p.review.taskId === e.taskId && p.review.state === 'pending') {
            p.review = { ...p.review, state: 'expired' };
          }
        }
        break;
      default:
        return;
    }
    this.changed();
  }

  /** Every retained proposal's review state, oldest first. */
  state(): ProposalReview[] {
    return [...this.proposals.values()].map((p) => p.review);
  }

  reasons(): Record<string, string> {
    return Object.fromEntries(this.reasonText);
  }

  pending(): PendingItem[] {
    const items: PendingItem[] = [];
    for (const a of this.approvals.values()) {
      if (a.answering) continue;
      items.push({
        kind: 'approval',
        taskId: a.taskId,
        id: a.approvalId,
        label: actionLabel(a.call),
      });
    }
    for (const p of this.proposals.values()) {
      if (p.review.state !== 'pending') continue;
      const n = p.proposal.files.length;
      items.push({
        kind: 'review',
        taskId: p.review.taskId,
        id: p.review.proposalId,
        label: `Review ${n === 1 ? (p.proposal.files[0]?.path ?? 'an edit') : `edits to ${n} files`}`,
      });
    }
    return items;
  }

  /** The file as it would be after the proposal, for the diff editor. `stale`: the blocks no longer match. */
  async proposedText(
    taskId: string,
    proposalId: string,
    path: string,
  ): Promise<{ text: string; stale: boolean; exists: boolean } | undefined> {
    const file = this.proposals
      .get(reviewKey(taskId, proposalId))
      ?.proposal.files.find((f) => f.path === path);
    if (!file) return undefined;
    const current = (await this.opts.workspace.read([path])).get(path) ?? null;
    const result = applyBlocks(current, file.edits);
    return result.ok
      ? { text: result.text, stale: false, exists: current !== null }
      : { text: current ?? '', stale: true, exists: current !== null };
  }

  /**
   * Answer a proposal. Accepted files are re-validated against their current text and applied as
   * one edit; a file whose blocks no longer match is `stale` (the agent re-reads and proposes
   * again). Then every file's result goes to the orchestrator in one `edits.report`.
   */
  async submit(
    taskId: string,
    proposalId: string,
    decisions: readonly FileDecision[],
    reason?: string,
  ): Promise<Outcome> {
    const entry = this.proposals.get(reviewKey(taskId, proposalId));
    if (!entry) return { ok: false, error: 'That proposal is no longer available.' };
    if (entry.review.state === 'expired') {
      return {
        ok: false,
        error: 'The task ended before this was reviewed, so nothing was applied.',
      };
    }
    if (entry.review.state !== 'pending')
      return { ok: false, error: 'This proposal was already answered.' };
    const paths = entry.proposal.files.map((f) => f.path);
    const answered = new Map(decisions.map((d) => [d.path, d.accept]));
    if (answered.size !== paths.length || !paths.every((p) => answered.has(p))) {
      return { ok: false, error: 'Answer every file of the proposal.' };
    }

    this.update(entry, { state: 'applying' });
    const accepted = entry.proposal.files.filter((f) => answered.get(f.path) === true);
    let stale = new Set<string>();
    try {
      stale = await this.applyAccepted(accepted, taskId);
    } catch (err) {
      // Nothing was written (the edit is all or nothing): the user can try again.
      this.update(entry, { state: 'pending', error: `Couldn't apply the edits: ${message(err)}` });
      return { ok: false, error: `Couldn't apply the edits: ${message(err)}` };
    }

    const results: FileApplyResult[] = paths.map((path) => {
      if (answered.get(path) !== true) {
        return { path, status: 'rejected', ...(reason ? { reason } : {}) };
      }
      return { path, status: stale.has(path) ? 'stale' : 'applied' };
    });
    const status = new Map<string, FileReviewStatus>(results.map((r) => [r.path, r.status]));
    const review: ProposalReview = {
      taskId,
      proposalId,
      state: 'done',
      files: paths.map((path) => ({ path, status: status.get(path) ?? 'rejected' })),
    };
    try {
      await this.opts.rpc.report(taskId, proposalId, results);
    } catch (err) {
      const applied = results.some((r) => r.status === 'applied');
      const error = `Couldn't tell the agent: ${message(err)}${applied ? ' The applied changes stay (Undo reverts them).' : ''}`;
      entry.review = { ...review, error };
      this.changed();
      return { ok: false, error };
    }
    entry.review = review;
    this.changed();
    return { ok: true };
  }

  /** Approve once, allow for this task (exact match only, enforced by COR-2), or reject. */
  async answer(
    taskId: string,
    approvalId: string,
    answer: ApprovalAnswer,
    reason?: string,
  ): Promise<Outcome> {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.taskId !== taskId) {
      return { ok: false, error: 'That request is no longer waiting for an answer.' };
    }
    if (approval.answering) return { ok: true };
    approval.answering = true;
    this.changed();
    try {
      if (answer === 'reject') await this.opts.rpc.reject(taskId, approvalId, reason || undefined);
      else await this.opts.rpc.approve(taskId, approvalId, answer);
      return { ok: true };
    } catch (err) {
      approval.answering = false;
      this.changed();
      return { ok: false, error: `Couldn't send your answer: ${message(err)}` };
    }
  }

  /** Returns the paths that turned out stale. Throws when the editor refused the edit. */
  private async applyAccepted(files: EditProposal['files'], taskId: string): Promise<Set<string>> {
    const stale = new Set<string>();
    if (files.length === 0) return stale;
    for (let attempt = 1; ; attempt++) {
      const current = await this.opts.workspace.read(files.map((f) => f.path));
      const changes: FileChange[] = [];
      for (const file of files) {
        if (stale.has(file.path)) continue;
        const before = current.get(file.path) ?? null;
        const result = applyBlocks(before, file.edits);
        if (result.ok) changes.push({ path: file.path, before, after: result.text });
        else stale.add(file.path);
      }
      if (changes.length === 0) return stale;
      const outcome = await this.opts.workspace.apply(
        changes,
        `Desiide: apply edits (task ${taskId})`,
      );
      if (outcome.applied) return stale;
      if (outcome.conflicts.length === 0) throw new Error('the editor rejected the edit');
      // Someone typed between our read and the apply: re-read and re-validate.
      if (attempt >= APPLY_ATTEMPTS) {
        for (const path of outcome.conflicts) stale.add(path);
      }
    }
  }

  private dropApproval(taskId: string, callId: string): boolean {
    for (const [id, a] of this.approvals) {
      if (a.taskId === taskId && a.call.id === callId) {
        this.approvals.delete(id);
        return true;
      }
    }
    return false;
  }

  private addReasons(labels: readonly ReasonLabel[]): void {
    for (const label of labels) {
      if (!this.reasonText.has(label)) this.reasonText.set(label, this.describe(label));
    }
  }

  private update(entry: Proposal, patch: Partial<ProposalReview>): void {
    const next: ProposalReview = { ...entry.review, ...patch };
    if (!('error' in patch)) delete next.error;
    entry.review = next;
    this.changed();
  }

  private prune(): void {
    let excess = this.proposals.size - this.maxProposals;
    for (const [key, p] of this.proposals) {
      if (excess <= 0) break;
      if (p.review.state === 'pending' || p.review.state === 'applying') continue;
      this.proposals.delete(key);
      excess--;
    }
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
