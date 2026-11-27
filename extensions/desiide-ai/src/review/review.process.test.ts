// UI-4 end to end with COR-2: the REAL bundled orchestrator (task engine + JEV-2 policy gate) over
// stdio via the extension's own `OrchestratorClient`, a scripted OpenAI-compatible model on
// loopback, and the `ReviewService` the extension uses, applying to a real directory.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TaskEvent, TaskInputRaw } from '@desiide/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log.ts';
import { OrchestratorClient } from '../orchestrator/client.ts';
import { orchestratorReviewRpc } from './rpc.ts';
import { ReviewService, type FileChange, type ReviewWorkspace } from './service.ts';

interface Turn {
  text?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
let bundle: string;
let workspace: string;
let server: Server;
let baseUrl: string;
let turns: Turn[] = [];
/** The `messages` of every model request, in order. */
let requests: { role: string; content?: unknown }[][] = [];

function respond(res: ServerResponse, turn: Turn): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const sse = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  const delta = (d: Record<string, unknown>) => sse({ choices: [{ index: 0, delta: d }] });
  if (turn.text) delta({ content: turn.text });
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
  sse({
    choices: [
      { index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' },
    ],
  });
  sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  res.end('data: [DONE]\n\n');
}

/** What the model was told about tool results in request `i` (all tool messages, joined). */
function toolResults(i: number): string {
  return (requests[i] ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** The real directory as the editor would see it (no open buffers in this harness). */
class DiskWorkspace implements ReviewWorkspace {
  applyCalls = 0;
  private file(path: string): string {
    return join(workspace, path);
  }
  read(paths: readonly string[]) {
    return Promise.resolve(
      new Map(
        paths.map((p) => [p, existsSync(this.file(p)) ? readFileSync(this.file(p), 'utf8') : null]),
      ),
    );
  }
  apply(changes: readonly FileChange[]) {
    this.applyCalls++;
    const conflicts = changes
      .filter(
        (c) =>
          (existsSync(this.file(c.path)) ? readFileSync(this.file(c.path), 'utf8') : null) !==
          c.before,
      )
      .map((c) => c.path);
    if (conflicts.length > 0) return Promise.resolve({ applied: false, conflicts });
    for (const c of changes) {
      mkdirSync(dirname(this.file(c.path)), { recursive: true });
      writeFileSync(this.file(c.path), c.after);
    }
    return Promise.resolve({ applied: true, conflicts: [] });
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desiide-review-process-'));
  bundle = join(dir, 'orchestrator.js');
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../../../../packages/orchestrator/scripts/build.mjs'),
    '--outfile',
    bundle,
  ]);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: { role: string; content?: unknown }[] };
      requests.push(parsed.messages);
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

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  workspace = mkdtempSync(join(dir, 'ws-'));
  mkdirSync(join(workspace, 'src'));
  turns = [];
  requests = [];
});

/**
 * Runs one task with the extension's review service in the loop. `onEvent` plays the user: it sees
 * each event after the service has, and answers through the service like the cards do.
 */
async function run(
  input: TaskInputRaw,
  onEvent: (e: TaskEvent, service: ReviewService) => Promise<void> | void,
): Promise<{ events: TaskEvent[]; service: ReviewService; ws: DiskWorkspace }> {
  const client = new OrchestratorClient({
    modulePath: bundle,
    logDir: join(dir, 'logs'),
    workspaceRoots: () => [workspace],
    client: { name: 'desiide-ai-review-test', version: '0.0.0' },
    secrets: () => Promise.resolve(null),
    log: silent,
  });
  const ws = new DiskWorkspace();
  const service = new ReviewService({ workspace: ws, rpc: orchestratorReviewRpc(client) });
  const events: TaskEvent[] = [];
  try {
    await client.request('config.update', {
      models: [{ id: 'fake', provider: 'openai-compatible', model: 'scripted', baseUrl }],
      roles: { cheap: 'fake', strong: 'fake' },
    });
    const done = new Promise<void>((resolve, reject) => {
      client.onEvent((e) => {
        events.push(e);
        service.onEvent(e);
        Promise.resolve(onEvent(e, service)).catch(reject);
        if (e.type === 'state_changed' && ['done', 'failed', 'cancelled'].includes(e.to)) resolve();
      });
    });
    await client.request('task.create', input);
    await done;
  } finally {
    await client.dispose();
  }
  return { events, service, ws };
}

