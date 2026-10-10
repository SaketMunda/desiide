import type { TaskEvent } from '@desiide/protocol';

/**
 * Append `event` to a task's retained event log, merging it into the previous event when both are
 * deltas (`text_delta` / `reasoning_delta`) of the same message. Keeps the first delta's `ts` (when
 * the stream started) and the last one's `seq`, so replaying the compacted log through the reducer
 * gives the same transcript as the original stream. Mutates and returns `log`.
 */
export function appendCompacted(log: TaskEvent[], event: TaskEvent): TaskEvent[] {
  const last = log.at(-1);
  if (
    last &&
    (event.type === 'text_delta' || event.type === 'reasoning_delta') &&
    last.type === event.type &&
    last.messageId === event.messageId &&
    last.taskId === event.taskId
  ) {
    log[log.length - 1] = { ...last, seq: event.seq, delta: last.delta + event.delta };
    return log;
  }
  log.push(event);
  return log;
}
