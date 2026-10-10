import {
  TERMINAL_TASK_STATES,
  parseTaskEvent,
  type TaskEvent,
  type TaskSummary,
  type ToolCall,
  type ToolResult,
} from '@desiide/protocol';
import type {
  ApprovalResolution,
  AssistantItem,
  TaskMeta,
  TaskView,
  ToolStatus,
  TranscriptItem,
  TranscriptState,
} from './model.ts';

/** Where the reducer reports events it skips. Never throws. */
export interface ReduceLog {
  debug(message: string): void;
  warn(message: string): void;
}

const silent: ReduceLog = { debug() {}, warn() {} };

/** The user-message item's id; one per task. */
export const USER_ITEM_ID = 'user';

export function emptyTaskView(id: string, instruction = ''): TaskView {
  const view: TaskView = {
    meta: {
      id,
      instruction,
      state: 'queued',
      models: [],
      iteration: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    items: [],
    index: {},
    lastSeq: -1,
  };
  if (instruction) {
    view.items.push({ kind: 'user', id: USER_ITEM_ID, text: instruction });
    view.index[USER_ITEM_ID] = 0;
  }
  return view;
}

/**
 * Apply a batch of raw `task.event` payloads. Pure: returns a new state and leaves the input
 * untouched, copying each task, item list and item at most once per batch (cheap for the many
 * `text_delta`s in one animation frame). Unknown event types are ignored with a debug log (FND-2);
 * invalid payloads and out-of-order duplicates are dropped. `replay` marks a compacted log
 * (`compact.ts`) being replayed after a reload.
 */
export function applyEvents(
  state: TranscriptState,
  raws: readonly unknown[],
  log: ReduceLog = silent,
  opts: { replay?: boolean } = {},
): TranscriptState {
  if (raws.length === 0) return state;
  const batch = new Batch(state);
  for (const raw of raws) {
    const parsed = parseTaskEvent(raw);
    if (parsed.status === 'unknown') {
      log.debug(`Ignoring unknown task event type "${parsed.type}"`);
      continue;
    }
    if (parsed.status === 'invalid') {
      log.warn(`Dropped an invalid task event (${parsed.error.issues.length} issues)`);
      continue;
    }
    batch.apply(parsed.event, log, opts.replay === true);
  }
  return batch.result();
}

/**
 * Add a task, or refresh one from an authoritative `TaskSummary` (`task.create` / `task.list`).
 * Totals, models and iteration come from the summary; the state only when no event has been
 * applied yet or the summary says the task ended (events are the fresher source otherwise).
 */
export function upsertSummary(state: TranscriptState, summary: TaskSummary): TranscriptState {
  const batch = new Batch(state);
  const view = batch.task(summary.id, summary.instruction);
  const meta = view.meta;
  meta.kind = summary.kind;
  meta.createdAt = summary.createdAt;
  meta.updatedAt = summary.updatedAt;
  if (summary.workflow) meta.workflow = summary.workflow;
  if (summary.failureReason) meta.failureReason = summary.failureReason;
  for (const m of summary.models) if (!meta.models.includes(m)) meta.models = [...meta.models, m];
  meta.iteration = Math.max(meta.iteration, summary.iteration);
  if (
    summary.usage.inputTokens + summary.usage.outputTokens >=
    meta.usage.inputTokens + meta.usage.outputTokens
  ) {
    meta.usage = { ...summary.usage };
  }
  if (view.lastSeq < 0 || TERMINAL_TASK_STATES.includes(summary.state)) meta.state = summary.state;
  if (!meta.instruction && summary.instruction) {
    meta.instruction = summary.instruction;
    batch.insertUser(view, summary.instruction);
  }
  return batch.result();
}

/** Forget a task (e.g. pruned from the list). */
export function removeTask(state: TranscriptState, id: string): TranscriptState {
  if (!state.tasks[id]) return state;
  const tasks = Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id));
  return { tasks, order: state.order.filter((t) => t !== id) };
}

export const isTerminal = (view: TaskView): boolean =>
  TERMINAL_TASK_STATES.includes(view.meta.state);

/** The assistant item still receiving text: the last item, while the task hasn't ended. */
export function streamingItemId(view: TaskView): string | undefined {
  const last = view.items.at(-1);
  return last?.kind === 'assistant' && !isTerminal(view) ? last.id : undefined;
}

function toolStatus(result: ToolResult): ToolStatus {
  if (result.ok) return 'ok';
  return result.error?.kind ?? 'failed';
}

function resolution(result: ToolResult): ApprovalResolution | undefined {
  if (result.ok) return 'approved';
  switch (result.error?.kind) {
    case 'rejected':
      return 'rejected';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    default:
      // Approved, then failed while running.
      return 'approved';
  }
}

