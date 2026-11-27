import { createContext } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ExtensionToWebview } from '../../shared/messages.ts';
import { reviewKey, type ProposalReview } from '../../shared/review/model.ts';
import type { TaskView } from '../../shared/transcript/model.ts';
import { subscribe } from '../bridge.ts';

export interface ReviewSnapshot {
  proposals: ReadonlyMap<string, ProposalReview>;
  reasons: Readonly<Record<string, string>>;
}

const EMPTY: ReviewSnapshot = { proposals: new Map(), reasons: {} };

/** Review state from the host (`review.state`, replaced whole on each change). */
export function createReviewStore() {
  let current = EMPTY;
  const listeners = new Set<(s: ReviewSnapshot) => void>();
  const handle = (m: ExtensionToWebview) => {
    if (m.type !== 'review.state') return;
    current = {
      proposals: new Map(m.proposals.map((p) => [reviewKey(p.taskId, p.proposalId), p])),
      reasons: m.reasons,
    };
    for (const l of listeners) l(current);
  };
  return {
    handle,
    get: () => current,
    subscribe(listener: (s: ReviewSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: ReturnType<typeof createReviewStore> | undefined;

function reviewStore() {
  if (!shared) {
    shared = createReviewStore();
    subscribe(shared.handle);
  }
  return shared;
}

export function useReview(): ReviewSnapshot {
  const store = reviewStore();
  const [snapshot, setSnapshot] = useState(store.get);
  useEffect(() => {
    setSnapshot(store.get());
    return store.subscribe(setSnapshot);
  }, [store]);
  return snapshot;
}

/** The task whose transcript is rendering: approval cards look up their gate decision in it. */
export const TaskViewContext = createContext<TaskView | undefined>(undefined);