const accept = (
  service: ReviewService,
  e: Extract<TaskEvent, { type: 'edit_proposed' }>,
  rejected: string[] = [],
  reason?: string,
) =>
  service.submit(
    e.taskId,
    e.proposal.id,
    e.proposal.files.map((f) => ({ path: f.path, accept: !rejected.includes(f.path) })),
    reason,
  );

describe('UI-4 with the real task engine', () => {
  it('AC1: accept 2 of 3 files → exactly those written, the model told per file', async () => {
    for (const n of ['a', 'b', 'c'])
      writeFileSync(join(workspace, `src/${n}.ts`), `export const ${n} = 1;\n`);
    turns = [
      {
        toolCalls: [
          {
            id: 'call_edit',
            name: 'propose_edit',
            args: {
              files: ['a', 'b', 'c'].map((n) => ({
                path: `src/${n}.ts`,
                edits: [{ search: `${n} = 1`, replace: `${n} = 2` }],
              })),
            },
          },
        ],
      },
      { text: 'Done.' },
    ];
    let outcome: unknown;
    const { events, ws } = await run(
      { kind: 'refactor', instruction: 'Bump the constants', allowedTools: ['propose_edit'] },
      async (e, service) => {
        if (e.type === 'edit_proposed') outcome = await accept(service, e, ['src/b.ts'], 'leave b');
      },
    );
    expect(outcome).toEqual({ ok: true });
    expect(ws.applyCalls).toBe(1);
    expect(readFileSync(join(workspace, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(workspace, 'src/b.ts'), 'utf8')).toBe('export const b = 1;\n');
    expect(readFileSync(join(workspace, 'src/c.ts'), 'utf8')).toBe('export const c = 2;\n');
    const told = toolResults(1);
    expect(told).toContain('src/a.ts: applied');
    expect(told).toContain('src/b.ts: user rejected: leave b');
    expect(told).toContain('src/c.ts: applied');
    expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'done' });
  }, 60_000);

  it('AC2: the user edits the file after the proposal → stale → the agent re-reads and re-proposes', async () => {
    writeFileSync(join(workspace, 'src/a.ts'), 'export const add = (a, b) => a - b;\n');
    turns = [
      {
        toolCalls: [
          {
            id: 'call_edit1',
            name: 'propose_edit',
            args: { files: [{ path: 'src/a.ts', edits: [{ search: 'a - b', replace: 'a + b' }] }] },
          },
        ],
      },
      { toolCalls: [{ id: 'call_read', name: 'read_file', args: { path: 'src/a.ts' } }] },
      {
        toolCalls: [
          {
            id: 'call_edit2',
            name: 'propose_edit',
            args: {
              files: [
                {
                  path: 'src/a.ts',
                  edits: [{ search: '(a, b) => b - a', replace: '(a, b) => a + b' }],
                },
              ],
            },
          },
        ],
      },
      { text: 'Fixed.' },
    ];
    const proposals: string[] = [];
    const outcomes: unknown[] = [];
    const { events, service } = await run(
      {
        kind: 'bug_fix',
        instruction: 'Fix add',
        allowedTools: ['read_file', 'propose_edit'],
      },
      async (e, s) => {
        if (e.type === 'approval_required') await s.answer(e.taskId, e.approvalId, 'once');
        if (e.type !== 'edit_proposed') return;
        proposals.push(e.proposal.id);
        // Before answering the first one, the user changes the very line it targets.
        if (proposals.length === 1) {
          writeFileSync(join(workspace, 'src/a.ts'), 'export const add = (a, b) => b - a;\n');
        }
        outcomes.push(await accept(s, e));
      },
    );
    expect(proposals).toHaveLength(2);
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
    expect(service.state().map((r) => r.files)).toEqual([
      [{ path: 'src/a.ts', status: 'stale' }],
      [{ path: 'src/a.ts', status: 'applied' }],
    ]);
    // COR-2 forwarded the stale result to the model, which then re-read the file.
    expect(toolResults(1)).toContain('src/a.ts: stale');
    expect(toolResults(2)).toContain('b - a');
    expect(readFileSync(join(workspace, 'src/a.ts'), 'utf8')).toBe(
      'export const add = (a, b) => a + b;\n',
    );
    expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'done' });
  }, 60_000);

  it('AC3: run once / allow for this task / reject each reach COR-2 and behave', async () => {
    for (const f of ['a.tmp', 'b.tmp', 'keep.tmp']) writeFileSync(join(workspace, f), 'x');
    const rm = (id: string, file: string) => ({
      toolCalls: [{ id, name: 'shell', args: { command: `rm -f ${file}` } }],
    });
    turns = [
      rm('call_1', 'a.tmp'), // allow for this task
      rm('call_2', 'a.tmp'), // the exact same call: runs without asking
      rm('call_3', 'b.tmp'), // run once
      rm('call_4', 'keep.tmp'), // reject, with a reason
      { text: 'Cleaned up what I was allowed to.' },
    ];
    const asked: string[] = [];
    const answers: Record<string, 'once' | 'task' | 'reject'> = {
      call_1: 'task',
      call_3: 'once',
      call_4: 'reject',
    };
    const { events, service } = await run(
      { kind: 'infra_change', instruction: 'Clean temp files', allowedTools: ['shell'] },
      async (e, s) => {
        if (e.type !== 'approval_required') return;
        asked.push(e.call.id);
        expect(s.pending().map((p) => p.id)).toContain(e.approvalId);
        const answer = answers[e.call.id] ?? 'reject';
        const out = await s.answer(
          e.taskId,
          e.approvalId,
          answer,
          answer === 'reject' ? 'keep that one' : undefined,
        );
        expect(out).toEqual({ ok: true });
      },
    );
    expect(asked).toEqual(['call_1', 'call_3', 'call_4']);
    expect(existsSync(join(workspace, 'a.tmp'))).toBe(false);
    expect(existsSync(join(workspace, 'b.tmp'))).toBe(false);
    expect(existsSync(join(workspace, 'keep.tmp'))).toBe(true);
    const finished = events.flatMap((e) => (e.type === 'tool_call_finished' ? [e.result] : []));
    expect(finished.map((r) => [r.callId, r.ok])).toEqual([
      ['call_1', true],
      ['call_2', true],
      ['call_3', true],
      ['call_4', false],
    ]);
    expect(finished[3]?.error?.kind).toBe('rejected');
    expect(toolResults(4)).toContain('User rejected this shell call: keep that one');
    expect(service.pending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'state_changed', to: 'done' });
  }, 60_000);
});

