import type { EditProposal, TaskEvent, ToolCall } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { ReviewService } from './service.ts';
import { FakeRpc, FakeWorkspace } from './testDeps.ts';

const TS = '2026-11-27T10:00:00.000Z';
let seq = 0;
const ev = (e: Record<string, unknown>): TaskEvent =>
  ({ taskId: 't1', seq: seq++, ts: TS, ...e }) as TaskEvent;

const proposal: EditProposal = {
  id: 'p1',
  taskId: 't1',
  files: [
    { path: 'src/a.ts', edits: [{ search: 'a - b', replace: 'a + b' }] },
    { path: 'src/b.ts', edits: [{ search: 'old', replace: 'new' }] },
    { path: 'src/c.ts', edits: [{ search: 'one', replace: 'two' }] },
  ],
};
const proposed = (p: EditProposal = proposal) =>
  ev({ type: 'edit_proposed', proposal: p, files: [] });

const shell: ToolCall = {
  id: 'call1',
  tool: 'shell',
  args: { command: 'npm install' },
  sideEffect: 'external',
};
const approvalRequired = ev({
  type: 'approval_required',
  approvalId: 'ap1',
  call: shell,
  outcome: 'confirm',
  reasons: ['jev_uncertain', 'deny_list:rm_rf'],
  paths: [],
});

function setup(
  files: Record<string, string> = { 'src/a.ts': 'a - b', 'src/b.ts': 'old', 'src/c.ts': 'one' },
) {
  const workspace = new FakeWorkspace(files);
  const rpc = new FakeRpc();
  const service = new ReviewService({ workspace, rpc });
  let changes = 0;
  service.onChange(() => changes++);
  return { workspace, rpc, service, changes: () => changes };
}

const decide = (accept: Record<string, boolean>) =>
  Object.entries(accept).map(([path, a]) => ({ path, accept: a }));

