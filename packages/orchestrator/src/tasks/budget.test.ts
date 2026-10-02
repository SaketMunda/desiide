import { DEFAULT_BUDGET } from '@desiide/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskFailure, callKey, createBudgetTracker, createWallClock } from './budget.ts';

const reasonOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskFailure) return err.reason;
    throw err;
  }
  return undefined;
};

describe('createBudgetTracker', () => {
  it('allows exactly the budgeted number of tool calls', () => {
    const b = createBudgetTracker({ ...DEFAULT_BUDGET, maxToolCalls: 2 });
    b.countToolCall();
    b.countToolCall();
    expect(reasonOf(() => b.countToolCall())).toBe('budget:maxToolCalls');
  });

  it('fails once tokens pass the limit, not at it', () => {
    const b = createBudgetTracker({ ...DEFAULT_BUDGET, maxTokens: 100 });
    b.addTokens(100);
    expect(reasonOf(() => b.addTokens(1))).toBe('budget:maxTokens');
  });

  it('counts iterations from 1', () => {
    const b = createBudgetTracker({ ...DEFAULT_BUDGET, maxIterations: 2 });
    expect(b.iteration).toBe(1);
    b.nextIteration();
    expect(b.iteration).toBe(2);
    expect(reasonOf(() => b.nextIteration())).toBe('budget:maxIterations');
  });

  it('detects 3 identical calls in a row only', () => {
    const b = createBudgetTracker(DEFAULT_BUDGET);
    b.checkRepeat('a');
    b.checkRepeat('a');
    b.checkRepeat('b');
    b.checkRepeat('a');
    b.checkRepeat('a');
    expect(reasonOf(() => b.checkRepeat('a'))).toBe('loop_detected');
  });
});

describe('callKey', () => {
  it('ignores object key order at every depth but not array order', () => {
    expect(callKey('t', { a: 1, b: { c: [1, 2], d: null } })).toBe(
      callKey('t', { b: { d: null, c: [1, 2] }, a: 1 }),
    );
    expect(callKey('t', { a: [1, 2] })).not.toBe(callKey('t', { a: [2, 1] }));
    expect(callKey('t', {})).not.toBe(callKey('u', {}));
    expect(callKey('t', '{"a":1}')).not.toBe(callKey('t', { a: 1 }));
  });
});

describe('createWallClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires after the limit of running time, excluding pauses', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const clock = createWallClock(1000, onExpire, { now: () => Date.now() });
    clock.start();
    vi.advanceTimersByTime(600);
    clock.pause();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    clock.resume();
    vi.advanceTimersByTime(399);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('never fires after stop, and resume is idempotent', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const clock = createWallClock(100, onExpire, { now: () => Date.now() });
    clock.start();
    clock.resume();
    clock.stop();
    clock.resume();
    vi.advanceTimersByTime(1000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
