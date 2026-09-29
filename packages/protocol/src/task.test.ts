import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_BUDGET, TaskInput } from './task.ts';

describe('TaskInput defaults', () => {
  it('fills budget, tools, success and context from a minimal request', () => {
    const task = TaskInput.parse({ kind: 'explain', instruction: 'What does this do?' });
    expect(task.budget).toEqual(DEFAULT_BUDGET);
    expect(task.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(task.success).toEqual({ userApproval: true });
    expect(task.context).toEqual({ refs: [], openEditors: [], tests: [] });
    expect(task.preference).toBe('balance');
  });

  it('does not grant side-effecting tools by default', () => {
    const task = TaskInput.parse({ kind: 'bug_fix', instruction: 'fix it' });
    expect(task.allowedTools).not.toContain('shell');
    expect(task.allowedTools).not.toContain('run_tests');
  });

  it('keeps partial budget overrides and defaults the rest', () => {
    const task = TaskInput.parse({
      kind: 'refactor',
      instruction: 'x',
      budget: { maxIterations: 2 },
    });
    expect(task.budget).toEqual({ ...DEFAULT_BUDGET, maxIterations: 2 });
  });
});
