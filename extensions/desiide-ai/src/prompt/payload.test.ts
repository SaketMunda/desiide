import { ClientMethods, TaskInput } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import type { PromptChip } from '../../shared/messages.ts';
import { buildTaskCreateParams, type PromptSubmission } from './payload.ts';

const file = (path: string): PromptChip => ({
  ref: { type: 'file', path },
  label: path.split('/').at(-1) ?? path,
  detail: path,
});
const selection: PromptChip = {
  ref: {
    type: 'selection',
    path: 'src/app.ts',
    range: { start: { line: 11, character: 0 }, end: { line: 29, character: 4 } },
  },
  label: 'app.ts:12-30',
  detail: 'src/app.ts',
  chars: 400,
};
const diff: PromptChip = { ref: { type: 'diff', scope: 'working' }, label: 'diff', detail: '' };

const base: PromptSubmission = {
  instruction: '  Fix the null check in the parser  ',
  chips: [],
  preference: 'balance',
  workflow: 'auto',
  openEditors: [],
};

describe('buildTaskCreateParams', () => {
  it('produces task.create params that pass the protocol schema, chips in order', () => {
    const result = buildTaskCreateParams({
      ...base,
      chips: [
        selection,
        file('src/parser.ts'),
        diff,
        { ...file('lib'), ref: { type: 'folder', path: 'lib' } },
      ],
      openEditors: ['src/main.ts'],
      preference: 'quality',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ClientMethods['task.create'].params.safeParse(result.params).success).toBe(true);
    expect(result.params.instruction).toBe('Fix the null check in the parser');
    expect(result.params.kind).toBe('bug_fix');
    expect(result.params.preference).toBe('quality');
    expect(result.params.context.refs).toEqual([
      selection.ref,
      { type: 'file', path: 'src/parser.ts' },
      { type: 'diff', scope: 'working' },
      { type: 'folder', path: 'lib' },
    ]);
    expect(result.params.context.openEditors).toEqual(['src/main.ts']);
    expect(result.params).not.toHaveProperty('workflowOverride');
  });

  it('sends workflowOverride only for explicit choices', () => {
    const result = buildTaskCreateParams({ ...base, workflow: 'local-cloud-cascade' });
    expect(result.ok && result.params.workflowOverride).toBe('local-cloud-cascade');
  });

  it('drops exact duplicate chips but keeps first-seen order', () => {
    const result = buildTaskCreateParams({
      ...base,
      chips: [file('b.ts'), file('a.ts'), file('b.ts')],
    });
    expect(result.ok && result.params.context.refs.map((r) => ('path' in r ? r.path : ''))).toEqual(
      ['b.ts', 'a.ts'],
    );
  });

  it('does not repeat attached files in openEditors', () => {
    const result = buildTaskCreateParams({
      ...base,
      chips: [file('a.ts')],
      openEditors: ['a.ts', 'b.ts', 'b.ts'],
    });
    expect(result.ok && result.params.context.openEditors).toEqual(['b.ts']);
  });

  it('rejects an empty instruction with a user-facing message', () => {
    expect(buildTaskCreateParams({ ...base, instruction: '   ' })).toEqual({
      ok: false,
      message: 'Type an instruction first.',
    });
  });

  it('rejects paths the protocol forbids instead of sending them', () => {
    const result = buildTaskCreateParams({ ...base, openEditors: ['../outside.ts'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/must not contain/);
  });

  it('applies protocol defaults (budget, tools, success)', () => {
    const result = buildTaskCreateParams(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(TaskInput.parse(result.params)).toEqual(result.params);
  });
});
