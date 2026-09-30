import { describe, expect, it } from 'vitest';
import { isDesiideApp, shouldOpenWelcome } from './appWelcome.ts';

describe('app-only first-run welcome', () => {
  it('detects the Desiide app by its exact appName', () => {
    expect(isDesiideApp('Desiide')).toBe(true);
    for (const other of ['Visual Studio Code', 'VSCodium', 'Cursor', 'Code - OSS', 'desiide', '']) {
      expect(isDesiideApp(other)).toBe(false);
    }
  });

  it('opens the walkthrough once, in the app only', () => {
    expect(shouldOpenWelcome('Desiide', false)).toBe(true);
    expect(shouldOpenWelcome('Desiide', true)).toBe(false);
    expect(shouldOpenWelcome('Visual Studio Code', false)).toBe(false);
  });
});
