import { TERMINAL_TASK_STATES, type TaskEvent, type TaskState } from '@desiide/protocol';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../log.ts';
import { OrchestratorClient } from '../orchestrator/client.ts';
import { secretStorageKey } from '../orchestrator/notice.ts';
import { buildTaskCreateParams } from '../prompt/payload.ts';
import { SettingsService } from './service.ts';
import { fakeSettingsDeps } from './testDeps.ts';
import { TRY_IT_PROMPT } from './tryIt.ts';

// AC1, machine part: a fresh profile (no settings) with Ollama running reaches a finished first
// task through the onboarding path: discover → one click → Test → Try it. Needs a running Ollama
// with at least one model. Run: DESIIDE_LIVE=1 pnpm -F desiide-ai exec vitest run onboarding.live
const LIVE = process.env.DESIIDE_LIVE === '1';
const BUDGET_MS = 120_000;

let dir: string;
let bundle: string;

describe.skipIf(!LIVE)('onboarding with a live Ollama (AC1)', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'desiide-onboarding-live-'));
    bundle = join(dir, 'orchestrator.js');
    execFileSync(process.execPath, [
      join(import.meta.dirname, '../../../../packages/orchestrator/scripts/build.mjs'),
      '--outfile',
      bundle,
    ]);
    const ws = join(dir, 'ws');
    execFileSync('mkdir', ['-p', join(ws, 'src')]);
    writeFileSync(join(ws, 'README.md'), '# Tally\nA tiny CLI that counts words in files.\n');
    writeFileSync(
      join(ws, 'src', 'count.ts'),
      'export function count(text: string): number {\n  return text.split(" ").length;\n}\n',
    );
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it(
    'discover → use as cheap → test → Try it finishes within 2 minutes',
    async () => {
      const started = Date.now();
      const marks: Record<string, number> = {};
      const mark = (name: string) => (marks[name] = Date.now() - started);
      const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
      const f = fakeSettingsDeps({});
      const late: { client?: OrchestratorClient } = {};
      f.deps.orchestrator = {
        isRunning: () => late.client?.status.state === 'ready',
        request: (method, params) => {
          if (!late.client) throw new Error('no client');
          return late.client.request(method, params);
        },
      };
      const service = new SettingsService(f.deps);
      // The app passes the editor's own rg; here, the orchestrator's dev dependency.
      const rg = createRequire(
        join(import.meta.dirname, '../../../../packages/orchestrator/package.json'),
      )('@vscode/ripgrep') as { rgPath: string };
      const client = new OrchestratorClient({
        modulePath: bundle,
        env: { DESIIDE_RG_PATH: rg.rgPath },
        workspaceRoots: () => [join(dir, 'ws')],
        client: { name: 'desiide-ai-live', version: '0.0.0' },
        secrets: async (ref) => (await f.deps.secrets.get(secretStorageKey(ref))) ?? null,
        onSessionStart: async (send) => {
          await send('config.update', service.config());
        },
        log: silent,
      });
      late.client = client;
      try {
        await service.handle({ type: 'settings.discover' });
        const found = f.posts.find((p) => p.type === 'settings.discovered');
        if (found?.type !== 'settings.discovered') throw new Error('no discovery result');
        expect(found.error).toBeUndefined();
        const model = process.env.DESIIDE_LIVE_OLLAMA_MODEL ?? found.models[0]?.model;
        if (!model) throw new Error('Ollama has no models');
        mark('discovered');

        await service.handle({ type: 'settings.useDiscovered', model });
        const test = f.posts.find((p) => p.type === 'settings.modelTest');
        expect(test).toMatchObject({ result: { ok: true } });
        mark('tested');

        const params = buildTaskCreateParams({
          instruction: TRY_IT_PROMPT,
          chips: [],
          openEditors: [],
          preference: 'balance',
          workflow: 'auto',
        });
        if (!params.ok) throw new Error(params.message);
        const states: TaskState[] = [];
        let text = '';
        const done = new Promise<TaskState>((resolve) => {
          client.onEvent((e: TaskEvent) => {
            if (e.type === 'text_delta') text += e.delta;
            if (e.type === 'error' || (e.type === 'state_changed' && e.reason)) {
              console.log(`task event: ${JSON.stringify(e)}`);
            }
            if (e.type === 'state_changed') {
              states.push(e.to);
              if (TERMINAL_TASK_STATES.includes(e.to)) resolve(e.to);
            }
          });
        });
        await client.request('task.create', params.params);
        expect(await done).toBe('done');
        mark('taskDone');
        expect(text.trim().length).toBeGreaterThan(0);
        const total = Date.now() - started;
        console.log(`AC1 live timings (ms): ${JSON.stringify({ model, ...marks, total })}`);
        expect(total).toBeLessThan(BUDGET_MS);
      } finally {
        await client.dispose();
      }
    },
    BUDGET_MS + 30_000,
  );
});
