import { ModelError } from '@desiide/models';
import { createFakeModelAdapter, type FakeTurn } from '@desiide/models/testing';
import { TaskEvent, type TaskEventType } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { TaskFailure } from './budget.ts';
import { confirmAllGate, type Gate } from './gate.ts';
import { createHarness, failed, fakeTools, ok } from './testHarness.ts';

const edit = (id: string, path = 'src/a.ts') => ({
  id,
  name: 'propose_edit',
  args: { files: [{ path, edits: [{ search: 'bug', replace: 'fix' }] }] },
});
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, args });

function expectWireValid(events: TaskEvent[]): void {
  for (const e of events) expect(TaskEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
  for (const id of new Set(events.map((e) => e.taskId))) {
    const seqs = events.filter((e) => e.taskId === id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  }
}

describe('AC1 happy path', () => {
  it('edit proposed → applied → tests approved and passing → done', async () => {
    const model = createFakeModelAdapter({
      turns: [
        {
          text: ['Fixing', ' the bug.'],
          toolCalls: [edit('c1')],
          usage: { inputTokens: 100, outputTokens: 20 },
        },
        { text: 'Done.', usage: { inputTokens: 150, outputTokens: 5 } },
      ],
    });
    const tools = fakeTools({ run_tests: (c) => ok(c, 'Tests  3 passed') });
    const h = createHarness({ model, tools: tools.run, gate: confirmAllGate });
    const t = h.create({
      kind: 'bug_fix',
      instruction: 'Fix the bug in a.ts',
      context: { refs: [{ type: 'file', path: 'src/a.ts' }] },
      success: { testsPass: true },
      allowedTools: ['read_file', 'propose_edit', 'run_tests'],
    });
    expect(t.state).toBe('queued');

    const proposed = await h.next('edit_proposed', t.id);
    expect(proposed.proposal.files[0]?.path).toBe('src/a.ts');
    // The edit is reviewed in the diff, not behind a second approval card.
    expect(h.of(t.id).some((e) => e.type === 'approval_required')).toBe(false);
    h.tasks.reportEdits(t.id, proposed.proposal.id, [{ path: 'src/a.ts', status: 'applied' }]);

    const approval = await h.next('approval_required', t.id);
    expect(approval.call).toMatchObject({ tool: 'run_tests', sideEffect: 'external' });
    h.tasks.approve(t.id, approval.approvalId, 'once');

    const summary = await h.tasks.settled(t.id);
    expect(summary).toMatchObject({
      state: 'done',
      iteration: 1,
      models: ['fake'],
      usage: { inputTokens: 250, outputTokens: 25 },
    });
    expect(h.states(t.id)).toEqual([
      'queued',
      'planning',
      'running',
      'awaiting_approval',
      'running',
      'verifying',
      'awaiting_approval',
      'verifying',
      'done',
    ]);
    // The model saw the user's context and, next turn, the apply result.
    expect(model.calls[0]?.messages[0]?.content).toContain('- file: src/a.ts');
    expect(model.calls[0]?.tools?.map((s) => s.name)).toEqual([
      'read_file',
      'propose_edit',
      'run_tests',
    ]);
    expect(model.calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      name: 'propose_edit',
      content: 'src/a.ts: applied',
    });
    const text = h.of(t.id).flatMap((e) => (e.type === 'text_delta' ? [e.delta] : []));
    expect(text.join('')).toBe('Fixing the bug.Done.');
    expect(tools.calls.map((c) => c.tool)).toEqual(['propose_edit', 'run_tests']);
    expectWireValid(h.events);
  });

  it('a task with no checks is done when the model stops calling tools', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'It does X.' }] });
    const h = createHarness({ model });
    const t = h.create({ kind: 'explain', instruction: 'What does a.ts do?' });
    expect((await h.tasks.settled(t.id)).state).toBe('done');
  });

  it('a stale file goes back to the model, which re-reads and proposes again', async () => {
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [edit('c1')] }, { toolCalls: [edit('c2')] }, { text: 'Done.' }],
    });
    const h = createHarness({ model });
    const t = h.create({ kind: 'bug_fix', instruction: 'fix' });
    const first = await h.next('edit_proposed', t.id);
    h.tasks.reportEdits(t.id, first.proposal.id, [{ path: 'src/a.ts', status: 'stale' }]);
    const second = await h.next('edit_proposed', t.id);
    h.tasks.reportEdits(t.id, second.proposal.id, [{ path: 'src/a.ts', status: 'applied' }]);
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      isError: true,
      content: expect.stringContaining('stale') as unknown,
    });
    const finished = h.of(t.id).filter((e) => e.type === 'tool_call_finished');
    expect(finished[0]).toMatchObject({ result: { ok: false, error: { kind: 'failed' } } });
  });

  it('collects per-file reports across calls and forwards rejection reasons', async () => {
    const model = createFakeModelAdapter({
      turns: [
        {
          toolCalls: [
            {
              id: 'c1',
              name: 'propose_edit',
              args: {
                files: [
                  { path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] },
                  { path: 'b.ts', edits: [{ search: 'x', replace: 'y' }] },
                ],
              },
            },
          ],
        },
        { text: 'ok' },
      ],
    });
    const h = createHarness({ model });
    const t = h.create({ kind: 'refactor', instruction: 'rename' });
    const p = await h.next('edit_proposed', t.id);
    expect(() =>
      h.tasks.reportEdits(t.id, p.proposal.id, [{ path: 'c.ts', status: 'applied' }]),
    ).toThrow(/Not in proposal/);
    h.tasks.reportEdits(t.id, p.proposal.id, [
      { path: 'b.ts', status: 'rejected', reason: 'keep b' },
    ]);
    expect(h.tasks.get(t.id).state).toBe('awaiting_approval');
    h.tasks.reportEdits(t.id, p.proposal.id, [{ path: 'a.ts', status: 'applied' }]);
    await h.tasks.settled(t.id);
    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      content: 'a.ts: applied\nb.ts: user rejected: keep b',
      isError: true,
    });
    expect(h.of(t.id).find((e) => e.type === 'tool_call_finished')).toMatchObject({
      result: { error: { kind: 'rejected', reasons: ['user_rejected'] } },
    });
    expect(() =>
      h.tasks.reportEdits(t.id, p.proposal.id, [{ path: 'a.ts', status: 'applied' }]),
    ).toThrow(/No pending/);
  });
});

