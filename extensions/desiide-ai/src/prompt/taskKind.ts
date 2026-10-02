import type { TaskKind } from '@desiide/protocol';

// First match wins, so more specific kinds come first. `task.create` requires a kind and the
// Prompt Box has no kind picker; this keyword guess only seeds Jev's state (it re-scores the task).
const RULES: ReadonlyArray<[TaskKind, RegExp]> = [
  [
    'test_write',
    /\b(write|add|create|generate|missing)\b.{0,40}\b(unit |e2e |integration )?tests?\b|\btest coverage\b/i,
  ],
  [
    'bug_fix',
    /\b(fix|bug|broken|crash(es|ing)?|error|exception|fails?|failing|regression|doesn'?t work)\b/i,
  ],
  [
    'infra_change',
    /\b(docker(file)?|kubernetes|k8s|terraform|helm|ci|pipeline|github actions|deploy(ment)?|nginx|migration)\b/i,
  ],
  ['refactor', /\b(refactor|rename|extract|clean ?up|simplify|reorganize|restructure|move)\b/i],
  ['explain', /^(explain|what|why|how|where|describe)\b|\bexplain\b/i],
];

export function inferTaskKind(instruction: string): TaskKind {
  for (const [kind, re] of RULES) if (re.test(instruction)) return kind;
  return 'other';
}
