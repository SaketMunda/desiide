import { DesiideConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROVIDERS } from './providers.ts';
import { createModelRegistry } from './registry.ts';
import { loadFixture, replayFetch } from './testing/fixtures.ts';

const fixture = (path: string) =>
  loadFixture(new URL(`../test/fixtures/${path}.jsonl`, import.meta.url).pathname);

describe('BUILTIN_PROVIDERS through the registry', () => {
  it('ships every provider the protocol names', () => {
    expect(Object.keys(BUILTIN_PROVIDERS).sort()).toEqual([
      'anthropic',
      'ollama',
      'openai-compatible',
    ]);
  });

  it('Anthropic end to end: key via secrets.get, models.test, published cost, no discovery', async () => {
    const replay = replayFetch(fixture('anthropic/text'));
    const asked: string[] = [];
    const registry = createModelRegistry({
      providers: BUILTIN_PROVIDERS,
      requestSecret: (name) => (asked.push(name), Promise.resolve('sk-ant-e2e')),
      fetch: replay.fetch,
    });
    registry.configure(
      DesiideConfig.parse({
        models: [
          {
            id: 'claude',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            apiKey: 'secret:anthropic',
          },
        ],
      }),
    );
    expect(await registry.test('claude', new AbortController().signal)).toMatchObject({ ok: true });
    expect(asked).toEqual(['secret:anthropic']);
    expect(replay.requests[0]?.headers['x-api-key']).toBe('sk-ant-e2e');
    expect(registry.config('claude')?.costPerMTok).toEqual({ input: 4, output: 20 });
    const { models, discovered } = await registry.list(
      { discover: true },
      new AbortController().signal,
    );
    expect(models).toMatchObject([
      {
        id: 'claude',
        healthy: true,
        locality: 'cloud',
        capabilities: { contextTokens: 1_000_000 },
      },
    ]);
    // Only the test request went to Anthropic; discovery never asks a cloud provider.
    const toAnthropic = replay.requests.filter((r) =>
      r.url.startsWith('https://api.anthropic.com'),
    );
    expect(toAnthropic).toHaveLength(1);
    expect(discovered.every((m) => m.provider !== 'anthropic')).toBe(true);
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
