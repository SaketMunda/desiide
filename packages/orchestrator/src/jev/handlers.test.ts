import { createModelRegistry } from '@desiide/models';
import { createFakeModelAdapter } from '@desiide/models/testing';
import {
  ClientMethods,
  JevPackState,
  KnownPack,
  LogNotification,
  PROTOCOL_VERSION,
  type ModelInfo,
} from '@desiide/protocol';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigUpdate } from '../config/handler.ts';
import { createContextEngine } from '../context/engine.ts';
import { createHost } from '../host/host.ts';
import { createWorkspacePolicy } from '../policy/workspacePolicy.ts';
import { makeTestWorkspace } from '../tools/testWorkspace.ts';
import {
  availableModels,
  costTierOf,
  jevTestResult,
  pickSample,
  registerJevHandlers,
  workspaceSampler,
} from './handlers.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Appears in every file body; must never appear in a preview. */
const SENTINEL = 'SENTINEL_FILE_CONTENT_7f3a';
const SALT = 'f'.repeat(64);

async function setup(files: Record<string, string>) {
  const ws = await makeTestWorkspace(files, { git: true });
  cleanups.push(() => ws.dispose());
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createMessageConnection(toServer, toClient);
  const client: MessageConnection = createMessageConnection(toClient, toServer);
  const host = createHost({ connection: server, logger: pino({ level: 'silent' }) });
  cleanups.push(
    () => host.shutdown('test done'),
    () => client.dispose(),
  );
  const models = createModelRegistry({
    providers: { ollama: { create: () => createFakeModelAdapter({ id: 'local', turns: [] }) } },
    requestSecret: () => Promise.resolve(null),
  });
  let ids = 0;
  const policy = createWorkspacePolicy(host, { newId: () => `dec${++ids}` });
  registerConfigUpdate(host, [(c) => models.configure(c), policy.onConfig]);
  const context = createContextEngine({ workspaceRoots: () => host.session?.workspaceRoots });
  registerJevHandlers(host, {
    models,
    redactor: () => policy.redactor(),
    jevSettings: () => policy.jevSettings(),
    git: (signal) => policy.git(signal),
    sampleFiles: workspaceSampler({
      workspaceRoots: () => host.session?.workspaceRoots,
      describeFiles: (paths, signal) => context.describeFiles(paths, signal),
    }),
  });
  const logs: LogNotification[] = [];
  client.onNotification('log', (raw: unknown) => {
    logs.push(LogNotification.parse(raw));
  });
  server.listen();
  client.listen();
  await client.sendRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test', version: '1.0.0' },
    workspaceRoots: [ws.root],
  });
  const preview = async (pack: KnownPack): Promise<JevPackState> => {
    const raw = await client.sendRequest('jev.preview', { pack });
    return ClientMethods['jev.preview'].result.parse(raw).state;
  };
  return { client, logs, preview };
}

const FILES = {
  'src/acmecorp/invoice.ts': `export const total = 1; // ${SENTINEL}\n`,
  'src/app.ts': `console.log('${SENTINEL}');\nexport {};\n`,
  'README.md': `# Readme\n${SENTINEL}\n`,
  '.env': `API_KEY=${SENTINEL}\n`,
};

