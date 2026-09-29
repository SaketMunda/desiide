# FND-2 · Protocol (shared contracts)

**Status:** in-progress · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-orchestration-core

## Purpose
`@mutt/protocol` holds the zod schemas and inferred types for **everything that crosses the extension ↔ orchestrator boundary**. It defines the full Alpha surface up front so that later modules rarely touch it (ADR-010: additive-only afterwards).

## Scope
**Domain schemas**
- `Task` (per the `ide-orchestration-core` skill): `id, kind, instruction, context, allowedTools, success, budget, preference, workflowOverride?`
- `ContextRef` (`file | folder | selection | diff`), `Range`
- `ToolName`, `ToolCall {id, tool, args, sideEffect: none|workspace|external}`, `ToolResult`
- `FileEdit {path, edits: {search, replace}[]}` (search/replace blocks), `EditProposal {id, taskId, files: FileEdit[]}`
- `TaskState` enum + `TaskSummary`
- `DecisionRecord`, `PolicyOutcome = auto|confirm|block`, `ReasonLabel` (string enum, extensible)
- `ModelInfo {id, provider, model, role?, capabilities, healthy}`
- `ProjectConfig` (`.mutt/project.json`: `testCommand?, lintCommand?, sensitiveGlobs?, ignoreGlobs?`)

**RPC** (`methods.ts`: one table of `{params, result}` schemas)
- ext → orch: `initialize` (protocol version handshake), `task.create`, `task.cancel`, `task.list`, `task.approve {taskId, approvalId, scope: once|task}`, `task.reject`, `models.list`, `models.test`, `jev.test`, `decisions.list`, `decisions.replay`, `config.update`, `health.ping`
- orch → ext (reverse requests): `secrets.get {ref}`, `workspace.applyEdit` is **not** here (ADR-004: the extension applies edits after approval)
- notifications orch → ext: `task.event` (discriminated union: `state_changed, text_delta, tool_call_started, tool_call_finished, edit_proposed, approval_required, decision_made, usage, error`), `log`

**Rules**
- Requests are `.strict()`. Event payloads are tolerant: clients ignore unknown event `type`s so the protocol can evolve.
- `PROTOCOL_VERSION` constant; `initialize` fails clearly on major mismatch.

## Out of scope
Transport (COR-1), behavior. This module is types + schemas + fixtures only.

## Acceptance criteria
1. Every schema has a valid fixture + at least one invalid fixture test.
2. `Infer` types are exported for every schema; no hand-written duplicate interfaces.
3. The three example Jev states from the original brief can be expressed through protocol types (as fixtures used later by JEV-1).
4. A `docs/protocol.md` generated or hand-written summary table of methods + events.

## Handoff notes
_(filled by the build session)_
