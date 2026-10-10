import { describe, expect, it } from 'vitest';
import { StreamEvent, type ChatRequest } from '../types.ts';
import { createFakeModelAdapter } from './fake.ts';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(StreamEvent.parse(event));
  return events;
}

const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('createFakeModelAdapter', () => {
  it('plays scripted turns in order and records requests', async () => {
    const fake = createFakeModelAdapter({
      turns: [
        { text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 2 } },
        { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
      ],
    });
    const signal = new AbortController().signal;
    expect(await collect(fake.chat(req, signal))).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'done', stopReason: 'end' },
    ]);
    expect(await collect(fake.chat(req, signal))).toEqual([
      { type: 'tool_call', call: { id: 'c1', name: 'read_file', args: '{"path":"a.ts"}' } },
      { type: 'done', stopReason: 'tool_calls' },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual(req);
    expect(fake.remaining).toBe(0);
  });

  it('streams scripted reasoning first and provider state it owns', async () => {
    const fake = createFakeModelAdapter({
      id: 'claude',
      turns: [{ reasoning: ['Let me', ' look'], text: 'ok', providerState: { sig: 's' } }],
    });
    expect(await collect(fake.chat(req, new AbortController().signal))).toEqual([
      { type: 'reasoning_delta', text: 'Let me' },
      { type: 'reasoning_delta', text: ' look' },
      { type: 'text_delta', text: 'ok' },
      { type: 'provider_state', state: { owner: 'claude', data: { sig: 's' } } },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('keeps raw (possibly malformed) args strings as-is', async () => {
    const fake = createFakeModelAdapter({
      turns: [{ toolCalls: [{ id: 'c1', name: 'shell', args: '{"command": ' }] }],
    });
    const events = await collect(fake.chat(req, new AbortController().signal));
    expect(events[0]).toEqual({
      type: 'tool_call',
      call: { id: 'c1', name: 'shell', args: '{"command": ' },
    });
  });

  it('ends with an error event when out of turns', async () => {
    const fake = createFakeModelAdapter({ id: 'm' });
    const events = await collect(fake.chat(req, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'unknown' } });
  });

  it('emits a scripted error after partial output', async () => {
    const fake = createFakeModelAdapter({
      turns: [{ text: 'par', error: { kind: 'rate_limit' } }],
    });
    const events = await collect(fake.chat(req, new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'error']);
    expect(events[1]).toMatchObject({ error: { kind: 'rate_limit' } });
  });

  it('a hanging turn ends with cancelled when aborted', async () => {
    const fake = createFakeModelAdapter({ turns: [{ text: 'thinking', hang: true }] });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const events = await collect(fake.chat(req, controller.signal));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'error']);
    expect(events[1]).toMatchObject({ error: { kind: 'cancelled' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('push() appends turns and capabilities() merges overrides', async () => {
    const fake = createFakeModelAdapter({ capabilities: { toolCalls: false } });
    fake.push({ text: 'ok' });
    expect(fake.remaining).toBe(1);
    expect(await fake.capabilities()).toMatchObject({ toolCalls: false, streaming: true });
  });
});
