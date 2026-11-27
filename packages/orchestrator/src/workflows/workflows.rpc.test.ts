// COR-5 end to end over JSON-RPC: the real host, model registry, JEV-2 policy (rules engine),
// COR-4 context engine, COR-3 tools with a real test command, and the workflow engine wired as in
// `host/main.ts`. Two fake providers stand in for a local cheap model and a cloud strong model.
import { createModelRegistry } from '@desiide/models';
import { createFakeModelAdapter, type FakeTurn } from '@desiide/models/testing';
import { PROTOCOL_VERSION, TaskEvent, type DecisionRecord, type ResultOf } from '@desiide/protocol';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigUpdate } from '../config/handler.ts';
import { createContextEngine } from '../context/engine.ts';
import { createHost } from '../host/host.ts';
import { availableModels } from '../jev/handlers.ts';
import { createWorkspacePolicy } from '../policy/workspacePolicy.ts';
import { registerTaskEngine } from '../tasks/engine.ts';
import { makeTestWorkspace } from '../tools/testWorkspace.ts';
import { createWorkflowEngine } from './engine.ts';
import { resolveRoles } from './roles.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const edit = (id: string, search: string, replace: string) => ({
  id,
  name: 'propose_edit',
  args: { files: [{ path: 'src/a.mjs', edits: [{ search, replace }] }] },
});