describe('AC2 verification', () => {
  it('a failing test run goes back to the model; the second attempt passes', async () => {
    const model = createFakeModelAdapter({
      turns: [
        { toolCalls: [edit('c1')] },
        { text: 'Done.' },
        { toolCalls: [edit('c2')] },
        { text: 'Fixed for real.' },
      ],
    });
    let runs = 0;
    const tools = fakeTools({
      run_tests: (c) =>
        ++runs === 1 ? failed(c, 'Tests  1 failed | 2 passed') : ok(c, 'Tests  3 passed'),
    });
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({
      kind: 'bug_fix',
      instruction: 'fix',
      success: { testsPass: true },
      allowedTools: ['propose_edit', 'run_tests'],
    });
    for (let i = 0; i < 2; i++) {
      const p = await h.next('edit_proposed', t.id);
      h.tasks.reportEdits(t.id, p.proposal.id, [{ path: 'src/a.ts', status: 'applied' }]);
    }
    const summary = await h.tasks.settled(t.id);
    expect(summary).toMatchObject({ state: 'done', iteration: 2 });
    expect(runs).toBe(2);
    const feedback = model.calls[2]?.messages.at(-1);
    expect(feedback?.role).toBe('user');
    expect(feedback?.content).toContain('Verification failed');
    expect(feedback?.content).toContain('1 failed');
  });

  it('runs lint too, and reports every failing check at once', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'a' }, { text: 'b' }] });
    let n = 0;
    const tools = fakeTools({
      run_tests: (c) => (n++ === 0 ? failed(c, 'tests bad') : ok(c)),
      lint: (c) => (n++ === 1 ? failed(c, 'lint bad') : ok(c)),
    });
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({
      kind: 'other',
      instruction: 'x',
      success: { testsPass: true, lintClean: true },
    });
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    const feedback = model.calls[1]?.messages.at(-1)?.content;
    expect(feedback).toContain('## Tests\ntests bad');
    expect(feedback).toContain('## Lint\nlint bad');
  });

  it('a rejected check ends the task instead of looping', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'done' }] });
    const h = createHarness({ model, gate: confirmAllGate });
    const t = h.create({ kind: 'other', instruction: 'x', success: { testsPass: true } });
    const a = await h.next('approval_required', t.id);
    h.tasks.reject(t.id, a.approvalId, 'not now');
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'failed',
      failureReason: 'verification_rejected',
    });
  });

  it('a blocked check ends the task', async () => {
    const block: Gate = {
      evaluate: () => Promise.resolve({ outcome: 'block', reasons: ['deny_list'] }),
    };
    const model = createFakeModelAdapter({ turns: [{ text: 'done' }] });
    const h = createHarness({ model, gate: block });
    const t = h.create({ kind: 'other', instruction: 'x', success: { testsPass: true } });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'verification_blocked' });
  });
});

