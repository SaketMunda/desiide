import type { ModelConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_KEY_HINT,
  anthropicProvider,
  buildAnthropicParams,
  createAnthropicAdapter,
} from './anthropic.ts';
import type { ProviderContext } from './registry.ts';
import { collectTurn } from './stream.ts';
import { assertStreamInvariants, collectEvents, runAdapterContract } from './testing/contract.ts';
import { loadFixture, replayFetch, type ReplayFetch } from './testing/fixtures.ts';
import type { ChatMessage, ChatRequest, StreamEvent } from './types.ts';

const fixture = (name: string) =>
  loadFixture(new URL(`../test/fixtures/anthropic/${name}.jsonl`, import.meta.url).pathname);

const KEY = 'sk-ant-api03-SENTINEL-9c1e';

function setup(
  name: string | string[],
  config: Partial<ModelConfig> = {},
  options: { maxRetries?: number; key?: string | undefined } = {},
) {
  const replay = replayFetch([name].flat().flatMap(fixture));
  const key = 'key' in options ? options.key : KEY;
  const ctx: ProviderContext = {
    config: {
      id: 'claude',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'secret:anthropic',
      ...config,
    },
    apiKey: () => Promise.resolve(key),
    secrets: () => [KEY],
    fetch: replay.fetch,
  };
  return {
    adapter: createAnthropicAdapter(ctx, { maxRetries: options.maxRetries ?? 0 }),
    replay,
  };
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read one file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const TOOLS: ChatRequest = {
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'Read a.ts and b.ts' }],
  tools: [READ_FILE],
};

async function chat(name: string | string[], req: ChatRequest = TOOLS, config = {}) {
  const { adapter, replay } = setup(name, config);
  const events = assertStreamInvariants(
    await collectEvents(adapter.chat(req, new AbortController().signal)),
  );
  return { events, replay };
}

const bodyOf = (replay: ReplayFetch, i = 0) => replay.requests[i]?.body as Record<string, unknown>;
const textOf = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
const reasoningOf = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'reasoning_delta' ? [e.text] : [])).join('');

