import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../log.ts';
import { OrchestratorClient } from '../orchestrator/client.ts';
import { secretStorageKey } from '../orchestrator/notice.ts';
import { SettingsService } from './service.ts';
import { fakeSettingsDeps } from './testDeps.ts';

// AC2 + AC3 end to end: the real bundled orchestrator, a real (local) provider that rejects the
// key and echoes it back, and the settings service in between.
const SENTINEL = 'sk-live-SENTINEL-9d2c71';

let dir: string;
let bundle: string;
let server: Server;
let baseUrl: string;
const seenAuth: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desiide-settings-process-'));
  bundle = join(dir, 'orchestrator.js');
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../../../../packages/orchestrator/scripts/build.mjs'),
    '--outfile',
    bundle,
  ]);
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    seenAuth.push(auth);
    // Like a careless provider: the rejected key is echoed in the error body.
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('settings with the bundled orchestrator', () => {
  it('an invalid key: Test shows kind + hint, and the key appears nowhere but SecretStorage', async () => {
    const lines: string[] = [];
    const at = (level: string) => (m: string) => lines.push(`${level}: ${m}`);
    const log: Logger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    };
    const logDir = join(dir, 'logs');

    const f = fakeSettingsDeps({});
    const late: { client?: OrchestratorClient } = {};
    f.deps.orchestrator = {
      isRunning: () => late.client?.status.state === 'ready',
      request: (method, params) => {
        if (!late.client) throw new Error('no client');
        return late.client.request(method, params);
      },
    };
    f.deps.log = log;
    const service = new SettingsService(f.deps);
    const client = new OrchestratorClient({
      modulePath: bundle,
      logDir,
      logLevel: 'debug',
      workspaceRoots: () => [dir],
      client: { name: 'desiide-ai-test', version: '0.0.0' },
      secrets: async (ref) => (await f.deps.secrets.get(secretStorageKey(ref))) ?? null,
      onSessionStart: async (send) => {
        await send('config.update', service.config());
      },
      log,
    });
    late.client = client;
    try {
      await service.handle({
        type: 'settings.saveModel',
        model: {
          id: 'compat',
          provider: 'openai-compatible',
          model: 'gpt-test',
          baseUrl,
          apiKey: 'secret:example',
        },
        key: SENTINEL,
        test: true,
      });

      const result = f.posts.find((p) => p.type === 'settings.modelTest');
      expect(result).toMatchObject({
        id: 'compat',
        result: { ok: false, error: { kind: 'auth', hint: expect.any(String) as unknown } },
      });
      if (result?.type !== 'settings.modelTest') throw new Error('unreachable');
      expect(result.result.error?.hint?.length).toBeGreaterThan(0);
      // The key really was used (from SecretStorage, via secrets.get) ...
      expect(seenAuth.some((a) => a.includes(SENTINEL))).toBe(true);
      // ... and it's nowhere else: settings, the webview, the extension log, the orchestrator log.
      expect(JSON.stringify([...f.settings])).not.toContain(SENTINEL);
      expect(JSON.stringify(f.posts)).not.toContain(SENTINEL);
      expect(lines.join('\n')).not.toContain(SENTINEL);
    } finally {
      await client.dispose();
    }
    const logFiles = readdirSync(logDir);
    expect(logFiles.length).toBeGreaterThan(0);
    for (const file of logFiles) {
      const text = readFileSync(join(logDir, file), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(SENTINEL);
    }
  }, 30_000);
});
