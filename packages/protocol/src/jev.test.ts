import { describe, expect, it } from 'vitest';
import { jevExampleStates } from './fixtures/index.ts';
import { JevPackState } from './jev.ts';

describe('Jev example states', () => {
  it('covers each v1 pack exactly once', () => {
    expect(jevExampleStates.map((s) => s.pack)).toEqual([
      'workflow_select@1',
      'risk_gate@1',
      'cost_route@1',
    ]);
  });

  it.each(jevExampleStates.map((s) => [s.pack, s] as const))('%s is expressible', (_p, state) => {
    expect(JevPackState.parse(state)).toEqual(state);
  });

  it('pack states reject content-like fields (metadata only, ADR-005)', () => {
    for (const state of jevExampleStates) {
      expect(JevPackState.safeParse({ ...state, content: 'const secret = 1' }).success).toBe(false);
    }
  });
});
