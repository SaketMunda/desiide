import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, checkProtocolCompatibility } from './version.ts';

describe('checkProtocolCompatibility', () => {
  it('accepts identical and same-major versions', () => {
    expect(checkProtocolCompatibility(PROTOCOL_VERSION, PROTOCOL_VERSION)).toEqual({ ok: true });
    expect(checkProtocolCompatibility('1.4.0', '1.0.2')).toEqual({ ok: true });
  });

  it('rejects a major mismatch with an actionable message', () => {
    const result = checkProtocolCompatibility('1.0.0', '2.0.0');
    expect(result).toMatchObject({ ok: false, reason: 'major_mismatch' });
    expect(!result.ok && result.message).toMatch(/Update Desiide/);
  });

  it('rejects malformed versions', () => {
    expect(checkProtocolCompatibility('1.0.0', 'v1')).toMatchObject({
      ok: false,
      reason: 'invalid_version',
    });
  });
});