describe('ReviewService: edit proposals', () => {
  it('AC1: accept 2 of 3 → exactly those applied, in ONE edit, and the orchestrator told per file', async () => {
    const { workspace, rpc, service } = setup();
    service.onEvent(proposed());
    expect(service.pending()).toEqual([
      { kind: 'review', taskId: 't1', id: 'p1', label: 'Review edits to 3 files' },
    ]);

    const out = await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': false, 'src/c.ts': true }),
      'keep b as is',
    );
    expect(out).toEqual({ ok: true });
    expect(workspace.applied).toHaveLength(1);
    expect(workspace.applied[0]?.changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(workspace.text('src/a.ts')).toBe('a + b');
    expect(workspace.text('src/b.ts')).toBe('old');
    expect(workspace.text('src/c.ts')).toBe('two');
    expect(rpc.calls).toEqual([
      [
        'report',
        't1',
        'p1',
        [
          { path: 'src/a.ts', status: 'applied' },
          { path: 'src/b.ts', status: 'rejected', reason: 'keep b as is' },
          { path: 'src/c.ts', status: 'applied' },
        ],
      ],
    ]);
    expect(service.state()[0]).toMatchObject({
      state: 'done',
      files: [
        { path: 'src/a.ts', status: 'applied' },
        { path: 'src/b.ts', status: 'rejected' },
        { path: 'src/c.ts', status: 'applied' },
      ],
    });
    expect(service.pending()).toEqual([]);
  });

  it('AC5: re-validates against the open (dirty) buffer, not the disk', async () => {
    const { workspace, service } = setup();
    // Unsaved edits elsewhere in the file: the block still matches, and the edit keeps them.
    workspace.buffers.set('src/a.ts', '// unsaved note\na - b');
    service.onEvent(proposed());
    await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': false, 'src/c.ts': false }),
    );
    expect(workspace.text('src/a.ts')).toBe('// unsaved note\na + b');
    expect(workspace.applied[0]?.changes[0]?.before).toBe('// unsaved note\na - b');
  });

  it('AC2: a file changed after the proposal → stale, the rest still applies', async () => {
    const { workspace, rpc, service } = setup();
    service.onEvent(proposed());
    workspace.buffers.set('src/a.ts', 'a * b'); // the user edited it
    await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': true, 'src/c.ts': false }),
    );
    expect(workspace.text('src/a.ts')).toBe('a * b');
    expect(workspace.text('src/b.ts')).toBe('new');
    expect(rpc.calls[0]?.[3]).toEqual([
      { path: 'src/a.ts', status: 'stale' },
      { path: 'src/b.ts', status: 'applied' },
      { path: 'src/c.ts', status: 'rejected' },
    ]);
  });

  it('a change between the read and the apply is re-validated, not overwritten', async () => {
    const { workspace, rpc, service } = setup();
    service.onEvent(proposed());
    workspace.beforeApply = () => workspace.buffers.set('src/a.ts', 'typed a - b');
    await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': false, 'src/c.ts': false }),
    );
    expect(workspace.text('src/a.ts')).toBe('typed a + b');
    expect(rpc.calls[0]?.[3]).toEqual([
      { path: 'src/a.ts', status: 'applied' },
      { path: 'src/b.ts', status: 'rejected' },
      { path: 'src/c.ts', status: 'rejected' },
    ]);
  });

  it('creates new files and rejects everything without touching the workspace', async () => {
    const { workspace, rpc, service } = setup({});
    service.onEvent(
      proposed({
        id: 'p2',
        taskId: 't1',
        files: [{ path: 'new.md', edits: [{ search: '', replace: '# hi\n' }] }],
      }),
    );
    await service.submit('t1', 'p2', decide({ 'new.md': true }));
    expect(workspace.applied[0]?.changes).toEqual([
      { path: 'new.md', before: null, after: '# hi\n' },
    ]);

    service.onEvent(proposed({ ...proposal, id: 'p3' }));
    await service.submit(
      't1',
      'p3',
      decide({ 'src/a.ts': false, 'src/b.ts': false, 'src/c.ts': false }),
    );
    expect(workspace.applied).toHaveLength(1);
    expect(rpc.calls[1]?.[3]).toEqual(
      ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => ({ path, status: 'rejected' })),
    );
  });

  it('refuses incomplete, repeated, unknown and expired answers', async () => {
    const { rpc, service } = setup();
    service.onEvent(proposed());
    expect(await service.submit('t1', 'p1', decide({ 'src/a.ts': true }))).toMatchObject({
      ok: false,
    });
    expect(
      await service.submit(
        't1',
        'p1',
        decide({ 'src/a.ts': true, 'src/b.ts': true, 'src/x.ts': true }),
      ),
    ).toMatchObject({ ok: false });
    expect(await service.submit('t1', 'nope', decide({ 'src/a.ts': true }))).toMatchObject({
      ok: false,
    });
    await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': true, 'src/c.ts': true }),
    );
    expect(
      await service.submit(
        't1',
        'p1',
        decide({ 'src/a.ts': true, 'src/b.ts': true, 'src/c.ts': true }),
      ),
    ).toEqual({ ok: false, error: 'This proposal was already answered.' });
    expect(rpc.calls).toHaveLength(1);

    service.onEvent(proposed({ ...proposal, id: 'p9' }));
    service.onEvent(ev({ type: 'state_changed', from: 'awaiting_approval', to: 'cancelled' }));
    expect(service.state().find((r) => r.proposalId === 'p9')?.state).toBe('expired');
    expect(service.pending()).toEqual([]);
    expect(
      await service.submit(
        't1',
        'p9',
        decide({ 'src/a.ts': true, 'src/b.ts': true, 'src/c.ts': true }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('an editor refusal leaves the proposal pending with the error; nothing is reported', async () => {
    const { workspace, rpc, service } = setup();
    workspace.refuse = true;
    service.onEvent(proposed());
    const out = await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': false, 'src/c.ts': false }),
    );
    expect(out.ok).toBe(false);
    expect(service.state()[0]).toMatchObject({
      state: 'pending',
      error: expect.stringContaining('rejected the edit'),
    });
    expect(rpc.calls).toEqual([]);
  });

  it('a failed report keeps the results and says the applied changes stay', async () => {
    const { rpc, service } = setup();
    rpc.fail = new Error('No pending approval');
    service.onEvent(proposed());
    const out = await service.submit(
      't1',
      'p1',
      decide({ 'src/a.ts': true, 'src/b.ts': false, 'src/c.ts': false }),
    );
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('Undo reverts') });
    expect(service.state()[0]?.files[0]?.status).toBe('applied');
  });

  it('previews the proposed text from the current buffer, flagging stale files', async () => {
    const { workspace, service } = setup();
    service.onEvent(proposed());
    expect(await service.proposedText('t1', 'p1', 'src/a.ts')).toEqual({
      text: 'a + b',
      stale: false,
      exists: true,
    });
    workspace.buffers.set('src/a.ts', 'changed');
    expect(await service.proposedText('t1', 'p1', 'src/a.ts')).toEqual({
      text: 'changed',
      stale: true,
      exists: true,
    });
    expect(await service.proposedText('t1', 'p1', 'nope.ts')).toBeUndefined();
  });
});

