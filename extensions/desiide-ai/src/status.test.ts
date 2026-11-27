import { describe, expect, it } from 'vitest';
import { formatStatus } from './status.ts';

describe('formatStatus', () => {
  it('shows a plain label when idle', () => {
    expect(formatStatus({ runningTasks: 0 })).toEqual({
      text: '$(sparkle) Desiide',
      tooltip: 'Desiide\nNo tasks running\nClick to open the Desiide view',
      highlight: false,
    });
  });

  it('highlights approvals and reviews waiting for the user', () => {
    const s = formatStatus({ runningTasks: 1, pending: 2 });
    expect(s.text).toBe('$(sparkle) Desiide $(sync~spin) 1 $(bell-dot) 2');
    expect(s.tooltip).toContain('2 waiting for you');
    expect(s.highlight).toBe(true);
  });

  it('shows workflow, model and running count', () => {
    const s = formatStatus({ workflow: 'cascade', model: 'ollama-qwen', runningTasks: 2 });
    expect(s.text).toBe('$(sparkle) cascade · ollama-qwen $(sync~spin) 2');
    expect(s.tooltip).toContain('2 tasks running');
  });

  it('uses singular for one task', () => {
    expect(formatStatus({ model: 'claude', runningTasks: 1 }).tooltip).toContain('1 task running');
  });
});