describe('AnthropicAdapter', () => {
  // AC1: the MOD-1 contract over recorded-shape fixtures.
  runAdapterContract<string>((name) => setup(name).adapter, {
    text: { fixture: 'text', expectText: 'Hello, there!', expectUsage: true },
    toolCalls: {
      fixture: 'tools',
      expectCalls: [
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'read_file', args: { path: 'b.ts' } },
      ],
    },
    errors: [
      { fixture: 'error-401', kind: 'auth', label: 'an invalid key (401)' },
      { fixture: 'error-overloaded', kind: 'rate_limit', label: 'overloaded (529)' },
      { fixture: 'error-rate-limit', kind: 'rate_limit', label: 'a rate limit (429)' },
      { fixture: 'error-context-length', kind: 'context_length', label: 'prompt too long' },
      { fixture: 'error-midstream', kind: 'rate_limit', label: 'overloaded mid-stream' },
      { fixture: 'error-truncated', kind: 'network', label: 'a truncated stream' },
      { fixture: 'refusal', kind: 'bad_request', label: 'a refusal' },
    ],
    cancel: { fixture: 'cancel' },
  });

  it('sends the key only in x-api-key, to the default base URL, never with other credentials', async () => {
    const { replay } = await chat('text');
    const req = replay.requests[0];
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req?.headers['x-api-key']).toBe(KEY);
    expect(req?.headers).not.toHaveProperty('authorization');
  });

  it('ignores ANTHROPIC_* environment credentials and base URL (keys come from SecretStorage only)', async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = 'https://env-host.example.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    try {
      const { replay } = await chat('text');
      const req = replay.requests[0];
      expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
      expect(req?.headers['x-api-key']).toBe(KEY);
      expect(req?.headers).not.toHaveProperty('authorization');
      expect(JSON.stringify(req?.headers)).not.toMatch(/env-(token|key)/);
    } finally {
      process.env = saved;
    }
  });

  it('uses a configured base URL', async () => {
    const { replay } = await chat('text', TOOLS, { baseUrl: 'https://proxy.example.test/' });
    expect(replay.requests[0]?.url).toBe('https://proxy.example.test/v1/messages');
  });

  it('without a key fails with auth and a hint, and sends nothing', async () => {
    const { adapter, replay } = setup('text', {}, { key: undefined });
    const events = await collectEvents(adapter.chat(TOOLS, new AbortController().signal));
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          kind: 'auth',
          message: 'No API key is configured for "claude"',
          hint: ANTHROPIC_KEY_HINT,
        },
      },
    ]);
    expect(replay.requests).toHaveLength(0);
  });

  it('merges start and end usage into one event, cache tokens included', async () => {
    const { events } = await chat('cache-usage');
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      {
        type: 'usage',
        inputTokens: 9 + 4096 + 512,
        outputTokens: 3,
        cacheReadTokens: 4096,
        cacheWriteTokens: 512,
      },
    ]);
  });

  it('emits tool calls after the text, with the raw JSON the model wrote', async () => {
    const { events } = await chat('tools');
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'tool_call',
      'tool_call',
      'usage',
      'done',
    ]);
    expect(events[1]).toEqual({
      type: 'tool_call',
      call: { id: 'toolu_01A', name: 'read_file', args: '{"path": "a.ts"}' },
    });
  });

  it('a tool input cut off by max_tokens reaches the caller raw (so the loop reports it)', async () => {
    const { events } = await chat('max-tokens-tool');
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ call: { name: 'propose_edit' } });
    expect(() => JSON.parse(call?.type === 'tool_call' ? call.call.args : '')).toThrow();
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('a refusal is an error with the category, not a silent end', async () => {
    const { events } = await chat('refusal');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'bad_request', message: expect.stringContaining('(cyber)') as unknown },
    });
  });

  it('the SDK retries an overloaded response, then succeeds', async () => {
    const replay = replayFetch([
      ...fixture('error-overloaded').map((e) => ({
        ...e,
        headers: { ...e.headers, 'retry-after-ms': '1' },
      })),
      ...fixture('text'),
    ]);
    const adapter = createAnthropicAdapter(
      {
        config: { id: 'claude', provider: 'anthropic', model: 'claude-opus-5-5' },
        apiKey: () => Promise.resolve(KEY),
        secrets: () => [KEY],
        fetch: replay.fetch,
      },
      { maxRetries: 1 },
    );
    const events = await collectEvents(adapter.chat(TOOLS, new AbortController().signal));
    expect(textOf(events)).toBe('Hello, there!');
    expect(replay.requests).toHaveLength(2);
  });

  it('never leaks the key into events', async () => {
    for (const name of ['error-401', 'error-overloaded', 'error-midstream', 'text']) {
      const { events } = await chat(name);
      expect(JSON.stringify(events)).not.toContain(KEY);
    }
  });

  it('a stalled stream ends with timeout', async () => {
    const replay = replayFetch(fixture('cancel'));
    const adapter = createAnthropicAdapter(
      {
        config: { id: 'claude', provider: 'anthropic', model: 'claude-opus-5-5' },
        apiKey: () => Promise.resolve(KEY),
        secrets: () => [KEY],
        fetch: replay.fetch,
      },
      { maxRetries: 0, timeouts: { idleMs: 50 } },
    );
    const events = assertStreamInvariants(
      await collectEvents(adapter.chat(TOOLS, new AbortController().signal)),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
  });

  it('reports capabilities from the model table, and cost through the provider', async () => {
    const { adapter } = setup('text');
    expect(await adapter.capabilities()).toEqual({
      streaming: true,
      toolCalls: true,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      vision: true,
    });
    expect(anthropicProvider.costPerMTok?.('claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(anthropicProvider.costPerMTok?.('claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      output: 5,
    });
    expect(anthropicProvider.costPerMTok?.('claude-opus-9')).toBeUndefined();
  });
});

