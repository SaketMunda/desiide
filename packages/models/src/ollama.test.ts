import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ModelConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import {
  OLLAMA_DEFAULT_CONTEXT,
  OLLAMA_NOT_RUNNING_HINT,
  capabilitiesFromShow,
  createOllamaAdapter,
  discoverOllama,
  ollamaRoot,
} from './ollama.ts';
import type { ProviderContext } from './registry.ts';
import { collectEvents, runAdapterContract } from './testing/contract.ts';
import { loadFixture, replayFetch, type ReplayFetch } from './testing/fixtures.ts';
import type { ChatRequest, StreamEvent } from './types.ts';
import type { FetchLike } from './http.ts';

const fixture = (name: string) =>
  loadFixture(new URL(`../test/fixtures/ollama/${name}.jsonl`, import.meta.url).pathname);

function context(fetch: FetchLike, config: Partial<ModelConfig> = {}): ProviderContext {
  return {
    config: { id: 'local', provider: 'ollama', model: 'qwen2.5:7b', ...config },
    apiKey: () => Promise.resolve(undefined),
    secrets: () => [],
    fetch,
  };
}

function setup(name: string, config: Partial<ModelConfig> = {}) {
  const replay = replayFetch(fixture(name));
  return { adapter: createOllamaAdapter(context(replay.fetch, config)), replay };
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

const textOf = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
const callsOf = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
const chatBody = (replay: ReplayFetch) =>
  replay.requests.find((r) => r.url.endsWith('/api/chat'))?.body as Record<string, unknown>;

/** A fetch that fails like Node's does when nothing listens on the port. */
const refused: FetchLike = () =>
  Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    }),
  );

describe('OllamaAdapter', () => {
  runAdapterContract<string>((name) => setup(name).adapter, {
    text: { fixture: 'text', expectText: 'Hello there, friend.', expectUsage: true },
    toolCalls: {
      fixture: 'tools',
      expectCalls: [
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'read_file', args: { path: 'b.ts' } },
      ],
    },
    errors: [
      { fixture: 'chat-not-pulled', kind: 'bad_request', label: 'a model that is not pulled' },
      { fixture: 'error-midstream', kind: 'server', label: 'a runner crash mid-stream' },
      { fixture: 'truncated', kind: 'network', label: 'a stream cut off mid-reply' },
    ],
    cancel: { fixture: 'cancel' },
  });

  it('probes /api/show and sends num_ctx with the native request', async () => {
    const { events, replay } = await chat('text', {
      system: 'You are a test.',
      maxTokens: 50,
      temperature: 0,
      messages: [{ role: 'user', content: 'Say hello in three words.' }],
    });
    expect(replay.requests.map((r) => r.url)).toEqual([
      'http://localhost:11434/api/show',
      'http://localhost:11434/api/chat',
    ]);
    expect(replay.requests[0]?.body).toEqual({ model: 'qwen2.5:7b' });
    expect(chatBody(replay)).toEqual({
      model: 'qwen2.5:7b',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Say hello in three words.' },
      ],
      options: { num_ctx: 32_768, num_predict: 50, temperature: 0 },
    });
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 24,
      outputTokens: 6,
    });
  });

  it('takes num_ctx from the config, and maps tool history to the native shape', async () => {
    const { replay } = await chat(
      'tools',
      {
        ...TOOLS,
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.ts"}' }],
          },
          { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'x' },
        ],
      },
      { baseUrl: 'http://127.0.0.1:11434/v1/', capabilities: { contextTokens: 16_384 } },
    );
    const body = chatBody(replay);
    expect(replay.requests[1]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.options).toEqual({ num_ctx: 16_384 });
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
      },
      { role: 'tool', tool_name: 'read_file', content: 'x' },
    ]);
    expect(body.tools).toHaveLength(1);
  });

  it('native tool calls arrive whole, one per chunk (AC2)', async () => {
    const { events } = await chat('tools');
    expect(callsOf(events)).toEqual([
      { id: 'call_o0j0cm8x', name: 'read_file', args: '{"path":"a.ts"}' },
      { id: 'call_n53zf3qy', name: 'read_file', args: '{"path":"b.ts"}' },
    ]);
    // Ollama says "stop" even when the turn ends in tool calls.
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('ignores thinking and reports the answer', async () => {
    const { events } = await chat('thinking', TOOLS, { model: 'qwen3:4b' });
    expect(textOf(events)).toBe('Hi!');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('models without tool support use the text tool protocol', async () => {
    const { events, replay } = await chat('text-tools', TOOLS, { model: 'qwen2.5vl:3b' });
    const body = chatBody(replay);
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body.messages)).toContain('<tool_call>');
    expect(textOf(events).trimEnd()).toBe('Reading.');
    expect(callsOf(events)).toMatchObject([{ name: 'read_file', args: '{"path":"a.ts"}' }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('Ollama not running → network error with "Is Ollama running?" (AC3)', async () => {
    const adapter = createOllamaAdapter(context(refused));
    const events = await collectEvents(adapter.chat(TOOLS, new AbortController().signal));
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          kind: 'network',
          message: expect.stringContaining('ECONNREFUSED') as string,
          hint: OLLAMA_NOT_RUNNING_HINT,
        },
      },
    ]);
    await expect(adapter.capabilities()).rejects.toMatchObject({
      kind: 'network',
      hint: OLLAMA_NOT_RUNNING_HINT,
    });
  });

  it('Ollama not running, against a real closed local port (AC3)', async () => {
    // A port that was just free: nothing listens there, so the connection is refused.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    const adapter = createOllamaAdapter({
      ...context((url, init) => fetch(url, init)),
      config: {
        id: 'local',
        provider: 'ollama',
        model: 'x',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
    });
    const events = await collectEvents(adapter.chat(TOOLS, new AbortController().signal));
    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          kind: 'network',
          message: expect.stringContaining('ECONNREFUSED') as string,
          hint: OLLAMA_NOT_RUNNING_HINT,
        },
      },
    ]);
  });

  it('a model that is not pulled says how to pull it', async () => {
    const { adapter } = setup('not-pulled', { model: 'nope' });
    await expect(adapter.capabilities()).rejects.toMatchObject({
      kind: 'bad_request',
      hint: 'Pull it first: `ollama pull nope`.',
    });
  });

  it('caches a successful probe and retries a failed one', async () => {
    let calls = 0;
    const exchanges = [...fixture('not-pulled'), ...fixture('text')];
    const replay = replayFetch(exchanges);
    const adapter = createOllamaAdapter(
      context((url, init) => {
        calls++;
        return replay.fetch(url, init);
      }),
    );
    await expect(adapter.capabilities()).rejects.toMatchObject({ kind: 'bad_request' });
    const caps = await adapter.capabilities();
    expect(caps).toEqual({
      streaming: true,
      toolCalls: true,
      contextTokens: 32_768,
      vision: false,
    });
    await adapter.capabilities();
    expect(calls).toBe(2);
  });
});

