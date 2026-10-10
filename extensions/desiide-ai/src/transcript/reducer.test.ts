import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskEvent, TaskSummary } from '@desiide/protocol';
import { describe, expect, it, vi } from 'vitest';
import { appendCompacted } from '../../shared/transcript/compact.ts';
import {
  EMPTY_TRANSCRIPT,
  type TaskView,
  type TranscriptState,
} from '../../shared/transcript/model.ts';
import {
  applyEvents,
  removeTask,
  streamingItemId,
  upsertSummary,
  USER_ITEM_ID,
} from '../../shared/transcript/reducer.ts';

// Fixtures are recorded from the real orchestrator by `src/transcript/record.test.ts`.
interface Recording {
  summary: TaskSummary;
  events: TaskEvent[];
}
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../shared/transcript/fixtures', `${name}.json`),
      'utf8',
    ),
  );
const happy = fixture('happy');
const escalation = fixture('escalation');
const failure = fixture('failure');
const cancel = fixture('cancel');
const rec = (r: unknown) => r as Recording;

function run(r: Recording, events = r.events): TaskView {
  const state = applyEvents(upsertSummary(EMPTY_TRANSCRIPT, r.summary), events);
  const view = state.tasks[r.summary.id];
  if (!view) throw new Error('task missing');
  return view;
}

const kinds = (view: TaskView) => view.items.map((i) => i.kind);

/** One event per batch, the way a slow stream arrives. */
function oneByOne(r: Recording): TaskView {
  let state = upsertSummary(EMPTY_TRANSCRIPT, r.summary);
  for (const e of r.events) state = applyEvents(state, [e]);
  return state.tasks[r.summary.id] as TaskView;
}

