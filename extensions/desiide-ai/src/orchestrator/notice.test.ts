import { describe, expect, it } from 'vitest';
import { RESTART_ACTION, SHOW_LOG_ACTION, secretStorageKey, statusNotice } from './notice.ts';
import { RestartPolicy } from './restartPolicy.ts';

describe('statusNotice', () => {
  it('stays quiet for healthy and transient states', () => {
    expect(statusNotice({ state: 'idle' })).toBeUndefined();
    expect(statusNotice({ state: 'starting' })).toBeUndefined();
    expect(statusNotice({ state: 'ready', pid: 1, serverVersion: '1' })).toBeUndefined();
    expect(
      statusNotice({ state: 'restarting', attempt: 1, delayMs: 250, reason: 'x' }),
    ).toBeUndefined();
    expect(statusNotice({ state: 'stopped' })).toBeUndefined();
  });

  it('offers a restart after a crash loop', () => {
    expect(
      statusNotice({ state: 'failed', reason: 'crash_loop', message: 'keeps crashing' }),
    ).toEqual({ message: 'keeps crashing', actions: [RESTART_ACTION, SHOW_LOG_ACTION] });
  });

  it('shows the protocol mismatch message without a pointless restart', () => {
    const message = 'Protocol mismatch: … Update Desiide so both sides match.';
    expect(statusNotice({ state: 'failed', reason: 'protocol_mismatch', message })).toEqual({
      message,
      actions: [SHOW_LOG_ACTION],
    });
  });
});

describe('secretStorageKey', () => {
  it('maps secret:<name> to the SecretStorage key <name>', () => {
    expect(secretStorageKey('secret:anthropic')).toBe('anthropic');
    expect(secretStorageKey('plain')).toBe('plain');
  });
});

describe('RestartPolicy', () => {
  it('allows 3 restarts per 60 s with exponential backoff, then stops', () => {
    const policy = new RestartPolicy();
    expect(policy.onCrash(0)).toEqual({ restart: true, attempt: 1, delayMs: 250 });
    expect(policy.onCrash(1_000)).toEqual({ restart: true, attempt: 2, delayMs: 500 });
    expect(policy.onCrash(2_000)).toEqual({ restart: true, attempt: 3, delayMs: 1_000 });
    expect(policy.onCrash(3_000)).toEqual({ restart: false });
  });

  it('slides the window and resets on demand', () => {
    const policy = new RestartPolicy({ maxDelayMs: 600 });
    policy.onCrash(0);
    policy.onCrash(10_000);
    policy.onCrash(20_000);
    expect(policy.onCrash(61_000)).toEqual({ restart: true, attempt: 3, delayMs: 600 });
    policy.reset();
    expect(policy.onCrash(62_000)).toMatchObject({ attempt: 1 });
  });
});