describe('capabilitiesFromShow', () => {
  const show = (ctx: number, caps: string[], parameters?: string) => ({
    model_info: { 'general.architecture': 'x', 'x.context_length': ctx },
    capabilities: caps,
    ...(parameters ? { parameters } : {}),
  });

  it('caps the window at the default to keep KV-cache memory sane', () => {
    expect(capabilitiesFromShow(show(262_144, ['completion', 'tools', 'vision']))).toEqual({
      streaming: true,
      toolCalls: true,
      contextTokens: OLLAMA_DEFAULT_CONTEXT,
      vision: true,
    });
    expect(capabilitiesFromShow(show(8_192, ['completion'])).contextTokens).toBe(8_192);
  });

  it('respects a Modelfile num_ctx and the config, never past the model maximum', () => {
    expect(capabilitiesFromShow(show(131_072, [], 'num_ctx 65536\ntop_k 20')).contextTokens).toBe(
      65_536,
    );
    expect(capabilitiesFromShow(show(131_072, []), 100_000).contextTokens).toBe(100_000);
    expect(capabilitiesFromShow(show(8_192, []), 100_000).contextTokens).toBe(8_192);
    expect(capabilitiesFromShow({}).contextTokens).toBe(OLLAMA_DEFAULT_CONTEXT);
  });
});

describe('discoverOllama', () => {
  it('lists chat models from /api/tags with their capabilities, skipping embedding models', async () => {
    const replay = replayFetch(fixture('tags'));
    const models = await discoverOllama(
      { baseUrl: 'http://localhost:11434/v1', fetch: replay.fetch },
      new AbortController().signal,
    );
    expect(replay.requests[0]?.url).toBe('http://localhost:11434/api/tags');
    expect(models).toEqual([
      {
        model: 'qwen2.5vl:3b',
        capabilities: { toolCalls: false, vision: true, contextTokens: 32_768 },
      },
      {
        model: 'qwen3:8b',
        capabilities: { toolCalls: true, vision: false, contextTokens: 32_768 },
      },
      {
        model: 'qwen2.5:7b',
        capabilities: { toolCalls: true, vision: false, contextTokens: 32_768 },
      },
    ]);
  });

  it('fails fast when Ollama is not running', async () => {
    await expect(
      discoverOllama(
        { baseUrl: 'http://localhost:11434', fetch: refused },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('ollamaRoot', () => {
  it.each([
    [undefined, 'http://localhost:11434'],
    ['http://localhost:11434/v1', 'http://localhost:11434'],
    ['http://box:11434/v1/', 'http://box:11434'],
    ['http://box:11434', 'http://box:11434'],
  ])('%s → %s', (input, expected) => {
    expect(ollamaRoot(input)).toBe(expected);
  });
});
