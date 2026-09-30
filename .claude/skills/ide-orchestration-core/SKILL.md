---
name: ide-orchestration-core
description: Designing or changing the orchestrator — Task DSL, agent loop, workflows (single/cascade/critique), tool runner (shell, files, tests, lint, git), RPC protocol and events. Load before editing packages/orchestrator or packages/protocol.
---

# Orchestration core

## Process model
The orchestrator is a Node child process spawned by the `desiide-ai` extension and speaks JSON-RPC 2.0 over stdio (`vscode-jsonrpc`). It must not import `vscode`, so it can later run remotely behind a WebSocket transport.

## Task DSL (`packages/protocol`, zod)
```ts
Task = {
  id, kind: 'autocomplete'|'refactor'|'bug_fix'|'test_write'|'infra_change'|'explain'|'other',
  instruction: string,
  context: { files: string[]; selections?: Range[]; diffs?: string[]; tests?: string[] },
  allowedTools: ToolName[],              // subset of: read, search, propose_edit, shell, run_tests, lint, git_read
  success: { testsPass?: boolean; lintClean?: boolean; userApproval: boolean },
  budget: { maxIterations: 8; maxToolCalls: 40; maxTokens: number; wallClockMs: 600_000 },
  preference: 'cheap'|'balance'|'quality',
}
```
New fields must be optional or come with a default, because old clients must still parse.

## Agent loop
One manager loop per task. Tool runners are stateless functions.
1. Build context (files, diffs, project config).
2. `jev.workflow_select`: pick single | cascade | critique (see `ide-jev-decisions`).
3. The workflow drives model turns. Each tool call gets validated (zod), then `jev.risk_gate` + policy → `auto | confirm | block`.
4. `confirm` → emit `awaiting_approval`, pause until `task.approve/reject`. `block` → return a structured refusal to the model as the tool result.
5. After edits are applied, run `success` checks. Pass → `done`. Fail → feed the results back and iterate.
6. Every state change emits a `TaskEvent`, which the UI renders.

States: `queued → planning → running ⇄ awaiting_approval → verifying → done | failed | cancelled`.

## Workflows
- **single**: one model runs the full loop.
- **cascade**: cheap model drafts. Escalate to the strong model if verification fails, the edit doesn't parse, or `jev.escalation_need ≥ 3`. Escalate at most once, carrying the draft + failure as context.
- **critique**: model A drafts an edit, model B returns a structured `{verdict: approve|revise|reject, issues[]}`. At most one revise round, then show the edit to the user with the critique attached.

## Tools
| Tool | Rules |
|---|---|
| read/search/list | workspace-confined; resolve realpath to block symlink escape; skip `.git`, `node_modules`, gitignored |
| propose_edit | returns `FileEdit[]` (search/replace blocks); **never writes**; the extension applies via WorkspaceEdit |
| shell | cwd = workspace root, timeout (default 120 s), output capped at 64 KB tail, AbortSignal, env scrubbed of `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*` |
| run_tests / lint | commands from `.desiide/project.json`; parse exit code + summary |
| git_read | status/diff/log/show only. Commit/push/reset go through `shell`, so they're gated |

## Gotchas
- **Infinite loops:** enforce every budget field, and fail the task if the same tool+args repeats 3× in a row.
- **Long tasks:** everything takes an AbortSignal. Cancel kills the process group (`detached: true` + `process.kill(-pid)`).
- **Model output is untrusted:** validate tool args with zod, and feed malformed calls back as errors instead of throwing.
- Never let the stdio channel carry stray logs. Log to stderr or a file only, because stdout is the RPC transport.
- Tests use `FakeModelAdapter` with scripted turns. Don't hit real models in unit tests.
