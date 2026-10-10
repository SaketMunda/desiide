import { describe, expect, it } from 'vitest';
import { TASK_EVENT_TYPES, parseTaskEvent } from './events.ts';

const env = { taskId: 'task-1', seq: 0, ts: '2026-09-29T12:00:00.000Z' };

describe('parseTaskEvent', () => {
  it('parses known events and strips unknown fields', () => {
    const parsed = parseTaskEvent({
      ...env,
      type: 'text_delta',
      messageId: 'm',
      delta: 'hi',
      x: 1,
    });
    expect(parsed).toEqual({
      status: 'known',
      event: { ...env, type: 'text_delta', messageId: 'm', delta: 'hi' },
    });
  });

  it('reports unknown event types instead of failing', () => {
    expect(parseTaskEvent({ ...env, type: 'plan_updated', steps: [] })).toEqual({
      status: 'unknown',
      type: 'plan_updated',
    });
  });

  it('rejects malformed known events', () => {
    expect(parseTaskEvent({ ...env, type: 'text_delta' }).status).toBe('invalid');
  });

  it('rejects payloads without a type', () => {
    expect(parseTaskEvent({ ...env }).status).toBe('invalid');
    expect(parseTaskEvent('text_delta').status).toBe('invalid');
  });

  it('lists every event type from the brief', () => {
    expect([...TASK_EVENT_TYPES].sort()).toEqual(
      [
        'state_changed',
        'text_delta',
        'reasoning_delta',
        'tool_call_started',
        'tool_call_finished',
        'edit_proposed',
        'approval_required',
        'decision_made',
        'usage',
        'error',
      ].sort(),
    );
  });
});
