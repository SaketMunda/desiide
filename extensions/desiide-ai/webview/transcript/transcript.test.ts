import type { TaskEvent } from '@desiide/protocol';
import { describe, expect, it, vi } from 'vitest';
import { errorView, secondsLeft } from './errors.ts';
import { formatCost, formatCount, formatDuration, summarizeArgs, tail } from './format.ts';
import { highlightSync, loadLanguage, resolveLanguage } from './highlight.ts';
import { renderBlocks } from './mdBlocks.ts';
import { ESTIMATED_ROW_PX, isAtBottom, visibleWindow, VIRTUALIZE_OVER } from './virtual.ts';

vi.mock('../bridge.ts', () => ({ post: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
const { createTranscriptStore } = await import('./store.ts');

describe('renderBlocks', () => {
  it('splits code fences out of the prose and keeps lists whole', () => {
    const blocks = renderBlocks('1. one\n\n2. two\n\n```ts\nconst a = 1;\n```\n\nAfter.');
    expect(blocks.map((b) => b.type)).toEqual(['html', 'code', 'html']);
    expect(blocks[0]).toMatchObject({
      html: expect.stringMatching(/^<ol>[\s\S]*two[\s\S]*<\/ol>/),
    });
    expect(blocks[1]).toEqual({ type: 'code', code: 'const a = 1;', language: 'ts', closed: true });
  });

  it('marks a fence that is still streaming as open', () => {
    const blocks = renderBlocks('Here:\n\n```py\nprint(1)\nprint(');
    expect(blocks.at(-1)).toMatchObject({ type: 'code', closed: false, language: 'py' });
    expect(renderBlocks('```\n```').at(-1)).toMatchObject({ closed: true, language: undefined });
  });

  it('never renders raw HTML or unsafe links from the model', () => {
    const [block] = renderBlocks(
      '<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)',
    );
    const html = block?.type === 'html' ? block.html : '';
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://example.com"');
  });
});

describe('highlight', () => {
  it('resolves aliases and unknown languages', () => {
    expect(resolveLanguage('TS')).toBe('typescript');
    expect(resolveLanguage('yml')).toBe('yaml');
    expect(resolveLanguage('brainfuck')).toBeUndefined();
    expect(resolveLanguage(undefined)).toBeUndefined();
  });

  it('loads a grammar on first use, then highlights with escaped output', async () => {
    expect(highlightSync('const a = "<b>";', 'typescript')).toBeUndefined();
    await expect(loadLanguage('typescript')).resolves.toBe(true);
    const html = highlightSync('const a = "<b>";', 'typescript') ?? '';
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('&lt;b&gt;');
    await expect(loadLanguage('nope')).resolves.toBe(false);
  });
});

describe('errorView', () => {
  it('maps model error kinds to actionable messages', () => {
    expect(errorView('auth')).toMatchObject({
      hint: 'Check your key in Settings.',
      action: { run: { command: 'desiide.setup' } },
    });
    expect(errorView('model_error:auth').title).toBe(errorView('auth').title);
    expect(errorView('rate_limit', 30_000)).toMatchObject({
      countdownMs: 30_000,
      action: { run: { retry: true } },
    });
    expect(errorView('rate_limit')).not.toHaveProperty('countdownMs');
    expect(errorView('context_length').hint).toMatch(/fewer files/);
    expect(errorView('budget:maxTokens').hint).toMatch(/token limit/);
    expect(errorView('model_unavailable').action?.run).toEqual({ command: 'desiide.setup' });
    expect(errorView('something_new')).toMatchObject({
      action: { run: { command: 'desiide.showLog' } },
    });
  });

  it('counts down retry-after', () => {
    const ts = '2026-10-10T00:00:00.000Z';
    const t0 = Date.parse(ts);
    expect(secondsLeft(ts, 30_000, t0)).toBe(30);
    expect(secondsLeft(ts, 30_000, t0 + 29_100)).toBe(1);
    expect(secondsLeft(ts, 30_000, t0 + 31_000)).toBe(0);
  });
});

describe('format', () => {
  const call = (tool: string, args: Record<string, unknown>) =>
    ({ id: 'c', tool, args, sideEffect: 'none' }) as never;

  it('summarizes tool args in one line', () => {
    expect(summarizeArgs(call('read_file', { path: 'src/a.ts' }))).toBe('src/a.ts');
    expect(summarizeArgs(call('read_file', { path: 'a.ts', startLine: 10, endLine: 20 }))).toBe(
      'a.ts:10-20',
    );
    expect(summarizeArgs(call('search', { query: 'foo', path: 'src' }))).toBe('"foo" in src');
    expect(summarizeArgs(call('shell', { command: 'npm   test\n --run' }))).toBe('npm test --run');
    expect(summarizeArgs(call('git_read', { command: 'diff', path: 'a.ts' }))).toBe(
      'git diff a.ts',
    );
    expect(
      summarizeArgs(call('propose_edit', { files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] })),
    ).toBe('3 files');
    expect(summarizeArgs(call('shell', { command: 'x'.repeat(200) }))).toHaveLength(80);
    expect(summarizeArgs(undefined)).toBe('');
  });

  it('formats numbers, cost and durations', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(4855)).toBe('4.9k');
    expect(formatCount(48_550)).toBe('49k');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatCost(0.000616)).toBe('~$0.0006');
    expect(formatCost(0.25)).toBe('~$0.250');
    expect(formatCost(3.5)).toBe('~$3.50');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_300)).toBe('12 s');
    expect(formatDuration(3_250)).toBe('3.3 s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('keeps the tail of long output', () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(tail(out, 20)).toEqual({
      text: Array.from({ length: 20 }, (_, i) => `line ${i + 11}`).join('\n'),
      hidden: 10,
    });
    expect(tail('a\n', 20)).toEqual({ text: 'a', hidden: 0 });
  });
});