/** Copy-on-write over one batch. */
class Batch {
  private tasks: Record<string, TaskView> | undefined;
  private order: string[] | undefined;
  private readonly fresh = new Set<object>();

  constructor(private readonly base: TranscriptState) {}

  result(): TranscriptState {
    if (!this.tasks) return this.base;
    return { tasks: this.tasks, order: this.order ?? this.base.order };
  }

  /** A writable copy of the task, created if unknown. */
  task(id: string, instruction = ''): TaskView {
    const tasks = (this.tasks ??= { ...this.base.tasks });
    const existing = tasks[id];
    if (existing && this.fresh.has(existing)) return existing;
    let view: TaskView;
    if (existing) {
      view = {
        ...existing,
        meta: { ...existing.meta },
        items: [...existing.items],
        index: { ...existing.index },
      };
    } else {
      view = emptyTaskView(id, instruction);
      this.order = [...(this.order ?? this.base.order), id];
    }
    this.fresh.add(view);
    tasks[id] = view;
    return view;
  }

  insertUser(view: TaskView, text: string): void {
    if (view.index[USER_ITEM_ID] !== undefined) return;
    view.items.unshift({ kind: 'user', id: USER_ITEM_ID, text });
    view.index = Object.fromEntries(view.items.map((item, i) => [item.id, i]));
  }

  apply(event: TaskEvent, log: ReduceLog, replay: boolean): void {
    const current = this.tasks?.[event.taskId] ?? this.base.tasks[event.taskId];
    if (current && event.seq <= current.lastSeq) {
      log.debug(`Ignoring duplicate or out-of-order event ${event.taskId}#${event.seq}`);
      return;
    }
    const view = this.task(event.taskId);
    // A replayed log is compacted (merged deltas keep the last seq), so jumps are expected there.
    if (!replay && event.seq > view.lastSeq + 1) {
      log.debug(`Missing events before ${event.taskId}#${event.seq}`);
    }
    view.lastSeq = event.seq;
    view.meta.updatedAt = event.ts;
    if (event.type !== 'reasoning_delta') this.endReasoning(view, event.ts);

    switch (event.type) {
      case 'state_changed': {
        const { meta } = view;
        if (event.to === 'running' && meta.iteration === 0) meta.iteration = 1;
        else if (event.to === 'running' && event.from === 'verifying') meta.iteration++;
        if (event.from === 'awaiting_approval') this.resumeTools(view);
        meta.state = event.to;
        if (TERMINAL_TASK_STATES.includes(event.to)) {
          if (event.to === 'failed' && event.reason) meta.failureReason = event.reason;
          this.push(view, {
            kind: 'status',
            id: `status:${event.seq}`,
            state: event.to,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ts: event.ts,
          });
        }
        break;
      }
      case 'text_delta':
      case 'reasoning_delta': {
        const item = this.assistant(view, event.messageId, event.ts);
        if (event.type === 'text_delta') {
          item.text += event.delta;
        } else if (item.reasoning) {
          item.reasoning = { ...item.reasoning, text: item.reasoning.text + event.delta };
        } else {
          item.reasoning = { text: event.delta, startedAt: event.ts };
        }
        break;
      }
      case 'tool_call_started': {
        const existing = this.find(view, `tool:${event.call.id}`);
        if (existing?.kind === 'tool') {
          existing.call = event.call;
        } else {
          this.push(view, {
            kind: 'tool',
            id: `tool:${event.call.id}`,
            callId: event.call.id,
            call: event.call,
            status: 'running',
            startedAt: event.ts,
          });
        }
        this.resolveApproval(view, event.call.id, 'approved');
        break;
      }
      case 'tool_call_finished': {
        const { result } = event;
        const existing = this.find(view, `tool:${result.callId}`);
        if (existing?.kind === 'tool') {
          existing.result = result;
          existing.status = toolStatus(result);
        } else {
          // Refused before it ran (blocked / disallowed / rejected at approval).
          this.push(view, {
            kind: 'tool',
            id: `tool:${result.callId}`,
            callId: result.callId,
            ...this.approvedCall(view, result.callId),
            result,
            status: toolStatus(result),
            startedAt: event.ts,
          });
        }
        const resolved = resolution(result);
        if (resolved) this.resolveApproval(view, result.callId, resolved);
        break;
      }
      case 'edit_proposed':
        this.push(view, {
          kind: 'edit_proposal',
          id: `edit:${event.proposal.id}`,
          proposal: event.proposal,
          files: event.files,
        });
        break;
      case 'approval_required': {
        const tool = this.find(view, `tool:${event.call.id}`);
        if (tool?.kind === 'tool' && tool.status === 'running') tool.status = 'awaiting_approval';
        this.push(view, {
          kind: 'approval',
          id: `approval:${event.approvalId}`,
          approvalId: event.approvalId,
          call: event.call,
          reasons: event.reasons,
          paths: event.paths,
          ...(event.decisionId === undefined ? {} : { decisionId: event.decisionId }),
        });
        break;
      }
      case 'decision_made': {
        const { decision } = event;
        if (decision.workflow) view.meta.workflow = decision.workflow;
        const last = view.items.at(-1);
        const first = last?.kind === 'decision' ? last.decisions[0] : undefined;
        if (last && first?.pack === decision.pack && first.stateHash === decision.stateHash) {
          const item = this.find(view, last.id);
          if (item?.kind === 'decision') item.decisions = [...item.decisions, decision];
        } else {
          this.push(view, {
            kind: 'decision',
            id: `decision:${decision.id}`,
            decisions: [decision],
          });
        }
        break;
      }
      case 'usage': {
        const { meta } = view;
        if (!meta.models.includes(event.modelId)) meta.models = [...meta.models, event.modelId];
        const cost =
          meta.usage.costUsd === undefined && event.usage.costUsd === undefined
            ? undefined
            : (meta.usage.costUsd ?? 0) + (event.usage.costUsd ?? 0);
        meta.usage = {
          inputTokens: meta.usage.inputTokens + event.usage.inputTokens,
          outputTokens: meta.usage.outputTokens + event.usage.outputTokens,
          ...(cost === undefined ? {} : { costUsd: cost }),
        };
        break;
      }
      case 'error':
        this.push(view, {
          kind: 'error',
          id: `error:${event.seq}`,
          errorKind: event.kind,
          message: event.message,
          retryable: event.retryable,
          ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
          ts: event.ts,
        });
        break;
    }
  }

