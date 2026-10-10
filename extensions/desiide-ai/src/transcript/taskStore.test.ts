import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskInput, type TaskEvent, type TaskSummary } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { ExtensionToWebview } from '../../shared/messages.ts';
import { EMPTY_TRANSCRIPT } from '../../shared/transcript/model.ts';
import { applyEvents, upsertSummary } from '../../shared/transcript/reducer.ts';
import { formatToolOutput } from './output.ts';
import { TaskStore } from './taskStore.ts';

interface Recording {
  summary: TaskSummary;
  events: TaskEvent[];
}
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../shared/transcript/fixtures', `${name}.json`),
      'utf8',
    ),
  ) as Recording;
const happy = load('happy');
const escalation = load('escalation');
const params = TaskInput.parse({ kind: 'bug_fix', instruction: 'Fix the bug' });

function setup(maxTasks?: number) {
  const posted: ExtensionToWebview[] = [];
  const timers: Array<() => void> = [];
  const store = new TaskStore({
    post: (m) => posted.push(ExtensionToWebview.parse(m)),
    schedule: (fn) => {
      timers.push(fn);
      return { cancel: () => timers.splice(timers.indexOf(fn), 1) };
    },
    ...(maxTasks === undefined ? {} : { maxTasks }),
  });
  const tick = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { store, posted, tick, timers };
}

describe('TaskStore', () => {
  it('batches events: one post per flush, not one per delta', () => {
    const { store, posted, tick, timers } = setup();
    store.created(happy.summary, params);
    for (const e of happy.events) store.onEvent(e);
    expect(timers).toHaveLength(1);
    tick();
    const batches = posted.filter((m) => m.type === 'tasks.events');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.type === 'tasks.events' && batches[0].events).toHaveLength(
      happy.events.length,
    );
  });

  it('a snapshot replays to the same transcript as the live stream, with deltas compacted', () => {
    const { store, tick } = setup();
    store.created(happy.summary, params);
    for (const e of happy.events) store.onEvent(e);
    tick();
    const [record] = store.snapshot();
    expect(record).toMatchObject({ id: happy.summary.id, retryable: true });
    // 7 text/reasoning deltas in 3 runs collapse to 4 events (reasoning, text, text, text).
    expect(record?.events.length).toBeLessThan(happy.events.length);
    const live = applyEvents(upsertSummary(EMPTY_TRANSCRIPT, happy.summary), happy.events);
    const replayed = applyEvents(
      upsertSummary(EMPTY_TRANSCRIPT, happy.summary),
      record?.events ?? [],
      undefined,
      { replay: true },
    );
    expect(replayed).toEqual(live);
  });

  it('a snapshot includes pending events and cancels their batch (nothing sent twice)', () => {
    const { store, posted, tick } = setup();
    for (const e of happy.events.slice(0, 5)) store.onEvent(e);
    const [record] = store.snapshot();
    expect(record).toMatchObject({ id: happy.summary.id, retryable: false });
    expect(record).not.toHaveProperty('summary');
    tick();
    expect(posted.filter((m) => m.type === 'tasks.events')).toHaveLength(0);
  });

  it('reports when a task ends, once', () => {
    const { store } = setup();
    const ends = happy.events.map((e) => store.onEvent(e));
    expect(ends.filter(Boolean)).toHaveLength(1);
    expect(ends.at(-1)).toBe(true);
    expect(store.onEvent(happy.events.at(-1) as TaskEvent)).toBe(false);
  });

  it('refresh only updates known tasks', () => {
    const { store, posted } = setup();
    store.created(happy.summary, params);
    store.refresh([{ ...happy.summary, state: 'done' }, { ...escalation.summary }]);
    const summaries = posted.filter((m) => m.type === 'tasks.summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toMatchObject({ summary: { state: 'done' }, retryable: true });
  });

  it('keeps create params for retry', () => {
    const { store } = setup();
    store.created(happy.summary, params);
    expect(store.params(happy.summary.id)).toBe(params);
    expect(store.params('other')).toBeUndefined();
  });

  it('finds a tool call and its output, including refused calls', () => {
    const { store } = setup();
    for (const e of [...happy.events, ...escalation.events]) store.onEvent(e);
    const read = store.toolOutput(happy.summary.id, 'call_read');
    expect(read?.call?.tool).toBe('read_file');
    expect(read?.result.output).toContain('export const add');
    const push = store.toolOutput(escalation.summary.id, 'call_push');
    expect(push?.result.error?.kind).toBe('rejected');
    expect(store.toolOutput(happy.summary.id, 'nope')).toBeUndefined();
    expect(formatToolOutput(push as NonNullable<typeof push>)).toBe(
      '# shell {"command":"git push origin main"}\n' +
        '# rejected: User rejected this shell call: not now, ' +
        `${push?.result.durationMs ?? 0} ms\n\nUser rejected this shell call: not now\n`,
    );
  });

  it('drops the oldest finished tasks over the limit, never running ones', () => {
    const { store, posted } = setup(1);
    const running = happy.events.filter((e) => e.seq <= 3);
    for (const e of running) store.onEvent(e);
    for (const e of escalation.events) store.onEvent(e);
    // Two tasks, limit 1: only the finished one can go.
    expect(posted.filter((m) => m.type === 'tasks.removed')).toEqual([
      { type: 'tasks.removed', taskIds: [escalation.summary.id] },
    ]);
    expect(store.snapshot().map((r) => r.id)).toEqual([happy.summary.id]);
  });
});
