import { describe, expect, it } from 'vitest';
import type { PromptChip } from '../../shared/messages.ts';
import {
  addChip,
  estimateTokens,
  findMentionQuery,
  formatTokens,
  mentionItems,
  NO_HISTORY,
  removeMention,
  stepHistory,
} from './logic.ts';

describe('findMentionQuery', () => {
  it('finds the @token under the caret', () => {
    expect(findMentionQuery('fix @pars', 9)).toEqual({ start: 4, end: 9, query: 'pars' });
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(findMentionQuery('see (@a', 7)).toEqual({ start: 5, end: 7, query: 'a' });
  });

  it('ignores e-mails, finished tokens and text without @', () => {
    expect(findMentionQuery('mail me@host', 12)).toBeUndefined();
    expect(findMentionQuery('fix @app now', 12)).toBeUndefined();
    expect(findMentionQuery('plain', 5)).toBeUndefined();
  });
});

describe('removeMention', () => {
  it('removes the query and one doubled space', () => {
    const text = 'fix @app now';
    expect(removeMention(text, { start: 4, end: 8, query: 'app' })).toEqual({
      text: 'fix now',
      caret: 4,
    });
  });
});

describe('mentionItems', () => {
  it('lists selection and diff first when they match', () => {
    const file = { kind: 'file' as const, label: 'a.ts', detail: 'a.ts', path: 'a.ts' };
    expect(mentionItems('', [file]).map((i) => i.kind)).toEqual(['selection', 'diff', 'file']);
    expect(mentionItems('sel', [file]).map((i) => i.kind)).toEqual(['selection', 'file']);
    expect(mentionItems('zz', []).map((i) => i.kind)).toEqual([]);
  });
});

describe('stepHistory', () => {
  const history = ['one', 'two', 'three'];

  /** Unwraps a step that must exist. */
  const must = <T>(v: T | undefined): T => {
    expect(v).toBeDefined();
    return v as T;
  };

  it('walks up to the oldest and stops', () => {
    let state = must(stepHistory(history, NO_HISTORY, 'up', 'draft'));
    expect(state.text).toBe('three');
    state = must(stepHistory(history, state.cursor, 'up', 'three'));
    state = must(stepHistory(history, state.cursor, 'up', 'two'));
    expect(state.text).toBe('one');
    expect(stepHistory(history, state.cursor, 'up', 'one')).toBeUndefined();
  });

  it('walks back down to the stashed draft', () => {
    const up = must(stepHistory(history, NO_HISTORY, 'up', 'my draft'));
    const down = must(stepHistory(history, up.cursor, 'down', up.text));
    expect(down).toEqual({ cursor: NO_HISTORY, text: 'my draft' });
    expect(stepHistory(history, NO_HISTORY, 'down', 'x')).toBeUndefined();
  });

  it('does nothing without history', () => {
    expect(stepHistory([], NO_HISTORY, 'up', '')).toBeUndefined();
  });
});

describe('tokens', () => {
  const chip = (chars?: number): PromptChip => ({
    ref: { type: 'file', path: `f${chars ?? 'x'}.ts` },
    label: 'f',
    detail: 'f',
    ...(chars === undefined ? {} : { chars }),
  });

  it('estimates chars/4 over text and chips', () => {
    expect(estimateTokens('abcd', [chip(8), chip()])).toBe(3);
    expect(estimateTokens('', [])).toBe(0);
  });

  it('formats compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(8000)).toBe('8k');
    expect(formatTokens(250_400)).toBe('250k');
  });

  it('addChip ignores duplicates', () => {
    expect(addChip([chip(1)], chip(1))).toHaveLength(1);
    expect(addChip([chip(1)], chip(2))).toHaveLength(2);
  });
});
