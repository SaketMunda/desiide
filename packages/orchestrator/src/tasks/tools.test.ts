import { Task } from '@desiide/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestWorkspace, type TestWorkspace } from '../tools/testWorkspace.ts';
import { TaskFailure } from './budget.ts';
import { prepareTaskTools } from './tools.ts';

const rg = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('../tools/ripgrep.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tools/ripgrep.ts')>();
  return { ...real, resolveRgPath: () => Promise.resolve(rg.path) };
});

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const ws of workspaces.splice(0)) await ws.dispose();
});

async function workspace(files: Record<string, string> = {}) {
  rg.path = '/usr/bin/rg';
  const ws = await makeTestWorkspace(files);
  workspaces.push(ws);
  return ws;
}

const task = (fields: Record<string, unknown> = {}) =>
  Task.parse({ id: 't1', kind: 'other', instruction: 'x', ...fields });
const signal = new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<TaskFailure> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TaskFailure);
  return err as TaskFailure;
}

describe('prepareTaskTools', () => {
  it('runs calls in the workspace with the task id', async () => {
    rg.path = '/usr/bin/rg';
    const ws = await workspace({ 'a.txt': 'hello\n' });
    const run = await prepareTaskTools(task(), {
      workspaceRoots: () => [ws.root],
      newId: () => 'n1',
    });
    const exec = await run({ id: 'c1', tool: 'read_file', args: { path: 'a.txt' } }, signal);
    expect(exec.result).toMatchObject({ callId: 'c1', ok: true });
    expect(exec.result.output).toContain('hello');
  });

  it('needs an open folder', async () => {
    const err = await failure(
      prepareTaskTools(task(), { workspaceRoots: () => undefined, newId: () => 'n' }),
    );
    expect(err.reason).toBe('no_workspace');
  });

  it('fails with an actionable message when ripgrep is missing and search tools are allowed', async () => {
    const ws = await workspace();
    rg.path = undefined;
    const env = { workspaceRoots: () => [ws.root], newId: () => 'n' };
    const err = await failure(prepareTaskTools(task(), env));
    expect(err.reason).toBe('ripgrep_missing');
    expect(err.message).toContain('DESIIDE_RG_PATH');
    // Without the rg tools, a missing ripgrep doesn't matter.
    await expect(prepareTaskTools(task({ allowedTools: ['read_file'] }), env)).resolves.toBeTypeOf(
      'function',
    );
  });

  it('fails when a success check has no command, and passes when it has one', async () => {
    rg.path = '/usr/bin/rg';
    const ws = await workspace();
    const env = { workspaceRoots: () => [ws.root], newId: () => 'n' };
    const err = await failure(
      prepareTaskTools(task({ success: { testsPass: true, lintClean: true } }), env),
    );
    expect(err.reason).toBe('no_check_command');
    expect(err.message).toContain('testCommand / lintCommand');
    await ws.write(
      '.desiide/project.json',
      JSON.stringify({ testCommand: 'true', lintCommand: 'true' }),
    );
    await expect(
      prepareTaskTools(task({ success: { testsPass: true, lintClean: true } }), env),
    ).resolves.toBeTypeOf('function');
  });

  it('logs project config warnings', async () => {
    rg.path = '/usr/bin/rg';
    const ws = await workspace({ '.desiide/project.json': '{ not json' });
    const warn = vi.fn();
    await prepareTaskTools(task(), {
      workspaceRoots: () => [ws.root],
      newId: () => 'n',
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    expect(warn).toHaveBeenCalled();
  });
});
