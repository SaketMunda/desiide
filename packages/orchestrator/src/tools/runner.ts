import { ToolName, type EditProposal, type ToolResult } from '@desiide/protocol';
import * as z from 'zod';
import { PathError } from './paths.ts';
import type { EditError } from './proposeEdit.ts';
import { TOOLS } from './registry.ts';
import type { ToolContext, ToolOutput } from './types.ts';

/** A call as the model made it: tool name and args are untrusted until validated here. */
export interface RawToolCall {
  id: string;
  tool: string;
  args: unknown;
}

export interface ToolExecution {
  result: ToolResult;
  proposal?: EditProposal;
  editErrors?: EditError[];
}

/**
 * Validates and runs one tool call. Never throws: bad names, bad args, path escapes, and crashes
 * all come back as a structured `ToolResult` the model can read and retry from.
 * Whether the call may run at all is decided before this (COR-2 / JEV-2).
 */
export async function executeToolCall(
  call: RawToolCall,
  ctx: ToolContext,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<ToolExecution> {
  const start = now();
  const finish = (out: ToolOutput): ToolExecution => {
    const result: ToolResult = {
      callId: call.id,
      ok: out.ok,
      output: out.output,
      truncated: out.truncated ?? false,
      durationMs: Math.max(0, Math.round(now() - start)),
    };
    if (out.exitCode !== undefined) result.exitCode = out.exitCode;
    if (out.error) result.error = { ...out.error, reasons: [] };
    const exec: ToolExecution = { result };
    if (out.proposal) exec.proposal = out.proposal;
    if (out.editErrors) exec.editErrors = out.editErrors;
    return exec;
  };
  const invalid = (message: string): ToolExecution =>
    finish({ ok: false, output: message, error: { kind: 'invalid_args', message } });

  const name = ToolName.safeParse(call.tool);
  if (!name.success) {
    return invalid(`Unknown tool "${call.tool}". Available: ${ToolName.options.join(', ')}.`);
  }
  const tool = TOOLS[name.data];
  const args = tool.argsSchema.safeParse(call.args ?? {});
  if (!args.success) {
    return invalid(`Invalid arguments for ${tool.name}:\n${z.prettifyError(args.error)}`);
  }
  if (signal.aborted) {
    return finish({
      ok: false,
      output: 'cancelled',
      error: { kind: 'cancelled', message: 'cancelled' },
    });
  }
  try {
    return finish(await tool.run(args.data, ctx, signal));
  } catch (err) {
    if (err instanceof PathError) return invalid(`${tool.name}: ${err.message}`);
    if (signal.aborted) {
      return finish({
        ok: false,
        output: 'cancelled',
        error: { kind: 'cancelled', message: 'cancelled' },
      });
    }
    const message = `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    return finish({ ok: false, output: message, error: { kind: 'failed', message } });
  }
}
