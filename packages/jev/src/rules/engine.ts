import type { JevResult } from '@desiide/protocol';
import { getQuestion, parsePackState, resolveChoiceOptions } from '../packs/registry.ts';
import {
  JevRequestError,
  type ChoiceRequest,
  type ChoiceResult,
  type JevAnswer,
  type JevEngine,
  type JevRequest,
  type NoulResult,
  type ScoreResult,
} from '../types.ts';
import type { Ruled } from './answers.ts';
import { cheapSuccess } from './costRoute.ts';
import { riskGateNoul } from './riskGate.ts';
import { complexity, escalationNeed, workflowChoice } from './workflowSelect.ts';

function answer<R extends JevResult>(ruled: Ruled<R>, startedAt: number): JevAnswer<R> {
  return {
    engine: 'rules',
    result: ruled.result,
    rationale: ruled.rationale,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function unanswerable(pack: string, question: string): never {
  // Only reachable if a pack gains a question without a rule; the registry test guards it.
  throw new JevRequestError('unknown_question', `No rule for ${pack}/${question}`, pack);
}

/**
 * Deterministic, explainable answers for every pack question. The default engine when Jev
 * isn't configured, the per-call fallback when it fails, and the test oracle for JEV-3.
 */
export function createRuleJevEngine(): JevEngine {
  return {
    kind: 'rules',

    async choice(request: ChoiceRequest, signal?: AbortSignal): Promise<JevAnswer<ChoiceResult>> {
      signal?.throwIfAborted();
      const startedAt = performance.now();
      const state = parsePackState(request.state);
      const question = getQuestion(state.pack, request.question, 'choice');
      const options = resolveChoiceOptions(state, question, request.options);
      if (state.pack === 'workflow_select@1' && question.id === 'workflow') {
        return answer(workflowChoice(state, options), startedAt);
      }
      return unanswerable(state.pack, question.id);
    },

    async score(request: JevRequest, signal?: AbortSignal): Promise<JevAnswer<ScoreResult>> {
      signal?.throwIfAborted();
      const startedAt = performance.now();
      const state = parsePackState(request.state);
      const question = getQuestion(state.pack, request.question, 'score');
      if (state.pack === 'workflow_select@1') {
        if (question.id === 'complexity') return answer(complexity(state), startedAt);
        if (question.id === 'escalation_need') return answer(escalationNeed(state), startedAt);
      }
      if (state.pack === 'cost_route@1' && question.id === 'cheap_success') {
        return answer(cheapSuccess(state), startedAt);
      }
      return unanswerable(state.pack, question.id);
    },

    async noul(request: JevRequest, signal?: AbortSignal): Promise<JevAnswer<NoulResult>> {
      signal?.throwIfAborted();
      const startedAt = performance.now();
      const state = parsePackState(request.state);
      const question = getQuestion(state.pack, request.question, 'noul');
      const ruled = state.pack === 'risk_gate@1' ? riskGateNoul(state, question.id) : undefined;
      return ruled ? answer(ruled, startedAt) : unanswerable(state.pack, question.id);
    },
  };
}
