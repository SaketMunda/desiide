import type { ChatMessage, ModelAdapter, StreamEvent, ToolCallRequest } from '@desiide/models';
import {
  ToolName,
  type CostPerMTok,
  type EditProposal,
  type FileApplyResult,
  type FileMeta,
  type ReasonLabel,
  type Task,
  type TaskEvent,
  type ToolCall,
  type ToolErrorKind,
  type ToolResult,
  type Usage,
} from '@desiide/protocol';
import * as z from 'zod';
import { TOOLS, toolSpecs } from '../tools/registry.ts';
import type { RawToolCall, ToolExecution } from '../tools/runner.ts';
import { TaskFailure, callKey, createBudgetTracker } from './budget.ts';
import type { ContextProvider } from './context.ts';
import type { Gate, GateDecision } from './gate.ts';
import {
  SYSTEM_PROMPT,
  editReportMessage,
  firstMessage,
  verificationFailedMessage,
} from './prompt.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A task event before the run stamps `taskId`, `seq`, and `ts`. */
export type TaskEventBody = DistributiveOmit<TaskEvent, 'taskId' | 'seq' | 'ts'>;

export interface ApprovalRequest {
  call: ToolCall;
  reasons: ReasonLabel[];
  decisionId?: string;
}

export type ApprovalAnswer =
  { approved: true; scope: 'once' | 'task' } | { approved: false; reason?: string };

/** How the loop talks to the outside. The task run implements it (state, events, waiting on the user). */
export interface AgentLoopIO {
  emit(event: TaskEventBody): void;
  setState(to: 'running' | 'verifying'): void;
  setIteration(n: number): void;
  /** Emits `approval_required` and waits for `task.approve` / `task.reject`. */
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  /** Emits `edit_proposed` and waits until every file of the proposal is reported. */
  requestEditReport(
    proposal: EditProposal,
    files: FileMeta[],
    signal: AbortSignal,
  ): Promise<FileApplyResult[]>;
}

export interface AgentLoopOptions {
  task: Task;
  model: ModelAdapter;
  gate: Gate;
  context: ContextProvider;
  runTool(call: RawToolCall, signal: AbortSignal): Promise<ToolExecution>;
  io: AgentLoopIO;
  signal: AbortSignal;
  newId(): string;
  costPerMTok?: CostPerMTok;
  now?: () => number;
}

interface CallOutcome {
  result: ToolResult;
  /** Set when the user declined a verification check, which ends the task. */
  declined?: 'rejected' | 'blocked';
}

const CHECKS = [
  { field: 'testsPass', tool: 'run_tests', label: 'Tests' },
  { field: 'lintClean', tool: 'lint', label: 'Lint' },
] as const;

