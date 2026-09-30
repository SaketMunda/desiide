import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@desiide/protocol';
import { JEV_PROTOCOL_VERSION, PACKAGE_NAME } from './index.ts';

describe('@desiide/jev', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@desiide/jev');
  });

  it('imports @desiide/protocol', () => {
    expect(JEV_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