describe('visibleWindow', () => {
  it('renders everything up to the threshold', () => {
    expect(visibleWindow([], VIRTUALIZE_OVER, 5000, 500)).toEqual({
      start: 0,
      end: VIRTUALIZE_OVER,
      before: 0,
      after: 0,
    });
  });

  it('renders only rows near the viewport, with spacers that keep the scroll height', () => {
    const count = 1000;
    const heights = Array.from({ length: count }, () => 100);
    const w = visibleWindow(heights, count, 50_000, 500, 200);
    expect(w.start).toBe(498);
    expect(w.end).toBe(507);
    expect(w.before).toBe(498 * 100);
    expect(w.before + (w.end - w.start) * 100 + w.after).toBe(count * 100);
  });

  it('estimates rows not yet measured', () => {
    const w = visibleWindow([], 400, 0, 500, 0);
    expect(w.start).toBe(0);
    expect(w.end).toBe(Math.ceil(500 / ESTIMATED_ROW_PX));
  });

  it('copes with a scroll position past the end', () => {
    const w = visibleWindow([], 400, 10_000_000, 500, 0);
    expect(w.end - w.start).toBeGreaterThanOrEqual(1);
    expect(w.after).toBe(0);
  });

  it('detects the bottom with some slack', () => {
    expect(isAtBottom(960, 500, 1500)).toBe(true);
    expect(isAtBottom(900, 500, 1500)).toBe(false);
  });
});

describe('transcript store', () => {
  const ts = '2026-10-10T00:00:00.000Z';
  const delta = (seq: number, d: string): TaskEvent => ({
    taskId: 't1',
    seq,
    ts,
    type: 'text_delta',
    messageId: 'm1',
    delta: d,
  });

  it('applies everything queued in one frame, with one notification', () => {
    const frames: Array<() => void> = [];
    const store = createTranscriptStore((fn) => frames.push(fn));
    const seen = vi.fn();
    store.subscribe(seen);
    for (let i = 0; i < 5000; i++) store.handle({ type: 'tasks.events', events: [delta(i, 'x')] });
    expect(frames).toHaveLength(1);
    expect(seen).not.toHaveBeenCalled();
    frames.shift()?.();
    expect(seen).toHaveBeenCalledTimes(1);
    const item = store.get().state.tasks['t1']?.items[0];
    expect(item?.kind === 'assistant' && item.text.length).toBe(5000);
  });

  it('a snapshot replaces whatever was queued before it', () => {
    const frames: Array<() => void> = [];
    const store = createTranscriptStore((fn) => frames.push(fn));
    store.handle({ type: 'tasks.events', events: [delta(0, 'stale')] });
    store.handle({
      type: 'tasks.snapshot',
      tasks: [{ id: 't2', events: [{ ...delta(0, 'fresh'), taskId: 't2' }], retryable: true }],
    });
    frames.shift()?.();
    expect(store.get().state.order).toEqual(['t2']);
    expect(store.get().retryable.has('t2')).toBe(true);
  });

  it('tracks retryable tasks and removals', () => {
    const frames: Array<() => void> = [];
    const store = createTranscriptStore((fn) => frames.push(fn));
    const summary = {
      id: 't1',
      kind: 'explain' as const,
      instruction: 'Explain',
      state: 'queued' as const,
      models: [],
      iteration: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: ts,
      updatedAt: ts,
    };
    store.handle({ type: 'tasks.summary', summary, retryable: true });
    frames.shift()?.();
    expect(store.get().retryable.has('t1')).toBe(true);
    expect(store.get().state.tasks['t1']?.items[0]).toMatchObject({
      kind: 'user',
      text: 'Explain',
    });
    store.handle({ type: 'tasks.removed', taskIds: ['t1'] });
    frames.shift()?.();
    expect(store.get().state.order).toEqual([]);
    expect(store.get().retryable.size).toBe(0);
  });
});
