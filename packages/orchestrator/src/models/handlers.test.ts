import { createModelRegistry, type ProviderDefinitions } from '@desiide/models';
import { createFakeModelAdapter } from '@desiide/models/testing';
import { PROTOCOL_VERSION } from '@desiide/protocol';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigUpdate } from '../config/handler.ts';
import { createHost } from '../host/host.ts';
import { registerModelHandlers } from './handlers.ts';

const connections: MessageConnection[] = [];

afterEach(() => {
  for (const c of connections.splice(0)) c.dispose();
});

async function setup(providers: ProviderDefinitions, secrets: Record<string, string> = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createMessageConnection(toServer, toClient);
  const client = createMessageConnection(toClient, toServer);
  connections.push(server, client);
  const host = createHost({ connection: server, logger: pino({ level: 'silent' }) });
  const registry = createModelRegistry({
    providers,
    requestSecret: (ref, signal) => host.requestSecret(ref, signal),
  });
  registerModelHandlers(host, registry);
  registerConfigUpdate(host, [(config) => registry.configure(config)]);
  const secretRequests: string[] = [];
  client.onRequest('secrets.get', ({ ref }: { ref: string }) => {
    secretRequests.push(ref);
    return { value: secrets[ref.slice('secret:'.length)] ?? null };
  });
  server.listen();
  client.listen();
  await client.sendRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test', version: '1.0.0' },
    workspaceRoots: ['/ws'],
  });
  return { client, secretRequests };
}

describe('models.* and config.update over RPC', () => {
  it('lists nothing before config, then the configured models', async () => {
    const providers: ProviderDefinitions = {
      ollama: {
        create: ({ config }) =>
          createFakeModelAdapter({ id: config.id, model: config.model, provider: 'ollama' }),
      },
    };
    const { client } = await setup(providers);
    expect(await client.sendRequest('models.list', {})).toEqual({ models: [], discovered: [] });
    expect(
      await client.sendRequest('config.update', {
        models: [
          { id: 'local', provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434/v1' },
        ],
        roles: { cheap: 'local' },
      }),
    ).toEqual({ ok: true });
    expect(await client.sendRequest('models.list', {})).toEqual({
      models: [
        {
          id: 'local',
          provider: 'ollama',
          model: 'qwen',
          role: 'cheap',
          healthy: true,
          locality: 'local',
          capabilities: {
            streaming: true,
            toolCalls: true,
            contextTokens: 32_000,
            maxOutputTokens: 4096,
            vision: false,
          },
        },
      ],
      discovered: [],
    });
  });

  it('models.test resolves the key through secrets.get and reports latency', async () => {
    let seenKey: string | undefined;
    const providers: ProviderDefinitions = {
      anthropic: {
        create: (ctx) => ({
          ...createFakeModelAdapter({ id: ctx.config.id }),
          async *chat(_req, signal) {
            seenKey = await ctx.apiKey(signal);
            yield { type: 'text_delta', text: 'OK' };
            yield { type: 'done', stopReason: 'end' };
          },
        }),
      },
    };
    const { client, secretRequests } = await setup(providers, { anthropic: 'sk-test-key-123' });
    await client.sendRequest('config.update', {
      models: [{ id: 'cloud', provider: 'anthropic', model: 'claude', apiKey: 'secret:anthropic' }],
    });
    const result = await client.sendRequest('models.test', { modelId: 'cloud' });
    expect(result).toMatchObject({ ok: true, latencyMs: expect.any(Number) as unknown });
    expect(seenKey).toBe('sk-test-key-123');
    expect(secretRequests).toEqual(['secret:anthropic']);
  });

  it('models.test reports a missing key as an auth error with a hint', async () => {
    const providers: ProviderDefinitions = {
      anthropic: {
        create: (ctx) => ({
          ...createFakeModelAdapter({ id: ctx.config.id }),
          async *chat(_req, signal) {
            await ctx.apiKey(signal);
            yield { type: 'done', stopReason: 'end' };
          },
        }),
      },
    };
    const { client } = await setup(providers);
    await client.sendRequest('config.update', {
      models: [{ id: 'cloud', provider: 'anthropic', model: 'claude', apiKey: 'secret:anthropic' }],
    });
    expect(await client.sendRequest('models.test', { modelId: 'cloud' })).toEqual({
      ok: false,
      error: {
        kind: 'auth',
        message: 'No API key is stored for "anthropic"',
        hint: 'Add the "anthropic" key in Desiide settings.',
      },
    });
  });

  it('a provider missing from this build lists as unhealthy and tests as unavailable', async () => {
    const { client } = await setup({});
    await client.sendRequest('config.update', {
      models: [
        {
          id: 'x',
          provider: 'openai-compatible',
          model: 'gpt',
          baseUrl: 'https://api.example.test/v1',
        },
      ],
    });
    const list = (await client.sendRequest('models.list', {})) as {
      models: Array<{ healthy: boolean }>;
    };
    expect(list.models[0]?.healthy).toBe(false);
    expect(await client.sendRequest('models.test', { modelId: 'x' })).toMatchObject({
      ok: false,
      error: { kind: 'bad_request', message: expect.stringContaining('not available') as unknown },
    });
  });
});
