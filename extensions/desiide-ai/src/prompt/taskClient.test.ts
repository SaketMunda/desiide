import { RpcErrorCode, TaskInput, type TaskEvent, type TaskState } from '@desiide/protocol';
import { ResponseError } from 'vscode-jsonrpc';
import { describe, expect, it, vi } from 'vitest';
import { ActiveTasks } from './activeTasks.ts';
import {
  FallbackTaskClient,
  MockTaskClient,
  orchestratorTaskClient,
  type TaskClient,
} from './taskClient.ts';

const params = TaskInput.parse({ kind: 'other', instruction: 'do it' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function collect(client: TaskClient): TaskEvent[] {
  const events: TaskEvent[] = [];
  client.onEvent((e) => events.push(e));
  return events;
}

describe('MockTaskClient', () => {
  it('runs until cancelled (AC5 with the mock)', async () => {
    const mock = new MockTaskClient();
    const events = collect(mock);
    const task = await mock.create(params);
    expect(task).toMatchObject({ state: 'queued', instruction: 'do it' });
    await tick();
    expect(events.map((e) => e.type === 'state_changed' && e.to)).toEqual(['running']);
    expect(await mock.cancel(task.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'state_changed',
      from: 'running',
      to: 'cancelled',
    });
    expect(await mock.cancel(task.id)).toBe(false);
  });
});

describe('FallbackTaskClient', () => {
  const notImplemented = new ResponseError(
    RpcErrorCode.NotImplemented,
    'task.create is not implemented',
  );

  it('switches to the mock once the orchestrator says NotImplemented', async () => {
    const real: TaskClient = {
      create: vi.fn().mockRejectedValue(notImplemented),
      cancel: vi.fn(),
      onEvent: () => ({ dispose: () => undefined }),
    };
    const onFallback = vi.fn();
    const client = new FallbackTaskClient(real, new MockTaskClient(), onFallback);
    const t1 = await client.create(params);
    const t2 = await client.create(params);
    expect(t1.id).toMatch(/^mock-/);
    expect(t2.id).toMatch(/^mock-/);
    expect(real.create).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(client.mocked).toBe(true);
    expect(await client.cancel(t1.id)).toBe(true);
    expect(real.cancel).not.toHaveBeenCalled();
  });

  it('passes other errors through and stays on the real client', async () => {
    const real: TaskClient = {
      create: vi.fn().mockRejectedValue(new Error('offline')),
      cancel: vi.fn().mockResolvedValue(true),
      onEvent: () => ({ dispose: () => undefined }),
    };
    const client = new FallbackTaskClient(real, new MockTaskClient(), vi.fn());
    await expect(client.create(params)).rejects.toThrow('offline');
    expect(client.mocked).toBe(false);
    expect(await client.cancel('t-1')).toBe(true);
  });
});

describe('orchestratorTaskClient', () => {
  it('maps task.create / task.cancel onto requests', async () => {
    const request = vi.fn((method: string) =>
      Promise.resolve(method === 'task.create' ? { task: { id: 't1' } } : { cancelled: true }),
    );
    const client = orchestratorTaskClient({
      request: request as never,
      onEvent: () => ({ dispose: () => undefined }),
    });
    expect((await client.create(params)).id).toBe('t1');
    expect(await client.cancel('t1')).toBe(true);
    expect(request).toHaveBeenLastCalledWith('task.cancel', { taskId: 't1' });
  });
});

describe('ActiveTasks', () => {
  const ev = (taskId: string, seq: number, to: TaskState): TaskEvent => ({
    type: 'state_changed',
    taskId,
    seq,
    ts: '2026-10-02T00:00:00Z',
    from: null,
    to,
  });

  it('tracks tasks until a terminal state, and picks the running one for Stop', () => {
    const active = new ActiveTasks();
    active.add('a', 'queued');
    active.add('b', 'queued');
    expect(active.apply(ev('a', 1, 'running'))).toBe(true);
    expect(active.current()).toBe('a');
    expect(active.apply(ev('a', 2, 'done'))).toBe(true);
    expect(active.list()).toEqual([{ id: 'b', state: 'queued' }]);
    expect(active.current()).toBe('b');
  });

  it('ignores stale and unrelated events', () => {
    const active = new ActiveTasks();
    active.add('a', 'queued');
    active.apply(ev('a', 3, 'running'));
    expect(active.apply(ev('a', 2, 'done'))).toBe(false);
    expect(active.apply(ev('zzz', 1, 'running'))).toBe(false);
    expect(active.list()).toEqual([{ id: 'a', state: 'running' }]);
  });

  it('remembers events that arrive before create resolves', () => {
    const active = new ActiveTasks();
    active.apply(ev('fast', 1, 'running'));
    active.add('fast', 'queued');
    expect(active.list()).toEqual([{ id: 'fast', state: 'running' }]);
    active.apply(ev('gone', 2, 'failed'));
    active.add('gone', 'queued');
    expect(active.list()).toHaveLength(1);
  });
});
