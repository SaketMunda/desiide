import { createFakeModelAdapter } from '@desiide/models/testing';
import { Task, type TaskInputRaw } from '@desiide/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkspace } from '../tools/testWorkspace.ts';
import { makeTestWorkspace } from '../tools/testWorkspace.ts';
import { autoGate, createHarness } from '../tasks/testHarness.ts';
import { makeFixtureRepo, SECRET_SENTINEL } from './__fixtures__/repo.ts';
import { buildContextBundle, type ContextBundle } from './bundle.ts';
import {
  CONTEXT_GUIDANCE,
  contextBudget,
  createContextEngine,
  DEFAULT_CONTEXT_TOKENS,
  type ContextEngine,
} from './engine.ts';
import { createContextSensitivity } from './filters.ts';
import { listFiles } from './workspaceIO.ts';
import { resolveRgPath } from '../tools/ripgrep.ts';

const signal = new AbortController().signal;
let repo: TestWorkspace;
let engine: ContextEngine;

function task(context: TaskInputRaw['context'] = {}): Task {
  return Task.parse({ id: 't1', kind: 'bug_fix', instruction: 'Fix it', context });
}

const selection = (path: string, start: number, end: number) => ({
  type: 'selection' as const,
  path,
  range: { start: { line: start, character: 0 }, end: { line: end, character: 4 } },
});

function sectionPaths(b: ContextBundle): (string | undefined)[] {
  return b.sections.map((s) => s.path);
}

beforeAll(async () => {
  repo = await makeFixtureRepo();
  engine = createContextEngine({ workspaceRoots: () => [repo.root], env: repo.ctx.env });
});
afterAll(() => repo.dispose());