describe('UI-4 × COR-4', () => {
  it('a proposal touching .env arrives with FileMeta.sensitive for the review card', async () => {
    writeFileSync(join(workspace, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(workspace, '.env'), 'COOKIE_SECURE=false\n');
    turns = [
      {
        toolCalls: [
          {
            id: 'call_edit',
            name: 'propose_edit',
            args: {
              files: [
                { path: 'src/a.ts', edits: [{ search: 'a = 1', replace: 'a = 2' }] },
                { path: '.env', edits: [{ search: 'false', replace: 'true' }] },
              ],
            },
          },
        ],
      },
      { text: 'Done.' },
    ];
    let meta: { path: string; sensitive: boolean }[] = [];
    await run(
      { kind: 'refactor', instruction: 'Secure cookies', allowedTools: ['propose_edit'] },
      async (e, s) => {
        if (e.type !== 'edit_proposed') return;
        meta = e.files.map((f) => ({ path: f.path, sensitive: f.sensitive }));
        await accept(s, e, ['.env']);
      },
    );
    expect(meta).toEqual(
      expect.arrayContaining([
        { path: 'src/a.ts', sensitive: false },
        { path: '.env', sensitive: true },
      ]),
    );
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('COOKIE_SECURE=false\n');
  }, 60_000);
});
