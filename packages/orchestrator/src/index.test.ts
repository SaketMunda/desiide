import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@mutt/orchestrator', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@mutt/orchestrator');
  });
});
