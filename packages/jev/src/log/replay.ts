import {
  JevPackState,
  type DecisionRecord,
  type JevResult,
  type PolicyOutcome,
  type RiskGateState,
} from '@desiide/protocol';
import { getPack } from '../packs/registry.ts';
import { evaluateRiskState, type PolicySettings } from '../policy/gate.ts';
import { pathScope } from '../policy/paths.ts';
import { JevRequestError, type JevEngine } from '../types.ts';

/** One engine's answer on replay, shaped like `decisions.replay`'s `EngineRun`. */
export interface EngineRun {
  engine: DecisionRecord['engine'];
  result: JevResult;
  policyOutcome?: PolicyOutcome;
  latencyMs: number;
}

export interface ReplayResult {
  record: DecisionRecord;
  rules: EngineRun;
  jev?: EngineRun;
  jevError?: string;
  /** True when the record, the rules run and the Jev run don't all agree. */
  differs: boolean;
}

export interface ReplayOptions {
  rules: JevEngine;
  /** The Jev engine itself, not an `EngineSelector`: replay reports a failure, it doesn't hide it. */
  jev?: JevEngine;
  /** Current gating settings; a risk_gate replay answers "what would policy decide now?". */
  settings: PolicySettings;
  now?: () => number;
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

/**
 * Re-runs a logged state, and only that state (never more than was sent to Jev), through the
 * rules engine and Jev. risk_gate records go through the full policy so the outcome is
 * replayed too; routing records replay their one question.
 */
export async function replayDecision(
  record: DecisionRecord,
  opts: ReplayOptions,
  signal?: AbortSignal,
): Promise<ReplayResult> {
  signal?.throwIfAborted();
  const parsed = JevPackState.safeParse(record.state);
  if (!parsed.success) {
    throw new ReplayError(`Decision ${record.id} uses ${record.pack}, which can't be replayed`);
  }
  const state = parsed.data;
  const run = (engine: JevEngine): Promise<EngineRun> =>
    state.pack === 'risk_gate@1'
      ? replayRisk(state, record.question, engine, opts, signal)
      : replayQuestion(state, record.question, engine, signal);

  const rules = await run(opts.rules);
  let jev: EngineRun | undefined;
  let jevError: string | undefined;
  if (opts.jev) {
    // The gate turns an engine failure into `confirm` + `jev_unavailable`; replay reports it.
    const { engine, failure } = recordFailures(opts.jev);
    try {
      const r = await run(engine);
      if (failure.error === undefined) jev = r;
    } catch (err) {
      signal?.throwIfAborted();
      if (err instanceof JevRequestError) throw err;
      failure.error ??= err;
    }
    if (failure.error !== undefined) {
      const e = failure.error;
      jevError = e instanceof Error ? e.message : String(e);
    }
  }
  const runs = [rules, ...(jev ? [jev] : [])];
  const differs = runs.some((r) => !sameDecision(r, record));
  return {
    record,
    rules,
    ...(jev ? { jev } : {}),
    ...(jevError === undefined ? {} : { jevError }),
    differs,
  };
}

function recordFailures(engine: JevEngine): { engine: JevEngine; failure: { error?: unknown } } {
  const failure: { error?: unknown } = {};
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (!(err instanceof JevRequestError)) failure.error ??= err;
        throw err;
      }
    };
  return {
    engine: {
      kind: engine.kind,
      choice: wrap(engine.choice.bind(engine)),
      score: wrap(engine.score.bind(engine)),
      noul: wrap(engine.noul.bind(engine)),
    },
    failure,
  };
}

/**
 * The gate's context, rebuilt from the state alone. The state's action vocabulary already
 * encodes what the gate knew: read tools (and run_tests/lint with nothing configured) are
 * `other`/check actions with no command, and a run_tests/lint command is the project's
 * configured, trusted one.
 */
async function replayRisk(
  state: RiskGateState,
  question: string,
  engine: JevEngine,
  opts: ReplayOptions,
  signal?: AbortSignal,
): Promise<EngineRun> {
  const check = state.actionType === 'run_tests' || state.actionType === 'lint';
  const readOnlyTool =
    state.command === undefined &&
    state.editFileCount === undefined &&
    (state.actionType === 'other' || check);
  const captured: DecisionRecord[] = [];
  let ids = 0;
  const decision = await evaluateRiskState(
    state,
    {
      engine,
      settings: opts.settings,
      trustedCommands: check && state.command !== undefined ? [state.command] : [],
      readOnlyTool,
      floors: state.filesTouched.some((f) => pathScope(f.path) !== 'workspace')
        ? ['outside_workspace']
        : [],
      newId: () => `replay-${ids++}`,
      ...(opts.now ? { now: opts.now } : {}),
      onDecision: (r) => captured.push(r),
    },
    signal,
  );
  // The same question if this run asked it; otherwise the run took another path (e.g. policy
  // alone decided now), and its first record says why.
  const answer = captured.find((r) => r.question === question) ?? captured[0];
  if (!answer) throw new ReplayError('Replay produced no decision');
  return {
    engine: answer.engine,
    result: answer.result,
    policyOutcome: decision.outcome,
    latencyMs: answer.latencyMs,
  };
}

async function replayQuestion(
  state: JevPackState,
  question: string,
  engine: JevEngine,
  signal?: AbortSignal,
): Promise<EngineRun> {
  const { questions } = getPack(state.pack);
  const template = Object.hasOwn(questions, question) ? questions[question] : undefined;
  if (!template) throw new ReplayError(`${state.pack} has no question "${question}"`);
  const request = { state, question };
  const answer =
    template.type === 'choice'
      ? await engine.choice(request, signal)
      : template.type === 'score'
        ? await engine.score(request, signal)
        : await engine.noul(request, signal);
  return { engine: answer.engine, result: answer.result, latencyMs: answer.latencyMs };
}

/** The decisive value of a result: probabilities differ between engines and aren't a diff. */
function decisive(result: JevResult): string {
  switch (result.kind) {
    case 'choice':
      return `choice:${result.selected}`;
    case 'score':
      return `score:${result.score}`;
    case 'noul':
      return `noul:${result.answer}`;
  }
}

function sameDecision(run: EngineRun, record: DecisionRecord): boolean {
  return (
    decisive(run.result) === decisive(record.result) && run.policyOutcome === record.policyOutcome
  );
}
