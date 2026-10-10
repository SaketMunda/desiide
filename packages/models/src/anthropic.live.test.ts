import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from './anthropic.ts';
import { collectTurn } from './stream.ts';
import { assertStreamInvariants, collectEvents } from './testing/contract.ts';
import type { ChatMessage, ChatRequest } from './types.ts';

/**
 * Live smoke against the Anthropic API. Runs only with `DESIIDE_LIVE=1` and a key in
 * `DESIIDE_LIVE_ANTHROPIC_KEY` (env only, for this test; the app reads keys from SecretStorage):
 *
 *     DESIIDE_LIVE=1 DESIIDE_LIVE_ANTHROPIC_KEY=… pnpm -F @desiide/models test anthropic.live
 *
 * `DESIIDE_LIVE_ANTHROPIC_MODEL` picks the model (default `claude-opus-5-5`).
 */
const key = process.env.DESIIDE_LIVE_ANTHROPIC_KEY;
const live = process.env.DESIIDE_LIVE === '1' && key !== undefined && key !== '';
const model = process.env.DESIIDE_LIVE_ANTHROPIC_MODEL ?? 'claude-opus-5-5';

describe.skipIf(!live)(`live: Anthropic ${model}`, () => {
  const adapter = createAnthropicAdapter({
    config: { id: 'live', provider: 'anthropic', model, reasoning: 'low' },
    apiKey: () => Promise.resolve(key),
    secrets: () => (key ? [key] : []),
  });
  const req: ChatRequest = {
    system: 'You are a coding agent. Use the tools to answer.',
    messages: [{ role: 'user', content: 'What does src/a.ts export? Read the file.' }],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file in the workspace',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative path' } },
          required: ['path'],
        },
      },
    ],
    maxTokens: 2_000,
  };

  it(
    'completes a tool call, then answers with the thinking blocks round-tripped',
    { timeout: 180_000 },
    async () => {
      const events = assertStreamInvariants(
        await collectEvents(adapter.chat(req, AbortSignal.timeout(170_000))),
      );
      expect(events.at(-1), JSON.stringify(events.at(-1))).toEqual({
        type: 'done',
        stopReason: 'tool_calls',
      });
      const first = await collectTurn(
        (async function* () {
          yield* events;
        })(),
      );
      const call = first.toolCalls[0];
      expect(call?.name).toBe('read_file');
      const history: ChatMessage[] = [
        ...req.messages,
        {
          role: 'assistant',
          content: first.text,
          toolCalls: first.toolCalls,
          ...(first.providerState ? { providerState: first.providerState } : {}),
        },
        {
          role: 'tool',
          toolCallId: call?.id ?? '',
          name: 'read_file',
          content: 'export function add(a: number, b: number) { return a + b; }',
        },
      ];
      const second = await collectTurn(
        adapter.chat({ ...req, messages: history }, AbortSignal.timeout(170_000)),
      );
      expect(second.text).toMatch(/add/);
    },
  );
});
