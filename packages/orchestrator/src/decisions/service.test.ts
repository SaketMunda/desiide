import { createModelRegistry } from '@desiide/models';
import { createFakeModelAdapter, type FakeTurn } from '@desiide/models/testing';
import { LogNotification, PROTOCOL_VERSION, TaskEvent, type ResultOf } from '@desiide/protocol';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { ErrorCodes, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigUpdate } from '../config/handler.ts';
import { createHost } from '../host/host.ts';
import { createWorkspacePolicy } from '../policy/workspacePolicy.ts';
import { registerTaskEngine } from '../tasks/engine.ts';
import type { TaskManager } from '../tasks/taskManager.ts';
import { makeTestWorkspace } from '../tools/testWorkspace.ts';
import { createDecisionService } from './service.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Wired exactly like `host/main.ts`. */
async function setup(turns: FakeTurn[], files: Record<string, string>) {
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

  const model = createFakeModelAdapter({ id: 'local', turns });
  const models = createModelRegistry({
    providers: { ollama: { create: () => model } },
    requestSecret: () => Promise.resolve(null),
  });
  let ids = 0;
  const late: { tasks?: TaskManager } = {};
  const decisions = createDecisionService(host, {
    replayOptions: () => policy.replayOptions(),
    publish: (r) => late.tasks?.publishDecision(r),
  });
  const policy = createWorkspacePolicy(host, {
    newId: () => `dec${++ids}`,
    onDecision: (r) => decisions.record(r),
  });
  registerConfigUpdate(host, [(c) => models.configure(c), policy.onConfig]);
  late.tasks = registerTaskEngine(host, { models, gate: () => policy.gate });

  const events: TaskEvent[] = [];
  const logs: LogNotification[] = [];
  client.onNotification('task.event', (raw: unknown) => {
    events.push(TaskEvent.parse(raw));
  });
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
  await client.sendRequest('config.update', {
    models: [
      { id: 'local', provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434/v1' },
    ],
  });
  return { client, events, logs, decisions, root: ws.root };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

const READS: FakeTurn[] = [
  { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'src/a.ts' } }] },
  { toolCalls: [{ id: 'r2', name: 'read_file', args: { path: '.env' } }] },
  { text: 'done' },
];
const FILES = { 'src/a.ts': 'export const a = 1;\n', '.env': 'API_KEY=sentinel\n' };

describe('decision service', () => {
  it('persists, emits decision_made before the approval, lists and replays', async () => {
    const s = await setup(READS, FILES);
    const { task } = (await s.client.sendRequest('task.create', {
      kind: 'explain',
      instruction: 'Explain the config',
    })) as ResultOf<'task.create'>;
    await until(() => s.events.some((e) => e.type === 'approval_required'));

    const made = s.events.flatMap((e) => (e.type === 'decision_made' ? [e] : []));
    expect(made.map((e) => e.decision.policyOutcome)).toEqual(['auto', 'confirm']);
    const approval = s.events.find((e) => e.type === 'approval_required');
    if (approval?.type !== 'approval_required') throw new Error('unreachable');
    expect(approval.decisionId).toBe(made[1]?.decision.id);
    expect(made[1]?.seq).toBeLessThan(approval.seq);

    await s.decisions.flush();
    const dir = join(s.root, '.desiide', 'logs');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    const onDisk = (await readFile(join(dir, 'decisions.jsonl'), 'utf8')).trim().split('\n');
    expect(onDisk).toHaveLength(2);
    // Stored state is the risk_gate state, metadata only: never file contents.
    expect(onDisk.join('\n')).not.toContain('sentinel');

    const all = (await s.client.sendRequest('decisions.list', {
      taskId: task.id,
    })) as ResultOf<'decisions.list'>;
    expect(all.decisions.map((d) => d.id)).toEqual([made[1]?.decision.id, made[0]?.decision.id]);
    const confirmed = (await s.client.sendRequest('decisions.list', {
      outcome: 'confirm',
    })) as ResultOf<'decisions.list'>;
    expect(confirmed.decisions.map((d) => d.id)).toEqual([made[1]?.decision.id]);
    const paged = (await s.client.sendRequest('decisions.list', {
      limit: 1,
    })) as ResultOf<'decisions.list'>;
    expect(paged.decisions).toHaveLength(1);
    expect(paged.nextCursor).toBeDefined();

    for (const { decision } of made) {
      const replay = (await s.client.sendRequest('decisions.replay', {
        id: decision.id,
      })) as ResultOf<'decisions.replay'>;
      expect(replay.record).toEqual(decision);
      expect(replay.rules.result).toEqual(decision.result);
      expect(replay.rules.policyOutcome).toBe(decision.policyOutcome);
      expect(replay.jev).toBeUndefined();
      expect(replay.differs).toBe(false);
    }
  });

  it('answers unknown ids and bad cursors with InvalidParams', async () => {
    const s = await setup([{ text: 'done' }], { 'a.txt': 'x' });
    expect(await s.client.sendRequest('decisions.list', {})).toEqual({ decisions: [] });
    await expect(s.client.sendRequest('decisions.replay', { id: 'nope' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringContaining('may have rotated out') as unknown,
    });
    await expect(s.client.sendRequest('decisions.list', { cursor: '***' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });

  it('a log that cannot be written warns the user once; decisions still apply', async () => {
    // `.desiide` as a file makes `.desiide/logs` impossible to create.
    const s = await setup(READS, { ...FILES, '.desiide': 'not a directory' });
    await s.client.sendRequest('task.create', { kind: 'explain', instruction: 'x' });
    await until(() => s.events.some((e) => e.type === 'approval_required'));
    await until(() => s.logs.some((l) => l.message.includes('decision log')));
    expect(s.logs.filter((l) => l.message.includes('decision log'))).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'decision_made')).toHaveLength(2);
  });
});
