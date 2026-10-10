import { describe, expect, it } from 'vitest';
import { historyFor } from './history.ts';
import type { ChatMessage } from './types.ts';

describe('historyFor', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', providerState: { owner: 'claude', data: { blocks: [1] } } },
    { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'x' },
    { role: 'assistant', content: 'done', providerState: { owner: 'other', data: 1 } },
  ];

  it('keeps state the target adapter owns and drops the rest', () => {
    const out = historyFor(history, 'claude');
    expect(out[1]).toEqual(history[1]);
    expect(out[3]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('drops all state when the model changes, without touching the input', () => {
    const out = historyFor(history, 'local-small');
    expect(out.some((m) => m.role === 'assistant' && m.providerState)).toBe(false);
    expect(history[1]).toHaveProperty('providerState');
    expect(out[0]).toBe(history[0]);
  });
});
