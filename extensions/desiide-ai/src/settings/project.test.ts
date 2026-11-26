import { describe, expect, it } from 'vitest';
import { detectCommands, parseProjectFile, renderProjectFile } from './project.ts';
import { ensureRedactSalt, REDACT_SALT_KEY } from './salt.ts';

describe('project file', () => {
  it('parses missing, valid, and broken files', () => {
    expect(parseProjectFile(undefined)).toEqual({ config: {}, raw: {}, invalid: false });
    expect(parseProjectFile('{"testCommand":"pnpm test","x":1}')).toEqual({
      config: { testCommand: 'pnpm test' },
      raw: { testCommand: 'pnpm test', x: 1 },
      invalid: false,
    });
    expect(parseProjectFile('{nope').invalid).toBe(true);
    expect(parseProjectFile('[]').invalid).toBe(true);
    expect(parseProjectFile('{"testCommand":""}').invalid).toBe(true);
  });

  it('writes edits, drops empty fields, keeps unknown keys', () => {
    const text = renderProjectFile(
      { ignoreGlobs: ['dist/**'], lintCommand: 'old', future: true },
      { testCommand: ' pnpm test ', lintCommand: '', sensitiveGlobs: ['a/**', ' a/** ', ''] },
    );
    expect(JSON.parse(text)).toEqual({
      ignoreGlobs: ['dist/**'],
      future: true,
      testCommand: 'pnpm test',
      sensitiveGlobs: ['a/**'],
    });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses to write something that would not validate', () => {
    expect(() =>
      renderProjectFile(
        { sensitiveGlobs: 'x' },
        { testCommand: 'a', lintCommand: '', sensitiveGlobs: [] },
      ),
    ).not.toThrow();
    expect(() =>
      renderProjectFile({}, { testCommand: 'x'.repeat(2000), lintCommand: '', sensitiveGlobs: [] }),
    ).toThrow();
  });
});

describe('detectCommands', () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

  it('uses package.json scripts with the lockfile’s runner', () => {
    expect(detectCommands({ packageJson: pkg({ test: 'vitest', lint: 'eslint .' }) })).toEqual({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
    });
    expect(
      detectCommands({ packageJson: pkg({ test: 'x', check: 'y' }), lockfile: 'pnpm-lock.yaml' }),
    ).toEqual({ testCommand: 'pnpm test', lintCommand: 'pnpm check' });
    expect(
      detectCommands({ packageJson: pkg({ 'test:unit': 'x' }), lockfile: 'yarn.lock' }),
    ).toEqual({
      testCommand: 'yarn test:unit',
    });
  });

  it('falls back to other ecosystems', () => {
    expect(detectCommands({ packageJson: '{bad', cargoToml: true })).toEqual({
      testCommand: 'cargo test',
      lintCommand: 'cargo clippy',
    });
    expect(detectCommands({ goMod: true }).testCommand).toBe('go test ./...');
    expect(detectCommands({ pyproject: '[tool.ruff]\n' })).toEqual({
      testCommand: 'pytest',
      lintCommand: 'ruff check .',
    });
    expect(detectCommands({ makefile: 'build:\n\ttsc\ntest: build\n\tnode t.js\n' })).toEqual({
      testCommand: 'make test',
    });
    expect(detectCommands({})).toEqual({});
  });
});

describe('redaction salt', () => {
  const store = (initial?: unknown) => {
    const data = new Map<string, unknown>(
      initial === undefined ? [] : [[REDACT_SALT_KEY, initial]],
    );
    return {
      data,
      get: (k: string) => data.get(k),
      update: (k: string, v: unknown) => {
        data.set(k, v);
        return Promise.resolve();
      },
    };
  };

  it('creates 32 random bytes once and keeps them', () => {
    const s = store();
    const salt = ensureRedactSalt(s);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureRedactSalt(s)).toBe(salt);
    expect(ensureRedactSalt(store())).not.toBe(salt);
  });

  it('replaces a malformed stored value', () => {
    const s = store('/Users/me/project');
    expect(ensureRedactSalt(s, () => 'b'.repeat(64))).toBe('b'.repeat(64));
    expect(s.data.get(REDACT_SALT_KEY)).toBe('b'.repeat(64));
  });
});
