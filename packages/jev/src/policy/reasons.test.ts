import { KNOWN_REASON_LABELS } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { REASON_TEXT, describeReason } from './reasons.ts';

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
