import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../log.ts';
import type { TaskEvent } from '@desiide/protocol';
import { ActiveTasks } from '../prompt/activeTasks.ts';
import { buildTaskCreateParams } from '../prompt/payload.ts';
import {
  FallbackTaskClient,
  MockTaskClient,
  orchestratorTaskClient,
} from '../prompt/taskClient.ts';
import { OrchestratorClient, type OrchestratorStatus } from './client.ts';

// Spawns the real bundled orchestrator (as the extension does), so it needs a build first.
let dir: string;
let bundle: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'desiide-orch-process-'));
  bundle = join(dir, 'orchestrator.js');
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../../../../packages/orchestrator/scripts/build.mjs'),
    '--outfile',
    bundle,
  ]);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('OrchestratorClient with the bundled orchestrator process', () => {
  it('pings, restarts after kill -9 with a status event, and stops on dispose', async () => {
    const logDir = join(dir, 'logs');
    const statuses: OrchestratorStatus[] = [];
    const client = new OrchestratorClient({
      modulePath: bundle,
      logDir,
      workspaceRoots: () => [dir],
      client: { name: 'desiide-ai-test', version: '0.0.0' },
      secrets: () => Promise.resolve(null),
      log: silent,
    });
    client.onStatus((s) => statuses.push(s));
    try {
      const started = Date.now();
      await expect(client.request('health.ping', {})).resolves.toMatchObject({ ok: true });
      const coldStartMs = Date.now() - started;
      const first = client.status;
      if (first.state !== 'ready' || first.pid === undefined) throw new Error('not ready');
      expect(first.serverVersion).toMatch(/^\d+\.\d+\.\d+/);

      process.kill(first.pid, 'SIGKILL');
      await vi.waitFor(
        () => {
          expect(client.status.state).toBe('ready');
          expect(client.status).not.toMatchObject({ pid: first.pid });
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(statuses.map((s) => s.state)).toEqual([
        'starting',
        'ready',
        'restarting',
        'starting',
        'ready',
      ]);
      expect(statuses[2]).toMatchObject({ state: 'restarting', attempt: 1 });
      expect(statuses[2]?.state === 'restarting' && statuses[2].reason).toContain('SIGKILL');
      await expect(client.request('health.ping', {})).resolves.toMatchObject({ ok: true });

      const second = client.status;
      await client.dispose();
      expect(client.status.state).toBe('stopped');
      if (second.state === 'ready' && second.pid !== undefined) {
        expect(isAlive(second.pid)).toBe(false);
      }
      expect(existsSync(join(logDir, 'orchestrator.log'))).toBe(true);
      expect(readFileSync(join(logDir, 'orchestrator.log'), 'utf8')).toContain('SIGTERM');
      // Cold start budget is 500 ms (STANDARDS); allow slack for loaded CI machines.
      expect(coldStartMs).toBeLessThan(2_000);
    } finally {
      await client.dispose();
    }
  }, 30_000);

  it('Prompt Box send → Stop against the real orchestrator (UI-2 AC5, mock until COR-2)', async () => {
    const client = new OrchestratorClient({
      modulePath: bundle,
      logDir: join(dir, 'logs-prompt'),
      workspaceRoots: () => [dir],
      client: { name: 'desiide-ai-test', version: '0.0.0' },
      secrets: () => Promise.resolve(null),
      log: silent,
    });
    const onFallback = vi.fn();
    const tasks = new FallbackTaskClient(
      orchestratorTaskClient(client),
      new MockTaskClient(),
      onFallback,
    );
    const active = new ActiveTasks();
    const events: TaskEvent[] = [];
    tasks.onEvent((e) => {
      events.push(e);
      active.apply(e);
    });
    try {
      const built = buildTaskCreateParams({
        instruction: 'Fix the parser',
        chips: [],
        preference: 'balance',
        workflow: 'auto',
        openEditors: [],
      });
      if (!built.ok) throw new Error(built.message);
      const task = await tasks.create(built.params);
      active.add(task.id, task.state);
      // When COR-2 registers task.create this goes through the real engine instead.
      expect(onFallback).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(active.list()).toEqual([{ id: task.id, state: 'running' }]));
      expect(await tasks.cancel(task.id)).toBe(true);
      expect(active.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'cancelled' });
    } finally {
      await client.dispose();
    }
  }, 30_000);
});
