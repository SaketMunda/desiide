import type { AvailableModel, JevEngine } from '@desiide/jev';
import type { ModelAdapter } from '@desiide/models';
import { createFakeModelAdapter, type FakeTurn } from '@desiide/models/testing';
import type { ChoiceRequest } from '@desiide/jev';
import type { DecisionRecord, ModelRole, TaskInputRaw } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { createHarness, failed, fakeTools, ok } from '../tasks/testHarness.ts';
import { createWorkflowEngine } from './engine.ts';
import { resolveRoles, runnableOptions } from './roles.ts';

/** A Jev engine with fixed answers; records what it was asked. */
function scriptedEngine(selected: string, scores: Record<string, number> = {}) {
  const asked: { question: string; options?: string[] }[] = [];
  const engine: JevEngine = {
    kind: 'jev',
    choice: (req: ChoiceRequest) => {
      asked.push({ question: req.question, options: [...(req.options ?? [])] });
      return Promise.resolve({
        engine: 'jev',
        result: { kind: 'choice', selected, probs: { [selected]: 0.8 } },
        rationale: [],
        latencyMs: 3,
      });
    },
    score: (req) => {
      asked.push({ question: req.question });
      return Promise.resolve({
        engine: 'jev',
        result: { kind: 'score', score: scores[req.question] ?? 0 },
        rationale: [],
        latencyMs: 2,
      });
    },
    noul: () => Promise.reject(new Error('unused')),
  };
  return { engine, asked };
}

const edit = (id: string, path = 'src/a.ts') => ({
  id,
  name: 'propose_edit',
  args: { files: [{ path, edits: [{ search: 'a - b', replace: 'a + b' }] }] },
});
const usage = { inputTokens: 1000, outputTokens: 100 };

function setup(opts: {
  cheap?: FakeTurn[];
  strong?: FakeTurn[];
  roles?: Partial<Record<ModelRole, 'cheap' | 'strong'>>;
  engine: JevEngine;
  tests?: 'fail-once' | 'pass';
}) {
  const cheap = createFakeModelAdapter({ id: 'cheap', turns: opts.cheap ?? [] });
  const strong = createFakeModelAdapter({ id: 'strong', turns: opts.strong ?? [] });
  const byName = { cheap, strong };
  const assigned = opts.roles ?? { cheap: 'cheap', strong: 'strong' };
  const records: DecisionRecord[] = [];
  let testRuns = 0;
  const tools = fakeTools({
    run_tests: (c) =>
      opts.tests === 'fail-once' && testRuns++ === 0
        ? failed(c, 'FAIL src/a.test.ts: expected 3, got -1')
        : ok(c, 'Tests  3 passed'),
  });
  const workflows = createWorkflowEngine({
    roles: () =>
      resolveRoles((role) => {
        const name = assigned[role];
        if (!name) throw new Error(`no ${role}`);
        return byName[name];
      }),
    engine: () => opts.engine,
    onDecision: (r) => records.push(r),
    describeFiles: (paths) =>
      Promise.resolve(
        paths.map((path) => ({ path, sizeLines: 40, language: 'typescript', sensitive: false })),
      ),
    availableModels: (ids) =>
      Promise.resolve(
        ids.map((id): AvailableModel => ({
          id,
          contextTokens: 32_000,
          latencyMs: 0,
          costTier: id === 'cheap' ? 'free' : 'medium',
          locality: id === 'cheap' ? 'local' : 'cloud',
        })),
      ),
    newId: (() => {
      let n = 0;
      return () => `d${++n}`;
    })(),
  });
  const h = createHarness({
    model: cheap,
    tools: tools.run,
    overrides: {
      workflows,
      costPerMTok: (id) => (id === 'strong' ? { input: 3, output: 15 } : { input: 0, output: 0 }),
    },
  });
  /** Answers every edit proposal as applied. */
  const autoApply = (taskId: string) => {
    const loop = async () => {
      for (;;) {
        const p = await h.next('edit_proposed', taskId);
        h.tasks.reportEdits(
          taskId,
          p.proposal.id,
          p.proposal.files.map((f) => ({ path: f.path, status: 'applied' })),
        );
      }
    };
    void loop();
  };
  return { h, cheap, strong, records, tools, autoApply };
}

const bugFix = (extra: Partial<TaskInputRaw> = {}): TaskInputRaw => ({
  kind: 'bug_fix',
  instruction: 'Fix add() in src/a.ts',
  context: { refs: [{ type: 'file', path: 'src/a.ts' }] },
  success: { testsPass: true },
  allowedTools: ['read_file', 'propose_edit', 'run_tests'],
  ...extra,
});