describe('AC3 budgets', () => {
  it('maxIterations', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'a' }, { text: 'b' }] });
    const tools = fakeTools({ run_tests: (c) => failed(c, 'still failing') });
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({
      kind: 'bug_fix',
      instruction: 'x',
      success: { testsPass: true },
      budget: { maxIterations: 2 },
    });
    const summary = await h.tasks.settled(t.id);
    expect(summary).toMatchObject({
      state: 'failed',
      failureReason: 'budget:maxIterations',
      iteration: 2,
    });
    expect(h.of(t.id).at(-2)).toMatchObject({ type: 'error', kind: 'budget:maxIterations' });
    expect(h.of(t.id).at(-1)).toMatchObject({
      type: 'state_changed',
      to: 'failed',
      reason: 'budget:maxIterations',
    });
  });

  it('maxToolCalls', async () => {
    const model = createFakeModelAdapter({
      turns: [
        {
          toolCalls: [call('a', 'read_file', { path: 'a' }), call('b', 'read_file', { path: 'b' })],
        },
        { toolCalls: [call('c', 'read_file', { path: 'c' })] },
      ],
    });
    const tools = fakeTools();
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({ kind: 'other', instruction: 'x', budget: { maxToolCalls: 2 } });
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'failed',
      failureReason: 'budget:maxToolCalls',
    });
    expect(tools.calls).toHaveLength(2);
  });

  it('maxTokens', async () => {
    const model = createFakeModelAdapter({
      turns: [
        {
          toolCalls: [call('a', 'read_file', { path: 'a' })],
          usage: { inputTokens: 300, outputTokens: 50 },
        },
        {
          toolCalls: [call('b', 'read_file', { path: 'b' })],
          usage: { inputTokens: 400, outputTokens: 50 },
        },
      ],
    });
    const tools = fakeTools();
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({ kind: 'other', instruction: 'x', budget: { maxTokens: 500 } });
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'failed',
      failureReason: 'budget:maxTokens',
      usage: { inputTokens: 700, outputTokens: 100 },
    });
    // The over-budget turn's tool calls never run.
    expect(tools.calls.map((c) => c.id)).toEqual(['a']);
  });

  it('wallClockMs', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'thinking', hang: true }] });
    const h = createHarness({ model });
    const t = h.create({ kind: 'other', instruction: 'x', budget: { wallClockMs: 50 } });
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'failed',
      failureReason: 'budget:wallClockMs',
    });
  });

  it('time waiting on the user does not count against wallClockMs', async () => {
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [call('a', 'shell', { command: 'ls' })] }, { text: 'ok' }],
    });
    const h = createHarness({ model, gate: confirmAllGate });
    const t = h.create({
      kind: 'other',
      instruction: 'x',
      allowedTools: ['shell'],
      budget: { wallClockMs: 100 },
    });
    const a = await h.next('approval_required', t.id);
    await new Promise((r) => setTimeout(r, 200));
    h.tasks.approve(t.id, a.approvalId, 'once');
    expect((await h.tasks.settled(t.id)).state).toBe('done');
  });
});

