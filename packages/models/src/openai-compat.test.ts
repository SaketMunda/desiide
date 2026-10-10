import type { ModelConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { createOpenAICompatAdapter } from './openai-compat.ts';
import type { ProviderContext } from './registry.ts';
import { collectEvents, runAdapterContract } from './testing/contract.ts';
import { loadFixture, replayFetch, type ReplayFetch } from './testing/fixtures.ts';
import type { ChatRequest, ReasoningLevel, StreamEvent } from './types.ts';

const fixture = (name: string) =>
  loadFixture(
    new URL(`../test/fixtures/openai-compatible/${name}.jsonl`, import.meta.url).pathname,
  );

const KEY = 'sk-test-SENTINEL-7f3a';

function setup(name: string | string[], config: Partial<ModelConfig> = {}) {
  const replay = replayFetch([name].flat().flatMap(fixture));
  const ctx: ProviderContext = {
    config: {
      id: 'gpt',
      provider: 'openai-compatible',
      model: 'gpt-x',
      baseUrl: 'https://api.example.test/v1/',
      apiKey: 'secret:example',
      ...config,
    },
    apiKey: () => Promise.resolve(KEY),
    secrets: () => [KEY],
    fetch: replay.fetch,
  };
  return { adapter: createOpenAICompatAdapter(ctx), replay };
}

const TOOLS: ChatRequest = {
  messages: [{ role: 'user', content: 'Read a.ts and b.ts' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read one file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

async function chat(name: string, req: ChatRequest = TOOLS, config: Partial<ModelConfig> = {}) {
  const { adapter, replay } = setup(name, config);
  const events = await collectEvents(adapter.chat(req, new AbortController().signal));
  return { events, replay };
}

const callsOf = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
const bodyOf = (replay: ReplayFetch, i = 0) => replay.requests[i]?.body as Record<string, unknown>;

describe('OpenAICompatAdapter', () => {
  runAdapterContract<string>((name) => setup(name).adapter, {
    text: { fixture: 'text', expectText: 'Hello, there!', expectUsage: true },
    toolCalls: {
      fixture: 'tools-fragmented',
      expectCalls: [
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'read_file', args: { path: 'b.ts' } },
      ],
    },
    errors: [
      { fixture: 'error-401', kind: 'auth', label: 'a bad key (401)' },
      { fixture: 'error-context-length', kind: 'context_length', label: 'a too-long prompt' },
      { fixture: 'error-rate-limit', kind: 'rate_limit', label: 'a 429 with a long retry-after' },
      { fixture: 'error-midstream', kind: 'server', label: 'an error inside the stream' },
      { fixture: 'error-truncated', kind: 'network', label: 'a stream cut off mid-reply' },
    ],
    cancel: { fixture: 'cancel' },
  });

  it('parses fragmented tool calls split mid-event (AC2)', async () => {
    const { events } = await chat('tools-fragmented');
    expect(events.find((e) => e.type === 'text_delta')).toEqual({
      type: 'text_delta',
      text: 'Reading both.',
    });
    expect(callsOf(events)).toEqual([
      { id: 'call_A1', name: 'read_file', args: '{"path":"a.ts"}' },
      { id: 'call_B2', name: 'read_file', args: '{"path":"b.ts"}' },
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 81,
      outputTokens: 40,
      cacheReadTokens: 64,
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('parses single-chunk tool calls (recorded from Ollama /v1) (AC2)', async () => {
    const { events } = await chat('tools-single-chunk');
    expect(callsOf(events)).toEqual([
      { id: 'call_9ap1agjj', name: 'read_file', args: '{"path":"a.ts"}' },
      { id: 'call_kxklzd1l', name: 'read_file', args: '{"path":"b.ts"}' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('sends the OpenAI request shape with the key as a bearer token', async () => {
    const { replay } = await chat('tools-fragmented', {
      system: 'Be brief.',
      maxTokens: 100,
      temperature: 0.2,
      tools: TOOLS.tools ?? [],
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.ts"}' }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'nope', isError: true },
      ],
    });
    const [request] = replay.requests;
    expect(request?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.body).toEqual({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'Error: nope' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read one file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    });
  });

  it('applies quirks: max_completion_tokens for OpenAI, no stream_options when disabled', async () => {
    const req = { ...TOOLS, maxTokens: 10 };
    const openai = await chat('text', req, { baseUrl: 'https://api.openai.com/v1' });
    expect(bodyOf(openai.replay)).toMatchObject({ max_completion_tokens: 10 });
    expect(bodyOf(openai.replay)).not.toHaveProperty('max_tokens');
    const plain = await chat('text', req, { quirks: { streamUsage: false } });
    expect(bodyOf(plain.replay)).not.toHaveProperty('stream_options');
  });

  it('retries once without stream_options when the server rejects it, and remembers', async () => {
    const { adapter, replay } = setup(['stream-options-rejected', 'text']);
    const events = await collectEvents(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
    expect(replay.requests).toHaveLength(2);
    expect(bodyOf(replay, 0)).toHaveProperty('stream_options');
    expect(bodyOf(replay, 1)).not.toHaveProperty('stream_options');
    // The next request goes straight out without it.
    const next = await collectEvents(
      adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal),
    );
    expect(next.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
    expect(replay.requests).toHaveLength(3);
    expect(bodyOf(replay, 2)).not.toHaveProperty('stream_options');
  });

  it('streams reasoning deltas apart from the answer (recorded from Ollama /v1, ADR-022)', async () => {
    const { events, replay } = await chat('reasoning', { messages: TOOLS.messages });
    const reasoning = events.flatMap((e) => (e.type === 'reasoning_delta' ? [e.text] : []));
    expect(reasoning.join('')).toBe('Okay, the user is asking number 5.\n');
    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(text).toBe('5');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
    // Unset reasoning sends nothing.
    expect(bodyOf(replay)).not.toHaveProperty('reasoning_effort');
  });

  it('accepts reasoning_content (DeepSeek / vLLM shape)', async () => {
    const replay = replayFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ]);
    const adapter = createOpenAICompatAdapter({
      config: { id: 'ds', provider: 'openai-compatible', model: 'r1', baseUrl: 'http://x.test/v1' },
      apiKey: () => Promise.resolve(undefined),
      secrets: () => [],
      fetch: replay.fetch,
    });
    const events = await collectEvents(
      adapter.chat({ messages: TOOLS.messages }, new AbortController().signal),
    );
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning_delta', text: 'hmm' },
      { type: 'text_delta', text: 'ok' },
    ]);
  });

  it.each<[ReasoningLevel, string]>([
    ['off', 'none'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ])('reasoning %s sends reasoning_effort %s; a request overrides the config', async (level, effort) => {
    const configured = await chat('text', { messages: TOOLS.messages }, { reasoning: level });
    expect(bodyOf(configured.replay)).toMatchObject({ reasoning_effort: effort });
    const overridden = await chat(
      'text',
      { messages: TOOLS.messages, reasoning: level },
      { reasoning: level === 'off' ? 'high' : 'off' },
    );
    expect(bodyOf(overridden.replay)).toMatchObject({ reasoning_effort: effort });
  });

  it('drops reasoning_effort for good when the server rejects it', async () => {
    const { adapter, replay } = setup(['reasoning-effort-rejected', 'text', 'text'], {
      reasoning: 'low',
    });
    const req = { messages: TOOLS.messages };
    const events = await collectEvents(adapter.chat(req, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
    expect(bodyOf(replay, 0)).toHaveProperty('reasoning_effort', 'low');
    expect(bodyOf(replay, 1)).not.toHaveProperty('reasoning_effort');
    await collectEvents(adapter.chat(req, new AbortController().signal));
    expect(replay.requests).toHaveLength(3);
    expect(bodyOf(replay, 2)).not.toHaveProperty('reasoning_effort');
  });

  it('uses the text tool protocol when the config says the model cannot call tools', async () => {
    const { events, replay } = await chat('text-tools', TOOLS, {
      capabilities: { toolCalls: false },
    });
    const body = bodyOf(replay);
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body.messages)).toContain('<tool_call>');
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.type === 'text_delta' && e.text)
        .join('')
        .trimEnd(),
    ).toBe('Let me read it.');
    expect(callsOf(events)).toMatchObject([{ name: 'read_file', args: '{"path":"a.ts"}' }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('never leaks the key in error events', async () => {
    const { events } = await chat('error-401');
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('refuses a config without a baseUrl', () => {
    expect(() =>
      createOpenAICompatAdapter({
        config: { id: 'x', provider: 'openai-compatible', model: 'm' },
        apiKey: () => Promise.resolve(undefined),
        secrets: () => [],
      }),
    ).toThrow(/needs a baseUrl/);
  });
});
