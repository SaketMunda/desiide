import { useEffect, useState } from 'preact/hooks';
import type { ExtensionToWebview, TaskRecord } from '../../shared/messages.ts';
import { EMPTY_TRANSCRIPT, type TranscriptState } from '../../shared/transcript/model.ts';
import {
  applyEvents,
  removeTask,
  upsertSummary,
  type ReduceLog,
} from '../../shared/transcript/reducer.ts';
import { post, subscribe } from '../bridge.ts';

export interface TranscriptSnapshot {
  state: TranscriptState;
  /** Tasks whose create params the host kept (Retry works). */
  retryable: ReadonlySet<string>;
}

type Op =
  | { kind: 'events'; events: unknown[] }
  | { kind: 'reset'; tasks: TaskRecord[] }
  | { kind: 'other'; apply: (s: TranscriptSnapshot) => TranscriptSnapshot };

// Debug lines go to the webview console (DevTools), not the extension log: an unknown event type
// repeats per event. The host's client already logs each unknown type it drops.
const log: ReduceLog = {
  debug: (message) => console.debug(`[desiide] ${message}`),
  warn: (message) => post({ type: 'log', level: 'warn', message }),
};

/**
 * The transcript state, shared by every component of the panel. Bridge messages are queued and
 * applied once per animation frame, so thousands of `text_delta`s cost one reduce + one render
 * per frame (UI-3 performance budget).
 */
export function createTranscriptStore(
  requestFrame: (fn: () => void) => void = (fn) => requestAnimationFrame(fn),
) {
  let current: TranscriptSnapshot = { state: EMPTY_TRANSCRIPT, retryable: new Set() };
  let ops: Op[] = [];
  let scheduled = false;
  const listeners = new Set<(s: TranscriptSnapshot) => void>();

  const flush = () => {
    scheduled = false;
    const queued = ops;
    ops = [];
    let next = current;
    for (const op of queued) {
      if (op.kind === 'events') {
        next = { ...next, state: applyEvents(next.state, op.events, log) };
      } else if (op.kind === 'reset') {
        next = replay(op.tasks);
      } else {
        next = op.apply(next);
      }
    }
    if (next === current) return;
    current = next;
    for (const l of listeners) l(current);
  };

  const enqueue = (op: Op) => {
    const last = ops.at(-1);
    if (op.kind === 'events' && last?.kind === 'events') last.events.push(...op.events);
    else if (op.kind === 'reset') ops = [op];
    else ops.push(op.kind === 'events' ? { kind: 'events', events: [...op.events] } : op);
    if (!scheduled) {
      scheduled = true;
      requestFrame(flush);
    }
  };

  const handle = (m: ExtensionToWebview) => {
    switch (m.type) {
      case 'tasks.snapshot':
        enqueue({ kind: 'reset', tasks: m.tasks });
        break;
      case 'tasks.events':
        enqueue({ kind: 'events', events: m.events });
        break;
      case 'tasks.summary':
        enqueue({
          kind: 'other',
          apply: (s) => ({
            state: upsertSummary(s.state, m.summary),
            retryable: toggled(s.retryable, m.summary.id, m.retryable),
          }),
        });
        break;
      case 'tasks.removed':
        enqueue({
          kind: 'other',
          apply: (s) => ({
            state: m.taskIds.reduce(removeTask, s.state),
            retryable: new Set([...s.retryable].filter((id) => !m.taskIds.includes(id))),
          }),
        });
        break;
      default:
        break;
    }
  };

  return {
    handle,
    flush,
    get: () => current,
    subscribe(listener: (s: TranscriptSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function replay(records: TaskRecord[]): TranscriptSnapshot {
  let state = EMPTY_TRANSCRIPT;
  const retryable = new Set<string>();
  for (const r of records) {
    if (r.summary) state = upsertSummary(state, r.summary);
    state = applyEvents(state, r.events, log, { replay: true });
    if (r.retryable) retryable.add(r.id);
  }
  return { state, retryable };
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export type TranscriptStore = ReturnType<typeof createTranscriptStore>;

let shared: TranscriptStore | undefined;

/** The panel's store, listening to the bridge from first use. */
export function transcriptStore(): TranscriptStore {
  if (!shared) {
    const store = createTranscriptStore();
    subscribe(store.handle);
    shared = store;
  }
  return shared;
}

export function useTranscript(): TranscriptSnapshot {
  const store = transcriptStore();
  const [snapshot, setSnapshot] = useState(store.get);
  useEffect(() => {
    setSnapshot(store.get());
    return store.subscribe(setSnapshot);
  }, [store]);
  return snapshot;
}