describe('AC1: cascade escalates once when the cheap model fails the checks', () => {
  it('cheap draft fails tests → strong continues the same conversation → done; both logged', async () => {
    const { engine } = scriptedEngine('local-cloud-cascade');
    const { h, cheap, strong, records, autoApply } = setup({
      engine,
      tests: 'fail-once',
      cheap: [
        { toolCalls: [edit('c1')], usage },
        { text: 'Done.', usage },
      ],
      strong: [
        { text: 'The sign was wrong in two places.', toolCalls: [edit('s1')], usage },
        { text: 'Fixed.', usage },
      ],
    });
    const t = h.create(bugFix());
    autoApply(t.id);
    const summary = await h.tasks.settled(t.id);

    expect(summary).toMatchObject({
      state: 'done',
      workflow: 'local-cloud-cascade',
      models: ['cheap', 'strong'],
    });
    expect(cheap.calls).toHaveLength(2);
    expect(strong.calls).toHaveLength(2);
    // The strong model sees the cheap draft, the failure, and why it took over.
    const first = strong.calls[0]?.messages ?? [];
    const text = JSON.stringify(first);
    expect(text).toContain('Fix add() in src/a.ts');
    expect(text).toContain('expected 3, got -1');
    expect(text).toContain('taking over this task from a smaller model');
    expect(first.filter((m) => m.role === 'assistant')).toHaveLength(2);
    // Never two user messages in a row (the handoff joins the failure message).
    const roles = first.map((m) => m.role);
    expect(roles.some((r, i) => r === 'user' && roles[i + 1] === 'user')).toBe(false);

    // The decision log shows the routing and the escalation.
    expect(records.map((r) => [r.question, r.workflow])).toEqual([
      ['workflow', 'local-cloud-cascade'],
      ['complexity', 'local-cloud-cascade'],
      ['cheap_success', 'local-cloud-cascade'],
      ['escalation_need', 'local-cloud-cascade'],
      ['escalate', 'local-cloud-cascade'],
    ]);
    expect(records.at(-1)?.reasons).toEqual(['escalated', 'escalated:verification_failed']);

    // Usage and estimated cost per model.
    const usageEvents = h.of(t.id).flatMap((e) => (e.type === 'usage' ? [e] : []));
    expect(usageEvents.map((e) => [e.modelId, e.usage.costUsd])).toEqual([
      ['cheap', 0],
      ['cheap', 0],
      ['strong', 0.0045],
      ['strong', 0.0045],
    ]);
  });

  it('an edit that fails to parse escalates too, after every tool call has its result', async () => {
    const { engine } = scriptedEngine('local-cloud-cascade');
    const { h, cheap, strong, records, autoApply } = setup({
      engine,
      cheap: [
        {
          toolCalls: [
            { id: 'c1', name: 'propose_edit', args: '{"files": [ broken' },
            { id: 'c2', name: 'read_file', args: { path: 'src/a.ts' } },
          ],
        },
      ],
      strong: [{ toolCalls: [edit('s1')] }, { text: 'Fixed.' }],
    });
    const t = h.create(bugFix({ success: {} }));
    autoApply(t.id);
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    expect(cheap.calls).toHaveLength(1);
    const tools = (strong.calls[0]?.messages ?? []).filter((m) => m.role === 'tool');
    expect(tools.map((m) => (m.role === 'tool' ? m.toolCallId : ''))).toEqual(['c1', 'c2']);
    expect(records.at(-1)?.reasons).toEqual(['escalated', 'escalated:edit_failed']);
  });

  it('escalates at most once: the strong model iterates on its own failures', async () => {
    const { engine } = scriptedEngine('local-cloud-cascade');
    const { h, strong, records, autoApply } = setup({
      engine,
      tests: 'fail-once',
      cheap: [{ toolCalls: [{ id: 'c1', name: 'propose_edit', args: 'nope' }] }],
      // The strong model's first check fails too (fail-once is spent on it), then passes.
      strong: [{ toolCalls: [edit('s1')] }, { text: 'Done.' }, { text: 'Retried.' }],
    });
    const t = h.create(bugFix());
    autoApply(t.id);
    const summary = await h.tasks.settled(t.id);
    expect(summary.state).toBe('done');
    expect(strong.calls).toHaveLength(3);
    expect(records.filter((r) => r.question === 'escalate')).toHaveLength(1);
  });

  it('escalation_need ≥ 3 goes straight to the strong model', async () => {
    const { engine } = scriptedEngine('local-cloud-cascade', { escalation_need: 3 });
    const { h, cheap, strong, records } = setup({ engine, strong: [{ text: 'Explained.' }] });
    const t = h.create(bugFix({ kind: 'explain', success: {}, allowedTools: ['read_file'] }));
    expect(await h.tasks.settled(t.id)).toMatchObject({ state: 'done', models: ['strong'] });
    expect(cheap.calls).toHaveLength(0);
    expect(strong.calls).toHaveLength(1);
    expect(records.find((r) => r.question === 'escalation_need')?.reasons).toEqual([
      'escalated:escalation_need',
    ]);
  });
});