describe('ReviewService: approvals', () => {
  it('approve once / allow for task / reject go to the right RPC, once', async () => {
    const { rpc, service } = setup();
    service.onEvent(approvalRequired);
    expect(service.pending()).toEqual([
      { kind: 'approval', taskId: 't1', id: 'ap1', label: 'Run `npm install`' },
    ]);
    expect(await service.answer('t1', 'ap1', 'task')).toEqual({ ok: true });
    // A double click doesn't answer twice, and it no longer counts as pending.
    expect(await service.answer('t1', 'ap1', 'once')).toEqual({ ok: true });
    expect(service.pending()).toEqual([]);
    expect(rpc.calls).toEqual([['approve', 't1', 'ap1', 'task']]);

    service.onEvent(
      ev({
        type: 'tool_call_finished',
        result: { callId: 'call1', ok: true, output: '', truncated: false, durationMs: 1 },
      }),
    );
    expect(await service.answer('t1', 'ap1', 'once')).toMatchObject({ ok: false });

    service.onEvent({ ...approvalRequired, seq: seq++, approvalId: 'ap2' } as TaskEvent);
    await service.answer('t1', 'ap2', 'reject', 'no new deps');
    service.onEvent({ ...approvalRequired, seq: seq++, approvalId: 'ap3' } as TaskEvent);
    await service.answer('t1', 'ap3', 'reject', '');
    expect(rpc.calls.slice(1)).toEqual([
      ['reject', 't1', 'ap2', 'no new deps'],
      ['reject', 't1', 'ap3', undefined],
    ]);
  });

  it('a failed answer puts the request back as pending', async () => {
    const { rpc, service } = setup();
    rpc.fail = new Error('orchestrator restarting');
    service.onEvent(approvalRequired);
    expect(await service.answer('t1', 'ap1', 'once')).toMatchObject({ ok: false });
    expect(service.pending()).toHaveLength(1);
    expect(await service.answer('other-task', 'ap1', 'once')).toMatchObject({ ok: false });
  });

  it('translates reason labels from approvals and blocked results', () => {
    const { service } = setup();
    service.onEvent(approvalRequired);
    service.onEvent(
      ev({
        type: 'tool_call_finished',
        result: {
          callId: 'call9',
          ok: false,
          output: 'Blocked by policy',
          truncated: false,
          durationMs: 0,
          error: { kind: 'blocked', message: 'Blocked', reasons: ['deny_list:curl_pipe_sh'] },
        },
      }),
    );
    expect(service.reasons()).toEqual({
      jev_uncertain: "Jev isn't confident enough to run this unasked",
      'deny_list:rm_rf': 'Blocked: recursive delete of the system, home, or parent directory',
      'deny_list:curl_pipe_sh': 'Blocked: runs a downloaded script',
    });
  });

  it('a task that ends drops its approvals', () => {
    const { service } = setup();
    service.onEvent(approvalRequired);
    service.onEvent(ev({ type: 'state_changed', from: 'awaiting_approval', to: 'failed' }));
    expect(service.pending()).toEqual([]);
  });
});
