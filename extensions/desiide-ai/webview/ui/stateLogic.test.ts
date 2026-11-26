import type { DecisionRecord } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { firstLanding, LANDING_WINDOW_MS, summarizeDecision, thinkingLabel } from './stateLogic.ts';

const record = (over: Partial<DecisionRecord>): DecisionRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: null,
  pack: 'risk_gate@1',
  question: 'policy',
  engine: 'rules',
  stateHash: 'h',
  state: {},
  result: { kind: 'noul', answer: 'yes', pYes: 1 },
  reasons: [],
  latencyMs: 0,
  ts: '2026-11-26T10:00:00.000Z',
  ...over,
});

describe('summarizeDecision', () => {
  it('is undefined for no records', () => {
    expect(summarizeDecision([])).toBeUndefined();
  });

  it('headlines a risk gate with P(safe now) and its policy outcome', () => {
    const s = summarizeDecision([
      record({ question: 'safe_now', result: { kind: 'noul', answer: 'no', pYes: 0.18 } }),
      record({ question: 'reversible', result: { kind: 'noul', answer: 'no', pYes: 0.4 } }),
      record({ question: 'policy', policyOutcome: 'confirm' }),
    ]);
    expect(s).toEqual({
      label: 'rules · risk gate',
      outcome: 'confirm',
      probability: 0.18,
      probabilityLabel: 'safe now',
    });
  });

  it('shows a routing choice with the selected workflow and its probability, for Jev', () => {
    const s = summarizeDecision([
      record({
        pack: 'workflow_select@1',
        question: 'workflow',
        engine: 'jev',
        result: { kind: 'choice', selected: 'local-single', probs: { 'local-single': 0.82 } },
        workflow: 'local-single',
      }),
    ]);
    expect(s).toEqual({
      label: 'Jev · route',
      workflow: 'local-single',
      probability: 0.82,
      probabilityLabel: 'local-single',
    });
  });

  it('leaves out the probability for a score-only check and names unknown packs plainly', () => {
    const s = summarizeDecision([
      record({ pack: 'new_pack@2', question: 'complexity', result: { kind: 'score', score: 3 } }),
    ]);
    expect(s).toEqual({ label: 'rules · new pack' });
  });
});

describe('firstLanding', () => {
  const now = Date.parse('2026-11-26T10:00:01.000Z');

  it('pulses a fresh decision once, never again for the same id', () => {
    const seen = new Set<string>();
    expect(firstLanding(seen, 'a', '2026-11-26T10:00:00.000Z', now)).toBe(true);
    expect(firstLanding(seen, 'a', '2026-11-26T10:00:00.000Z', now)).toBe(false);
  });

  it('does not pulse old decisions (reopened panel), missing or invalid timestamps', () => {
    const seen = new Set<string>();
    const old = new Date(now - LANDING_WINDOW_MS - 1).toISOString();
    expect(firstLanding(seen, 'old', old, now)).toBe(false);
    expect(firstLanding(seen, 'none', undefined, now)).toBe(false);
    expect(firstLanding(seen, 'bad', 'not a date', now)).toBe(false);
  });
});

describe('thinkingLabel', () => {
  it('says Thinking… while live and Thought for N once done', () => {
    expect(thinkingLabel(true, '2.0 s')).toBe('Thinking…');
    expect(thinkingLabel(false, '3.1 s')).toBe('Thought for 3.1 s');
  });
});
