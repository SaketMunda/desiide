import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathError, createWorkspace, resolveWorkspacePath, type Workspace } from './paths.ts';

let base: string;
let root: string;
let outside: string;
let ws: Workspace;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'desiide-paths-'));
  root = join(base, 'ws');
  outside = join(base, 'outside');
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'src', 'a.ts'), 'export {};\n');
  await writeFile(join(outside, 'secret.txt'), 'nope\n');
  await symlink('/etc', join(root, 'etc-link'));
  await symlink(outside, join(root, 'out-dir'));
  await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
  await symlink(join(outside, 'does-not-exist.txt'), join(root, 'dangling.txt'));
  await symlink(join(root, 'src'), join(root, 'src-link'));
  ws = await createWorkspace([root]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function rejection(input: string): Promise<PathError> {
  const err = await resolveWorkspacePath(ws, input).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected "${input}" to be rejected`).toBeInstanceOf(PathError);
  return err as PathError;
}

describe('resolveWorkspacePath: adversarial', () => {
  it.each([
    '../outside/secret.txt',
    '..',
    'src/../../outside/secret.txt',
    'src/nested/../../..',
    './..',
    '../ws/src/a.ts',
  ])('rejects traversal %s', async (input) => {
    expect((await rejection(input)).reason).toBe('outside');
  });

  it.each(['/etc/passwd', '/', 'C:/Windows/system32', 'c:\\Windows', '~/.ssh/id_rsa'])(
    'rejects absolute path %s',
    async (input) => {
      expect((await rejection(input)).reason).toBe('invalid');
    },
  );

  it('rejects an absolute path that points inside the workspace too', async () => {
    await rejection(join(root, 'src', 'a.ts'));
  });

  it.each([
    'etc-link/passwd',
    'etc-link',
    'out-dir/secret.txt',
    'out-dir/new-file.txt',
    'out-dir/new-dir/deeper.txt',
    'secret-link.txt',
  ])('rejects symlink escape %s', async (input) => {
    expect((await rejection(input)).reason).toBe('outside');
  });

  it('rejects a dangling symlink that would be written through', async () => {
    expect((await rejection('dangling.txt')).reason).toBe('outside');
  });

  it.each([
    ['fullwidth dots', '\uff0e\uff0e/outside/secret.txt'],
    ['fullwidth slash', '..\uff0foutside'],
    ['division slash', '..\u2215outside'],
    ['fraction slash', 'src\u2044a.ts'],
    ['one dot leader pair', '\u2024\u2024/outside'],
    ['backslash traversal', '..\\outside\\secret.txt'],
    ['NUL byte', 'src/a.ts\u0000.png'],
    ['RTL override', 'src/\u202etxt.ts'],
    ['zero-width space', 'src/\u200ba.ts'],
    ['zero-width joiner in dots', '.\u200d./outside'],
    ['BOM', '\ufeffsrc/a.ts'],
    ['newline', 'src/a.ts\n../../etc/passwd'],
    ['line separator', 'src\u2028a.ts'],
  ])('rejects Unicode trick: %s', async (_name, input) => {
    await rejection(input);
  });

  it('rejects empty and oversized input', async () => {
    await rejection('');
    await rejection('a/'.repeat(3000));
  });
});

describe('resolveWorkspacePath: allowed', () => {
  it('resolves an existing file to a POSIX relative path', async () => {
    const r = await resolveWorkspacePath(ws, './src//a.ts');
    expect(r).toMatchObject({ rel: 'src/a.ts', root: ws.roots[0], exists: true });
  });

  it('resolves the root itself', async () => {
    expect((await resolveWorkspacePath(ws, '.')).rel).toBe('.');
    expect((await resolveWorkspacePath(ws, './')).rel).toBe('.');
  });

  it('allows a symlink that stays inside the workspace', async () => {
    const r = await resolveWorkspacePath(ws, 'src-link/a.ts');
    expect(r.exists).toBe(true);
  });

  it('allows a new file in a new directory', async () => {
    const r = await resolveWorkspacePath(ws, 'src/new/dir/file.ts');
    expect(r).toMatchObject({ rel: 'src/new/dir/file.ts', exists: false });
  });

  it('allows names that merely contain dots', async () => {
    expect((await resolveWorkspacePath(ws, 'src/..hidden')).rel).toBe('src/..hidden');
    expect((await resolveWorkspacePath(ws, '...')).rel).toBe('...');
  });

  it('allows non-ASCII names that are not tricks', async () => {
    expect((await resolveWorkspacePath(ws, 'docs/日本語.md')).rel).toBe('docs/日本語.md');
  });

  it('reports not_found when the caller requires existence', async () => {
    const err = await resolveWorkspacePath(ws, 'nope.ts', { mustExist: true }).catch(
      (e: unknown) => e,
    );
    expect((err as PathError).reason).toBe('not_found');
  });
});

describe('multi-root', () => {
  it('prefers the root where the path exists and defaults new files to the first root', async () => {
    const second = join(base, 'second');
    await mkdir(second);
    await writeFile(join(second, 'only-here.md'), '# hi\n');
    const multi = await createWorkspace([root, second]);
    expect((await resolveWorkspacePath(multi, 'only-here.md')).root).toBe(multi.roots[1]);
    expect((await resolveWorkspacePath(multi, 'brand-new.md')).root).toBe(multi.roots[0]);
  });

  it('requires absolute roots', async () => {
    await expect(createWorkspace(['relative/root'])).rejects.toBeInstanceOf(PathError);
    await expect(createWorkspace([])).rejects.toBeInstanceOf(PathError);
  });
});