describe('AC4 loop detection', () => {
  it('fails on the third identical call in a row, ignoring key order', async () => {
    const model = createFakeModelAdapter({
      turns: [
        { toolCalls: [call('a', 'search', { query: 'x', glob: '*.ts' })] },
        { toolCalls: [call('b', 'search', { glob: '*.ts', query: 'x' })] },
        { toolCalls: [call('c', 'search', { query: 'x', glob: '*.ts' })] },
      ],
    });
    const tools = fakeTools();
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'failed',
      failureReason: 'loop_detected',
    });
    expect(tools.calls).toHaveLength(2);
  });

  it('does not fire when a different call breaks the run', async () => {
    const same = (id: string) => call(id, 'read_file', { path: 'a' });
    const model = createFakeModelAdapter({
      turns: [
        {
          toolCalls: [
            same('1'),
            same('2'),
            call('3', 'read_file', { path: 'b' }),
            same('4'),
            same('5'),
          ],
        },
        { text: 'ok' },
      ],
    });
    const h = createHarness({ model });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect((await h.tasks.settled(t.id)).state).toBe('done');
  });

  it('counts repeated malformed calls too', async () => {
    const bad = (id: string) => ({ id, name: 'read_file', args: '{"path": ' });
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [bad('1'), bad('2'), bad('3')] }],
    });
    const h = createHarness({ model });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'loop_detected' });
  });
});

