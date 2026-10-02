import { describe, expect, it } from 'vitest';
import { pushHistory, readDraft, readHistory, MAX_HISTORY } from './history.ts';
import { parsePromptSettings, promptConfig, workflowAvailability } from './settings.ts';
import { inferTaskKind } from './taskKind.ts';

const model = (id: string, contextTokens?: number) => ({
  id,
  provider: 'ollama',
  model: id,
  ...(contextTokens ? { capabilities: { contextTokens } } : {}),
});

describe('parsePromptSettings', () => {
  it('keeps valid models and reports invalid ones without dropping the rest', () => {
    const s = parsePromptSettings({
      models: [model('a'), { id: 'broken' }],
      roles: { cheap: 'a', strong: 'missing' },
      defaultPreference: 'quality',
    });
    expect(s.models.map((m) => m.id)).toEqual(['a']);
    expect(s.roles).toEqual({ cheap: 'a' });
    expect(s.defaultPreference).toBe('quality');
    expect(s.problems).toEqual([
      'desiide.models[1] is invalid and was ignored',
      'desiide.roles.strong points to unknown model "missing"',
    ]);
  });

  it('treats unset settings as no models and balance', () => {
    const s = parsePromptSettings({
      models: undefined,
      roles: undefined,
      defaultPreference: undefined,
    });
    expect(s).toEqual({ models: [], roles: {}, defaultPreference: 'balance', problems: [] });
  });

  it('falls back on wrong types', () => {
    const s = parsePromptSettings({ models: 'x', roles: 3, defaultPreference: 'max' });
    expect(s.models).toEqual([]);
    expect(s.defaultPreference).toBe('balance');
    expect(s.problems).toHaveLength(3);
  });
});

describe('workflowAvailability', () => {
  it('disables options whose roles are missing, with a reason', () => {
    const byOption = Object.fromEntries(
      workflowAvailability({ strong: 's' }).map((w) => [w.option, w]),
    );
    expect(byOption['cloud-single']?.enabled).toBe(true);
    expect(byOption['local-single']).toMatchObject({
      enabled: false,
      reason: 'Assign a model to the "cheap" role in Desiide settings.',
    });
    expect(byOption['local-cloud-cascade']?.enabled).toBe(false);
  });

  it('hides critique until COR-5 Beta', () => {
    const critique = workflowAvailability({ strong: 's' }).find(
      (w) => w.option === 'cloud-with-critique',
    );
    expect(critique).toMatchObject({ enabled: true, hidden: true });
  });

  it('cascade needs both roles', () => {
    const cascade = workflowAvailability({}).find((w) => w.option === 'local-cloud-cascade');
    expect(cascade?.reason).toBe(
      'Assign a model to the "cheap" and "strong" roles in Desiide settings.',
    );
  });
});

describe('promptConfig', () => {
  it('uses the smallest declared context window', () => {
    const settings = parsePromptSettings({
      models: [model('a', 8192), model('b'), model('c', 200_000)],
      roles: {},
      defaultPreference: 'cheap',
    });
    expect(promptConfig(settings, true)).toMatchObject({
      hasModels: true,
      contextLimitTokens: 8192,
      defaultPreference: 'cheap',
      mock: true,
    });
  });

  it('reports no models (AC6 input)', () => {
    const c = promptConfig(
      parsePromptSettings({ models: [], roles: {}, defaultPreference: undefined }),
      false,
    );
    expect(c.hasModels).toBe(false);
    expect(c).not.toHaveProperty('contextLimitTokens');
  });
});

describe('history', () => {
  it('appends trimmed entries, collapses consecutive duplicates, caps the length', () => {
    let h: string[] = [];
    h = pushHistory(h, ' one ');
    h = pushHistory(h, 'one');
    h = pushHistory(h, '   ');
    h = pushHistory(h, 'two');
    expect(h).toEqual(['one', 'two']);
    for (let i = 0; i < 60; i++) h = pushHistory(h, `p${i}`);
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h.at(-1)).toBe('p59');
  });

  it('reads stored state defensively', () => {
    expect(readHistory(['a'])).toEqual(['a']);
    expect(readHistory('nope')).toEqual([]);
    expect(readDraft({ text: 'hi', chips: [] })).toEqual({ text: 'hi', chips: [] });
    expect(readDraft({ text: 1 })).toEqual({ text: '', chips: [] });
  });
});

describe('inferTaskKind', () => {
  it.each([
    ['Fix the crash when the list is empty', 'bug_fix'],
    ['Write unit tests for the parser', 'test_write'],
    ['Refactor session handling into a hook', 'refactor'],
    ['Explain how routing works', 'explain'],
    ['Why does this re-render?', 'explain'],
    ['Add a Dockerfile for the API', 'infra_change'],
    ['Add dark mode', 'other'],
  ])('%s → %s', (text, kind) => {
    expect(inferTaskKind(text)).toBe(kind);
  });
});
