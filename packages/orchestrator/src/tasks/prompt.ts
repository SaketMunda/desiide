import type { FileApplyResult, Task } from '@desiide/protocol';

export const SYSTEM_PROMPT = [
  'You are Desiide, a coding agent working inside the user’s workspace.',
  'Use the tools to inspect the code before changing it. Paths are workspace-relative.',
  'You never write files directly: change code with propose_edit, and the user reviews each edit.',
  'A tool result tells you whether the user applied, rejected, or could not apply (stale) an edit.',
  'If a file is stale, read it again and propose a fresh edit. If the user rejects something, ' +
    'respect the reason and adapt instead of retrying the same action.',
  'When the task is complete, reply with a short summary and no tool call. ' +
    'Desiide then runs the configured checks and reports failures back to you.',
].join('\n');

export function firstMessage(task: Task, contextText: string): string {
  const parts = [`Task (${task.kind}):`, task.instruction];
  if (contextText) parts.push('', contextText);
  const checks = [
    task.success.testsPass ? 'tests pass' : undefined,
    task.success.lintClean ? 'lint is clean' : undefined,
  ].filter((c) => c !== undefined);
  if (checks.length > 0) parts.push('', `Done means: ${checks.join(' and ')}.`);
  return parts.join('\n');
}

export function verificationFailedMessage(failures: { label: string; output: string }[]): string {
  return [
    'Verification failed. Fix the problems below, then finish again.',
    ...failures.map((f) => `\n## ${f.label}\n${f.output}`),
  ].join('\n');
}

/** What the model reads after the user reviewed a proposal. */
export function editReportMessage(results: FileApplyResult[]): string {
  return results
    .map((r) => {
      switch (r.status) {
        case 'applied':
          return `${r.path}: applied`;
        case 'rejected':
          return `${r.path}: user rejected${r.reason ? `: ${r.reason}` : ''}`;
        case 'stale':
          return `${r.path}: stale, the file changed since you read it. Read it again and propose a new edit.`;
      }
    })
    .join('\n');
}
