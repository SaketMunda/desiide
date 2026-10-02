import { TERMINAL_TASK_STATES, type TaskEvent, type TaskState } from '@desiide/protocol';
import type { ActiveTask } from '../../shared/messages.ts';

/**
 * Tasks started from the Prompt Box that haven't finished, oldest first. Drives Send ↔ Stop.
 * Events can arrive before `create` resolves, so early states are remembered by id.
 */
export class ActiveTasks {
  private readonly tasks = new Map<string, { state: TaskState; seq: number }>();
  private readonly early = new Map<string, { state: TaskState; seq: number }>();

  add(id: string, state: TaskState): void {
    const pending = this.early.get(id);
    this.early.delete(id);
    const current = pending ?? { state, seq: -1 };
    if (TERMINAL_TASK_STATES.includes(current.state)) return;
    this.tasks.set(id, current);
  }

  /** Returns true when the active list changed. */
  apply(event: TaskEvent): boolean {
    if (event.type !== 'state_changed') return false;
    const entry = this.tasks.get(event.taskId);
    if (!entry) {
      const prior = this.early.get(event.taskId);
      if (!prior || event.seq > prior.seq) {
        this.early.set(event.taskId, { state: event.to, seq: event.seq });
        // Bounded: ids we never `add` (tasks from elsewhere) mustn't pile up.
        if (this.early.size > 100) this.early.delete(this.early.keys().next().value as string);
      }
      return false;
    }
    if (event.seq <= entry.seq) return false;
    if (TERMINAL_TASK_STATES.includes(event.to)) this.tasks.delete(event.taskId);
    else this.tasks.set(event.taskId, { state: event.to, seq: event.seq });
    return true;
  }

  list(): ActiveTask[] {
    return [...this.tasks].map(([id, { state }]) => ({ id, state }));
  }

  /** The task Stop cancels: the one actually running, else the newest queued. */
  current(): string | undefined {
    const list = this.list();
    return (list.find((t) => t.state !== 'queued') ?? list.at(-1))?.id;
  }
}
