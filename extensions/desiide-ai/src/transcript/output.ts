import type { ToolOutput } from './taskStore.ts';

/** The text shown in the "Desiide: Tool Output" channel for one tool call. */
export function formatToolOutput({ call, result }: ToolOutput): string {
  const lines: string[] = [];
  const title = call ? `${call.tool} ${JSON.stringify(call.args)}` : `tool call ${result.callId}`;
  lines.push(`# ${title}`);
  const status = result.ok
    ? 'ok'
    : `${result.error?.kind ?? 'failed'}${result.error ? `: ${result.error.message}` : ''}`;
  const exit = result.exitCode === undefined ? '' : `, exit ${result.exitCode}`;
  lines.push(`# ${status}${exit}, ${result.durationMs} ms`);
  if (result.truncated) {
    lines.push('# Output was capped by the tool runner; this is its tail.');
  }
  lines.push('', result.output);
  return `${lines.join('\n')}\n`;
}
