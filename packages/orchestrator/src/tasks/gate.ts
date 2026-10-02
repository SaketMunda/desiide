import type { PolicyOutcome, ReasonLabel, Task, ToolCall } from '@desiide/protocol';

export interface GateDecision {
  outcome: PolicyOutcome;
  reasons: ReasonLabel[];
  /** Set when the decision was logged (JEV-4), so the UI can link to it. */
  decisionId?: string;
}

/**
 * Decides whether a validated tool call may run: `auto` runs it, `confirm` asks the user, `block`
 * returns a refusal to the model. JEV-2's `PolicyGate` implements this; the task engine takes it by
 * injection.
 */
export interface Gate {
  evaluate(call: ToolCall, task: Task, signal: AbortSignal): Promise<GateDecision>;
}

/**
 * The default until JEV-2 lands: every call asks the user. Conservative by construction (ADR-006):
 * even reads confirm, because which files are sensitive is the policy gate's call, not ours.
 */
export const confirmAllGate: Gate = {
  evaluate: () => Promise.resolve({ outcome: 'confirm', reasons: [] }),
};
