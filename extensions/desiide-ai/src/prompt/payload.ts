import { TaskInput, type ContextRef, type Preference, type WorkspacePath } from '@desiide/protocol';
import * as z from 'zod';
import type { PromptChip, WorkflowChoice } from '../../shared/messages.ts';
import { inferTaskKind } from './taskKind.ts';

export interface PromptSubmission {
  instruction: string;
  chips: readonly PromptChip[];
  preference: Preference;
  workflow: WorkflowChoice;
  /** Workspace-relative paths of open editors, most relevant first. */
  openEditors: readonly WorkspacePath[];
}

export type PayloadResult = { ok: true; params: TaskInput } | { ok: false; message: string };

/**
 * Builds and validates `task.create` params. Chips become `context.refs` in the order the user
 * added them (exact duplicates dropped); `auto` sends no `workflowOverride` so Jev decides.
 */
export function buildTaskCreateParams(input: PromptSubmission): PayloadResult {
  const instruction = input.instruction.trim();
  if (instruction.length === 0) return { ok: false, message: 'Type an instruction first.' };

  const refs: ContextRef[] = [];
  const seen = new Set<string>();
  for (const chip of input.chips) {
    const key = JSON.stringify(chip.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(chip.ref);
  }
  const attached = new Set(refs.flatMap((r) => ('path' in r && r.path ? [r.path] : [])));
  const openEditors = [...new Set(input.openEditors)].filter((p) => !attached.has(p));

  const parsed = TaskInput.safeParse({
    kind: inferTaskKind(instruction),
    instruction,
    context: { refs, openEditors },
    preference: input.preference,
    ...(input.workflow === 'auto' ? {} : { workflowOverride: input.workflow }),
  });
  if (!parsed.success) {
    return { ok: false, message: `Couldn't build the task: ${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, params: parsed.data };
}
