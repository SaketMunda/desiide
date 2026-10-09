import { describe, expect, it } from 'vitest';
import { createOllamaAdapter } from './ollama.ts';
import { assertStreamInvariants, collectEvents } from './testing/contract.ts';

/**
 * Live smoke against a local Ollama. Runs only with `DESIIDE_LIVE=1`:
 *
 *     DESIIDE_LIVE=1 pnpm -F @desiide/models test ollama.live
 *
 * `DESIIDE_LIVE_OLLAMA_MODEL` picks the model (default `qwen2.5-coder:7b`; it must be pulled).
 */
const live = process.env.DESIIDE_LIVE === '1';
const model = process.env.DESIIDE_LIVE_OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
const baseUrl = process.env.DESIIDE_LIVE_OLLAMA_URL ?? 'http://localhost:11434/v1';

describe.skipIf(!live)(`live: Ollama ${model}`, () => {
  const adapter = createOllamaAdapter({
    config: { id: 'live', provider: 'ollama', model, baseUrl },
    apiKey: () => Promise.resolve(undefined),
    secrets: () => [],
  });

  it('completes a tool call', { timeout: 180_000 }, async () => {
    const events = assertStreamInvariants(
      await collectEvents(
        adapter.chat(
          {
            system: 'You are a coding agent. Use the tools to answer.',
            messages: [{ role: 'user', content: 'What is in src/a.ts? Read the file.' }],
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
            temperature: 0,
          },
          AbortSignal.timeout(170_000),
        ),
      ),
    );
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls.length, JSON.stringify(events.at(-1))).toBeGreaterThan(0);
    expect(calls[0]?.name).toBe('read_file');
    expect(JSON.parse(calls[0]?.args ?? '')).toMatchObject({
      path: expect.stringContaining('a.ts'),
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('reports its capabilities from /api/show', async () => {
    const caps = await adapter.capabilities();
    expect(caps.contextTokens).toBeGreaterThan(0);
  });
});
