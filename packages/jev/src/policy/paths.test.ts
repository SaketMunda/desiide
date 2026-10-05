import { describe, expect, it } from 'vitest';
import { createSensitivity, globToRegExp, looksLikePath, pathScope } from './paths.ts';

describe('createSensitivity', () => {
  const sensitive = createSensitivity(['src/billing/**', '*.sql']);
  it.each([
    ['.env', true],
    ['apps/web/.env.local', true],
    ['config/prod.env', true],
    ['certs/server.pem', true],
    ['keys/id_ed25519', true],
    ['home/.ssh/config', true],
    ['.aws/credentials', true],
    ['infra/terraform.tfstate', true],
    ['secrets/db.txt', true],
    ['src/lib/secretManager.ts', true],
    ['src/billing/invoice.ts', true],
    ['db/migrations/0001.sql', true],
    ['.env.example', false],
    ['config/credentials.sample', false],
    ['src/app.ts', false],
    ['README.md', false],
    ['src/environment.ts', false],
    ['./', false],
  ])('%s → %s', (path, expected) => {
    expect(sensitive(path)).toBe(expected);
  });
});

describe('globToRegExp', () => {
  it('anchors patterns with a slash and floats bare names', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('lib/src/a.ts')).toBe(false);
    expect(globToRegExp('*.ts').test('lib/src/a.ts')).toBe(true);
    expect(globToRegExp('src/{a,b}.ts').test('src/b.ts')).toBe(true);
    expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false);
    expect(globToRegExp('docs').test('docs/x/y.md')).toBe(true);
  });
});

describe('pathScope', () => {
  it.each([
    ['src/a.ts', 'workspace'],
    ['/dev/null', 'workspace'],
    ['../x', 'outside'],
    ['a/../../x', 'outside'],
    ['/tmp/build/x', 'outside'],
    ['/var/folders/ab/T/x', 'outside'],
    ['~/projects/app/x', 'outside'],
    ['/Users/me/projects/app', 'outside'],
    ['/', 'system'],
    ['/etc/hosts', 'system'],
    ['/usr/local/bin', 'system'],
    ['/tmp', 'system'],
    ['/foo', 'system'],
    ['~', 'system'],
    ['$HOME', 'system'],
    ['~/Documents', 'system'],
    ['~/.ssh/authorized_keys', 'system'],
    ['$HOME/.zshrc', 'system'],
    ['/Users/me', 'system'],
    ['/home/me/.bashrc', 'system'],
  ])('%s → %s', (path, scope) => {
    expect(pathScope(path)).toBe(scope);
  });

  it('only path-looking words count as paths', () => {
    expect(['-n', 'HEAD', 'main', 'foo'].some(looksLikePath)).toBe(false);
    expect(['a/b', '.env', 'x.ts', '~', '..', '/'].every(looksLikePath)).toBe(true);
  });
});
