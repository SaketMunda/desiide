import type { DesiideConfigInput, ModelConfig } from '@desiide/protocol';
import { DesiideConfig } from '@desiide/protocol';
import { describe, expect, it, vi } from 'vitest';
import { errorEvent, toModelError } from './errors.ts';
import { httpRequest, type FetchLike } from './http.ts';
import {
  createModelRegistry,
  type ProviderDefinition,
  type ProviderDefinitions,
} from './registry.ts';
import { createSecretResolver } from './secrets.ts';
import { parseSse } from './sse.ts';
import { createFakeModelAdapter, type FakeTurn } from './testing/fake.ts';
import type { ModelAdapter } from './types.ts';

const SENTINEL = 'sk-SENTINEL-registry-7f3a9c';
const signal = (): AbortSignal => new AbortController().signal;
const config = (input: DesiideConfigInput): DesiideConfig => DesiideConfig.parse(input);

/** Fake provider: each configured model gets a FakeModelAdapter with the given turns. */
function fakeProvider(
  turns: Record<string, FakeTurn[]> = {},
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    create: ({ config }) =>
      createFakeModelAdapter({
        id: config.id,
        provider: config.provider,
        model: config.model,
        turns: turns[config.id] ?? [],
        capabilities: { contextTokens: 16_000, toolCalls: true },
      }),
    ...extra,
  };
}

const local: ModelConfig = {
  id: 'local',
  provider: 'ollama',
  model: 'qwen',
  baseUrl: 'http://localhost:11434/v1',
};
const cloud: ModelConfig = {
  id: 'cloud',
  provider: 'anthropic',
  model: 'claude',
  apiKey: 'secret:anthropic',
};

describe('createSecretResolver', () => {
  it('caches values in memory and shares concurrent lookups', async () => {
    const request = vi.fn(() => Promise.resolve(SENTINEL));
    const resolver = createSecretResolver(request);
    const [a, b] = await Promise.all([resolver.resolve('secret:x'), resolver.resolve('secret:x')]);
    expect(a).toBe(SENTINEL);
    expect(b).toBe(SENTINEL);
    await resolver.resolve('secret:x');
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolver.known()).toEqual([SENTINEL]);
  });

  it('clear() forgets values so the next lookup asks again', async () => {
    const request = vi.fn(() => Promise.resolve(SENTINEL));
    const resolver = createSecretResolver(request);
    await resolver.resolve('secret:x');
    resolver.clear();
    expect(resolver.known()).toEqual([]);
    await resolver.resolve('secret:x');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a lookup that finishes after clear() does not repopulate the cache', async () => {
    let release: (v: string) => void = () => {};
    const resolver = createSecretResolver(() => new Promise((r) => (release = r)));
    const pending = resolver.resolve('secret:x');
    resolver.clear();
    release(SENTINEL);
    await pending;
    expect(resolver.known()).toEqual([]);
  });

  it('an unset key is an actionable auth error and is not cached', async () => {
    const request = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(SENTINEL);
    const resolver = createSecretResolver(request);
    await expect(resolver.resolve('secret:openai')).rejects.toMatchObject({
      kind: 'auth',
      hint: expect.stringContaining('openai') as unknown,
    });
    await expect(resolver.resolve('secret:openai')).resolves.toBe(SENTINEL);
  });

  it('rejects malformed refs and maps transport failures', async () => {
    const resolver = createSecretResolver(() =>
      Promise.reject(new Error(`rpc closed ${SENTINEL}`)),
    );
    await expect(resolver.resolve('plain-key')).rejects.toMatchObject({ kind: 'auth' });
    const error = await resolver.resolve('secret:x').catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(SENTINEL);
  });
});