describe('recorded sequences (AC1)', () => {
  it('happy path: reasoning, read, edit proposal, answer → done', () => {
    const view = run(rec(happy));
    expect(kinds(view)).toEqual([
      'user',
      'assistant',
      'tool',
      'decision',
      'assistant',
      'tool',
      'decision',
      'edit_proposal',
      'assistant',
      'status',
    ]);
    const [user, first, read, , second, edit, decision, proposal, last, status] = view.items;
    expect(user).toMatchObject({ id: USER_ITEM_ID, text: 'Fix the bug in add() in src/a.ts' });
    expect(first).toMatchObject({
      text: "I'll look at `src/a.ts` first.",
      reasoning: {
        text: 'The user says `add` is wrong. I should read src/a.ts first.',
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      },
    });
    expect(read).toMatchObject({ status: 'ok', call: { tool: 'read_file' }, result: { ok: true } });
    expect(second).toMatchObject({ text: expect.stringContaining('```ts\n') });
    expect(edit).toMatchObject({ status: 'ok', call: { tool: 'propose_edit' } });
    // The three risk_gate questions about one action are one item.
    expect(decision).toMatchObject({ kind: 'decision' });
    expect(decision?.kind === 'decision' && decision.decisions).toHaveLength(3);
    expect(proposal).toMatchObject({ proposal: { files: [{ path: 'src/a.ts' }] } });
    expect(last).toMatchObject({ text: 'Fixed: `add` now returns `a + b`.' });
    expect(last && 'reasoning' in last).toBe(false);
    expect(status).toMatchObject({ state: 'done' });
    expect(view.meta).toMatchObject({
      state: 'done',
      kind: 'bug_fix',
      models: ['qwen-local'],
      iteration: 1,
      usage: { inputTokens: 3600, outputTokens: 255 },
    });
    expect(view.meta.usage.costUsd).toBeCloseTo(0.000616 * 3, 9);
    expect(streamingItemId(view)).toBeUndefined();
  });

  it('escalation: tools wait for approval; one approved, one rejected', () => {
    const r = rec(escalation);
    const waiting = run(
      r,
      r.events.filter((e) => e.seq <= 10),
    );
    expect(waiting.meta.state).toBe('awaiting_approval');
    const rm = waiting.items.find((i) => i.kind === 'tool');
    expect(rm).toMatchObject({
      status: 'awaiting_approval',
      call: { args: { command: 'rm -rf dist' } },
    });
    expect(waiting.items.at(-1)).toMatchObject({
      kind: 'approval',
      reasons: ['not_safe_now', 'irreversible', 'destructive_action'],
    });
    expect(waiting.items.at(-1)).not.toHaveProperty('resolution');

    const resumed = run(
      r,
      r.events.filter((e) => e.seq <= 11),
    );
    expect(resumed.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'running' });

    const view = run(r);
    const approvals = view.items.filter((i) => i.kind === 'approval');
    expect(approvals.map((a) => a.kind === 'approval' && a.resolution)).toEqual([
      'approved',
      'rejected',
    ]);
    const tools = view.items.filter((i) => i.kind === 'tool');
    expect(tools.map((t) => t.kind === 'tool' && t.status)).toEqual(['ok', 'rejected']);
    expect(tools[1]).toMatchObject({
      result: { output: 'User rejected this shell call: not now' },
    });
    expect(view.items.filter((i) => i.kind === 'decision')).toHaveLength(2);
    expect(view.meta).toMatchObject({ state: 'done', iteration: 1 });
  });

  it('failure: the model error becomes an error item, then failed', () => {
    const view = run(rec(failure));
    expect(kinds(view)).toEqual(['user', 'error', 'status']);
    expect(view.items[1]).toMatchObject({
      errorKind: 'auth',
      retryable: false,
      message: expect.stringContaining('Check the API key'),
    });
    expect(view.items[2]).toMatchObject({ state: 'failed', reason: 'model_error:auth' });
    expect(view.meta).toMatchObject({ state: 'failed', failureReason: 'model_error:auth' });
  });

  it('cancel: the partial answer stays, streaming stops', () => {
    const r = rec(cancel);
    const mid = run(
      r,
      r.events.filter((e) => e.seq <= 6),
    );
    expect(streamingItemId(mid)).toBe(mid.items.at(-1)?.id);
    expect(mid.items.at(-1)).toMatchObject({
      text: 'Here is a long ',
      reasoning: { text: 'Thinking about the whole module.', endedAt: expect.any(String) },
    });

    const view = run(r);
    expect(kinds(view)).toEqual(['user', 'assistant', 'status']);
    expect(view.items[1]).toMatchObject({ text: 'Here is a long explanation' });
    expect(view.items[2]).toMatchObject({ state: 'cancelled' });
    expect(streamingItemId(view)).toBeUndefined();
  });

  it.each([
    ['happy', happy],
    ['escalation', escalation],
    ['failure', failure],
    ['cancel', cancel],
  ])('%s: one batch, one event at a time, and a compacted replay agree', (_, raw) => {
    const r = rec(raw);
    const whole = run(r);
    expect(oneByOne(r)).toEqual(whole);
    const compacted: TaskEvent[] = [];
    for (const e of r.events) appendCompacted(compacted, e);
    const replayed = applyEvents(upsertSummary(EMPTY_TRANSCRIPT, r.summary), compacted, undefined, {
      replay: true,
    }).tasks[r.summary.id];
    expect(replayed).toEqual(whole);
  });
});