describe('contextBudget', () => {
  it('takes a quarter of the window, between 2k and 32k tokens', () => {
    expect(contextBudget(undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(contextBudget(4_096)).toBe(2_000);
    expect(contextBudget(32_768)).toBe(8_192);
    expect(contextBudget(200_000)).toBe(32_000);
  });
});

describe('AC4 snapshot of the fixture repo', () => {
  it('renders refs, selection, diff, open editors, and the repo map in priority order', async () => {
    const t = task({
      refs: [
        { type: 'file', path: 'src/app.ts' },
        selection('src/parser.ts', 199, 201),
        { type: 'folder', path: 'src/billing' },
        { type: 'file', path: '.env' },
        { type: 'diff', scope: 'working' },
        { type: 'diff', scope: 'staged' },
      ],
      openEditors: ['README.md', 'src/auth/session.ts', 'package-lock.json'],
    });
    const b = await engine.build(t, signal, { modelContextTokens: 32_768 });
    await expect(b.text).toMatchFileSnapshot('__snapshots__/fixture-bundle.md');
    expect({
      sections: b.sections.map((s) => ({ kind: s.kind, path: s.path, truncated: s.truncated })),
      files: b.files,
      omitted: b.omitted,
      tokenEstimate: b.tokenEstimate,
      budgetTokens: b.budgetTokens,
    }).toMatchSnapshot();
  });

  it('cuts a large file around the selection when the budget is tight', async () => {
    const b = await buildContextBundle({
      task: task({ refs: [selection('src/parser.ts', 199, 201)] }),
      workspace: repo.ctx.workspace,
      sensitivity: createContextSensitivity(),
      listing: undefined,
      diff: () => Promise.resolve(undefined),
      budgetTokens: 400,
      signal,
    });
    await expect(b.text).toMatchFileSnapshot('__snapshots__/fixture-tight.md');
    expect(b.tokenEstimate).toBeLessThanOrEqual(400);
    const sel = b.sections[0];
    expect(sel).toMatchObject({ kind: 'selection', path: 'src/parser.ts', truncated: true });
    expect(sel?.text).toContain('   200\texport function parseHeader');
    expect(sel?.text).toContain('partial');
  });
});

describe('AC1 budget', () => {
  const big = ['src/parser.ts', 'src/app.ts', 'README.md', 'src/billing/invoice.ts'];

  it('stays within the budget and keeps the explicit refs first', async () => {
    const t = task({
      refs: big.map((path) => ({ type: 'file' as const, path })),
      openEditors: ['src/auth/session.ts', 'package.json'],
    });
    const b = await engine.build(t, signal, { modelContextTokens: 8_000 });
    expect(b.budgetTokens).toBe(2_000);
    expect(b.tokenEstimate).toBeLessThanOrEqual(2_000);
    expect(Math.ceil(b.text.length / 4)).toBe(b.tokenEstimate);
    // The four refs, in the user's order, come before anything else.
    expect(sectionPaths(b).slice(0, 4)).toEqual(big);
    expect(b.sections[0]).toMatchObject({ path: 'src/parser.ts', truncated: true });
    // The small refs are whole even though the big one is cut.
    expect(b.sections[1]).toMatchObject({ path: 'src/app.ts', truncated: false });
  });

  it('never exceeds any budget, from tiny to large', async () => {
    const rgPath = await resolveRgPath({});
    const listing = await listFiles(repo.root, rgPath ?? '', [], { env: repo.ctx.env }, signal);
    const t = task({
      refs: [
        ...big.map((path) => ({ type: 'file' as const, path })),
        { type: 'folder', path: 'src' },
        selection('src/parser.ts', 10, 300),
        { type: 'diff', scope: 'working' },
      ],
      openEditors: ['src/auth/session.ts', 'package.json', 'Dockerfile'],
    });
    for (const budgetTokens of [
      50, 120, 300, 500, 800, 1_000, 1_500, 2_500, 4_000, 7_000, 12_000, 32_000,
    ]) {
      const b = await buildContextBundle({
        task: t,
        workspace: repo.ctx.workspace,
        sensitivity: createContextSensitivity(),
        listing,
        diff: () =>
          Promise.resolve({
            text: 'diff --git a/x b/x\n+'.repeat(400),
            truncated: false,
            paths: ['x'],
          }),
        budgetTokens,
        signal,
      });
      expect(b.tokenEstimate, `budget ${budgetTokens}`).toBeLessThanOrEqual(budgetTokens);
      // Attached files come before anything else, and if one of them didn't fit, nothing of
      // lower priority took its place.
      const kinds = b.sections.filter((s) => s.kind !== 'omitted');
      const explicit = kinds.filter((s) => s.kind === 'file' && big.includes(s.path ?? ''));
      expect(kinds.slice(0, explicit.length)).toEqual(explicit);
      if (explicit.length < big.length) {
        expect(kinds.every((s) => s.kind === 'file' || s.kind === 'folder')).toBe(true);
      }
    }
  });
});

describe('AC2 exclusions', () => {
  it('leaves out binaries, lockfiles, gitignored files, and secrets, saying why', async () => {
    const excluded = [
      'package-lock.json',
      'assets-logo.png',
      'data.bin.txt',
      'dist/bundle.js',
      'debug.log',
      '.env',
      'config/secrets/prod.json',
    ];
    const t = task({
      refs: [
        ...excluded.map((path) => ({ type: 'file' as const, path })),
        { type: 'folder', path: '.' },
      ],
      openEditors: ['.env', 'debug.log'],
    });
    const b = await engine.build(t, signal, { modelContextTokens: 200_000 });
    expect(b.text).not.toContain(SECRET_SENTINEL);
    for (const p of excluded) {
      expect(b.sections.some((s) => s.path === p && s.kind !== 'folder')).toBe(false);
    }
    expect(
      Object.fromEntries(
        b.omitted.filter((o) => excluded.includes(o.label)).map((o) => [o.label, o.reason]),
      ),
    ).toEqual({
      'package-lock.json': 'lockfile, not shown',
      'assets-logo.png': 'binary file, not shown',
      'data.bin.txt': 'binary file, not shown',
      'dist/bundle.js': 'ignored (.gitignore or ignoreGlobs), not shown',
      'debug.log': 'ignored (.gitignore or ignoreGlobs), not shown',
      '.env': 'may contain secrets, not shown; read_file asks the user first',
      'config/secrets/prod.json': 'may contain secrets, not shown; read_file asks the user first',
    });
    const map = b.sections.find((s) => s.kind === 'repo_map')?.text ?? '';
    expect(map).not.toMatch(/package-lock\.json|dist\/|debug\.log|assets-logo\.png/);
    expect(map).toContain('src/');
    // The folder's file contents skip the same files; the listing is gitignore-aware.
    const folder = b.sections.find((s) => s.kind === 'folder')?.text ?? '';
    expect(folder).not.toMatch(/dist\/|debug\.log/);
  });

  it('keeps secret and lockfile hunks out of the diff but says they changed', async () => {
    const b = await engine.build(task(), signal, { modelContextTokens: 200_000 });
    const diff = b.sections.find((s) => s.kind === 'diff')?.text ?? '';
    expect(diff).toContain('+  return header.name.trim();');
    expect(diff).toContain(
      'diff --git a/.env b/.env\n[may contain secrets, not shown; read_file asks the user first]',
    );
    expect(diff).toContain(
      'diff --git a/package-lock.json b/package-lock.json\n[lockfile, not shown]',
    );
    expect(diff).not.toContain(SECRET_SENTINEL);
    expect(diff).not.toContain('DEBUG=1');
    // Staged changes only when asked for.
    expect(diff).not.toContain('SESSION_TTL_S');
  });
});

describe('AC3 FileMeta.sensitive', () => {
  it('flags the default globs and nothing else', async () => {
    const paths = [
      'src/app.ts',
      'README.md',
      'src/auth/session.ts',
      'src/billing/invoice.ts',
      'src/payments-api/charge.ts',
      '.env',
      'db/migrations/001_init.sql',
      'config/secrets/prod.json',
      'infra/main.tf',
      'Dockerfile',
      '.github/workflows/ci.yml',
    ];
    const metas = await engine.describeFiles(paths, signal);
    expect(Object.fromEntries(metas.map((m) => [m.path, m.sensitive]))).toEqual({
      'src/app.ts': false,
      'README.md': false,
      'src/auth/session.ts': true,
      'src/billing/invoice.ts': true,
      'src/payments-api/charge.ts': true,
      '.env': true,
      'db/migrations/001_init.sql': true,
      'config/secrets/prod.json': true,
      'infra/main.tf': true,
      Dockerfile: true,
      '.github/workflows/ci.yml': true,
    });
  });

  it('uses the project sensitiveGlobs from .desiide/project.json', async () => {
    const ws = await makeTestWorkspace({
      '.desiide/project.json': JSON.stringify({ sensitiveGlobs: ['legal/**'] }),
      'legal/terms.md': 'x\n',
    });
    try {
      const e = createContextEngine({ workspaceRoots: () => [ws.root], env: ws.ctx.env });
      const [meta] = await e.describeFiles(['legal/terms.md'], signal);
      expect(meta).toEqual({
        path: 'legal/terms.md',
        sizeLines: 1,
        language: 'markdown',
        sensitive: true,
      });
      // A project secret is withheld like .env.
      const b = await e.build(task({ refs: [{ type: 'file', path: 'legal/terms.md' }] }), signal);
      expect(b.omitted).toContainEqual({
        label: 'legal/terms.md',
        reason: 'may contain secrets, not shown; read_file asks the user first',
      });
    } finally {
      await ws.dispose();
    }
  });
});

describe('describeFiles', () => {
  it('counts lines and handles files that do not exist yet', async () => {
    const metas = await engine.describeFiles(
      ['src/parser.ts', 'src/new/file.py', 'src/app.ts'],
      signal,
    );
    expect(metas).toEqual([
      { path: 'src/parser.ts', sizeLines: 400, language: 'typescript', sensitive: false },
      { path: 'src/new/file.py', sizeLines: 0, language: 'python', sensitive: false },
      { path: 'src/app.ts', sizeLines: 6, language: 'typescript', sensitive: false },
    ]);
  });
});

describe('edge cases', () => {
  it('merges a selection into the attached file it belongs to', async () => {
    const b = await engine.build(
      task({ refs: [{ type: 'file', path: 'src/app.ts' }, selection('src/app.ts', 2, 4)] }),
      signal,
    );
    expect(b.sections.filter((s) => s.path === 'src/app.ts')).toHaveLength(1);
    expect(b.sections[0]?.text.split('\n')[0]).toBe(
      '### File: src/app.ts (typescript, 6 lines, selection lines 3-5)',
    );
  });

  it('reports missing and outside paths instead of failing', async () => {
    const b = await engine.build(task({ refs: [{ type: 'file', path: 'nope.ts' }] }), signal);
    expect(b.omitted).toContainEqual({ label: 'nope.ts', reason: 'not found' });
  });

  it('works outside git: no implicit diff, and an explicit one is reported', async () => {
    const ws = await makeTestWorkspace({ 'a.ts': 'export {};\n' });
    try {
      const e = createContextEngine({ workspaceRoots: () => [ws.root], env: ws.ctx.env });
      const plain = await e.build(task({ refs: [{ type: 'file', path: 'a.ts' }] }), signal);
      expect(plain.sections.map((s) => s.kind)).toEqual(['file', 'repo_map']);
      const asked = await e.build(task({ refs: [{ type: 'diff', scope: 'working' }] }), signal);
      expect(asked.omitted).toEqual([
        { label: 'uncommitted changes', reason: 'git diff unavailable (not a git repository?)' },
      ]);
    } finally {
      await ws.dispose();
    }
  });

  it('works without ripgrep: no repo map and no folder contents', async () => {
    const e = createContextEngine({
      workspaceRoots: () => [repo.root],
      env: { ...repo.ctx.env, DESIIDE_RG_PATH: '/nonexistent/rg' },
    });
    const b = await e.build(
      task({
        refs: [
          { type: 'file', path: 'src/app.ts' },
          { type: 'folder', path: 'src' },
        ],
      }),
      signal,
    );
    expect(b.sections.some((s) => s.kind === 'repo_map')).toBe(false);
    expect(b.sections[0]?.path).toBe('src/app.ts');
    expect(b.omitted).toContainEqual({
      label: 'src/',
      reason: 'folder listing unavailable; use list_files',
    });
  });

  it('is empty without a workspace', async () => {
    const e = createContextEngine({ workspaceRoots: () => undefined });
    expect(await e.gather(task(), signal)).toEqual({ text: '' });
    expect(await e.describeFiles(['a.ts'], signal)).toEqual([]);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(
      engine.build(task({ refs: [{ type: 'file', path: 'src/app.ts' }] }), ac.signal),
    ).rejects.toThrow();
  });
});

describe('with the task engine', () => {
  it('puts the context in the first message and the guidance in the system prompt', async () => {
    const model = createFakeModelAdapter({ turns: [{ text: 'Done.' }] });
    const h = createHarness({ model, gate: autoGate, context: engine });
    const t = h.create({
      kind: 'bug_fix',
      instruction: 'Trim the name',
      context: { refs: [{ type: 'file', path: 'src/app.ts' }] },
    });
    expect((await h.tasks.settled(t.id)).state).toBe('done');
    const first = model.calls[0];
    expect(first?.system).toContain(CONTEXT_GUIDANCE);
    expect(first?.messages[0]?.content).toContain('### File: src/app.ts (typescript, 6 lines)');
    expect(first?.messages[0]?.content).toContain('     4\t  const header = parseHeader(raw);');
    expect(first?.messages[0]?.content).not.toContain(SECRET_SENTINEL);
  });
});