describe('message mapping (AC2)', () => {
  const params = (messages: ChatMessage[], req: Partial<ChatRequest> = {}) =>
    buildAnthropicParams('claude-opus-5-5', { messages, ...req }, 'claude', undefined);

  it('keeps the system prompt separate and merges consecutive same-role messages', () => {
    const p = params(
      [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'three' },
      ],
      { system: 'sys' },
    );
    expect(p.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(p.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('pairs tool calls with their results: one user turn of tool_results, results first', () => {
    const p = params([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'Reading.',
        toolCalls: [
          { id: 't1', name: 'read_file', args: '{"path":"a.ts"}' },
          { id: 't2', name: 'read_file', args: '{"path":"b.ts"}' },
        ],
      },
      { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'A' },
      { role: 'tool', toolCallId: 't2', name: 'read_file', content: 'nope', isError: true },
      { role: 'user', content: 'Tests failed.' },
    ]);
    expect(p.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'A' },
          { type: 'tool_result', tool_use_id: 't2', content: 'nope', is_error: true },
          { type: 'text', text: 'Tests failed.' },
        ],
      },
    ]);
  });

  it('drops empty text, gives empty results a placeholder, and malformed args an empty input', () => {
    const p = params([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', args: '{bad' }] },
      { role: 'tool', toolCallId: 't1', name: 'x', content: '' },
    ]);
    expect(p.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
    });
    expect(p.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '(no output)' }],
    });
  });

  it('repairs broken pairing instead of sending a request the API rejects', () => {
    const p = params([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', args: '{}' }] },
      { role: 'user', content: 'never mind' },
      { role: 'tool', toolCallId: 'ghost', name: 'x', content: 'late' },
    ]);
    expect(p.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'No result was recorded for this call.',
            is_error: true,
          },
          { type: 'text', text: 'Tool result (ghost):\nlate' },
          { type: 'text', text: 'never mind' },
        ],
      },
    ]);
  });

  it('sends tools with eager input streaming and their schema as input_schema', () => {
    const p = params([{ role: 'user', content: 'go' }], { tools: [READ_FILE] });
    expect(p.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read one file',
        input_schema: READ_FILE.inputSchema,
        eager_input_streaming: true,
      },
    ]);
  });

  it('ignores provider state another adapter owns', () => {
    const p = params([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'hi',
        providerState: {
          owner: 'other-model',
          data: { blocks: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
        },
      },
    ]);
    expect(p.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });
  });
});

