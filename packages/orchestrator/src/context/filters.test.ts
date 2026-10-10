import { describe, expect, it } from 'vitest';
import { createContextSensitivity, excludedByName } from './filters.ts';

describe('createContextSensitivity', () => {
  const s = createContextSensitivity();

  it.each([
    'src/auth/login.ts',
    'packages/api/auth/token.go',
    'billing/invoice.ts',
    'src/payments/charge.ts',
    'src/payment-gateway/stripe.ts',
    'config/app.env.local',
    '.env',
    '.env.production',
    'db/migrations/001_init.sql',
    'migrations/0002.py',
    'config/secrets/prod.json',
    'infra/main.tf',
    'main.tf',
    'Dockerfile',
    'services/api/Dockerfile',
    '.github/workflows/ci.yml',
    'docker-compose.yml',
  ])('AC3: %s is sensitive', (path) => {
    expect(s.sensitive(path)).toBe(true);
  });

  it.each(['src/app.ts', 'README.md', 'src/authorize.ts', 'docs/billing.md', 'tests/workflows.ts'])(
    '%s is not sensitive',
    (path) => {
      expect(s.sensitive(path)).toBe(false);
    },
  );

  it('separates secrets (never inlined) from high-risk areas (inlined, flagged)', () => {
    expect(s.secret('.env')).toBe(true);
    expect(s.secret('certs/server.pem')).toBe(true);
    expect(s.secret('config/secrets/prod.json')).toBe(true);
    expect(s.secret('src/auth/login.ts')).toBe(false);
    expect(s.secret('infra/main.tf')).toBe(false);
    // Templates are meant to be shared (JEV-2's rule).
    expect(s.secret('.env.example')).toBe(false);
  });

  it('adds the project sensitiveGlobs to both', () => {
    const p = createContextSensitivity(['internal/keys/**', '*.vault']);
    expect(p.secret('internal/keys/a.txt')).toBe(true);
    expect(p.sensitive('x/y.vault')).toBe(true);
    expect(s.sensitive('internal/keys/a.txt')).toBe(false);
  });
});

describe('excludedByName', () => {
  it.each([
    ['package-lock.json', 'lockfile'],
    ['web/pnpm-lock.yaml', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['poetry.lock', 'lockfile'],
    ['assets/logo.png', 'binary'],
    ['fonts/a.woff2', 'binary'],
    ['lib/native.so', 'binary'],
    ['dist/app.min.js', 'generated'],
    ['dist/app.js.map', 'generated'],
  ])('%s → %s', (path, reason) => {
    expect(excludedByName(path)).toBe(reason);
  });

  it('keeps ordinary source', () => {
    expect(excludedByName('src/lock.ts')).toBeUndefined();
    expect(excludedByName('package.json')).toBeUndefined();
    expect(excludedByName('Makefile')).toBeUndefined();
  });
});
