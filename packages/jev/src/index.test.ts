import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, createRuleJevEngine, listPacks } from './index.ts';

describe('@desiide/jev', () => {
  it('exposes its package name and public API', () => {
    expect(PACKAGE_NAME).toBe('@desiide/jev');
    expect(createRuleJevEngine().kind).toBe('rules');
    expect(listPacks()).toHaveLength(3);
  });
});
