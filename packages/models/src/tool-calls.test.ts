import { describe, expect, it } from 'vitest';
import { createToolCallAccumulator } from './tool-calls.ts';

const ids = () => {
  let n = 0;
  return () => `gen_${++n}`;
};

describe('createToolCallAccumulator', () => {
  it('joins argument fragments by index (OpenAI style, interleaved)', () => {
    const acc = createToolCallAccumulator(ids());
    acc.add({ index: 0, id: 'a', name: 'read_file', args: '' });
    acc.add({ index: 0, args: '{"path":' });
    acc.add({ index: 1, id: 'b', name: 'read_file' });
    acc.add({ index: 0, args: '"a.ts"}' });
    acc.add({ index: 1, args: '{"path":"b.ts"}' });
    expect(acc.finish()).toEqual([
      { id: 'a', name: 'read_file', args: '{"path":"a.ts"}' },
      { id: 'b', name: 'read_file', args: '{"path":"b.ts"}' },
    ]);
  });

  it('takes whole calls in one chunk, with or without index', () => {
    const acc = createToolCallAccumulator(ids());
    acc.add({ id: 'a', name: 'x', args: '{"n":1}' });
    acc.add({ id: 'b', name: 'y', args: '{"n":2}' });
    expect(acc.finish().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a new id on a reused index starts a new call (servers that always send index 0)', () => {
    const acc = createToolCallAccumulator(ids());
    acc.add({ index: 0, id: 'a', name: 'x', args: '{}' });
    acc.add({ index: 0, id: 'b', name: 'y', args: '{}' });
    expect(acc.finish().map((c) => c.name)).toEqual(['x', 'y']);
  });

  it('continues the latest call when a fragment has neither index nor id', () => {
    const acc = createToolCallAccumulator(ids());
    acc.add({ id: 'a', name: 'x', args: '{"q":' });
    acc.add({ args: '1}' });
    expect(acc.finish()).toEqual([{ id: 'a', name: 'x', args: '{"q":1}' }]);
  });

  it('fills missing and duplicate ids, defaults empty args, drops nameless calls', () => {
    const acc = createToolCallAccumulator(ids());
    acc.add({ index: 0, name: 'x' });
    acc.add({ index: 1, id: 'dup', name: 'y' });
    acc.add({ index: 2, id: 'dup', name: 'z' });
    acc.add({ index: 3, args: '{}' });
    expect(acc.size).toBe(4);
    expect(acc.finish()).toEqual([
      { id: 'gen_1', name: 'x', args: '{}' },
      { id: 'dup', name: 'y', args: '{}' },
      { id: 'gen_2', name: 'z', args: '{}' },
    ]);
  });
});