describe('AC2: a cascade whose cheap model succeeds never calls strong', () => {
  it('cheap draft passes the checks → done on cheap alone', async () => {
    const { engine } = scriptedEngine('local-cloud-cascade');
    const { h, cheap, strong, records, autoApply } = setup({
      engine,
      tests: 'pass',
      cheap: [
        { toolCalls: [edit('c1')], usage },
        { text: 'Done.', usage },
      ],
    });
    const t = h.create(bugFix());
    autoApply(t.id);
    expect(await h.tasks.settled(t.id)).toMatchObject({
      state: 'done',
      workflow: 'local-cloud-cascade',
      models: ['cheap'],
    });
    expect(cheap.calls).toHaveLength(2);
    expect(strong.calls).toHaveLength(0);
    expect(records.some((r) => r.question === 'escalate')).toBe(false);
  });
});

describe('AC3: options come from the configured roles', () => {
  it('missing cheap role → only cloud options are offered to Jev', async () => {
    const { engine, asked } = scriptedEngine('cloud-single');
    const { h, cheap, strong } = setup({
      engine,
      roles: { strong: 'strong' },
      strong: [{ text: 'Explained.' }],
    });
    const t = h.create(bugFix({ kind: 'explain', success: {}, allowedTools: ['read_file'] }));
    expect(await h.tasks.settled(t.id)).toMatchObject({ state: 'done', workflow: 'cloud-single' });
    expect(asked.find((a) => a.question === 'workflow')?.options).toEqual(['cloud-single']);
    expect(cheap.calls).toHaveLength(0);
    expect(strong.calls).toHaveLength(1);
  });

  it('role → option mapping (ADR-007), critique held back until Beta', () => {
    const m = (id: string) => ({ id }) as ModelAdapter;
    const roles = (r: Partial<Record<ModelRole, ModelAdapter>>) =>
      resolveRoles((role) => {
        const model = r[role];
        if (!model) throw new Error('unset');
        return model;
      });
    expect(runnableOptions(roles({ cheap: m('a'), strong: m('b'), reviewer: m('c') }))).toEqual([
      'local-single',
      'local-cloud-cascade',
      'cloud-single',
    ]);
    expect(runnableOptions(roles({ cheap: m('a') }))).toEqual(['local-single']);
    // One model in both roles: a cascade would repeat the same model.
    expect(runnableOptions(roles({ cheap: m('a'), strong: m('a') }))).toEqual([
      'local-single',
      'cloud-single',
    ]);
    expect(runnableOptions(roles({}))).toEqual([]);
  });

  it('no role at all fails the task with an actionable message, before any model call', async () => {
    const { engine } = scriptedEngine('local-single');
    const { h } = setup({ engine, roles: {} });
    const t = h.create(bugFix());
    const summary = await h.tasks.settled(t.id);
    expect(summary).toMatchObject({ state: 'failed', failureReason: 'model_unavailable' });
    const error = h.of(t.id).find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.message).toContain('desiide.roles.cheap');
  });
});

describe('AC4: workflowOverride', () => {
  it('bypasses selection but still logs a decision with user_override', async () => {
    const { engine, asked } = scriptedEngine('local-single');
    const { h, cheap, strong, records } = setup({ engine, strong: [{ text: 'Explained.' }] });
    const t = h.create(
      bugFix({
        kind: 'explain',
        success: {},
        allowedTools: ['read_file'],
        workflowOverride: 'cloud-single',
      }),
    );
    expect(await h.tasks.settled(t.id)).toMatchObject({ state: 'done', workflow: 'cloud-single' });
    expect(asked.filter((a) => a.question === 'workflow')).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      question: 'workflow',
      workflow: 'cloud-single',
      taskId: t.id,
      reasons: expect.arrayContaining(['user_override']),
    });
    expect(cheap.calls).toHaveLength(0);
    expect(strong.calls).toHaveLength(1);
  });
});
