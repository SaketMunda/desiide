import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestWorkspace } from '../tools/testWorkspace.ts';
import { createContextSensitivity } from './filters.ts';
import { filterDiff, gitDiff } from './workspaceIO.ts';

const signal = new AbortController().signal;
const sensitivity = createContextSensitivity();

describe('filterDiff', () => {
  it('keeps code hunks and replaces excluded files with a note', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/yarn.lock b/yarn.lock',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git "a/sec rets/.env" "b/sec rets/.env"',
      '+TOKEN=abc',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const r = filterDiff(diff, sensitivity);
    expect(r.paths).toEqual(['src/a.ts', 'yarn.lock', 'sec rets/.env', 'logo.png']);
    expect(r.text).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/yarn.lock b/yarn.lock',
        '[lockfile, not shown]',
        'diff --git "a/sec rets/.env" "b/sec rets/.env"',
        '[may contain secrets, not shown; read_file asks the user first]',
        'diff --git a/logo.png b/logo.png',
        '[binary file, not shown]',
      ].join('\n'),
    );
  });

  it('handles renames to a secret path by the new name', () => {
    const r = filterDiff(
      'diff --git a/config.json b/.env\nrename from config.json\n+K=v\n',
      sensitivity,
    );
    expect(r.text).not.toContain('K=v');
  });
});

describe('gitDiff', () => {
  it('does not run programs named in repo config', async () => {
    const ws = await makeTestWorkspace({ 'a.txt': 'one\n' }, { git: true });
    try {
      const marker = join(ws.root, 'PWNED');
      ws.git('config', 'diff.external', `sh -c 'touch ${marker}'`);
      ws.git('config', 'core.pager', `sh -c 'touch ${marker}'`);
      ws.git('config', 'core.fsmonitor', `sh -c 'touch ${marker}'`);
      await ws.write('a.txt', 'two\n');
      const d = await gitDiff(
        ws.root,
        'working',
        undefined,
        sensitivity,
        { env: ws.ctx.env },
        signal,
      );
      expect(d?.text).toContain('+two');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await ws.dispose();
    }
  });

  it('limits to a path and returns undefined outside a repository', async () => {
    const ws = await makeTestWorkspace({ 'a.txt': '1\n', 'b.txt': '1\n' }, { git: true });
    const plain = await makeTestWorkspace({ 'a.txt': '1\n' });
    try {
      await ws.write('a.txt', '2\n');
      await ws.write('b.txt', '2\n');
      const d = await gitDiff(
        ws.root,
        'working',
        'b.txt',
        sensitivity,
        { env: ws.ctx.env },
        signal,
      );
      expect(d?.paths).toEqual(['b.txt']);
      expect(
        await gitDiff(
          plain.root,
          'working',
          undefined,
          sensitivity,
          { env: plain.ctx.env },
          signal,
        ),
      ).toBeUndefined();
    } finally {
      await ws.dispose();
      await plain.dispose();
    }
  });
});
