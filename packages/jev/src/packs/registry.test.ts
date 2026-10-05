import { describe, expect, it } from 'vitest';
import { KnownPack, type WorkflowSelectState } from '@desiide/protocol';
import {
  exampleWorkflowSelectState,
  jevExampleStates,
  riskGateDenyListedState,
  riskGateReadOnlyState,
} from '@desiide/protocol/fixtures';
import { createRuleJevEngine } from '../rules/engine.ts';
import { JevRequestError } from '../types.ts';
import {
  allowedWorkflowOptions,
  isLocalModel,
  getPack,
  getQuestion,
  listPacks,
  parsePackState,
  resolveChoiceOptions,
} from './registry.ts';

describe('pack registry', () => {
  it('registers exactly the known v1 packs', () => {
    expect(listPacks().map((p) => p.id)).toEqual(KnownPack.options);
    for (const pack of listPacks()) expect(pack.id).toBe(`${pack.name}@${pack.version}`);
  });

  // AC1: the three example states validate against the pack schemas.
  it.each(jevExampleStates.map((s) => [s.pack, s] as const))(
    'example %s validates against its pack schema',
    (pack, state) => {
      expect(getPack(pack).schema.safeParse(state).success).toBe(true);
      expect(parsePackState(state)).toEqual(state);
    },
  );

  it.each([riskGateReadOnlyState, riskGateDenyListedState])(
    'extra risk_gate golden validates',
    (state) => {
      expect(getPack('risk_gate@1').schema.safeParse(state).success).toBe(true);
    },
  );

  it('rejects a state with an extra (e.g. contents) key', () => {
    const bad = { ...exampleWorkflowSelectState, contents: 'secret' };
    expect(() => parsePackState(bad)).toThrow(JevRequestError);
  });

  it('rejects unknown packs and questions with typed errors', () => {
    expect(() => getPack('risk_gate@2')).toThrow(expect.objectContaining({ code: 'unknown_pack' }));
    expect(() => getQuestion('risk_gate@1', 'nope', 'noul')).toThrow(
      expect.objectContaining({ code: 'unknown_question' }),
    );
    expect(() => getQuestion('risk_gate@1', 'safe_now', 'score')).toThrow(
      expect.objectContaining({ code: 'wrong_question_type' }),
    );
    expect(() => getQuestion('risk_gate@1', 'toString', 'noul')).toThrow(
      expect.objectContaining({ code: 'unknown_question' }),
    );
  });

  it('the rules engine answers every question of every pack', async () => {
    const engine = createRuleJevEngine();
    const examples = Object.fromEntries(jevExampleStates.map((s) => [s.pack, s]));
    for (const pack of listPacks()) {
      for (const q of Object.values(pack.questions)) {
        const state = parsePackState(examples[pack.id]);
        const result = await engine[q.type]({ state, question: q.id });
        expect(result.engine).toBe('rules');
        expect(result.result.kind).toBe(q.type);
        expect(result.rationale.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('workflow options', () => {
  const withModels = (tiers: Array<'free' | 'low' | 'high'>): WorkflowSelectState => ({
    ...exampleWorkflowSelectState,
    filesTouched: [...exampleWorkflowSelectState.filesTouched],
    availableModels: tiers.map((costTier, i) => ({
      id: `m${i}`,
      contextTokens: 8000,
      latencyMs: 100,
      costTier,
    })),
  });

  it('drops options whose models are not configured', () => {
    expect(allowedWorkflowOptions(withModels(['free', 'high']))).toEqual([
      'local-single',
      'cloud-single',
      'local-cloud-cascade',
      'cloud-with-critique',
    ]);
    expect(allowedWorkflowOptions(withModels(['free']))).toEqual(['local-single']);
    expect(allowedWorkflowOptions(withModels(['low']))).toEqual([
      'cloud-single',
      'cloud-with-critique',
    ]);
    expect(allowedWorkflowOptions(withModels([]))).toEqual([]);
  });

  it('uses locality over cost tier: a free cloud model is cloud, a paid local one is local', () => {
    const state: WorkflowSelectState = {
      ...withModels([]),
      availableModels: [
        {
          id: 'free-cloud',
          contextTokens: 8000,
          latencyMs: 100,
          costTier: 'free',
          locality: 'cloud',
        },
      ],
    };
    expect(allowedWorkflowOptions(state)).toEqual(['cloud-single', 'cloud-with-critique']);
    expect(
      isLocalModel({
        id: 'm',
        contextTokens: 1,
        latencyMs: 1,
        costTier: 'high',
        locality: 'local',
      }),
    ).toBe(true);
    expect(isLocalModel({ id: 'm', contextTokens: 1, latencyMs: 1, costTier: 'free' })).toBe(true);
  });

  it('validates requested options against the question', () => {
    const state = withModels(['free', 'high']);
    const q = getQuestion('workflow_select@1', 'workflow', 'choice');
    expect(resolveChoiceOptions(state, q, ['cloud-single', 'cloud-single'])).toEqual([
      'cloud-single',
    ]);
    expect(() => resolveChoiceOptions(state, q, ['yolo'])).toThrow(
      expect.objectContaining({ code: 'invalid_options' }),
    );
    expect(() => resolveChoiceOptions(withModels([]), q, undefined)).toThrow(
      expect.objectContaining({ code: 'invalid_options' }),
    );
  });
});
