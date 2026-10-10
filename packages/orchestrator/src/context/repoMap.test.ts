import { describe, expect, it } from 'vitest';
import { buildRepoMap, renderRepoMap } from './repoMap.ts';

const files = [
  'README.md',
  'package.json',
  'package-lock.json',
  'assets/logo.png',
  'src/a.ts',
  'src/b.ts',
  'src/deep/one/two/three.ts',
  ...Array.from({ length: 20 }, (_, i) => `src/many/f${String(i).padStart(2, '0')}.py`),
];

describe('buildRepoMap', () => {
  it('summarizes languages and a depth-limited tree, without lockfiles or binaries', () => {
    const map = buildRepoMap(files, { maxDepth: 2, maxFilesPerDir: 3 });
    expect([map.header, ...map.lines].join('\n')).toMatchInlineSnapshot(`
      "### Repository map (25 files, gitignored files left out; python 20, typescript 3, json 1, markdown 1):
      src/ (23 files)
        deep/ (1 file)
        many/ (20 files)
        a.ts
        b.ts
      README.md
      package.json"
    `);
  });

  it('cuts to the budget with a pointer to list_files', () => {
    const map = buildRepoMap(files);
    const text = renderRepoMap(map, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/\[… \d+ more entries; use list_files\]$/);
    expect(renderRepoMap(map, 10)).toBe('');
  });
});