/**
 * Runs one model through the task until it finishes and the success checks pass. Resolves on
 * success; throws `TaskFailure` for a failed task, or the signal's reason once it's aborted.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { task, model, gate, io, signal, newId } = opts;
  const now = opts.now ?? Date.now;
  const budget = createBudgetTracker(task.budget);
  const approvedForTask = new Set<string>();
  const tools = toolSpecs(task.allowedTools);

  const context = await opts.context.gather(task, signal);
  const messages: ChatMessage[] = [{ role: 'user', content: firstMessage(task, context.text) }];
  io.setState('running');
  io.setIteration(budget.iteration);

  for (;;) {
    const turn = await modelTurn(messages);
    if (turn.toolCalls.length === 0) {
      const failures = await verify();
      if (failures.length === 0) return;
      budget.nextIteration();
      io.setIteration(budget.iteration);
      messages.push({ role: 'user', content: verificationFailedMessage(failures) });
      io.setState('running');
      continue;
    }
    for (const call of turn.toolCalls) {
      budget.countToolCall();
      const { result } = await handleCall(call, 'model');
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.output,
        ...(result.ok ? {} : { isError: true }),
      });
    }
  }

  async function modelTurn(history: ChatMessage[]) {
    signal.throwIfAborted();
    const messageId = newId();
    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    let terminal: StreamEvent | undefined;
    const stream = model.chat({ system: SYSTEM_PROMPT, messages: history, tools }, signal);
    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          io.emit({ type: 'text_delta', messageId, delta: event.text });
          break;
        case 'tool_call':
          toolCalls.push(event.call);
          break;
        case 'usage': {
          const usage: Usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
          const cost = costOf(usage, opts.costPerMTok);
          if (cost !== undefined) usage.costUsd = cost;
          io.emit({ type: 'usage', modelId: model.id, usage });
          budget.addTokens(usage.inputTokens + usage.outputTokens);
          break;
        }
        case 'done':
        case 'error':
          terminal = event;
          break;
      }
    }
    signal.throwIfAborted();
    if (terminal?.type === 'error') {
      const { kind, message, hint } = terminal.error;
      throw new TaskFailure(`model_error:${kind}`, hint ? `${message} ${hint}` : message, {
        kind,
        retryable: ['rate_limit', 'server', 'network', 'timeout'].includes(kind),
      });
    }
    history.push({
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    return { text, toolCalls };
  }

  /** Runs the success checks. Returns what failed (empty = done). */
  async function verify(): Promise<{ label: string; output: string }[]> {
    const checks = CHECKS.filter((c) => task.success[c.field]);
    if (checks.length === 0) return [];
    io.setState('verifying');
    const failures: { label: string; output: string }[] = [];
    for (const check of checks) {
      const outcome = await handleCall({ id: newId(), name: check.tool, args: '{}' }, 'check');
      if (outcome.declined) {
        throw new TaskFailure(
          `verification_${outcome.declined}`,
          `${check.label} could not run: ${outcome.result.output}`,
        );
      }
      if (!outcome.result.ok) failures.push({ label: check.label, output: outcome.result.output });
    }
    return failures;
  }

  /**
   * One tool call: parse → validate → gate → (approval) → run → (edit review). Problems the model
   * can fix come back as a failed `ToolResult`, never as a thrown error.
   */
  async function handleCall(raw: ToolCallRequest, origin: 'model' | 'check'): Promise<CallOutcome> {
    const started = now();
    const fail = (
      kind: ToolErrorKind,
      message: string,
      reasons: ReasonLabel[] = [],
    ): ToolResult => ({
      callId: raw.id,
      ok: false,
      output: message,
      truncated: false,
      durationMs: Math.max(0, Math.round(now() - started)),
      error: { kind, message, reasons },
    });
    const finish = (result: ToolResult, declined?: CallOutcome['declined']): CallOutcome => {
      io.emit({ type: 'tool_call_finished', result });
      return declined ? { result, declined } : { result };
    };

    let args: unknown;
    try {
      args = JSON.parse(raw.args || '{}');
    } catch (err) {
      if (origin === 'model') budget.checkRepeat(callKey(raw.name, raw.args));
      const detail = err instanceof Error ? err.message : String(err);
      return finish(
        fail('invalid_args', `Arguments for ${raw.name} are not valid JSON: ${detail}`),
      );
    }
    if (origin === 'model') budget.checkRepeat(callKey(raw.name, args));

    const name = ToolName.safeParse(raw.name);
    if (!name.success) {
      return finish(
        fail(
          'invalid_args',
          `Unknown tool "${raw.name}". Available: ${task.allowedTools.join(', ')}.`,
        ),
      );
    }
    const tool = TOOLS[name.data];
    if (origin === 'model' && !task.allowedTools.includes(tool.name)) {
      return finish(
        fail('blocked', `The ${tool.name} tool is not allowed for this task.`, [
          'tool_not_allowed',
        ]),
      );
    }
    const record = z.record(z.string(), z.unknown()).safeParse(args);
    if (!record.success) {
      return finish(fail('invalid_args', `Arguments for ${tool.name} must be a JSON object.`));
    }
    const call: ToolCall = {
      id: raw.id,
      tool: tool.name,
      args: record.data,
      sideEffect: tool.sideEffect,
    };
    io.emit({ type: 'tool_call_started', call });

    const valid = tool.argsSchema.safeParse(record.data);
    if (!valid.success) {
      return finish(
        fail(
          'invalid_args',
          `Invalid arguments for ${tool.name}:\n${z.prettifyError(valid.error)}`,
        ),
      );
    }

    const decision = await decide(call);
    if (decision.outcome === 'block') {
      return finish(
        fail(
          'blocked',
          `Blocked by policy: ${decision.reasons.join(', ') || 'no reason given'}.`,
          decision.reasons,
        ),
        'blocked',
      );
    }
    // An edit is only ever proposed: the user approves it in the diff review, so asking first too
    // would be a second prompt for the same change.
    if (decision.outcome === 'confirm' && tool.name !== 'propose_edit') {
      const answer = await io.requestApproval(
        {
          call,
          reasons: decision.reasons,
          ...(decision.decisionId === undefined ? {} : { decisionId: decision.decisionId }),
        },
        signal,
      );
      io.setState(origin === 'check' ? 'verifying' : 'running');
      if (!answer.approved) {
        const message = `User rejected this ${tool.name} call${answer.reason ? `: ${answer.reason}` : '.'}`;
        return finish(fail('rejected', message, ['user_rejected']), 'rejected');
      }
      if (answer.scope === 'task') approvedForTask.add(callKey(call.tool, call.args));
    }

    const exec = await opts.runTool({ id: call.id, tool: call.tool, args: call.args }, signal);
    signal.throwIfAborted();
    if (!exec.proposal) return finish(exec.result);

    const proposal = exec.proposal;
    const files = await opts.context.describeFiles(
      proposal.files.map((f) => f.path),
      signal,
    );
    const report = await io.requestEditReport(proposal, files, signal);
    io.setState('running');
    const output = editReportMessage(report);
    const allApplied = report.every((r) => r.status === 'applied');
    const durationMs = Math.max(0, Math.round(now() - started));
    if (allApplied) {
      return finish({ callId: call.id, ok: true, output, truncated: false, durationMs });
    }
    const rejected = report.some((r) => r.status === 'rejected');
    return finish({
      callId: call.id,
      ok: false,
      output,
      truncated: false,
      durationMs,
      error: {
        kind: rejected ? 'rejected' : 'failed',
        message: output,
        reasons: rejected ? ['user_rejected'] : [],
      },
    });
  }

  /** The gate decides; a task-scoped approval only turns an exact-match `confirm` into `auto`. */
  async function decide(call: ToolCall): Promise<GateDecision> {
    let decision: GateDecision;
    try {
      decision = await gate.evaluate(call, task, signal);
    } catch {
      signal.throwIfAborted();
      // A broken gate must never let an action through unasked.
      decision = { outcome: 'confirm', reasons: ['gate_error'] };
    }
    if (decision.outcome === 'confirm' && approvedForTask.has(callKey(call.tool, call.args))) {
      return { ...decision, outcome: 'auto', reasons: [...decision.reasons, 'approved_for_task'] };
    }
    return decision;
  }
}

export function costOf(usage: Usage, price: CostPerMTok | undefined): number | undefined {
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
