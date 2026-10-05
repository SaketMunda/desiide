import type {
  DecisionRecord,
  JevResult,
  PolicyOutcome,
  ReasonLabel,
  RiskGateState,
  Task,
  ToolCall,
} from '@desiide/protocol';
import { createHash } from 'node:crypto';
import { buildRiskGateState, type GitInfo } from '../state/builders.ts';
import type { PathRedactor } from '../state/redact.ts';
import { actionFromToolCall } from '../state/toolCall.ts';
import { JevRequestError, type JevAnswer, type JevEngine, type NoulResult } from '../types.ts';
import { assessCommand } from './commands.ts';
import { createSensitivity, pathScope, type Sensitivity } from './paths.ts';
import type { Thresholds } from './thresholds.ts';

export type GatingMode = 'conservative' | 'strict';

export interface PolicySettings {
  mode: GatingMode;
  thresholds: Thresholds;
  /** Set when `desiide.jev.redactPaths` is on. */
  redactor?: PathRedactor;
}

/** What the gate needs to know about the project. */
export interface ProjectPolicy {
  sensitiveGlobs?: readonly string[];
  testCommand?: string;
  lintCommand?: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasons: ReasonLabel[];
  decisionId: string;
}

export interface RiskContext {
  engine: JevEngine;
  settings: PolicySettings;
  /** Unredacted command (the state's may be redacted). Defaults to `state.command`. */
  command?: string;
  sensitive?: Sensitivity;
  trustedCommands?: readonly string[];
  /** Read tools: allowed without asking unless a floor applies. */
  readOnlyTool?: boolean;
  /** Labels forcing at least `confirm`, found before the state was built (e.g. path scope). */
  floors?: readonly ReasonLabel[];
  taskId?: string | null;
  newId(): string;
  now?: () => number;
  onDecision?(record: DecisionRecord): void;
}

const RISK_QUESTIONS = ['safe_now', 'reversible', 'high_risk_area'] as const;

/** sha256 of canonical JSON (keys sorted), so equal states hash equally (replay, JEV-4). */
export function stateHash(state: unknown): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const dedupe = (labels: readonly ReasonLabel[]): ReasonLabel[] => [...new Set(labels)];

/**
 * The trust layer for one risk_gate state. Order, first match wins:
 * 1. deny-list → `block` (Jev is never asked);
 * 2. read-only allow-list with no floor → `auto`;
 * 3. strict mode → `confirm`;
 * 4. risk_gate questions against the thresholds; any floor (sensitive file, multi-file edit,
 *    outside the workspace, destructive, irreversible, inline code, sudo…) or a Jev fallback
 *    turns `auto` into `confirm`. Jev can therefore make a decision stricter, never looser.
 */
export async function evaluateRiskState(
  state: RiskGateState,
  ctx: RiskContext,
  signal?: AbortSignal,
): Promise<PolicyDecision> {
  const now = ctx.now ?? Date.now;
  const { thresholds, mode } = ctx.settings;
  const sensitive = ctx.sensitive ?? createSensitivity();
  const floors: ReasonLabel[] = [...(ctx.floors ?? [])];
  if (state.filesTouched.some((f) => f.sensitive)) floors.push('sensitive_file');
  if ((state.editFileCount ?? 0) > thresholds.maxAutoEditFiles) floors.push('multi_file_edit');

  const record = (
    question: string,
    answer: { engine: DecisionRecord['engine']; result: JevResult; latencyMs: number },
    outcome: PolicyOutcome,
    reasons: ReasonLabel[],
  ): DecisionRecord => {
    const rec: DecisionRecord = {
      id: ctx.newId(),
      taskId: ctx.taskId ?? null,
      pack: state.pack,
      question,
      engine: answer.engine,
      stateHash: stateHash(state),
      state: { ...state },
      result: answer.result,
      policyOutcome: outcome,
      reasons,
      latencyMs: Math.max(0, Math.round(answer.latencyMs)),
      ts: new Date(now()).toISOString(),
    };
    try {
      ctx.onDecision?.(rec);
    } catch {
      // The decision stands even if logging it failed.
    }
    return rec;
  };

  /**
   * Decided by policy alone. Logged as the pseudo-question `policy` ("may this run without
   * asking?": yes = auto, no = block, unknown = confirm) so the Decision panel shows it too.
   */
  const policyOnly = (outcome: PolicyOutcome, labels: readonly ReasonLabel[]): PolicyDecision => {
    const result: NoulResult =
      outcome === 'auto'
        ? { kind: 'noul', answer: 'yes', pYes: 1 }
        : outcome === 'block'
          ? { kind: 'noul', answer: 'no', pYes: 0 }
          : { kind: 'noul', answer: 'unknown', pYes: 0.5 };
    const reasons = dedupe(labels);
    const rec = record('policy', { engine: 'rules', result, latencyMs: 0 }, outcome, reasons);
    return { outcome, reasons, decisionId: rec.id };
  };

  const command = ctx.command ?? state.command;
  let readOnly = ctx.readOnlyTool ?? false;
  if (command !== undefined) {
    const assessed = assessCommand(command, {
      branch: state.context.branch,
      sensitive,
      trustedCommands: ctx.trustedCommands ?? [],
    });
    if (assessed.deny.length > 0) return policyOnly('block', assessed.deny);
    floors.push(...assessed.confirm);
    readOnly = assessed.readOnly;
  }
  if (readOnly && floors.length === 0 && (mode !== 'strict' || ctx.readOnlyTool)) {
    return policyOnly('auto', ['read_only_allow']);
  }
  if (ctx.readOnlyTool) return policyOnly('confirm', floors);
  if (mode === 'strict') return policyOnly('confirm', [...floors, 'policy_override:strict_mode']);

  signal?.throwIfAborted();
  let answers: JevAnswer<NoulResult>[];
  try {
    answers = await Promise.all(
      RISK_QUESTIONS.map((question) => ctx.engine.noul({ state, question }, signal)),
    );
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof JevRequestError) throw err;
    return policyOnly('confirm', [...floors, 'jev_unavailable']);
  }
  const [safe, rev, risk] = answers.map((a) => a.result.pYes) as [number, number, number];
  const reasons: ReasonLabel[] = [];
  let outcome: PolicyOutcome;
  if (safe < thresholds.blockSafeNowBelow) {
    outcome = 'block';
    reasons.push('not_safe_now');
    if (rev < thresholds.autoReversibleMin) reasons.push('irreversible');
    reasons.push(...floors);
  } else {
    const confident =
      safe >= thresholds.autoSafeNowMin &&
      rev >= thresholds.autoReversibleMin &&
      risk < thresholds.autoHighRiskMax;
    const fellBack = answers.some((a) => a.fallbackReason !== undefined);
    if (safe < thresholds.autoSafeNowMin) reasons.push('not_safe_now');
    if (rev < thresholds.autoReversibleMin) reasons.push('irreversible');
    if (risk >= thresholds.autoHighRiskMax) reasons.push('high_risk_area');
    if (fellBack) reasons.push('jev_unavailable');
    reasons.push(...floors);
    outcome = confident && !fellBack && floors.length === 0 ? 'auto' : 'confirm';
    if (answers.some((a) => a.engine === 'jev')) {
      reasons.push(outcome === 'auto' ? 'jev_confident' : 'jev_uncertain');
    }
  }
  const final = dedupe(reasons);
  const ids = RISK_QUESTIONS.map(
    (question, i) => record(question, answers[i] as JevAnswer<NoulResult>, outcome, final).id,
  );
  return { outcome, reasons: final, decisionId: ids[0] as string };
}

