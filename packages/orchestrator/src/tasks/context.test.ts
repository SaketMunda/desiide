import { Task } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import { pathOnlyContext } from './context.ts';

const signal = new AbortController().signal;

describe('pathOnlyContext', () => {
  it('lists refs, open editors, and tests by path only', async () => {
    const task = Task.parse({
      id: 't',
      kind: 'bug_fix',
      instruction: 'x',
      context: {
        refs: [
          { type: 'file', path: 'a.ts' },
          { type: 'folder', path: 'src' },
          {
            type: 'selection',
            path: 'b.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
          },
          { type: 'diff', scope: 'working' },
          { type: 'diff', scope: 'staged', path: 'c.ts' },
        ],
        openEditors: ['d.ts'],
        tests: ['a.test.ts'],
      },
    });
    expect((await pathOnlyContext.gather(task, signal)).text).toBe(
      [
        'Context the user attached:',
        '- file: a.ts',
        '- folder: src',
        '- selection: b.ts lines 1-5',
        '- working diff',
        '- staged diff of c.ts',
        'Open editors (most recent first):',
        '- d.ts',
        'Relevant tests:',
        '- a.test.ts',
      ].join('\n'),
    );
  });

  it('is empty without context and describes no files', async () => {
    const task = Task.parse({ id: 't', kind: 'other', instruction: 'x' });
    expect((await pathOnlyContext.gather(task, signal)).text).toBe('');
    expect(await pathOnlyContext.describeFiles(['a.ts'], signal)).toEqual([]);
  });
});
