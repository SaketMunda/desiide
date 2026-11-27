import type { DecisionRecord, PolicyOutcome } from '@desiide/protocol';

/** What the violet decision chip shows for one gate or routing check. */
export interface DecisionSummary {
  /** "rules · risk gate", "Jev · route". */
  label: string;
  /** Workflow picked by a routing decision (`cloud-single`, …). */
  workflow?: string;
  outcome?: PolicyOutcome;
  /** The headline probability: P(safe now) for a gate, P(selected) for a choice. */
  probability?: number;
  /** What `probability` is the probability of. */
  probabilityLabel?: string;
}

const PACK_NAMES: Record<string, string> = {
  risk_gate: 'risk gate',
  workflow_select: 'route',
  cost_route: 'cost',
};

function probabilityOf(r: DecisionRecord): number | undefined {
  switch (r.result.kind) {
    case 'noul':
      return r.result.pYes;
    case 'choice':
      return r.result.probs[r.result.selected];
    case 'score':
      return undefined;
  }
}

/** Summarizes the consecutive records of one check (a risk gate asks several questions). */
export function summarizeDecision(records: readonly DecisionRecord[]): DecisionSummary | undefined {
  const first = records[0];
  if (!first) return undefined;
  const pack = first.pack.split('@')[0] ?? first.pack;
  const engine = first.engine === 'rules' ? 'rules' : 'Jev';
  const outcome = records.find((r) => r.policyOutcome)?.policyOutcome;
  const workflow = records.find((r) => r.workflow)?.workflow;
  // A gate's headline is "safe now"; otherwise the first question with a probability.
  const headline =
    records.find((r) => r.question === 'safe_now') ??
    records.find((r) => probabilityOf(r) !== undefined);
  const probability = headline ? probabilityOf(headline) : undefined;
  return {
    label: `${engine} · ${PACK_NAMES[pack] ?? pack.replace(/_/g, ' ')}`,
    ...(workflow ? { workflow } : {}),
    ...(outcome ? { outcome } : {}),
    ...(probability !== undefined && headline
      ? {
          probability,
          probabilityLabel:
            headline.result.kind === 'choice'
              ? headline.result.selected
              : headline.question.replace(/_/g, ' '),
        }
      : {}),
  };
}

/** How long after it was made a decision still "lands" (pulses) when it first appears. */
export const LANDING_WINDOW_MS = 3000;

/**
 * True the first time `id` is seen in this webview, if it happened within the landing window. A
 * replayed or re-rendered (virtualized) item never pulses again, and reopening a panel full of old
 * decisions doesn't animate them all at once.
 */
export function firstLanding(
  seen: Set<string>,
  id: string,
  ts: string | undefined,
  now: number,
): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (!ts) return false;
  const age = now - Date.parse(ts);
  return Number.isFinite(age) && age >= -LANDING_WINDOW_MS && age <= LANDING_WINDOW_MS;
}

/** "Thinking…" while live; "Thought for 3 s" once it's done. */
export function thinkingLabel(live: boolean, elapsed: string): string {
  return live ? 'Thinking…' : `Thought for ${elapsed}`;
}
