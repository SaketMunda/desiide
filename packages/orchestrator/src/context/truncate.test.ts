import { describe, expect, it } from 'vitest';
import { renderLines, splitLines } from './truncate.ts';

const file = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'x'.repeat(i % 40)}`);

describe('splitLines', () => {
  it('handles empty text, CRLF, and a trailing newline like read_file', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('renderLines', () => {
  it('renders everything with read_file line numbers when it fits', () => {
    const r = renderLines(['a', 'b'], 1000);
    expect(r).toEqual({ text: '     1\ta\n     2\tb', truncated: false });
  });

  it('keeps the top of the file without a focus and marks the rest', () => {
    const r = renderLines(file, 2000);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('     1\tline 1')).toBe(true);
    expect(r.text).toMatch(/\[… lines \d+-300 not shown; read_file startLine \d+ endLine 300\]$/);
  });

  it('centres on the focus and marks both sides', () => {
    const r = renderLines(file, 1500, { start: 149, end: 151 });
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^\[… lines 1-\d+ not shown/);
    expect(lines.at(-1)).toMatch(/^\[… lines \d+-300 not shown/);
    expect(r.text).toContain('   150\tline 150');
    expect(r.text).toContain('   152\tline 152');
  });

  it('starts at the focus when the focus alone is bigger than the budget', () => {
    const r = renderLines(file, 600, { start: 100, end: 250 });
    expect(r.text).toMatch(/^\[… lines 1-100 not shown/);
    expect(r.text).toContain('   101\tline 101');
  });

  it('never exceeds maxChars', () => {
    for (let max = 0; max < 6000; max += 37) {
      for (const focus of [
        undefined,
        { start: 0, end: 0 },
        { start: 299, end: 299 },
        { start: 80, end: 120 },
      ]) {
        expect(renderLines(file, max, focus).text.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('cuts very long lines', () => {
    const r = renderLines(['y'.repeat(5000)], 10_000);
    expect(r.text).toContain('[… line truncated]');
    expect(r.text.length).toBeLessThan(1100);
  });
});
