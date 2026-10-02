import { describe, expect, it } from 'vitest';
import { WorkspacePath } from '@desiide/protocol';
import { createPathRedactor } from './redact.ts';

const SALT_A = 'workspace-a-salt-0123456789';
const SALT_B = 'workspace-b-salt-0123456789';

describe('path redaction', () => {
  // AC4: deterministic within a workspace.
  it('hashes the same path the same way, across redactor instances with the same salt', () => {
    const a1 = createPathRedactor({ salt: SALT_A });
    const a2 = createPathRedactor({ salt: SALT_A });
    const path = 'src/acme-secret-project/ledger.ts';
    expect(a1.path(path)).toBe(a1.path(path));
    expect(a1.path(path)).toBe(a2.path(path));
    expect(a1.path(path)).toMatch(/^src\/h_[0-9a-f]{10}\/h_[0-9a-f]{10}\.ts$/);
  });

  it('hashes differently in another workspace', () => {
    const path = 'src/acme/ledger.ts';
    expect(createPathRedactor({ salt: SALT_A }).path(path)).not.toBe(
      createPathRedactor({ salt: SALT_B }).path(path),
    );
  });

  it('keeps allow-listed folders and a shared folder hashes consistently', () => {
    const r = createPathRedactor({ salt: SALT_A });
    const a = r.path('packages/acme/src/auth/login.ts').split('/');
    const b = r.path('packages/acme/test/auth.test.ts').split('/');
    expect(a[0]).toBe('packages');
    expect(a[1]).toBe(b[1]);
    expect(a[2]).toBe('src');
    expect(a[3]).toBe('auth');
    expect(b[2]).toBe('test');
    expect(r.path('SRC/Billing/x')).toMatch(/^SRC\/Billing\/h_/);
  });

  it('never leaks a non-allow-listed name and stays a valid WorkspacePath', () => {
    const r = createPathRedactor({ salt: SALT_A });
    for (const p of [
      'acme/.env',
      '.github/workflows/deploy.yml',
      'clients/bigbank/contract.pdf',
      'Makefile',
    ]) {
      const out = r.path(p);
      expect(out).not.toMatch(/acme|bigbank|contract|Makefile|\.env$/);
      expect(WorkspacePath.safeParse(out).success).toBe(true);
    }
    expect(r.path('.github/workflows/deploy.yml')).toMatch(
      /^\.github\/workflows\/h_[0-9a-f]{10}\.yml$/,
    );
  });

  it('redacts path-like tokens inside commands', () => {
    const r = createPathRedactor({ salt: SALT_A });
    const out = r.command('pnpm vitest run src/bigbank/payout.test.ts --reporter=dot');
    expect(out).not.toContain('bigbank');
    expect(out).not.toContain('payout');
    expect(out).toMatch(/^pnpm vitest run src\/h_[0-9a-f]{10}\/h_[0-9a-f]{10}\.ts --reporter=dot$/);
    expect(r.command('git status')).toBe('git status');
  });

  it('supports a custom allow-list and rejects weak salts', () => {
    expect(createPathRedactor({ salt: SALT_A, allowList: ['acme'] }).path('acme/src')).toMatch(
      /^acme\/h_/,
    );
    expect(() => createPathRedactor({ salt: 'short' })).toThrow(/salt/);
  });
});