const config = (jev: Record<string, unknown> = {}) => ({
  models: [
    { id: 'local', provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434/v1' },
  ],
  jev,
});

describe('jev.preview (AC5: metadata only)', () => {
  it('builds every pack from the real workspace without any file contents', async () => {
    const s = await setup(FILES);
    await s.client.sendRequest('config.update', config());
    for (const pack of KnownPack.options) {
      const state = await s.preview(pack);
      expect(state.pack).toBe(pack);
      const json = JSON.stringify(state);
      expect(json).not.toContain(SENTINEL);
      expect(json).not.toContain('API_KEY');
    }
    const wf = await s.preview('workflow_select@1');
    if (wf.pack !== 'workflow_select@1') throw new Error('unreachable');
    expect(wf.filesTouched.map((f) => f.path).sort()).toEqual(
      ['.env', 'README.md', 'src/app.ts', 'src/acmecorp/invoice.ts'].sort(),
    );
    expect(wf.filesTouched.find((f) => f.path === '.env')?.sensitive).toBe(true);
    expect(wf.availableModels).toEqual([
      expect.objectContaining({ id: 'local', costTier: 'free', locality: 'local' }),
    ]);
  });

  it('hashes path segments with the configured salt when redactPaths is on', async () => {
    const s = await setup(FILES);
    await s.client.sendRequest('config.update', config({ redactPaths: true, redactSalt: SALT }));
    const state = await s.preview('workflow_select@1');
    const json = JSON.stringify(state);
    expect(json).not.toContain('acmecorp');
    expect(json).not.toContain('invoice');
    // Allow-listed folders and extensions stay readable.
    expect(json).toMatch(/src\/h_[0-9a-f]{10}\/h_[0-9a-f]{10}\.ts/);
    expect(json).not.toContain(SALT);
  });

  it('warns instead of using a guessable salt when none was sent', async () => {
    const s = await setup(FILES);
    await s.client.sendRequest('config.update', config({ redactPaths: true }));
    const state = await s.preview('workflow_select@1');
    expect(JSON.stringify(state)).toContain('acmecorp');
    expect(s.logs.map((l) => l.message).join('\n')).toMatch(/no redaction salt/);
  });
});

describe('jev.test', () => {
  it('reports rules-only status without calling any endpoint', async () => {
    expect(jevTestResult({ enabled: false, redactPaths: false })).toMatchObject({
      ok: false,
      error: { kind: 'not_configured' },
    });
    expect(jevTestResult({ enabled: true, redactPaths: false }).error?.message).toMatch(
      /no endpoint/,
    );
    expect(
      jevTestResult({ enabled: true, endpoint: 'https://jev.example.com', redactPaths: false }),
    ).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  it('answers over RPC from the last config.update', async () => {
    const s = await setup({ 'a.ts': 'x\n' });
    await s.client.sendRequest(
      'config.update',
      config({ enabled: true, endpoint: 'https://jev.example.com' }),
    );
    const raw = await s.client.sendRequest('jev.test', {});
    expect(ClientMethods['jev.test'].result.parse(raw).error?.kind).toBe('unavailable');
  });
});

describe('helpers', () => {
  it('picks an even spread of at most five paths', () => {
    expect(pickSample(['a', 'b'])).toEqual(['a', 'b']);
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}`);
    expect(pickSample(ten)).toEqual(['f0', 'f2', 'f4', 'f6', 'f8']);
  });

  it('maps price to cost tier, local is free', () => {
    expect(costTierOf({ locality: 'local' })).toBe('free');
    expect(costTierOf({ locality: 'cloud' })).toBe('medium');
    const cfg = (output: number) => ({
      id: 'm',
      provider: 'anthropic' as const,
      model: 'x',
      costPerMTok: { input: 1, output },
    });
    expect(costTierOf({ locality: 'cloud' }, cfg(0.6))).toBe('low');
    expect(costTierOf({ locality: 'cloud' }, cfg(15))).toBe('medium');
    expect(costTierOf({ locality: 'cloud' }, cfg(75))).toBe('high');
  });

  it('turns model infos into available models', () => {
    const info: ModelInfo = {
      id: 'c',
      provider: 'anthropic',
      model: 'x',
      capabilities: { streaming: true, toolCalls: true, contextTokens: 200_000, vision: false },
      healthy: true,
      locality: 'cloud',
    };
    expect(availableModels([info], () => undefined)).toEqual([
      { id: 'c', contextTokens: 200_000, latencyMs: 0, costTier: 'medium', locality: 'cloud' },
    ]);
  });
});
