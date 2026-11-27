import { describe, expect, it } from 'vitest';
import { applyBlocks, editStats, minimalReplace } from './blocks.ts';

describe('applyBlocks', () => {
  it('applies blocks in order, each to the result of the previous', () => {
    const r = applyBlocks('a b c', [
      { search: 'a', replace: 'x' },
      { search: 'x b', replace: 'y' },
    ]);
    expect(r).toEqual({ ok: true, text: 'y c', created: false });
  });

  it('an empty search inserts at the start, or creates a missing file', () => {
    expect(applyBlocks('body', [{ search: '', replace: 'head\n' }])).toEqual({
      ok: true,
      text: 'head\nbody',
      created: false,
    });
    expect(applyBlocks(null, [{ search: '', replace: 'new' }])).toEqual({
      ok: true,
      text: 'new',
      created: true,
    });
  });

  it('reports the first block that no longer matches', () => {
    expect(applyBlocks('const a = 1;', [{ search: 'const b', replace: '' }])).toEqual({
      ok: false,
      problem: 'search_not_found',
      editIndex: 0,
    });
    expect(
      applyBlocks('x x', [
        { search: 'x x', replace: 'x y' },
        { search: 'x', replace: 'z' },
      ]),
    ).toEqual({ ok: true, text: 'z y', created: false });
    expect(applyBlocks('x y x', [{ search: 'x', replace: 'z' }])).toEqual({
      ok: false,
      problem: 'search_ambiguous',
      editIndex: 0,
    });
    expect(applyBlocks(null, [{ search: 'x', replace: 'z' }])).toEqual({
      ok: false,
      problem: 'file_not_found',
      editIndex: 0,
    });
  });

  it('treats $ patterns in the replacement literally', () => {
    expect(applyBlocks('price', [{ search: 'price', replace: "$& $1 $'" }])).toMatchObject({
      text: "$& $1 $'",
    });
  });
});

describe('minimalReplace', () => {
  it('keeps the common prefix and suffix', () => {
    expect(minimalReplace('const a = 1;\n', 'const a = 2;\n')).toEqual({
      start: 10,
      end: 11,
      text: '2',
    });
  });

  it('handles pure inserts, deletes, identical and repeated text', () => {
    expect(minimalReplace('ab', 'aXb')).toEqual({ start: 1, end: 1, text: 'X' });
    expect(minimalReplace('aXb', 'ab')).toEqual({ start: 1, end: 2, text: '' });
    expect(minimalReplace('same', 'same')).toEqual({ start: 4, end: 4, text: '' });
    expect(minimalReplace('aaa', 'aaaa')).toEqual({ start: 3, end: 3, text: 'a' });
    expect(minimalReplace('', 'new')).toEqual({ start: 0, end: 0, text: 'new' });
  });

  it('rebuilds the target for arbitrary pairs', () => {
    const pairs: [string, string][] = [
      ['line1\nline2\nline3', 'line1\nchanged\nline3'],
      ['abcabc', 'abc'],
      ['x', ''],
      ['\n\n', '\n'],
    ];
    for (const [a, b] of pairs) {
      const r = minimalReplace(a, b);
      expect(a.slice(0, r.start) + r.text + a.slice(r.end)).toBe(b);
    }
  });
});

describe('editStats', () => {
  it('counts changed lines, ignoring lines shared at either end of a block', () => {
    expect(
      editStats({
        path: 'a.ts',
        edits: [
          {
            search: 'function f() {\n  return 1;\n}\n',
            replace: 'function f() {\n  return 2;\n}\n',
          },
          { search: '', replace: 'import x from "x";\nimport y from "y";\n' },
        ],
      }),
    ).toEqual({ added: 3, removed: 1 });
    expect(editStats({ path: 'b.ts', edits: [{ search: 'a\nb', replace: '' }] })).toEqual({
      added: 0,
      removed: 2,
    });
  });
});
