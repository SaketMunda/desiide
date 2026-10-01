import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarize } from './commands.ts';
import { executeToolCall } from './runner.ts';
import { makeTestWorkspace, type TestWorkspace } from './testWorkspace.ts';

let tw: TestWorkspace;
const signal = new AbortController().signal;
const run = (tool: string, args: unknown = {}, ctx = tw.ctx) =>
  executeToolCall({ id: 'c1', tool, args }, ctx, signal);

beforeAll(async () => {
  const many = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  tw = await makeTestWorkspace(
    {
      '.gitignore': 'dist/\n*.log\n',
      'README.md': '# Fixture\nTODO: write docs\n',
      'src/app.ts': 'export const answer = 42;\n// TODO: refactor\nexport const Greeting = "hi";\n',
      'src/deep/a/b/c/d.ts': 'export const deep = true;\n',
      'src/long.txt': many,
      'src/crlf.txt': 'one\r\ntwo\r\n',
      'src/wide.txt': 'x'.repeat(3000) + '\n',
      'src/empty.txt': '',
      'dist/bundle.js': 'TODO in build output\n',
      'debug.log': 'TODO in a log\n',
      'node_modules/pkg/index.js': 'TODO in deps\n',
      '.env': 'NOT_A_SECRET_FIXTURE=1\n',
      'bin/blob.dat': '\u0000\u0001\u0002',
    },
    { git: true },
  );
  await symlink('/etc', join(tw.root, 'etc-link'));
});
afterAll(async () => {
  await tw.dispose();
});

describe('read_file', () => {
  it('returns numbered lines with a header', async () => {
    const { result } = await run('read_file', { path: 'src/app.ts' });
    expect(result.ok).toBe(true);
    expect(result.output.split('\n')).toEqual([
      'src/app.ts (lines 1-3 of 3)',
      '     1\texport const answer = 42;',
      '     2\t// TODO: refactor',
      '     3\texport const Greeting = "hi";',
    ]);
  });

  it('caps a read at 2,000 lines and says how to continue', async () => {
    const { result } = await run('read_file', { path: 'src/long.txt' });
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/^src\/long.txt \(lines 1-2000 of 2500\)/);
    expect(result.output).toMatch(/continue with startLine 2001\]$/);
    const big = await run('read_file', { path: 'src/long.txt', startLine: 1, endLine: 2500 });
    expect(big.result.output).toMatch(/lines 1-2000 of 2500/);
  });

  it('reads a line range', async () => {
    const { result } = await run('read_file', {
      path: 'src/long.txt',
      startLine: 2499,
      endLine: 2600,
    });
    expect(result.output).toBe(
      'src/long.txt (lines 2499-2500 of 2500)\n  2499\tline 2499\n  2500\tline 2500',
    );
    expect(result.truncated).toBe(false);
  });

  it('handles CRLF, empty files, and very long lines', async () => {
    expect((await run('read_file', { path: 'src/crlf.txt' })).result.output).toBe(
      'src/crlf.txt (lines 1-2 of 2)\n     1\tone\n     2\ttwo',
    );
    expect((await run('read_file', { path: 'src/empty.txt' })).result.output).toMatch(/empty file/);
    expect((await run('read_file', { path: 'src/wide.txt' })).result.output).toMatch(
      /line truncated/,
    );
  });

  it.each([
    [{ path: 'src/app.ts', startLine: 10 }, 'invalid_args', /past the end/],
    [{ path: 'src/app.ts', startLine: 3, endLine: 2 }, 'invalid_args', />= startLine/],
    [{ path: 'missing.ts' }, 'invalid_args', /no such file/],
    [{ path: 'src' }, 'failed', /is a directory/],
    [{ path: 'bin/blob.dat' }, 'failed', /binary/],
    [{ path: '../../etc/passwd' }, 'invalid_args', /\.\./],
    [{ path: 'etc-link/hosts' }, 'invalid_args', /outside the workspace/],
    [{ path: '/etc/hosts' }, 'invalid_args', /workspace-relative/],
  ])('rejects %j', async (args, kind, message) => {
    const { result } = await run('read_file', args);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe(kind);
    expect(result.output).toMatch(message);
  });
});

describe('list_files', () => {
  it('is gitignore-aware and skips .git and node_modules, but shows dotfiles', async () => {
    const { result } = await run('list_files', { depth: 10 });
    const files = result.output.split('\n');
    expect(files).toContain('src/app.ts');
    expect(files).toContain('.env');
    expect(files).toContain('src/deep/a/b/c/d.ts');
    expect(files.some((f) => f.startsWith('dist/') || f.endsWith('.log'))).toBe(false);
    expect(files.some((f) => f.startsWith('.git/') || f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('etc-link'))).toBe(false); // symlinks aren't followed
    expect(files).toEqual([...files].sort());
  });

  it('is depth-limited', async () => {
    const { result } = await run('list_files', { path: 'src', depth: 1 });
    expect(result.output.split('\n')).toEqual(expect.arrayContaining(['src/app.ts']));
    expect(result.output).not.toContain('src/deep/');
  });

  it('applies the limit and says more exist', async () => {
    const { result } = await run('list_files', { limit: 2, depth: 10 });
    expect(result.output.split('\n')).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/more files not shown/);
  });

  it('honors ProjectConfig.ignoreGlobs', async () => {
    const ctx = { ...tw.ctx, projectConfig: { ignoreGlobs: ['src/deep'] } };
    const { result } = await run('list_files', { depth: 10 }, ctx);
    expect(result.output).not.toContain('src/deep/');
  });

  it('lists a single file and rejects escapes', async () => {
    expect((await run('list_files', { path: 'src/app.ts' })).result.output).toBe('src/app.ts');
    expect((await run('list_files', { path: 'etc-link' })).result.error?.kind).toBe('invalid_args');
    expect((await run('list_files', { path: '..' })).result.error?.kind).toBe('invalid_args');
  });
});

