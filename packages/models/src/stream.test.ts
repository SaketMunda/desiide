import { describe, expect, it } from 'vitest';
import { ModelError } from './errors.ts';
import { collectTurn } from './stream.ts';
import type { StreamEvent } from './types.ts';

async function* from(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  yield* events;
}

describe('collectTurn', () => {
  it('keeps reasoning apart from the text and captures provider state', async () => {
    const turn = await collectTurn(
      from([
        { type: 'reasoning_delta', text: 'Think' },
        { type: 'text_delta', text: 'Hi' },
        { type: 'reasoning_delta', text: 'ing' },
        { type: 'tool_call', call: { id: 'c', name: 'read_file', args: '{}' } },
        { type: 'provider_state', state: { owner: 'm', data: [1] } },
        { type: 'usage', inputTokens: 1, outputTokens: 2 },
        { type: 'done', stopReason: 'tool_calls' },
      ]),
    );
    expect(turn).toEqual({
      text: 'Hi',
      reasoning: 'Thinking',
      toolCalls: [{ id: 'c', name: 'read_file', args: '{}' }],
      providerState: { owner: 'm', data: [1] },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('throws an error event as a ModelError', async () => {
    await expect(
      collectTurn(from([{ type: 'error', error: { kind: 'auth', message: 'no' } }])),
    ).rejects.toBeInstanceOf(ModelError);
  });
});
