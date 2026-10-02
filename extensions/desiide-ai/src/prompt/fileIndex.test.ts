import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { FileIndex, MAX_FILE_RESULTS } from './fileIndex.ts';
import { fuzzyScore, rankBy } from './fuzzy.ts';

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively and rejects non-matches', () => {
    expect(fuzzyScore('prs', 'src/parser.ts')).toBeDefined();
    expect(fuzzyScore('PARSER', 'src/parser.ts')).toBeDefined();
    expect(fuzzyScore('xyz', 'src/parser.ts')).toBeUndefined();
  });

  it('ranks file-name matches above directory matches', () => {
    const ranked = rankBy(['parser/index.ts', 'src/util/parser.ts'], 'parser', (p) => p, 10);
    expect(ranked[0]).toBe('src/util/parser.ts');
  });

  it('ranks consecutive and word-boundary matches higher', () => {
    const ranked = rankBy(
      ['src/a/user_profile_service.ts', 'src/userProfile.ts', 'src/u_s_e_r.ts'],
      'userprof',
      (p) => p,
      10,
    );
    expect(ranked[0]).toBe('src/userProfile.ts');
  });

  it('an empty query matches everything', () => {
    expect(rankBy(['a', 'b'], '', (p) => p, 10)).toEqual(['a', 'b']);
  });
});

function syntheticWorkspace(n: number): string[] {
  const dirs = ['src', 'lib', 'test', 'packages/core/src', 'packages/ui/components', 'docs'];
  const words = ['user', 'parser', 'config', 'session', 'router', 'model', 'view', 'store'];
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    const dir = `${dirs[i % dirs.length]}/${words[(i * 7) % words.length]}${i % 37}`;
    files.push(`${dir}/${words[i % words.length]}${words[(i * 3) % words.length]}${i}.ts`);
  }
  return files;
}

describe('FileIndex', () => {
  it('returns files ranked, capped at 50, plus matching folders', async () => {
    const index = new FileIndex(() => Promise.resolve(syntheticWorkspace(2000)));
    const items = await index.search('parser', new AbortController().signal);
    const files = items.filter((i) => i.kind === 'file');
    expect(files).toHaveLength(MAX_FILE_RESULTS);
    expect(files[0]?.path).toMatch(/parser/i);
    expect(items.some((i) => i.kind === 'folder')).toBe(true);
    expect(files[0]).toMatchObject({
      label: files[0]?.path?.split('/').at(-1),
      detail: files[0]?.path,
    });
  });

  it('searches a 10k-file workspace in under 150 ms after the first load (AC3)', async () => {
    const index = new FileIndex(() => Promise.resolve(syntheticWorkspace(10_000)));
    const signal = new AbortController().signal;
    await index.search('', signal); // first load (findFiles in the real host)
    const times: number[] = [];
    for (const q of ['u', 'usr', 'parserconf', 'packages/ui', 'zzz', 'sessionrouter123']) {
      const t0 = performance.now();
      await index.search(q, signal);
      times.push(performance.now() - t0);
    }
    expect(Math.max(...times)).toBeLessThan(150);
  });

  it('lists files only once across concurrent searches, and again after invalidate()', async () => {
    const list = vi.fn(() => Promise.resolve(['a/b.ts']));
    const index = new FileIndex(list);
    const s = new AbortController().signal;
    await Promise.all([index.search('b', s), index.search('a', s)]);
    expect(list).toHaveBeenCalledTimes(1);
    index.invalidate();
    await index.search('b', s);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a cancelled search rejects without breaking the shared load', async () => {
    let release: (files: string[]) => void = () => undefined;
    const index = new FileIndex(() => new Promise((r) => (release = r)));
    const stale = new AbortController();
    const first = index.search('a', stale.signal);
    const second = index.search('b', new AbortController().signal);
    stale.abort(new Error('superseded'));
    await expect(first).rejects.toThrow('superseded');
    release(['b.ts']);
    expect((await second).map((i) => i.path)).toEqual(['b.ts']);
  });

  it('retries the listing after a failure', async () => {
    const list = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(['x.ts']);
    const index = new FileIndex(list);
    const s = new AbortController().signal;
    await expect(index.search('x', s)).rejects.toThrow('boom');
    expect(await index.search('x', s)).toHaveLength(1);
  });
});
