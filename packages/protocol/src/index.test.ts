import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index.ts';

describe('@mutt/protocol', () => {
  it('exposes a protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.0');
  });
});