describe('AC6 approvals', () => {
  it('a rejected command reaches the model with the reason, and the loop continues', async () => {
    const model = createFakeModelAdapter({
      turns: [
        { toolCalls: [call('c1', 'shell', { command: 'npm install left-pad' })] },
        { text: 'OK, skipping.' },
      ],
    });
    const tools = fakeTools();
    const h = createHarness({ model, tools: tools.run, gate: confirmAllGate });
    const t = h.create({ kind: 'other', instruction: 'x', allowedTools: ['shell'] });
    const a = await h.next('approval_required', t.id);
    expect(a).toMatchObject({
      outcome: 'confirm',
      call: { tool: 'shell', args: { command: 'npm install left-pad' } },
    });
    h.tasks.reject(t.id, a.approvalId, 'no new dependencies');
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    expect(tools.calls).toHaveLength(0);
    expect(model.calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      name: 'shell',
      content: 'User rejected this shell call: no new dependencies',
      isError: true,
    });
    expect(h.of(t.id).find((e) => e.type === 'tool_call_finished')).toMatchObject({
      result: { ok: false, error: { kind: 'rejected', reasons: ['user_rejected'] } },
    });
  });

  it('"allow for this task" covers exact repeats only', async () => {
    const model = createFakeModelAdapter({
      turns: [
        { toolCalls: [call('1', 'shell', { command: 'ls' })] },
        { toolCalls: [call('2', 'shell', { command: 'ls' })] },
        { toolCalls: [call('3', 'shell', { command: 'ls -la' })] },
        { text: 'ok' },
      ],
    });
    const h = createHarness({ model, gate: confirmAllGate });
    const t = h.create({ kind: 'other', instruction: 'x', allowedTools: ['shell'] });
    const first = await h.next('approval_required', t.id);
    h.tasks.approve(t.id, first.approvalId, 'task');
    const second = await h.next('approval_required', t.id);
    expect(second.call.args).toEqual({ command: 'ls -la' });
    h.tasks.approve(t.id, second.approvalId, 'once');
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    expect(h.of(t.id).filter((e) => e.type === 'approval_required')).toHaveLength(2);
  });

  it('a task-scoped approval never overrides a block', async () => {
    let blocked = false;
    const gate: Gate = {
      evaluate: () =>
        Promise.resolve(
          blocked
            ? { outcome: 'block', reasons: ['deny_list'] }
            : { outcome: 'confirm', reasons: [] },
        ),
    };
    const model = createFakeModelAdapter({
      turns: [
        { toolCalls: [call('1', 'shell', { command: 'ls' })] },
        { toolCalls: [call('2', 'shell', { command: 'ls' })] },
        { text: 'ok' },
      ],
    });
    const h = createHarness({ model, gate });
    const t = h.create({ kind: 'other', instruction: 'x', allowedTools: ['shell'] });
    const a = await h.next('approval_required', t.id);
    blocked = true;
    h.tasks.approve(t.id, a.approvalId, 'task');
    await h.tasks.settled(t.id);
    expect(h.of(t.id).filter((e) => e.type === 'tool_call_finished')[1]).toMatchObject({
      result: { ok: false, error: { kind: 'blocked', reasons: ['deny_list'] } },
    });
  });

  it('a blocked call returns a structured refusal and never runs', async () => {
    const gate: Gate = {
      evaluate: () =>
        Promise.resolve({ outcome: 'block', reasons: ['deny_list:rm_rf'], decisionId: 'd1' }),
    };
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [call('1', 'shell', { command: 'rm -rf /' })] }, { text: 'ok' }],
    });
    const tools = fakeTools();
    const h = createHarness({ model, gate, tools: tools.run });
    const t = h.create({ kind: 'other', instruction: 'x', allowedTools: ['shell'] });
    await h.tasks.settled(t.id);
    expect(tools.calls).toHaveLength(0);
    expect(h.of(t.id).some((e) => e.type === 'approval_required')).toBe(false);
    expect(model.calls[1]?.messages.at(-1)?.content).toBe('Blocked by policy: deny_list:rm_rf.');
  });

  it('a gate that throws falls back to asking the user', async () => {
    const gate: Gate = { evaluate: () => Promise.reject(new Error('jev down')) };
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [call('1', 'read_file', { path: 'a' })] }, { text: 'ok' }],
    });
    const h = createHarness({ model, gate });
    const t = h.create({ kind: 'other', instruction: 'x' });
    const a = await h.next('approval_required', t.id);
    expect(a.reasons).toEqual(['gate_error']);
    h.tasks.approve(t.id, a.approvalId, 'once');
    expect((await h.tasks.settled(t.id)).state).toBe('done');
  });

  it('approval and proposal ids are checked', async () => {
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [call('1', 'shell', { command: 'ls' })] }, { text: 'ok' }],
    });
    const h = createHarness({ model, gate: confirmAllGate });
    const t = h.create({ kind: 'other', instruction: 'x', allowedTools: ['shell'] });
    const a = await h.next('approval_required', t.id);
    expect(() => h.tasks.approve(t.id, 'nope', 'once')).toThrow(/No pending approval/);
    expect(() => h.tasks.approve('nope', a.approvalId, 'once')).toThrow(/No task/);
    h.tasks.approve(t.id, a.approvalId, 'once');
    expect(() => h.tasks.approve(t.id, a.approvalId, 'once')).toThrow(/No pending approval/);
    await h.tasks.settled(t.id);
  });
});

