import { createModelRegistry } from '@desiide/models';
import {
  createFakeModelAdapter,
  type FakeModelAdapter,
  type FakeTurn,
} from '@desiide/models/testing';
import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  Task,
  TaskEvent,
  type ResultOf,
  type TaskEventType,
} from '@desiide/protocol';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { ErrorCodes, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigUpdate } from '../config/handler.ts';
import { createHost, type Host } from '../host/host.ts';
import { makeTestWorkspace, type TestWorkspace } from '../tools/testWorkspace.ts';
import { registerTaskEngine, roleForTask } from './engine.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Setup {
  client: MessageConnection;
  host: Host;
  ws: TestWorkspace;
  model: FakeModelAdapter;
  events: TaskEvent[];
  next<T extends TaskEventType>(
    type: T,
    pred?: (e: Extract<TaskEvent, { type: T }>) => boolean,
  ): Promise<Extract<TaskEvent, { type: T }>>;
}

async function setup(turns: FakeTurn[], files: Record<string, string> = {}): Promise<Setup> {
  const ws = await makeTestWorkspace(files);
  cleanups.push(() => ws.dispose());
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createMessageConnection(toServer, toClient);
  const client = createMessageConnection(toClient, toServer);
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
  registerConfigUpdate(host, [(config) => models.configure(config)]);
  registerTaskEngine(host, { models });

  const events: TaskEvent[] = [];
  const waiters: Array<(e: TaskEvent) => boolean> = [];
  client.onNotification('task.event', (raw: unknown) => {
    const event = TaskEvent.parse(raw);
    events.push(event);
    for (const w of [...waiters]) if (w(event)) waiters.splice(waiters.indexOf(w), 1);
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

  const next: Setup['next'] = (type, pred = () => true) =>
    new Promise((resolve) => {
      waiters.push((e) => {
        if (e.type !== type || !pred(e as never)) return false;
        resolve(e as never);
        return true;
      });
    });
  return { client, host, ws, model, events, next };
}

const create = (client: MessageConnection, params: Record<string, unknown>) =>
  client.sendRequest('task.create', params) as Promise<ResultOf<'task.create'>>;

describe('task.* over JSON-RPC', () => {
  it('runs a task end to end: real tools, approvals, edit report, events', async () => {
    const s = await setup(
      [
        { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'src/a.ts' } }] },
        {
          toolCalls: [
            {
              id: 'e1',
              name: 'propose_edit',
              args: { files: [{ path: 'src/a.ts', edits: [{ search: 'bug', replace: 'fix' }] }] },
            },
          ],
        },
        { text: 'Fixed.' },
      ],
      { 'src/a.ts': 'export const x = "bug";\n' },
    );
    const approval = s.next('approval_required');
    const { task } = await create(s.client, { kind: 'bug_fix', instruction: 'Fix it' });
    expect(task.state).toBe('queued');

    const a = await approval;
    expect(a.call).toMatchObject({ tool: 'read_file', sideEffect: 'none' });
    expect(a.paths).toEqual(['src/a.ts']);
    const proposed = s.next('edit_proposed');
    await s.client.sendRequest('task.approve', {
      taskId: task.id,
      approvalId: a.approvalId,
      scope: 'once',
    });
    const p = await proposed;
    expect(p.proposal).toMatchObject({ taskId: task.id, files: [{ path: 'src/a.ts' }] });

    const done = s.next('state_changed', (e) => e.to === 'done');
    await s.client.sendRequest('edits.report', {
      taskId: task.id,
      proposalId: p.proposal.id,
      files: [{ path: 'src/a.ts', status: 'applied' }],
    });
    await done;
    // The orchestrator never writes (ADR-004): the file is unchanged until the extension applies.
    expect(await readFile(join(s.ws.root, 'src/a.ts'), 'utf8')).toContain('bug');
    expect(s.model.calls[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('export const x = "bug"') as unknown,
    });

    const { tasks } = (await s.client.sendRequest('task.list', {})) as ResultOf<'task.list'>;
    expect(tasks).toMatchObject([{ id: task.id, state: 'done', models: ['local'] }]);
    expect(s.events.map((e) => e.seq)).toEqual(s.events.map((_, i) => i));
  });

  it('AC5: cancel during a running shell command kills it and ends cancelled within 1 s', async () => {
    const s = await setup([
      {
        toolCalls: [
          { id: 's1', name: 'shell', args: { command: 'echo $$ > pid.txt; exec sleep 30' } },
        ],
      },
    ]);
    const approval = s.next('approval_required');
    const { task } = await create(s.client, {
      kind: 'other',
      instruction: 'Run a slow command',
      allowedTools: ['shell'],
    });
    const a = await approval;
    await s.client.sendRequest('task.approve', {
      taskId: task.id,
      approvalId: a.approvalId,
      scope: 'once',
    });

    const pidFile = join(s.ws.root, 'pid.txt');
    while (!existsSync(pidFile) || (await readFile(pidFile, 'utf8')).trim() === '') {
      await new Promise((r) => setTimeout(r, 10));
    }
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(isAlive(pid)).toBe(true);

    const cancelled = s.next('state_changed', (e) => e.to === 'cancelled');
    const started = Date.now();
    expect(await s.client.sendRequest('task.cancel', { taskId: task.id })).toEqual({
      cancelled: true,
    });
    await cancelled;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(isAlive(pid)).toBe(false);
    expect(await s.client.sendRequest('task.cancel', { taskId: task.id })).toEqual({
      cancelled: false,
    });
  });

  it('maps unknown tasks, approvals, and bad reports to protocol error codes', async () => {
    const s = await setup([{ toolCalls: [{ id: 'x', name: 'read_file', args: { path: 'a' } }] }]);
    await expect(s.client.sendRequest('task.cancel', { taskId: 'nope' })).rejects.toMatchObject({
      code: RpcErrorCode.TaskNotFound,
    });
    const approval = s.next('approval_required');
    const { task } = await create(s.client, { kind: 'other', instruction: 'x' });
    await approval;
    await expect(
      s.client.sendRequest('task.reject', { taskId: task.id, approvalId: 'nope' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.ApprovalNotFound });
    await expect(
      s.client.sendRequest('edits.report', {
        taskId: task.id,
        proposalId: 'nope',
        files: [{ path: 'a', status: 'applied' }],
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.ApprovalNotFound });
    await expect(
      s.client.sendRequest('task.create', { kind: 'other', instruction: '' }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });

  it('shutdown cancels running tasks', async () => {
    const s = await setup([{ text: 'thinking', hang: true }]);
    const delta = s.next('text_delta');
    const cancelled = s.next('state_changed', (e) => e.to === 'cancelled');
    await create(s.client, { kind: 'other', instruction: 'x' });
    await delta;
    void s.host.shutdown('test');
    await cancelled;
  });

  it('fails a task needing checks when the project has no check command', async () => {
    const s = await setup([{ text: 'x' }]);
    const failed = s.next('state_changed', (e) => e.to === 'failed');
    await create(s.client, { kind: 'other', instruction: 'x', success: { lintClean: true } });
    expect(await failed).toMatchObject({ reason: 'no_check_command' });
    expect(s.events.find((e) => e.type === 'error')).toMatchObject({
      kind: 'no_check_command',
      message: expect.stringContaining('lintCommand') as unknown,
    });
    expect(s.model.calls).toHaveLength(0);
  });
});

describe('roleForTask', () => {
  it('uses the strong model only for quality', () => {
    const task = (preference: string) =>
      Task.parse({ id: 't', kind: 'other', instruction: 'x', preference });
    expect(roleForTask(task('quality'))).toBe('strong');
    expect(roleForTask(task('balance'))).toBe('cheap');
    expect(roleForTask(task('cheap'))).toBe('cheap');
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