export interface PolicyGateOptions {
  /** Usually an `EngineSelector`: Jev when configured and healthy, else rules. */
  engine: JevEngine;
  settings(): PolicySettings;
  project(task: Task, signal: AbortSignal): Promise<ProjectPolicy>;
  git(signal: AbortSignal): Promise<GitInfo>;
  newId(): string;
  now?: () => number;
  /** Every decision, for the decision log (JEV-4) and the Decision panel (UI-5). Must not throw. */
  onDecision?(record: DecisionRecord): void;
}

/** Implements COR-2's `Gate` (structurally; this package doesn't depend on the orchestrator). */
export interface PolicyGate {
  evaluate(call: ToolCall, task: Task, signal: AbortSignal): Promise<PolicyDecision>;
}

const READ_TOOLS = new Set(['read_file', 'list_files', 'search', 'git_read']);
const NO_GIT: GitInfo = { branch: null, hasPendingMigrations: false };

/** Path-valued args across tools: `path`, `paths`, and `files[].path`. */
function argPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  add(args.path);
  if (Array.isArray(args.paths)) args.paths.forEach(add);
  if (Array.isArray(args.files)) {
    for (const f of args.files) if (f !== null && typeof f === 'object' && 'path' in f) add(f.path);
  }
  return [...new Set(out)];
}

/** Turns each tool call into a risk_gate state and runs `evaluateRiskState` on it. */
export function createPolicyGate(opts: PolicyGateOptions): PolicyGate {
  return {
    async evaluate(call, task, signal) {
      const settings = opts.settings();
      const project = await opts.project(task, signal);
      const sensitive = createSensitivity(project.sensitiveGlobs ?? []);
      const action = actionFromToolCall(call, {
        ...(project.testCommand === undefined ? {} : { testCommand: project.testCommand }),
        ...(project.lintCommand === undefined ? {} : { lintCommand: project.lintCommand }),
      });
      const paths = [...new Set([...action.paths, ...argPaths(call.args)])];
      const files = paths.map((path) => ({ path, sensitive: sensitive(path) }));
      const git =
        call.tool === 'shell' || call.tool === 'propose_edit' ? await opts.git(signal) : NO_GIT;
      const state = buildRiskGateState(
        { action, files, git },
        settings.redactor ? { redactor: settings.redactor } : {},
      );
      const readOnlyTool =
        READ_TOOLS.has(call.tool) ||
        // run_tests / lint with nothing configured fail without running anything.
        ((call.tool === 'run_tests' || call.tool === 'lint') && action.command === undefined);
      return evaluateRiskState(
        state,
        {
          engine: opts.engine,
          settings,
          ...(action.command === undefined ? {} : { command: action.command }),
          sensitive,
          trustedCommands: [project.testCommand, project.lintCommand].filter(
            (c): c is string => c !== undefined,
          ),
          readOnlyTool,
          floors: paths.some((p) => pathScope(p) !== 'workspace') ? ['outside_workspace'] : [],
          taskId: task.id,
          newId: opts.newId,
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
        },
        signal,
      );
    },
  };
}