describe('prompt caching (AC3)', () => {
  const marked = (p: ReturnType<typeof buildAnthropicParams>) =>
    JSON.stringify(p)
      .split('"cache_control"')
      .slice(0, -1)
      .map((before) => /"text":"([^"]*)"[^{}]*$/.exec(before)?.[1]);

  it('marks only the system prompt and cacheable messages', () => {
    const p = buildAnthropicParams(
      'claude-opus-5-5',
      {
        system: 'SYSTEM',
        tools: [READ_FILE],
        messages: [
          { role: 'user', content: 'REPO MAP', cacheable: true },
          { role: 'user', content: 'Fix the bug' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'volatile' },
        ],
      },
      'claude',
      undefined,
    );
    expect(marked(p).sort()).toEqual(['REPO MAP', 'SYSTEM']);
    // The repo map merges into one turn with the instruction, but only its block is marked.
    expect(p.messages[0]?.content).toEqual([
      { type: 'text', text: 'REPO MAP', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Fix the bug' },
    ]);
    expect(p).not.toHaveProperty('cache_control');
  });

  it('an append-only agent loop keeps rolling breakpoints on its latest turns, one per turn', () => {
    const p = buildAnthropicParams(
      'claude-opus-5-5',
      {
        system: 'S',
        messages: [
          { role: 'user', content: 'task', cacheable: true },
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', args: '{}' }] },
          { role: 'tool', toolCallId: 't1', name: 'x', content: 'r1', cacheable: true },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't2', name: 'x', args: '{}' },
              { id: 't3', name: 'x', args: '{}' },
            ],
          },
          { role: 'tool', toolCallId: 't2', name: 'x', content: 'r2', cacheable: true },
          { role: 'tool', toolCallId: 't3', name: 'x', content: 'r3', cacheable: true },
        ],
      },
      'claude',
      undefined,
    );
    const marks = p.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.flatMap((b) =>
            'cache_control' in b && b.cache_control
              ? [b.type === 'tool_result' ? b.content : b.type === 'text' ? b.text : '?']
              : [],
          )
        : [],
    );
    // System + the last block of each of the three cacheable turns; r2 shares a turn with r3.
    expect(marks).toEqual(['task', 'r1', 'r3']);
    expect(p.system?.[0]).toHaveProperty('cache_control');
  });

  it('adds no markers when nothing is cacheable', () => {
    const p = buildAnthropicParams(
      'claude-opus-5-5',
      { messages: [{ role: 'user', content: 'hi' }] },
      'claude',
      undefined,
    );
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('stays within four breakpoints, keeping the latest cacheable sections', () => {
    const messages: ChatMessage[] = ['a', 'b', 'c', 'd', 'e'].flatMap((t) => [
      { role: 'user' as const, content: t, cacheable: true },
      { role: 'assistant' as const, content: 'ok' },
    ]);
    const p = buildAnthropicParams(
      'claude-opus-5-5',
      { system: 'S', messages },
      'claude',
      undefined,
    );
    expect(marked(p).sort()).toEqual(['S', 'c', 'd', 'e']);
  });

  it('snapshot of a cached request as sent over the wire', async () => {
    const { replay } = await chat('cache-usage', {
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'REPO MAP', cacheable: true }],
    });
    expect(bodyOf(replay)).toMatchInlineSnapshot(`
      {
        "max_tokens": 32000,
        "messages": [
          {
            "content": [
              {
                "cache_control": {
                  "type": "ephemeral",
                },
                "text": "REPO MAP",
                "type": "text",
              },
            ],
            "role": "user",
          },
        ],
        "model": "claude-opus-5-5",
        "stream": true,
        "system": [
          {
            "cache_control": {
              "type": "ephemeral",
            },
            "text": "SYSTEM",
            "type": "text",
          },
        ],
        "thinking": {
          "display": "summarized",
          "type": "adaptive",
        },
      }
    `);
  });
});