describe('search', () => {
  it('finds literal matches as path:line: text, skipping ignored files', async () => {
    const { result } = await run('search', { query: 'TODO' });
    expect(result.output.split('\n')).toEqual([
      'README.md:2: TODO: write docs',
      'src/app.ts:2: // TODO: refactor',
    ]);
  });

  it('treats the query literally by default and as a regex on request', async () => {
    expect((await run('search', { query: 'answer = 4.' })).result.output).toBe('No matches.');
    expect((await run('search', { query: 'answer = 4.', regex: true })).result.output).toMatch(
      /src\/app.ts:1:/,
    );
  });

  it('uses smart case unless told otherwise', async () => {
    expect((await run('search', { query: 'greeting' })).result.output).toMatch(/app.ts:3/);
    expect((await run('search', { query: 'Greeting' })).result.output).toMatch(/app.ts:3/);
    expect((await run('search', { query: 'greeting', caseSensitive: true })).result.output).toBe(
      'No matches.',
    );
  });

  it('filters by path and glob', async () => {
    expect((await run('search', { query: 'TODO', path: 'src' })).result.output).not.toContain(
      'README',
    );
    expect((await run('search', { query: 'TODO', glob: '*.md' })).result.output).toBe(
      'README.md:2: TODO: write docs',
    );
  });

  it('caps results and says more exist', async () => {
    const { result } = await run('search', { query: 'line', path: 'src/long.txt', maxResults: 5 });
    expect(result.output.split('\n')).toHaveLength(6);
    expect(result.truncated).toBe(true);
  });

  it('does not read a query that looks like a flag as a flag', async () => {
    const { result } = await run('search', { query: '--files' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No matches.');
  });

  it('reports a bad regex as invalid_args', async () => {
    const { result } = await run('search', { query: '(unclosed', regex: true });
    expect(result.error?.kind).toBe('invalid_args');
    expect(result.output).toMatch(/regex parse error/);
  });

  it('does not follow symlinks out of the workspace', async () => {
    expect((await run('search', { query: 'localhost' })).result.output).toBe('No matches.');
    expect((await run('search', { query: 'localhost', path: 'etc-link' })).result.error?.kind).toBe(
      'invalid_args',
    );
  });
});

describe('git_read', () => {
  it('status shows branch and changes', async () => {
    await writeFile(join(tw.root, 'README.md'), '# Fixture\nchanged\n');
    const { result } = await run('git_read', { command: 'status' });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/^## main/);
    expect(result.output).toMatch(/ M README.md/);
  });

  it('diff, scoped to a path', async () => {
    const { result } = await run('git_read', { command: 'diff', path: 'README.md' });
    expect(result.output).toMatch(/-TODO: write docs\n\+changed/);
    const staged = await run('git_read', { command: 'diff', staged: true });
    expect(staged.result.output).toBe('(no output)');
  });

  it('log and show', async () => {
    const log = await run('git_read', { command: 'log', maxCount: 5 });
    expect(log.result.output).toMatch(
      /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Test \(HEAD -> main\) initial$/m,
    );
    const show = await run('git_read', { command: 'show', ref: 'HEAD:src/app.ts' });
    expect(show.result.output).toMatch(/answer = 42/);
  });

  it.each([
    [{ command: 'commit' }],
    [{ command: 'push' }],
    [{ command: 'show', ref: '--output=/tmp/pwned' }],
    [{ command: 'show', ref: 'HEAD; rm -rf /' }],
    [{ command: 'diff', path: '../outside' }],
    [{ command: 'status', extra: true }],
  ])('rejects %j', async (args) => {
    const { result } = await run('git_read', args);
    expect(result.error?.kind).toBe('invalid_args');
  });

  it('reports an unknown revision as a failed call', async () => {
    const { result } = await run('git_read', { command: 'show', ref: 'no-such-ref' });
    expect(result.error?.kind).toBe('failed');
    expect(result.error?.message).toMatch(/exited with code 128/);
  });

  it('does not run a repo-configured fsmonitor or external diff', async () => {
    const marker = join(tw.root, 'pwned');
    tw.git('config', 'core.fsmonitor', `touch ${marker}`);
    tw.git('config', 'diff.external', `touch ${marker}`);
    await run('git_read', { command: 'status' });
    await run('git_read', { command: 'diff' });
    tw.git('config', '--unset', 'core.fsmonitor');
    tw.git('config', '--unset', 'diff.external');
    const { access } = await import('node:fs/promises');
    await expect(access(marker)).rejects.toThrow();
  });
});

describe('shell', () => {
  it('runs at the workspace root with a scrubbed env', async () => {
    const ctx = { ...tw.ctx, env: { ...tw.ctx.env, OPENAI_API_KEY: 'sk-leak', VISIBLE: 'yes' } };
    const { result } = await run('shell', { command: 'pwd; env' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('VISIBLE=yes');
    expect(result.output).not.toContain('sk-leak');
    expect(result.output.split('\n')[0]).toMatch(/\/ws$/);
  });

  it('a non-zero exit is a failed call carrying the exit code and output', async () => {
    const { result } = await run('shell', { command: 'echo boom >&2; exit 7' });
    expect(result).toMatchObject({ ok: false, exitCode: 7, output: 'boom\n' });
    expect(result.error).toMatchObject({ kind: 'failed', message: 'command exited with code 7' });
  });

  it('times out', async () => {
    const { result } = await run('shell', { command: 'sleep 5', timeoutMs: 1000 });
    expect(result.error?.kind).toBe('timeout');
    expect(result.durationMs).toBeLessThan(4000);
  });

  it('cancels on abort', async () => {
    const ac = new AbortController();
    const p = executeToolCall(
      { id: 'c', tool: 'shell', args: { command: 'sleep 5' } },
      tw.ctx,
      ac.signal,
    );
    setTimeout(() => ac.abort(), 100);
    expect((await p).result.error?.kind).toBe('cancelled');
  });

  it('rejects an out-of-range timeout', async () => {
    const { result } = await run('shell', { command: 'true', timeoutMs: 10_000_000 });
    expect(result.error?.kind).toBe('invalid_args');
  });
});

describe('run_tests / lint', () => {
  it('runs the configured command and summarizes', async () => {
    const ctx = {
      ...tw.ctx,
      projectConfig: { testCommand: 'echo noise; echo "Tests  3 passed | 1 failed"; exit 1' },
    };
    const { result } = await run('run_tests', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/^\$ echo noise/);
    expect(result.output).toMatch(/tests failed \(exit 1\)/);
    expect(result.output).toMatch(/Summary:\n {2}Tests {2}3 passed \| 1 failed/);
  });

  it('lint passes on exit 0', async () => {
    const ctx = { ...tw.ctx, projectConfig: { lintCommand: 'echo clean' } };
    const { result } = await run('lint', {}, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/lint passed \(exit 0\)/);
  });

  it('explains how to configure a missing command', async () => {
    const { result } = await run('run_tests');
    expect(result.error?.kind).toBe('failed');
    expect(result.output).toMatch(/Add "testCommand" to .desiide\/project.json/);
  });

  it('takes no arguments (so the model cannot inject into the command)', async () => {
    const ctx = { ...tw.ctx, projectConfig: { testCommand: 'true' } };
    const { result } = await run('run_tests', { filter: '; rm -rf /' }, ctx);
    expect(result.error?.kind).toBe('invalid_args');
  });

  it('summarize picks result lines from common runners', () => {
    const out = [
      'collecting...',
      '===== 2 failed, 5 passed in 0.12s =====',
      'ok  \texample.com/pkg\t0.01s',
      'FAIL\texample.com/other',
      'test result: ok. 3 passed; 0 failed',
      '✖ 4 problems (4 errors, 0 warnings)',
      'random line',
    ].join('\n');
    expect(summarize(out)).toEqual([
      '===== 2 failed, 5 passed in 0.12s =====',
      'ok  \texample.com/pkg\t0.01s',
      'FAIL\texample.com/other',
      'test result: ok. 3 passed; 0 failed',
      '✖ 4 problems (4 errors, 0 warnings)',
    ]);
  });
});

describe('executeToolCall', () => {
  it('rejects an unknown tool with the list of available ones', async () => {
    const { result } = await run('rm_rf', {});
    expect(result.error?.kind).toBe('invalid_args');
    expect(result.output).toMatch(/Available: read_file, list_files/);
  });

  it('turns a crash inside a tool into a failed result', async () => {
    const ctx = { ...tw.ctx, rgPath: '/nonexistent/rg' };
    const { result } = await run('search', { query: 'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('failed');
    expect(result.output).toMatch(/could not start/);
  });

  it('does not start when already aborted', async () => {
    const r = await executeToolCall(
      { id: 'c', tool: 'shell', args: { command: 'touch should-not-exist' } },
      tw.ctx,
      AbortSignal.abort(),
    );
    expect(r.result.error?.kind).toBe('cancelled');
  });

  it('fills callId and durationMs', async () => {
    let t = 1000;
    const r = await executeToolCall(
      { id: 'call-9', tool: 'read_file', args: { path: 'src/app.ts' } },
      tw.ctx,
      signal,
      () => (t += 5),
    );
    expect(r.result).toMatchObject({ callId: 'call-9', durationMs: 5, truncated: false });
  });
});