describe('AC7 malformed tool calls', () => {
  it('feeds each problem back to the model instead of crashing', async () => {
    const model = createFakeModelAdapter({
      turns: [
        {
          toolCalls: [
            { id: 'json', name: 'read_file', args: '{"path": ' },
            { id: 'schema', name: 'read_file', args: { path: 42 } },
            { id: 'array', name: 'read_file', args: '[1]' },
            { id: 'unknown', name: 'delete_everything', args: {} },
            { id: 'notallowed', name: 'shell', args: { command: 'ls' } },
          ],
        },
        { text: 'Sorry, done.' },
      ],
    });
    const tools = fakeTools();
    const h = createHarness({ model, tools: tools.run });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    expect(tools.calls).toHaveLength(0);
    const results = model.calls[1]?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(results.map((m) => [m.toolCallId, m.content.split('\n')[0]])).toEqual([
      ['json', expect.stringMatching(/^Arguments for read_file are not valid JSON/) as unknown],
      ['schema', 'Invalid arguments for read_file:'],
      ['array', 'Arguments for read_file must be a JSON object.'],
      ['unknown', expect.stringMatching(/^Unknown tool "delete_everything"/) as unknown],
      ['notallowed', 'The shell tool is not allowed for this task.'],
    ]);
    expect(results.every((m) => m.role === 'tool' && m.isError)).toBe(true);
    const finished = h.of(t.id).filter((e) => e.type === 'tool_call_finished');
    expect(finished.map((e) => e.type === 'tool_call_finished' && e.result.error?.kind)).toEqual([
      'invalid_args',
      'invalid_args',
      'invalid_args',
      'invalid_args',
      'blocked',
    ]);
    // Only a call with an allowed tool and object args is shown as started.
    const started = h.of(t.id).filter((e) => e.type === 'tool_call_started');
    expect(started.map((e) => e.type === 'tool_call_started' && e.call.id)).toEqual(['schema']);
    expectWireValid(h.events);
  });
});

describe('AC8 concurrency', () => {
  it('two tasks run with separate state, and a third waits in the queue', async () => {
    const models = new Map<string, ReturnType<typeof createFakeModelAdapter>>();
    const turnsFor = (n: string): FakeTurn[] => [
      { toolCalls: [call(`${n}-c`, 'shell', { command: `echo ${n}` })] },
      { text: `done ${n}` },
    ];
    const h = createHarness({
      gate: confirmAllGate,
      model: (task) => {
        const m = createFakeModelAdapter({
          id: task.instruction,
          turns: turnsFor(task.instruction),
        });
        models.set(task.instruction, m);
        return m;
      },
    });
    const input = (n: string) => ({
      kind: 'other' as const,
      instruction: n,
      allowedTools: ['shell' as const],
    });
    const a = h.create(input('A'));
    const aWait = h.next('approval_required', a.id);
    const b = h.create(input('B'));
    const bWait = h.next('approval_required', b.id);
    const c = h.create(input('C'));
    const [aApproval, bApproval] = await Promise.all([aWait, bWait]);

    expect(h.tasks.get(c.id).state).toBe('queued');
    expect(models.has('C')).toBe(false);
    // An approval belongs to its own task only.
    expect(() => h.tasks.approve(b.id, aApproval.approvalId, 'task')).toThrow(
      /No pending approval/,
    );
    expect(aApproval.call.args).toEqual({ command: 'echo A' });
    expect(bApproval.call.args).toEqual({ command: 'echo B' });

    const cWait = h.next('approval_required', c.id);
    h.tasks.approve(a.id, aApproval.approvalId, 'task');
    expect((await h.tasks.settled(a.id)).state).toBe('done');
    const cApproval = await cWait;
    expect(h.tasks.get(b.id).state).toBe('awaiting_approval');
    h.tasks.approve(b.id, bApproval.approvalId, 'once');
    h.tasks.approve(c.id, cApproval.approvalId, 'once');
    await Promise.all([h.tasks.settled(b.id), h.tasks.settled(c.id)]);

    for (const n of ['A', 'B', 'C']) {
      const m = models.get(n);
      expect(m?.calls[1]?.messages.at(-1)).toMatchObject({ toolCallId: `${n}-c` });
      expect(
        m?.calls
          .flatMap((r) => r.messages)
          .some((msg) => msg.content.includes(n === 'A' ? 'B' : 'A')),
      ).toBe(false);
    }
    expect(h.tasks.list().map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expectWireValid(h.events);
  });

  it('cancelling a queued task never starts it', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'working', hang: true }] });
    const h = createHarness({ model, maxRunning: 1 });
    const a = h.create({ kind: 'other', instruction: 'a' });
    const started = h.next('text_delta', a.id);
    const b = h.create({ kind: 'other', instruction: 'b' });
    expect(h.tasks.cancel(b.id)).toBe(true);
    expect(h.states(b.id)).toEqual(['queued', 'cancelled']);
    expect(h.tasks.cancel(b.id)).toBe(false);
    await started;
    h.tasks.cancel(a.id);
    expect((await h.tasks.settled(a.id)).state).toBe('cancelled');
    expect(model.calls).toHaveLength(1);
  });

  it('keeps only the most recent finished tasks', async () => {
    const h = createHarness({
      model: () => createFakeModelAdapter({ turns: [{ text: 'ok' }] }),
      overrides: { maxRetained: 2 },
    });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const t = h.create({ kind: 'other', instruction: `t${i}` });
      await h.tasks.settled(t.id);
      ids.push(t.id);
    }
    expect(h.tasks.list().map((s) => s.id)).toEqual(ids.slice(2));
  });
});

