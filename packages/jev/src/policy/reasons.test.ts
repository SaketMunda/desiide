import { KNOWN_REASON_LABELS } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { DENY_CORPUS } from './commands.test.ts';
import { DENY_RULES, REASON_TEXT, describeReason } from './reasons.ts';

describe('describeReason', () => {
  it('has text for every label known to the protocol', () => {
    for (const label of KNOWN_REASON_LABELS) expect(REASON_TEXT[label]).toBeTruthy();
  });

  it('renders details, deny rules, overrides, and unknown labels', () => {
    expect(describeReason('deny_list:rm_rf')).toBe(
      'Blocked: recursive delete of the system, home, or parent directory',
    );
    expect(describeReason('deny_list:new_rule')).toBe('Blocked: new_rule');
    expect(describeReason('policy_override:cheap_success')).toBe(
      'Adjusted by policy: a local model is likely to succeed',
    );
    expect(describeReason('option_unavailable:local-single')).toMatch(/\(local-single\)$/);
    expect(describeReason('something_new:x')).toBe('something new x');
  });
});

describe('DENY_RULES', () => {
  it('lists every rule the deny corpus triggers, each with text', () => {
    const ids = new Set(DENY_RULES.map((r) => r.id));
    for (const [, rule] of DENY_CORPUS) expect(ids).toContain(rule);
    for (const r of DENY_RULES)
      expect(describeReason(`deny_list:${r.id}`)).toBe(`Blocked: ${r.text}`);
  });

  it('is frozen, so a consumer cannot edit the shown list', () => {
    expect(Object.isFrozen(DENY_RULES)).toBe(true);
  });
});

describe('COR-5 labels', () => {
  it('explains escalations and user overrides', () => {
    expect(describeReason('escalated')).toBe('Handed to the stronger model');
    expect(describeReason('escalated:verification_failed')).toBe(
      'Handed to the stronger model: the checks failed',
    );
    expect(describeReason('escalated:edit_failed')).toBe(
      "Handed to the stronger model: the draft edit didn't parse or apply",
    );
    expect(describeReason('user_override')).toBe('You picked this workflow');
  });
});
