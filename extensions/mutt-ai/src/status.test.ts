import { describe, expect, it } from 'vitest';
import { formatStatus } from './status.ts';

describe('formatStatus', () => {
  it('shows a plain label when idle', () => {
    expect(formatStatus({ runningTasks: 0 })).toEqual({
      text: '$(sparkle) Mutt',
      tooltip: 'Mutt\nNo tasks running\nClick to open the Mutt view',
    });
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
