import { describe, expect, it } from 'vitest';
import { errorEvent, toModelError } from '../errors.ts';
import { httpRequest } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ModelAdapter, StreamEvent } from '../types.ts';
import { assertStreamInvariants, collectEvents, runAdapterContract } from './contract.ts';
import { createFakeModelAdapter, type FakeTurn } from './fake.ts';
import { parseFixture, replayFetch, type RecordedExchange } from './fixtures.ts';

describe('FakeModelAdapter', () => {
  runAdapterContract<FakeTurn>((turn) => createFakeModelAdapter({ turns: [turn] }), {
    text: {
      fixture: { text: ['Hello', ', world'], usage: { inputTokens: 5, outputTokens: 3 } },
      expectText: 'Hello, world',
      expectUsage: true,
    },
    toolCalls: {
      fixture: {
        text: 'Reading.',
        toolCalls: [
          { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } },
          { id: 'call_2', name: 'read_file', args: '{"path":"b.ts"}' },
        ],
      },
      expectCalls: [
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'read_file', args: { path: 'b.ts' } },
      ],
    },
    errors: [
      { fixture: { error: { kind: 'auth' } }, kind: 'auth', label: 'a bad key' },
      {
        fixture: { text: 'partial', error: { kind: 'rate_limit' } },
        kind: 'rate_limit',
        label: 'a mid-stream 429',
      },
    ],
    cancel: { fixture: { text: ['a', 'b', 'c'], delayMs: 50 } },
  });
});

/** A minimal SSE adapter over recorded fixtures: shows how MOD-2/3 plug into the harness. */
function sseAdapter(exchanges: RecordedExchange[]): ModelAdapter {
  const { fetch } = replayFetch(exchanges);
  return {
    id: 'sse',
    provider: 'openai-compatible',
    model: 'replay',
    capabilities: () =>
      Promise.resolve({ streaming: true, toolCalls: false, contextTokens: 1000, vision: false }),
    async *chat(_req, signal): AsyncGenerator<StreamEvent> {
      try {
        const res = await httpRequest(
          { url: 'https://api.example.test/v1/chat', body: {} },
          { signal, fetch, sleep: () => Promise.resolve() },
        );
        for await (const event of parseSse(res.body()))
          yield { type: 'text_delta', text: event.data };
        yield { type: 'done', stopReason: 'end' };
      } catch (error) {
        yield errorEvent(toModelError(error, signal));
      }
    },
  };
}

const sse = (status: number, ...chunks: Array<string | number>): string =>
  [
    JSON.stringify({ response: { status, headers: { 'content-type': 'text/event-stream' } } }),
    ...chunks.map((c) => JSON.stringify(typeof c === 'number' ? { delayMs: c } : { chunk: c })),
  ].join('\n');

describe('recorded-fixture adapter', () => {
  runAdapterContract<string>((jsonl) => sseAdapter(parseFixture(jsonl)), {
    text: {
      fixture: sse(200, 'data: Hel', 'lo\n\ndata: !\n\n', 'data: [DONE]\n\n'),
      expectText: 'Hello!',
    },
    errors: [
      { fixture: sse(401, '{"error":"bad key"}'), kind: 'auth' },
      {
        fixture: `${sse(429)}\n${sse(500)}\n${sse(503)}\n${sse(503)}`,
        kind: 'server',
        label: 'retries exhausted',
      },
    ],
    cancel: { fixture: sse(200, 'data: a\n\n', 200, 'data: b\n\n') },
  });
});

describe('fixtures', () => {
  it('parses exchanges, chunks and delays', () => {
    expect(parseFixture(`${sse(429)}\n\n${sse(200, 'data: x\n\n', 5)}`)).toEqual([
      { status: 429, headers: { 'content-type': 'text/event-stream' }, body: [] },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: ['data: x\n\n', 5] },
    ]);
  });

  it('refuses fixtures that record credentials or are malformed', () => {
    expect(() =>
      parseFixture(
        JSON.stringify({ response: { status: 200, headers: { Authorization: 'Bearer x' } } }),
      ),
    ).toThrow(/Authorization/);
    expect(() => parseFixture(JSON.stringify({ chunk: 'x' }))).toThrow(/before any response/);
    expect(() => parseFixture('{"nope":1}')).toThrow(/line 1/);
  });

  it('replayFetch records requests and runs out loudly', async () => {
    const { fetch, requests } = replayFetch(parseFixture(sse(200, 'ok')));
    const res = await fetch('https://x.test', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'x-test': '1' },
    });
    expect(await res.text()).toBe('ok');
    expect(requests).toEqual([
      { url: 'https://x.test', method: 'POST', headers: { 'x-test': '1' }, body: { a: 1 } },
    ]);
    await expect(fetch('https://x.test', {})).rejects.toThrow(/no recorded exchange/);
  });
});

describe('contract invariants catch broken adapters', () => {
  const run = async (events: StreamEvent[]) => {
    async function* stream(): AsyncGenerator<StreamEvent> {
      yield* events;
    }
    return assertStreamInvariants(await collectEvents(stream()));
  };

  it.each<[string, StreamEvent[]]>([
    ['no terminal event', [{ type: 'text_delta', text: 'x' }]],
    [
      'two terminal events',
      [
        { type: 'done', stopReason: 'end' },
        { type: 'done', stopReason: 'end' },
      ],
    ],
    [
      'events after done',
      [
        { type: 'done', stopReason: 'end' },
        { type: 'text_delta', text: 'x' },
      ],
    ],
    [
      'duplicate tool call ids',
      [
        { type: 'tool_call', call: { id: 'a', name: 'x', args: '{}' } },
        { type: 'tool_call', call: { id: 'a', name: 'x', args: '{}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
    ],
    [
      'two usage events',
      [
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'usage', inputTokens: 1, outputTokens: 2 },
        { type: 'done', stopReason: 'end' },
      ],
    ],
  ])('rejects %s', async (_label, events) => {
    await expect(run(events)).rejects.toThrow();
  });

  it('rejects invalid event shapes and adapters that throw', async () => {
    await expect(run([{ type: 'text_delta' } as unknown as StreamEvent])).rejects.toThrow(
      /not a valid StreamEvent/,
    );
    // eslint-disable-next-line require-yield
    async function* throwing(): AsyncGenerator<StreamEvent> {
      throw new Error('boom');
    }
    await expect(collectEvents(throwing())).rejects.toThrow(/threw instead of yielding/);
  });
});