describe('ModelRegistry', () => {
  it('builds adapters from config and resolves roles', () => {
    const registry = createModelRegistry({
      providers: { ollama: fakeProvider(), anthropic: fakeProvider() },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(
      config({ models: [local, cloud], roles: { cheap: 'local', strong: 'cloud' } }),
    );
    expect(registry.get('local').model).toBe('qwen');
    expect(registry.forRole('strong').id).toBe('cloud');
    expect(() => registry.forRole('reviewer')).toThrow(/reviewer/);
    expect(() => registry.get('nope')).toThrow(expect.objectContaining({ kind: 'bad_request' }));
    expect(registry.config('cloud')).toEqual(cloud);
  });

  it('an unset role falls back to the only configured model', () => {
    const registry = createModelRegistry({
      providers: { ollama: fakeProvider() },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(config({ models: [local] }));
    expect(registry.forRole('strong').id).toBe('local');
  });

  it('config-declared capabilities override adapter ones', async () => {
    const registry = createModelRegistry({
      providers: { ollama: fakeProvider() },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(
      config({ models: [{ ...local, capabilities: { contextTokens: 4096, toolCalls: false } }] }),
    );
    expect(await registry.capabilities('local')).toEqual({
      streaming: true,
      toolCalls: false,
      contextTokens: 4096,
      maxOutputTokens: 4096,
      vision: false,
    });
  });

  it('lists models with role, capabilities and health; missing providers are unhealthy', async () => {
    const registry = createModelRegistry({
      providers: { ollama: fakeProvider() },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(config({ models: [local, cloud], roles: { cheap: 'local' } }));
    const { models, discovered } = await registry.list({ discover: false }, signal());
    expect(discovered).toEqual([]);
    expect(models).toEqual([
      expect.objectContaining({
        id: 'local',
        role: 'cheap',
        healthy: true,
        locality: 'local',
        capabilities: expect.objectContaining({ contextTokens: 16_000 }) as unknown,
      }),
      expect.objectContaining({
        id: 'cloud',
        healthy: false,
        locality: 'cloud',
        capabilities: expect.objectContaining({ contextTokens: 8192, toolCalls: false }) as unknown,
      }),
    ]);
    expect(() => registry.get('cloud')).toThrow(/not available/);
    expect(await registry.test('cloud', signal())).toMatchObject({
      ok: false,
      error: { kind: 'bad_request' },
    });
  });

  it('a failing capability probe lists the model as unhealthy instead of failing the list', async () => {
    const providers: ProviderDefinitions = {
      ollama: {
        create: ({ config: c }) => ({
          ...createFakeModelAdapter({ id: c.id }),
          capabilities: () => Promise.reject(new Error('down')),
        }),
      },
    };
    const registry = createModelRegistry({ providers, requestSecret: () => Promise.resolve(null) });
    registry.configure(config({ models: [local] }));
    const { models } = await registry.list({ discover: false }, signal());
    expect(models[0]).toMatchObject({ id: 'local', healthy: false });
  });

  it('models.test reports latency, error kinds, and updates health', async () => {
    let t = 0;
    const registry = createModelRegistry({
      providers: {
        ollama: fakeProvider({
          local: [{ text: 'OK', delayMs: 1 }, { error: { kind: 'rate_limit' } }],
        }),
      },
      requestSecret: () => Promise.resolve(null),
      now: () => (t += 40),
    });
    registry.configure(config({ models: [local] }));
    expect(await registry.test('local', signal())).toEqual({ ok: true, latencyMs: 40 });
    const failed = await registry.test('local', signal());
    expect(failed).toMatchObject({
      ok: false,
      error: { kind: 'rate_limit', hint: expect.any(String) as unknown },
    });
    expect((await registry.list({ discover: false }, signal())).models[0]?.healthy).toBe(false);
    expect(await registry.test('ghost', signal())).toMatchObject({
      ok: false,
      error: { kind: 'bad_request' },
    });
  });

  it('models.test stops the stream once the model answers', async () => {
    let seen: AbortSignal | undefined;
    const providers: ProviderDefinitions = {
      ollama: {
        create: () => ({
          ...createFakeModelAdapter(),
          async *chat(_req, s) {
            seen = s;
            yield { type: 'text_delta', text: 'OK' };
            yield { type: 'text_delta', text: ' and a long essay…' };
            yield { type: 'done', stopReason: 'end' };
          },
        }),
      },
    };
    const registry = createModelRegistry({ providers, requestSecret: () => Promise.resolve(null) });
    registry.configure(config({ models: [local] }));
    expect((await registry.test('local', signal())).ok).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it('config.update clears cached keys and health', async () => {
    const requestSecret = vi.fn(() => Promise.resolve(SENTINEL));
    let adapterKey: string | undefined;
    const providers: ProviderDefinitions = {
      anthropic: {
        create: (ctx) => ({
          ...createFakeModelAdapter({
            id: ctx.config.id,
            turns: [{ error: { kind: 'auth' } }, { text: 'OK' }],
          }),
          async *chat(req, s) {
            adapterKey = await ctx.apiKey(s);
            yield* createFakeModelAdapter({ turns: [{ text: 'OK' }] }).chat(req, s);
          },
        }),
      },
    };
    const registry = createModelRegistry({ providers, requestSecret });
    registry.configure(config({ models: [cloud] }));
    await registry.test('cloud', signal());
    await registry.test('cloud', signal());
    expect(requestSecret).toHaveBeenCalledTimes(1);
    expect(adapterKey).toBe(SENTINEL);
    expect(registry.knownSecrets()).toEqual([SENTINEL]);
    registry.configure(config({ models: [cloud] }));
    expect(registry.knownSecrets()).toEqual([]);
    await registry.test('cloud', signal());
    expect(requestSecret).toHaveBeenCalledTimes(2);
  });

  it('discovers unconfigured models on configured base URLs only, best-effort', async () => {
    const discover = vi.fn(({ baseUrl }: { baseUrl: string }) =>
      baseUrl.includes('broken')
        ? Promise.reject(new Error('down'))
        : Promise.resolve([
            { model: 'qwen' },
            { model: 'llama3', capabilities: { toolCalls: true } },
          ]),
    );
    const registry = createModelRegistry({
      providers: { ollama: fakeProvider({}, { discover }) },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(
      config({ models: [local, { ...local, id: 'other', baseUrl: 'http://broken:11434/v1' }] }),
    );
    const { discovered } = await registry.list({ discover: true }, signal());
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discovered).toEqual([
      {
        id: 'ollama:llama3',
        provider: 'ollama',
        model: 'llama3',
        healthy: true,
        capabilities: { streaming: true, toolCalls: true, contextTokens: 8192, vision: false },
        locality: 'local',
      },
    ]);
    await registry.list({ discover: false }, signal());
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('with discover, finds a server at its default loopback URL even when nothing is configured', async () => {
    const discover = vi.fn(() => Promise.resolve([{ model: 'qwen2.5-coder:7b' }]));
    const remoteDefault = vi.fn(() => Promise.resolve([{ model: 'x' }]));
    const registry = createModelRegistry({
      providers: {
        ollama: fakeProvider({}, { discover, defaultBaseUrl: 'http://localhost:11434/v1' }),
        // A default that isn't loopback is never probed on its own.
        'openai-compatible': fakeProvider(
          {},
          { discover: remoteDefault, defaultBaseUrl: 'https://api.example.test/v1' },
        ),
      },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(config({ models: [] }));
    expect((await registry.list({ discover: false }, signal())).discovered).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
    const { discovered } = await registry.list({ discover: true }, signal());
    expect(discover).toHaveBeenCalledWith(
      { baseUrl: 'http://localhost:11434/v1' },
      expect.anything(),
    );
    expect(remoteDefault).not.toHaveBeenCalled();
    expect(discovered).toMatchObject([
      { id: 'ollama:qwen2.5-coder:7b', provider: 'ollama', locality: 'local' },
    ]);
  });

  it('a configured Ollama without a baseUrl uses the default and is not rediscovered', async () => {
    const discover = vi.fn(() => Promise.resolve([{ model: 'qwen' }, { model: 'other' }]));
    const registry = createModelRegistry({
      providers: {
        ollama: fakeProvider({}, { discover, defaultBaseUrl: 'http://localhost:11434/v1' }),
      },
      requestSecret: () => Promise.resolve(null),
    });
    registry.configure(config({ models: [{ id: 'local', provider: 'ollama', model: 'qwen' }] }));
    const { discovered } = await registry.list({ discover: true }, signal());
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discovered.map((m) => m.model)).toEqual(['other']);
  });
});

describe('sentinel key never leaks (registry + http end to end)', () => {
  /** A minimal HTTP provider like MOD-2 will build: key in a header, errors from httpRequest. */
  function httpProvider(fetch: FetchLike): ProviderDefinition {
    return {
      create: (ctx): ModelAdapter => ({
        id: ctx.config.id,
        provider: ctx.config.provider,
        model: ctx.config.model,
        capabilities: () =>
          Promise.resolve({
            streaming: true,
            toolCalls: false,
            contextTokens: 1000,
            vision: false,
          }),
        async *chat(_req, s) {
          try {
            const key = await ctx.apiKey(s);
            const res = await httpRequest(
              {
                url: `${ctx.config.baseUrl ?? ''}/chat?key=${key ?? ''}`,
                headers: { authorization: `Bearer ${key ?? ''}` },
                body: {},
              },
              {
                signal: s,
                fetch,
                secrets: ctx.secrets(),
                sleep: () => Promise.resolve(),
                ...(ctx.logger ? { logger: ctx.logger } : {}),
              },
            );
            for await (const e of parseSse(res.body())) yield { type: 'text_delta', text: e.data };
            yield { type: 'done', stopReason: 'end' };
          } catch (error) {
            yield errorEvent(toModelError(error, s, ctx.secrets()));
          }
        },
      }),
    };
  }

  it('keeps the key out of models.test results and logs', async () => {
    const logs: string[] = [];
    const logger = {
      debug: (o: object, m?: string) => logs.push(JSON.stringify(o) + (m ?? '')),
      warn: (o: object, m?: string) => logs.push(JSON.stringify(o) + (m ?? '')),
    };
    const echo =
      (status: number): FetchLike =>
      () =>
        Promise.resolve(
          new Response(`{"error":"bad key ${SENTINEL}"}`, {
            status,
            headers: { 'retry-after': '0' },
          }),
        );
    const fetches: FetchLike[] = [
      echo(401),
      echo(503),
      () => Promise.reject(new TypeError(`connect ECONNREFUSED ${SENTINEL}`)),
    ];
    for (const fetch of fetches) {
      const registry = createModelRegistry({
        providers: { 'openai-compatible': httpProvider(fetch) },
        requestSecret: () => Promise.resolve(SENTINEL),
        logger,
      });
      registry.configure(
        config({
          models: [
            {
              id: 'm',
              provider: 'openai-compatible',
              model: 'x',
              baseUrl: 'https://api.example.test/v1',
              apiKey: 'secret:k',
            },
          ],
        }),
      );
      const result = await registry.test('m', signal());
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(JSON.stringify(await registry.list({ discover: false }, signal()))).not.toContain(
        SENTINEL,
      );
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(SENTINEL);
  });
});
