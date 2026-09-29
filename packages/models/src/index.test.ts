import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@mutt/models', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@mutt/models');
  });
});
