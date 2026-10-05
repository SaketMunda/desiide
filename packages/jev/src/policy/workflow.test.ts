import type { DecisionRecord, WorkflowSelectState } from '@desiide/protocol';
import { exampleCostRouteState, exampleWorkflowSelectState } from '@desiide/protocol/fixtures';
import { describe, expect, it } from 'vitest';
import { createRuleJevEngine } from '../rules/engine.ts';
import type { JevEngine } from '../types.ts';
import { decideWorkflow } from './workflow.ts';

let n = 0;
const newId = (): string => `w${++n}`;
const rules = createRuleJevEngine();

/** Answers with fixed values, to drive each policy rule. */
function scripted(selected: string, complexity: number, cheapSuccess: number): JevEngine {
  return {
    kind: 'jev',
    noul: () => Promise.reject(new Error('unused')),
    choice: () =>
      Promise.resolve({
        engine: 'jev',
        result: { kind: 'choice', selected, probs: {} },
        rationale: [],
        latencyMs: 1,
      }),
    score: (req) =>
      Promise.resolve({
        engine: 'jev',
        result: { kind: 'score', score: req.question === 'complexity' ? complexity : cheapSuccess },
        rationale: [],
        latencyMs: 1,
      }),
  };
}

const models = (...localities: Array<'local' | 'cloud'>): WorkflowSelectState['availableModels'] =>
  localities.map((locality, i) => ({
    id: `m${i}`,
    contextTokens: 32_000,
    latencyMs: 100,
    costTier: locality === 'local' ? 'free' : 'high',
    locality,
  }));

const state = (over: Partial<WorkflowSelectState> = {}): WorkflowSelectState => ({
  ...exampleWorkflowSelectState,
  filesTouched: [...exampleWorkflowSelectState.filesTouched],
  availableModels: models('local', 'cloud'),
  ...over,
});
const task = (
  preference: 'cheap' | 'balance' | 'quality' = 'balance',
  workflowOverride?: string,
) => ({
  id: 't1',
  preference,
  ...(workflowOverride ? { workflowOverride: workflowOverride as never } : {}),
});

describe('AC1 goldens: workflow_select and cost_route examples', () => {
  it.each([
    ['rules', rules],
    ['overconfident Jev', scripted('cloud-with-critique', 4, 4)],
  ] as const)('%s picks an available workflow and logs all three questions', async (_n, engine) => {
    const records: DecisionRecord[] = [];
    const d = await decideWorkflow(
      {
        task: task(exampleCostRouteState.userCostBias),
        workflowState: exampleWorkflowSelectState,
        costState: exampleCostRouteState,
      },
      { engine, newId, onDecision: (r) => records.push(r) },
    );
    expect(d.workflow).toBeDefined();
    expect([
      'local-single',
      'cloud-single',
      'local-cloud-cascade',
      'cloud-with-critique',
    ]).toContain(d.workflow);
    expect(records.map((r) => r.question)).toEqual(['workflow', 'complexity', 'cheap_success']);
    expect(records.every((r) => r.workflow === d.workflow && r.taskId === 't1')).toBe(true);
    expect(records[0]?.id).toBe(d.decisionId);
  });
});

describe('workflow policy rules', () => {
  const run = (engine: JevEngine, t = task(), s = state()) =>
    decideWorkflow(
      { task: t, workflowState: s, costState: exampleCostRouteState },
      { engine, newId },
    );

  it('likely cheap success goes local-first unless the user wants quality', async () => {
    expect(await run(scripted('cloud-single', 1, 3))).toEqual(
      expect.objectContaining({
        workflow: 'local-cloud-cascade',
        reasons: ['policy_override:cheap_success'],
      }),
    );
    expect((await run(scripted('cloud-single', 1, 3), task('quality'))).workflow).toBe(
      'cloud-single',
    );
  });

  it('complex or sensitive work gets at least cloud-single, critique for quality', async () => {
    expect(await run(scripted('local-single', 3, 0))).toMatchObject({
      workflow: 'cloud-single',
      reasons: ['policy_override:complexity_floor'],
    });
    expect((await run(scripted('local-single', 3, 0), task('quality'))).workflow).toBe(
      'cloud-with-critique',
    );
    const sensitive = state({
      filesTouched: [{ path: '.env', sizeLines: 3, language: 'dotenv', sensitive: true }],
    });
    expect(await run(scripted('local-single', 0, 0), task(), sensitive)).toMatchObject({
      workflow: 'cloud-single',
      reasons: ['policy_override:sensitive_floor'],
    });
  });

  it('the complexity floor wins over cheap success', async () => {
    expect((await run(scripted('cloud-single', 4, 4))).workflow).toBe('cloud-single');
  });

  it('honors an available user choice and explains an unavailable one', async () => {
    expect(await run(scripted('cloud-single', 0, 0), task('balance', 'local-single'))).toEqual({
      workflow: 'local-single',
      reasons: ['policy_override:user_choice'],
    });
    const cloudOnly = state({ availableModels: models('cloud') });
    const d = await run(scripted('cloud-single', 0, 0), task('balance', 'local-single'), cloudOnly);
    expect(d).toMatchObject({
      workflow: 'cloud-single',
      reasons: ['option_unavailable:local-single'],
    });
  });

  it('with only local models, floors cannot reach the cloud and the choice stays local', async () => {
    const localOnly = state({ availableModels: models('local') });
    expect((await run(scripted('local-single', 4, 0), task(), localOnly)).workflow).toBe(
      'local-single',
    );
  });

  it('an engine picking an unavailable option is corrected', async () => {
    const localOnly = state({ availableModels: models('local') });
    expect(await run(scripted('cloud-with-critique', 0, 0), task(), localOnly)).toMatchObject({
      workflow: 'local-single',
      reasons: ['policy_override:option_unavailable'],
    });
  });

  it('no models means no workflow', async () => {
    expect(await run(rules, task(), state({ availableModels: [] }))).toEqual({
      workflow: undefined,
      reasons: ['no_models_configured'],
    });
  });
});