async function setup(cheapTurns: FakeTurn[], strongTurns: FakeTurn[]) {
  const ws = await makeTestWorkspace(
    {
      'src/a.mjs': 'export const add = (a, b) => a - b;\n',
      // The project's test command: passes only once add() adds.
      'check.mjs':
        "import { add } from './src/a.mjs';\nprocess.exit(add(1, 2) === 3 ? 0 : (console.log('expected 3, got', add(1, 2)), 1));\n",
      '.desiide/project.json': JSON.stringify({ testCommand: 'node check.mjs' }),
    },
    { git: true },
  );
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

  const cheap = createFakeModelAdapter({ id: 'qwen-local', turns: cheapTurns });
  const strong = createFakeModelAdapter({ id: 'claude', turns: strongTurns });
  const models = createModelRegistry({
    providers: { ollama: { create: () => cheap }, anthropic: { create: () => strong } },
    requestSecret: () => Promise.resolve(null),
  });
  const decisions: DecisionRecord[] = [];
  let ids = 0;
  const newId = () => `id${++ids}`;
  const policy = createWorkspacePolicy(host, { newId, onDecision: (r) => decisions.push(r) });
  registerConfigUpdate(host, [(c) => models.configure(c), policy.onConfig]);
  const context = createContextEngine({ workspaceRoots: () => host.session?.workspaceRoots });
  const workflows = createWorkflowEngine({
    roles: () => resolveRoles((role) => models.forRole(role)),
    engine: () => policy.engine,
    onDecision: (r) => policy.onDecision(r),
    describeFiles: (paths, signal) => context.describeFiles(paths, signal),
    availableModels: async (want, signal) => {
      const { models: listed } = await models.list({ discover: false }, signal);
      return availableModels(
        listed.filter((m) => want.includes(m.id)),
        (id) => models.config(id),
      );
    },
    newId,
  });
  registerTaskEngine(host, { models, gate: () => policy.gate, context, workflows });

  const events: TaskEvent[] = [];
  client.onNotification('task.event', (raw: unknown) => {
    const e = TaskEvent.parse(raw);
    events.push(e);
    // Play the extension: write accepted edits (ADR-004), then report them.
    if (e.type === 'edit_proposed') {
      for (const f of e.proposal.files) {
        const file = join(ws.root, f.path);
        let text = readFileSync(file, 'utf8');
        for (const b of f.edits) text = text.replace(b.search, () => b.replace);
        writeFileSync(file, text);
      }
      void client.sendRequest('edits.report', {
        taskId: e.taskId,
        proposalId: e.proposal.id,
        files: e.proposal.files.map((f) => ({ path: f.path, status: 'applied' })),
      });
    }
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
      {
        id: 'qwen-local',
        provider: 'ollama',
        model: 'qwen3',
        baseUrl: 'http://localhost:11434/v1',
      },
      {
        id: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'secret:anthropic',
        costPerMTok: { input: 3, output: 15 },
      },
    ],
    roles: { cheap: 'qwen-local', strong: 'claude' },
  });
  const run = async (input: Record<string, unknown>) => {
    const { task } = (await client.sendRequest('task.create', input)) as ResultOf<'task.create'>;
    for (let i = 0; i < 500; i++) {
      if (
        events.some(
          (e) =>
            e.taskId === task.id &&
            e.type === 'state_changed' &&
            ['done', 'failed', 'cancelled'].includes(e.to),
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const { tasks } = (await client.sendRequest('task.list', {})) as ResultOf<'task.list'>;
    return tasks.find((t) => t.id === task.id);
  };
  return { ws, run, events, decisions, cheap, strong };
}

const input = {
  kind: 'bug_fix',
  instruction: 'Fix add() in src/a.mjs',
  context: { refs: [{ type: 'file', path: 'src/a.mjs' }] },
  success: { testsPass: true },
  allowedTools: ['read_file', 'propose_edit', 'run_tests'],
  workflowOverride: 'local-cloud-cascade',
};

describe('COR-5 over JSON-RPC with the real policy, context and tools', () => {
  it('AC1: the cheap draft fails the real tests → strong fixes it → done; the log has both', async () => {
    const s = await setup(
      [{ toolCalls: [edit('c1', 'a - b', 'a * b')] }, { text: 'Done.' }],
      [
        {
          toolCalls: [edit('s1', 'a * b', 'a + b')],
          usage: { inputTokens: 2000, outputTokens: 120 },
        },
        { text: 'Fixed: add() adds.', usage: { inputTokens: 2200, outputTokens: 10 } },
      ],
    );
    const summary = await s.run(input);
    expect(summary).toMatchObject({
      state: 'done',
      workflow: 'local-cloud-cascade',
      models: ['qwen-local', 'claude'],
    });
    expect(readFileSync(join(s.ws.root, 'src/a.mjs'), 'utf8')).toContain('a + b');
    // The strong model saw the real test failure.
    expect(JSON.stringify(s.strong.calls[0]?.messages)).toContain('expected 3, got 2');
    const routing = s.decisions.filter((d) => d.pack === 'workflow_select@1');
    expect(routing.map((d) => [d.question, d.engine])).toEqual([
      ['workflow', 'rules'],
      ['escalation_need', 'rules'],
      ['escalate', 'rules'],
    ]);
    expect(routing[0]?.reasons).toContain('user_override');
    expect(routing[2]?.reasons).toEqual(['escalated', 'escalated:verification_failed']);
    // The strong model's usage carries its estimated cost; the local one has none configured.
    const usage = s.events.flatMap((e) =>
      e.type === 'usage' ? [[e.modelId, e.usage.costUsd !== undefined]] : [],
    );
    expect(usage).toContainEqual(['claude', true]);
  }, 30_000);

  it('AC2: the cheap draft passes → the strong model is never called', async () => {
    const s = await setup(
      [{ toolCalls: [edit('c1', 'a - b', 'a + b')] }, { text: 'Done.' }],
      [{ text: 'should not run' }],
    );
    expect(await s.run(input)).toMatchObject({ state: 'done', models: ['qwen-local'] });
    expect(s.strong.calls).toHaveLength(0);
  }, 30_000);

  it('without an override the rules engine routes, and the summary says which workflow', async () => {
    const s = await setup([{ text: 'It subtracts.' }], [{ text: 'It subtracts.' }]);
    const summary = await s.run({
      kind: 'explain',
      instruction: 'What does add do?',
      allowedTools: ['read_file'],
    });
    expect(summary?.state).toBe('done');
    expect(['local-single', 'local-cloud-cascade', 'cloud-single']).toContain(summary?.workflow);
    expect(s.decisions.map((d) => d.question).slice(0, 3)).toEqual([
      'workflow',
      'complexity',
      'cheap_success',
    ]);
  }, 30_000);
});
