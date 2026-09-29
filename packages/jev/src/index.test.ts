import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@mutt/protocol';
import { JEV_PROTOCOL_VERSION, PACKAGE_NAME } from './index.ts';

describe('@mutt/jev', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@mutt/jev');
  });

  it('imports @mutt/protocol', () => {
    expect(JEV_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