describe('robustness', () => {
  const r = rec(happy);
  const id = r.summary.id;

  it('ignores unknown event types with a debug log (AC3)', () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const future = { taskId: id, seq: 3, ts: r.events[0]?.ts, type: 'plan_updated', steps: [] };
    const state = applyEvents(
      upsertSummary(EMPTY_TRANSCRIPT, r.summary),
      [...r.events.slice(0, 3), future, ...r.events.slice(3)],
      log,
    );
    expect(state.tasks[id]).toEqual(run(r));
    expect(log.debug).toHaveBeenCalledWith('Ignoring unknown task event type "plan_updated"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops invalid payloads with a warning and keeps going', () => {
    const log = { debug: vi.fn(), warn: vi.fn() };
    const state = applyEvents(
      upsertSummary(EMPTY_TRANSCRIPT, r.summary),
      [null, 42, { type: 'text_delta', taskId: id }, ...r.events],
      log,
    );
    expect(state.tasks[id]).toEqual(run(r));
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('drops duplicate and out-of-order events', () => {
    const doubled = r.events.flatMap((e) => [e, e]);
    expect(run(r, doubled)).toEqual(run(r));
    const log = { debug: vi.fn(), warn: vi.fn() };
    applyEvents(upsertSummary(EMPTY_TRANSCRIPT, r.summary), [r.events[5], r.events[4]], log);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('out-of-order'));
  });

  it('never mutates its input', () => {
    const before = upsertSummary(EMPTY_TRANSCRIPT, r.summary);
    const mid = applyEvents(before, r.events.slice(0, 10));
    const snapshot = structuredClone(mid);
    const after = applyEvents(mid, r.events.slice(10));
    expect(mid).toEqual(snapshot);
    expect(after).not.toBe(mid);
    // Untouched items keep their identity, so memoized rows don't re-render.
    expect(after.tasks[id]?.items[1]).toBe(mid.tasks[id]?.items[1]);
  });

  it('returns the same state for an empty batch', () => {
    const state = upsertSummary(EMPTY_TRANSCRIPT, r.summary);
    expect(applyEvents(state, [])).toBe(state);
  });

  it('events before the summary: the task appears, the user message is added first later', () => {
    let state: TranscriptState = applyEvents(EMPTY_TRANSCRIPT, r.events.slice(0, 7));
    expect(state.order).toEqual([id]);
    expect(state.tasks[id]?.items[0]?.kind).toBe('assistant');
    state = upsertSummary(state, r.summary);
    expect(state.tasks[id]?.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(state.tasks[id]?.index).toEqual({
      [USER_ITEM_ID]: 0,
      [`msg:${(r.events[3] as { messageId: string }).messageId}`]: 1,
    });
    // The queued summary doesn't roll the live state back.
    expect(state.tasks[id]?.meta.state).toBe('running');
  });

  it('a terminal summary (task.list refresh) is authoritative', () => {
    const state = upsertSummary(applyEvents(EMPTY_TRANSCRIPT, r.events.slice(0, 7)), {
      ...r.summary,
      state: 'failed',
      iteration: 3,
      models: ['qwen-local', 'claude'],
      usage: { inputTokens: 9000, outputTokens: 900, costUsd: 0.5 },
      failureReason: 'budget:maxIterations',
    });
    expect(state.tasks[id]?.meta).toMatchObject({
      state: 'failed',
      iteration: 3,
      models: ['qwen-local', 'claude'],
      usage: { inputTokens: 9000, outputTokens: 900, costUsd: 0.5 },
      failureReason: 'budget:maxIterations',
    });
  });

  it('counts an iteration per return from verifying to running', () => {
    const ts = '2026-10-10T00:00:00.000Z';
    const s = (seq: number, from: string | null, to: string) => ({
      taskId: 't',
      seq,
      ts,
      type: 'state_changed',
      from,
      to,
    });
    const state = applyEvents(EMPTY_TRANSCRIPT, [
      s(0, null, 'queued'),
      s(1, 'queued', 'planning'),
      s(2, 'planning', 'running'),
      s(3, 'running', 'verifying'),
      s(4, 'verifying', 'running'),
      s(5, 'running', 'verifying'),
      s(6, 'verifying', 'awaiting_approval'),
      s(7, 'awaiting_approval', 'verifying'),
      s(8, 'verifying', 'running'),
    ]);
    expect(state.tasks['t']?.meta.iteration).toBe(3);
  });

  it('removes a task', () => {
    const state = upsertSummary(EMPTY_TRANSCRIPT, r.summary);
    expect(removeTask(state, id)).toEqual(EMPTY_TRANSCRIPT);
    expect(removeTask(state, 'nope')).toBe(state);
  });
});