describe('failures', () => {
  it('a model error fails the task with a retryable error event', async () => {
    const model = createFakeModelAdapter({
      turns: [{ error: { kind: 'rate_limit', message: 'Slow down' } }],
    });
    const h = createHarness({ model });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'model_error:rate_limit' });
    expect(h.of(t.id).find((e) => e.type === 'error')).toMatchObject({
      kind: 'rate_limit',
      message: 'Slow down',
      retryable: true,
    });
  });

  it('no model for the role fails with the actionable hint', async () => {
    const h = createHarness({
      model: () => {
        throw new ModelError('bad_request', 'No model is assigned to the "cheap" role', {
          hint: 'Set desiide.roles.cheap in settings.',
        });
      },
    });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'model_unavailable' });
    expect(h.of(t.id).find((e) => e.type === 'error')).toMatchObject({
      kind: 'bad_request',
      message: 'No model is assigned to the "cheap" role Set desiide.roles.cheap in settings.',
    });
  });

  it('a TaskFailure from tool preparation fails before the model runs', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'x' }] });
    const h = createHarness({
      model,
      overrides: {
        prepareTools: () => Promise.reject(new TaskFailure('ripgrep_missing', 'no rg')),
      },
    });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'ripgrep_missing' });
    expect(model.calls).toHaveLength(0);
  });

  it('an unexpected crash is reported without leaking details', async () => {
    const errors: unknown[] = [];
    const model = createFakeModelAdapter({
      turns: [{ toolCalls: [call('1', 'read_file', { path: 'a' })] }],
    });
    const h = createHarness({
      model,
      tools: () => Promise.reject(new Error('boom /secret/path')),
      overrides: { logger: { info: () => {}, warn: () => {}, error: (o) => errors.push(o) } },
    });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect(await h.tasks.settled(t.id)).toMatchObject({ failureReason: 'internal_error' });
    expect(JSON.stringify(h.of(t.id))).not.toContain('/secret/path');
    expect(errors).toHaveLength(1);
  });

  it('usage carries a cost estimate when the model has a price', async () => {
    const model = createFakeModelAdapter({
      turns: [{ text: 'x', usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }],
    });
    const h = createHarness({
      model,
      overrides: { costPerMTok: () => ({ input: 3, output: 15 }) },
    });
    const t = h.create({ kind: 'other', instruction: 'x' });
    expect((await h.tasks.settled(t.id)).usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsd: 10.5,
    });
  });

  it('emits only known event types', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'x' }] });
    const h = createHarness({ model });
    await h.tasks.settled(h.create({ kind: 'other', instruction: 'x' }).id);
    const known: TaskEventType[] = ['state_changed', 'text_delta'];
    expect(new Set(h.events.map((e) => e.type))).toEqual(new Set(known));
  });
});