describe('reasoning (ADR-022, AC5)', () => {
  it('streams thinking as reasoning_delta and keeps the signed blocks as provider state', async () => {
    const { events } = await chat('thinking-tool-turn');
    expect(reasoningOf(events)).toBe('The user wants a.ts.\nI should read it first.');
    expect(textOf(events)).toBe('Let me read it.');
    expect(events.map((e) => e.type)).toEqual([
      'reasoning_delta',
      'reasoning_delta',
      'text_delta',
      'tool_call',
      'provider_state',
      'usage',
      'done',
    ]);
    const state = events.find((e) => e.type === 'provider_state');
    expect(state).toMatchObject({ state: { owner: 'claude' } });
  });

  it('thinking blocks survive a tool-use turn: replayed verbatim and in order', async () => {
    const { adapter, replay } = setup('thinking-tool-turn');
    const signal = new AbortController().signal;
    const first = await collectTurn(adapter.chat(TOOLS, signal));
    expect(first.reasoning).toBe('The user wants a.ts.\nI should read it first.');
    const history: ChatMessage[] = [
      ...TOOLS.messages,
      {
        role: 'assistant',
        content: first.text,
        toolCalls: first.toolCalls,
        ...(first.providerState ? { providerState: first.providerState } : {}),
      },
      { role: 'tool', toolCallId: 'toolu_01T', name: 'read_file', content: 'export const add…' },
    ];
    const second = await collectTurn(adapter.chat({ ...TOOLS, messages: history }, signal));
    expect(second.text).toBe('a.ts exports `add`.');

    const sent = bodyOf(replay, 1).messages as Array<{ role: string; content: unknown[] }>;
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'The user wants a.ts.\nI should read it first.',
          signature:
            'EqQBCkgIBxABGAIiQL1fixture1signature0000000000000000000000000000000000000000AA==',
        },
        { type: 'redacted_thinking', data: 'EmwKAhgBEgy3fixtureRedactedPayload==' },
        { type: 'text', text: 'Let me read it.' },
        { type: 'tool_use', id: 'toolu_01T', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    expect(sent[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01T', content: 'export const add…' }],
    });
  });

  it('a different model gets no thinking blocks from history', () => {
    const p = buildAnthropicParams(
      'claude-sonnet-5-5',
      {
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'hi',
            providerState: {
              owner: 'claude',
              data: { blocks: [{ type: 'thinking', thinking: 'secret plan', signature: 's' }] },
            },
          },
        ],
      },
      'claude-cheap',
      undefined,
    );
    expect(JSON.stringify(p)).not.toContain('secret plan');
  });

  it.each([
    // [model, level, thinking, effort, extra max_tokens]
    ['claude-opus-5-5', undefined, { type: 'adaptive', display: 'summarized' }, undefined],
    ['claude-opus-5-5', 'high', { type: 'adaptive', display: 'summarized' }, 'high'],
    ['claude-opus-5-5', 'off', { type: 'adaptive', display: 'summarized' }, 'low'],
    ['claude-sonnet-5-5', 'off', { type: 'between_tools' }, undefined],
    ['claude-sonnet-5-5', 'medium', { type: 'adaptive', display: 'summarized' }, 'medium'],
    ['claude-opus-4-8', undefined, undefined, undefined],
    ['claude-opus-4-8', 'off', { type: 'disabled' }, undefined],
    ['claude-opus-4-8', 'low', { type: 'adaptive', display: 'summarized' }, 'low'],
    ['claude-haiku-4-5', undefined, undefined, undefined],
    ['claude-haiku-4-5', 'off', undefined, undefined],
    [
      'claude-haiku-4-5',
      'medium',
      { type: 'enabled', budget_tokens: 8192, display: 'summarized' },
      undefined,
    ],
    ['claude-opus-9', 'off', { type: 'adaptive', display: 'summarized' }, 'low'],
  ] as const)('%s with reasoning %s', (model, level, thinking, effort) => {
    const p = buildAnthropicParams(
      model,
      { messages: [{ role: 'user', content: 'go' }], ...(level ? { reasoning: level } : {}) },
      'claude',
      undefined,
    );
    expect(p.thinking).toEqual(thinking);
    expect(p.output_config).toEqual(effort ? { effort } : undefined);
  });

  it('a thinking budget raises max_tokens so the answer keeps its room', () => {
    const p = buildAnthropicParams(
      'claude-haiku-4-5',
      { messages: [{ role: 'user', content: 'go' }], maxTokens: 1000, reasoning: 'high' },
      'claude',
      undefined,
    );
    expect(p.max_tokens).toBe(1000 + 24_576);
  });

  it('the configured level applies unless the request overrides it', () => {
    const base = { messages: [{ role: 'user' as const, content: 'go' }] };
    expect(buildAnthropicParams('claude-opus-4-8', base, 'c', 'high').output_config).toEqual({
      effort: 'high',
    });
    expect(
      buildAnthropicParams('claude-opus-4-8', { ...base, reasoning: 'off' }, 'c', 'high').thinking,
    ).toEqual({ type: 'disabled' });
  });

  it('temperature only goes to models that accept it, and never with thinking on', () => {
    const req = { messages: [{ role: 'user' as const, content: 'go' }], temperature: 0.2 };
    expect(buildAnthropicParams('claude-opus-5-5', req, 'c', undefined)).not.toHaveProperty(
      'temperature',
    );
    expect(buildAnthropicParams('claude-opus-4-6', req, 'c', undefined).temperature).toBe(0.2);
    expect(buildAnthropicParams('claude-opus-4-6', req, 'c', 'high')).not.toHaveProperty(
      'temperature',
    );
  });
});