  private push(view: TaskView, item: TranscriptItem): void {
    if (view.index[item.id] !== undefined) return;
    view.index[item.id] = view.items.length;
    view.items.push(item);
    this.fresh.add(item);
  }

  /** A writable copy of the item with this id, if any. */
  private find(view: TaskView, id: string): TranscriptItem | undefined {
    const i = view.index[id];
    if (i === undefined) return undefined;
    const item = view.items[i];
    if (!item || this.fresh.has(item)) return item;
    const copy = { ...item };
    view.items[i] = copy;
    this.fresh.add(copy);
    return copy;
  }

  private assistant(view: TaskView, messageId: string, ts: string): AssistantItem {
    const id = `msg:${messageId}`;
    const existing = this.find(view, id);
    if (existing?.kind === 'assistant') return existing;
    const item: AssistantItem = { kind: 'assistant', id, messageId, text: '', startedAt: ts };
    this.push(view, item);
    return item;
  }

  /** Reasoning ends at the next event of the task, whatever it is. */
  private endReasoning(view: TaskView, ts: string): void {
    const last = view.items.at(-1);
    if (last?.kind !== 'assistant' || !last.reasoning || last.reasoning.endedAt) return;
    const item = this.find(view, last.id) as AssistantItem;
    item.reasoning = { ...last.reasoning, endedAt: ts };
  }

  /** The user answered: tools that waited for approval now run (or finish as rejected). */
  private resumeTools(view: TaskView): void {
    view.items.forEach((item) => {
      if (item.kind !== 'tool' || item.status !== 'awaiting_approval') return;
      const copy = this.find(view, item.id);
      if (copy?.kind === 'tool') copy.status = 'running';
    });
  }

  private approvedCall(view: TaskView, callId: string): { call?: ToolCall } {
    for (let i = view.items.length - 1; i >= 0; i--) {
      const item = view.items[i];
      if (item?.kind === 'approval' && item.call.id === callId) return { call: item.call };
    }
    return {};
  }

  private resolveApproval(view: TaskView, callId: string, to: ApprovalResolution): void {
    for (let i = view.items.length - 1; i >= 0; i--) {
      const item = view.items[i];
      if (item?.kind !== 'approval' || item.call.id !== callId) continue;
      if (item.resolution) return;
      const copy = this.find(view, item.id);
      if (copy?.kind === 'approval') copy.resolution = to;
      return;
    }
  }
}

/** Header numbers for a task. */
export function taskTotals(meta: TaskMeta): { tokens: number; costUsd?: number } {
  return {
    tokens: meta.usage.inputTokens + meta.usage.outputTokens,
    ...(meta.usage.costUsd === undefined ? {} : { costUsd: meta.usage.costUsd }),
  };
}
