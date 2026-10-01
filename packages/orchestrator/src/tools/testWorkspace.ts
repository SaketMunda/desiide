// Test-only helper: a throwaway workspace and a ToolContext pointing at it.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '@desiide/protocol';
import { createWorkspace } from './paths.ts';
import { resolveRgPath } from './ripgrep.ts';
import type { ToolContext } from './types.ts';

export interface TestWorkspace {
  root: string;
  ctx: ToolContext;
  write(rel: string, content: string): Promise<void>;
  git(...args: string[]): string;
  dispose(): Promise<void>;
}

export async function makeTestWorkspace(
  files: Record<string, string> = {},
  opts: { git?: boolean; projectConfig?: ProjectConfig } = {},
): Promise<TestWorkspace> {
  const base = await mkdtemp(join(tmpdir(), 'desiide-tools-'));
  const root = join(base, 'ws');
  await mkdir(root);
  const write = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) await write(rel, content);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' });
  if (opts.git) {
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
  }

  const rgPath = await resolveRgPath({});
  if (!rgPath) throw new Error('ripgrep binary not found (@vscode/ripgrep)');
  let n = 0;
  const ctx: ToolContext = {
    workspace: await createWorkspace([root]),
    taskId: 'task-1',
    projectConfig: opts.projectConfig ?? {},
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base },
    rgPath,
    newId: () => `id-${++n}`,
  };
  return {
    root,
    ctx,
    write,
    git,
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
