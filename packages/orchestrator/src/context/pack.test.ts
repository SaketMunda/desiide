import { describe, expect, it } from 'vitest';
import { allocate, estimateTokens, packTiers, type PackItem } from './pack.ts';

function item(size: number, min = 100, label = 'x'): PackItem {
  return {
    fullChars: size,
    minChars: Math.min(min, size),
    render: (max) => label.repeat(Math.min(size, max)),
  };
}

describe('estimateTokens', () => {
  it('is chars / 4 rounded up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});

describe('allocate', () => {
  it('gives everything when it fits', () => {
    expect(allocate([item(100), item(200)], 1000)).toEqual([100, 200]);
  });

  it('gives small items all they need and shares the rest equally', () => {
    expect(allocate([item(5000), item(50), item(5000)], 1050)).toEqual([500, 50, 500]);
  });

  it('drops the lowest-priority starved item, never an earlier one', () => {
    // Three items can't each get 100; the last is dropped and the first two share.
    expect(allocate([item(1000), item(1000), item(1000)], 250)).toEqual([125, 125, 0]);
    expect(allocate([item(1000), item(1000), item(1000)], 120)).toEqual([120, 0, 0]);
  });

  it('keeps a small late item that fits while a big earlier one is truncated', () => {
    expect(allocate([item(10_000), item(40)], 500)).toEqual([460, 40]);
  });
});

describe('packTiers', () => {
  it('fills tiers in order and never exceeds the budget', () => {
    for (let budget = 0; budget < 5000; budget += 61) {
      const r = packTiers(
        [
          [item(3000, 200, 'a'), item(900, 200, 'b')],
          [item(2000, 300, 'c')],
          [item(500, 100, 'd')],
        ],
        budget,
      );
      const text = r.rendered
        .flat()
        .filter((t) => t !== undefined)
        .join('\n\n');
      expect(text.length).toBeLessThanOrEqual(budget);
      expect(r.usedChars).toBe(
        r.rendered
          .flat()
          .filter((t) => t !== undefined)
          .reduce((n, t) => n + t.length + 2, 0),
      );
    }
  });

  it('gives a later tier only what the earlier ones left', () => {
    const r = packTiers([[item(1000, 100, 'a')], [item(1000, 100, 'b')]], 1200);
    expect(r.rendered[0]?.[0]).toHaveLength(1000);
    expect(r.rendered[1]?.[0]).toHaveLength(1200 - 1002 - 2);
  });

  it('leaves an item out when its share is below its minimum', () => {
    const r = packTiers([[item(1000, 100, 'a')], [item(1000, 500, 'b')]], 1300);
    expect(r.rendered[1]?.[0]).toBeUndefined();
  });
});
