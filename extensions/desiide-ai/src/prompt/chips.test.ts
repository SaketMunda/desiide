import { describe, expect, it } from 'vitest';
import { excludeGlob, fileChip, folderChip, selectionChip, selectionLabel } from './chips.ts';

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe('selection chips', () => {
  it('labels with 1-based lines, and a single line once', () => {
    expect(selectionLabel('src/app.ts', range(11, 0, 29, 4))).toBe('app.ts:12-30');
    expect(selectionLabel('src/app.ts', range(4, 2, 4, 9))).toBe('app.ts:5');
  });

  it("doesn't count a last line selected only up to column 0", () => {
    expect(selectionLabel('a.ts', range(2, 0, 5, 0))).toBe('a.ts:3-5');
  });

  it('builds a selection ref with the size of the selected text', () => {
    const r = selectionChip('src/app.ts', range(0, 0, 2, 0), 42);
    expect(r).toEqual({
      ok: true,
      chip: {
        ref: { type: 'selection', path: 'src/app.ts', range: range(0, 0, 2, 0) },
        label: 'app.ts:1-2',
        detail: 'src/app.ts',
        chars: 42,
      },
    });
  });

  it('refuses empty selections and files outside the workspace', () => {
    expect(selectionChip('a.ts', range(3, 1, 3, 1), 0)).toEqual({
      ok: false,
      message: 'Select some code in the editor first.',
    });
    expect(selectionChip(undefined, range(0, 0, 1, 0), 5).ok).toBe(false);
    expect(selectionChip('../etc/passwd', range(0, 0, 1, 0), 5).ok).toBe(false);
  });
});

describe('file and folder chips', () => {
  it('uses the base name as label and the full path as tooltip', () => {
    expect(fileChip('src/deep/util.ts', 120)).toEqual({
      ok: true,
      chip: {
        ref: { type: 'file', path: 'src/deep/util.ts' },
        label: 'util.ts',
        detail: 'src/deep/util.ts',
        chars: 120,
      },
    });
    expect(folderChip('src/deep')).toMatchObject({ ok: true, chip: { label: 'deep/' } });
  });

  it('rejects absolute and traversal paths', () => {
    expect(fileChip('/etc/passwd', 1).ok).toBe(false);
    expect(folderChip('a/../../b').ok).toBe(false);
    expect(fileChip('', 1).ok).toBe(false);
  });
});

describe('excludeGlob', () => {
  it('combines enabled files/search excludes with the defaults', () => {
    expect(excludeGlob({ '**/.DS_Store': true, '**/tmp': false }, { '**/dist': true })).toBe(
      '{**/node_modules/**,**/.git/**,**/.DS_Store,**/dist}',
    );
  });

  it('skips patterns with braces or `when` conditions', () => {
    expect(excludeGlob({ '**/*.{js,map}': true, '**/*.js': { when: '$(basename).ts' } })).toBe(
      '{**/node_modules/**,**/.git/**}',
    );
    expect(excludeGlob(undefined)).toBe('{**/node_modules/**,**/.git/**}');
  });
});
