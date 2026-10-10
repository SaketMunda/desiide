// Records the `task.event` fixtures in `shared/transcript/fixtures/` from the REAL bundled
// orchestrator (task engine, policy gate, decision log), driven over stdio by the extension's own
// `OrchestratorClient`. The model is a scripted OpenAI-compatible server on loopback.
// Run: DESIIDE_RECORD=1 pnpm -F desiide-ai exec vitest run src/transcript/record.test.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskEvent, TaskInputRaw, TaskSummary } from '@desiide/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../log.ts';
import { OrchestratorClient } from '../orchestrator/client.ts';

interface Turn {
  reasoning?: string[];
  text?: string[];
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** Respond with this HTTP error instead of a stream. */
  status?: number;
  /** Stream the text, then keep the connection open (the cancel scenario). */
  hang?: boolean;
}

const RECORD = process.env.DESIIDE_RECORD === '1';
const FIXTURES = join(import.meta.dirname, '../../shared/transcript/fixtures');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
let workspace: string;
let server: Server;
let baseUrl: string;
let turns: Turn[] = [];
const hanging: ServerResponse[] = [];

function sse(res: ServerResponse, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function respond(res: ServerResponse, turn: Turn): void {
  if (turn.status) {
    res.writeHead(turn.status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = (d: Record<string, unknown>) => sse(res, { choices: [{ index: 0, delta: d }] });
  for (const r of turn.reasoning ?? []) delta({ reasoning_content: r });
  for (const t of turn.text ?? []) delta({ content: t });
  if (turn.hang) {
    hanging.push(res);
    return;
  }
  (turn.toolCalls ?? []).forEach((c, index) =>
    delta({
      tool_calls: [
        {
          index,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        },
      ],
    }),
  );
  sse(res, {
    choices: [
      { index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' },
    ],
  });
  sse(res, { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 85 } });
  res.end('data: [DONE]\n\n');
}

beforeAll(async () => {
  if (!RECORD) return;
  dir = mkdtempSync(join(tmpdir(), 'desiide-record-'));
  workspace = join(dir, 'ws');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(
    join(workspace, 'src/a.ts'),
    'export const add = (a: number, b: number) => a - b; // bug\n',
  );
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../../../../packages/orchestrator/scripts/build.mjs'),
    '--outfile',
    join(dir, 'orchestrator.js'),
  ]);
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const turn = turns.shift();
      if (!turn) {
        res.writeHead(500).end('no scripted turn');
        return;
      }
      respond(res, turn);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}, 60_000);

afterAll(() => {
  if (!RECORD) return;
  for (const res of hanging) res.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function withClient<T>(fn: (client: OrchestratorClient) => Promise<T>): Promise<T> {
  const client = new OrchestratorClient({
    modulePath: join(dir, 'orchestrator.js'),
    logDir: join(dir, 'logs'),
    workspaceRoots: () => [workspace],
    client: { name: 'desiide-ai-recorder', version: '0.0.0' },
    secrets: () => Promise.resolve(null),
    log: silent,
  });
  try {
    await client.request('config.update', {
      models: [
        {
          id: 'qwen-local',
          provider: 'openai-compatible',
          model: 'qwen3:8b',
          baseUrl,
          costPerMTok: { input: 0.4, output: 1.6 },
        },
      ],
      roles: { cheap: 'qwen-local', strong: 'qwen-local' },
    });
    return await fn(client);
  } finally {
    await client.dispose();
  }
}

/**
 * Runs one task and answers what it asks for: `onEvent` gets each event and may act on it
 * (approve, reject, report edits, cancel). Resolves with the summary and every event, in order.
 */
async function record(
  client: OrchestratorClient,
  input: TaskInputRaw,
  onEvent: (e: TaskEvent, taskId: string) => Promise<void> | void,
): Promise<{ summary: TaskSummary; events: TaskEvent[] }> {
  const events: TaskEvent[] = [];
  // Set once task.create answers; events can arrive before that.
  const target: { id?: string } = {};
  const early: TaskEvent[] = [];
  const done: { resolve: () => void; reject: (err: unknown) => void; promise?: Promise<void> } = {
    resolve: () => {},
    reject: () => {},
  };
  done.promise = new Promise<void>((resolve, reject) => Object.assign(done, { resolve, reject }));
  const handle = (e: TaskEvent) => {
    events.push(e);
    Promise.resolve(onEvent(e, e.taskId)).catch(done.reject);
    if (e.type === 'state_changed' && ['done', 'failed', 'cancelled'].includes(e.to)) {
      done.resolve();
    }
  };
  const sub = client.onEvent((e) => {
    if (target.id === undefined) early.push(e);
    else if (e.taskId === target.id) handle(e);
  });
  const { task } = await client.request('task.create', input);
  target.id = task.id;
  for (const e of early.splice(0)) if (e.taskId === task.id) handle(e);
  await done.promise;
  sub.dispose();
  return { summary: task, events };
}

function save(name: string, description: string, summary: TaskSummary, events: TaskEvent[]): void {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    join(FIXTURES, `${name}.json`),
    `${JSON.stringify({ description, summary, events }, null, 2)}\n`,
  );
}

describe.skipIf(!RECORD)('record task.event fixtures from the real orchestrator', () => {
  it('happy path: reasoning, a read, an edit proposal applied, a final answer', async () => {
    turns = [
      {
        reasoning: ['The user says ', '`add` is wrong. ', 'I should read src/a.ts first.'],
        text: ["I'll look at ", '`src/a.ts` first.'],
        toolCalls: [{ id: 'call_read', name: 'read_file', args: { path: 'src/a.ts' } }],
      },
      {
        text: [
          '`add` subtracts instead of adding:\n\n',
          '```ts\nexport const add = (a: number, b: number) => a - b;\n```\n\n',
          'Proposing the fix.',
        ],
        toolCalls: [
          {
            id: 'call_edit',
            name: 'propose_edit',
            args: {
              files: [
                { path: 'src/a.ts', edits: [{ search: 'a - b; // bug', replace: 'a + b;' }] },
              ],
            },
          },
        ],
      },
      { text: ['Fixed: `add` now returns ', '`a + b`.'] },
    ];
    await withClient(async (client) => {
      const { summary, events } = await record(
        client,
        {
          kind: 'bug_fix',
          instruction: 'Fix the bug in add() in src/a.ts',
          allowedTools: ['read_file', 'propose_edit'],
          context: { refs: [{ type: 'file', path: 'src/a.ts' }] },
        },
        async (e, taskId) => {
          if (e.type === 'edit_proposed') {
            await client.request('edits.report', {
              taskId,
              proposalId: e.proposal.id,
              files: [{ path: 'src/a.ts', status: 'applied' }],
            });
          } else if (e.type === 'approval_required') {
            await client.request('task.approve', {
              taskId,
              approvalId: e.approvalId,
              scope: 'once',
            });
          }
        },
      );
      expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'done' });
      save(
        'happy',
        'Reasoning, a read, an applied edit proposal, a final answer → done.',
        summary,
        events,
      );
    });
  }, 60_000);

  it('escalation: side-effecting commands go to the user; one approved, one rejected', async () => {
    turns = [
      {
        text: ['Cleaning the build output first.'],
        toolCalls: [{ id: 'call_rm', name: 'shell', args: { command: 'rm -rf dist' } }],
      },
      {
        text: ['Now publishing.'],
        toolCalls: [{ id: 'call_push', name: 'shell', args: { command: 'git push origin main' } }],
      },
      { text: ['Skipped the push as you asked. The build output is clean.'] },
    ];
    await withClient(async (client) => {
      const { summary, events } = await record(
        client,
        {
          kind: 'infra_change',
          instruction: 'Clean dist and publish',
          allowedTools: ['read_file', 'shell'],
        },
        async (e, taskId) => {
          if (e.type !== 'approval_required') return;
          const command = String(e.call.args['command']);
          if (command.startsWith('rm')) {
            await client.request('task.approve', {
              taskId,
              approvalId: e.approvalId,
              scope: 'once',
            });
          } else {
            await client.request('task.reject', {
              taskId,
              approvalId: e.approvalId,
              reason: 'not now',
            });
          }
        },
      );
      expect(events.some((e) => e.type === 'approval_required')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'done' });
      save(
        'escalation',
        'Two shell commands escalated to the user: one approved, one rejected → done.',
        summary,
        events,
      );
    });
  }, 60_000);

  it('failure: the model rejects the key', async () => {
    turns = [{ status: 401 }];
    await withClient(async (client) => {
      const { summary, events } = await record(
        client,
        { kind: 'explain', instruction: 'Explain src/a.ts', allowedTools: ['read_file'] },
        () => {},
      );
      expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'failed' });
      save('failure', 'The model answers 401 → an auth error, then failed.', summary, events);
    });
  }, 60_000);

  it('cancel: stopped while the answer streams', async () => {
    turns = [
      {
        reasoning: ['Thinking about the ', 'whole module.'],
        text: ['Here is ', 'a long ', 'explanation'],
        hang: true,
      },
    ];
    await withClient(async (client) => {
      let deltas = 0;
      const { summary, events } = await record(
        client,
        { kind: 'explain', instruction: 'Explain the whole module', allowedTools: ['read_file'] },
        async (e, taskId) => {
          if (e.type === 'text_delta' && ++deltas === 3)
            await client.request('task.cancel', { taskId });
        },
      );
      expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'cancelled' });
      save('cancel', 'Cancelled by the user while the answer was streaming.', summary, events);
    });
  }, 60_000);
});
