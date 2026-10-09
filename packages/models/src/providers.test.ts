import { DesiideConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROVIDERS } from './providers.ts';
import { createModelRegistry } from './registry.ts';
import { loadFixture, replayFetch } from './testing/fixtures.ts';

const fixture = (path: string) =>
  loadFixture(new URL(`../test/fixtures/${path}.jsonl`, import.meta.url).pathname);

describe('BUILTIN_PROVIDERS through the registry', () => {
  it('ships openai-compatible and ollama', () => {
    expect(Object.keys(BUILTIN_PROVIDERS).sort()).toEqual(['ollama', 'openai-compatible']);
  });

  it('models.test against Ollama, and onboarding discovery of a running Ollama', async () => {
    const replay = replayFetch([...fixture('ollama/text'), ...fixture('ollama/tags')]);
    const registry = createModelRegistry({
      providers: BUILTIN_PROVIDERS,
      requestSecret: () => Promise.resolve(null),
      fetch: replay.fetch,
    });
    registry.configure(
      DesiideConfig.parse({ models: [{ id: 'local', provider: 'ollama', model: 'qwen2.5:7b' }] }),
    );
    expect(await registry.test('local', new AbortController().signal)).toMatchObject({ ok: true });
    const { models, discovered } = await registry.list(
      { discover: true },
      new AbortController().signal,
    );
    expect(models).toMatchObject([
      {
        id: 'local',
        healthy: true,
        locality: 'local',
        capabilities: { toolCalls: true, contextTokens: 32_768 },
      },
    ]);
    expect(discovered.map((m) => m.id)).toEqual(['ollama:qwen2.5vl:3b', 'ollama:qwen3:8b']);
    expect(replay.requests.at(-1)?.url).toBe('http://localhost:11434/api/tags');
  });

  it('an openai-compatible model without a baseUrl is listed as unavailable, with the reason', async () => {
    const registry = createModelRegistry({
      providers: BUILTIN_PROVIDERS,
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(
      DesiideConfig.parse({ models: [{ id: 'x', provider: 'openai-compatible', model: 'gpt-x' }] }),
    );
    expect(await registry.test('x', new AbortController().signal)).toMatchObject({
      ok: false,
      error: { kind: 'bad_request', message: expect.stringMatching(/needs a baseUrl/) as string },
    });
  });
});
