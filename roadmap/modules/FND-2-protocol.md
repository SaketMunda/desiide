# FND-2 · Protocol (shared contracts)

**Status:** done · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-orchestration-core

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
**Built (branch `mod/FND-2-protocol`):** `@mutt/protocol` at `PROTOCOL_VERSION = 1.0.0`, zod 4.
- **Entry points:** `@mutt/protocol` (all schemas + inferred types) and `@mutt/protocol/fixtures` (`schemaFixtures`, `jevExampleStates`, extra risk-gate goldens).
- **Files:** `common.ts` (Id, IsoDateTime, WorkspacePath, Range, SecretRef, Ack, Empty), `context.ts` (ContextRef, FileMeta), `task.ts` (Task, TaskInput, TaskState, TaskSummary, Budget, WorkflowOption, Usage), `tools.ts`, `edits.ts`, `models.ts` (ModelInfo, ModelConfig, ModelCapabilities, ModelErrorKind), `config.ts` (ProjectConfig, MuttConfig), `reasons.ts` (PolicyOutcome, ReasonLabel), `jev.ts` (pack states, JevResult, DecisionRecord), `events.ts` (TaskEvent + `parseTaskEvent`), `methods.ts` (`ClientMethods`, `ServerMethods`, `ServerNotifications`, `ParamsOf/ResultOf`, `RpcErrorCode`), `version.ts` (`checkProtocolCompatibility`).
- **For COR-1:** build the router from `ClientMethods[m].params/result`, answer a major mismatch with `RpcErrorCode.ProtocolMismatch` plus `checkProtocolCompatibility(...).message`, and type `requestSecret` from `ServerMethods['secrets.get']`.
- **For UI-3:** use `parseTaskEvent`. It returns `known | unknown | invalid`, so ignore `unknown` with a debug log.
- **For JEV-1:** register `WorkflowSelectState` / `RiskGateState` / `CostRouteState` as the v1 pack schemas instead of redefining them. The caps (`MAX_FILES_TOUCHED`, `MAX_COMMAND_CHARS`) are exported.
- **For MOD-1:** `ModelConfig`, `ModelCapabilities`, `ModelInfo`, and `ModelErrorKind` are already defined here because they cross `config.update` / `models.*`. Build on them.

**Evidence:**
- AC1: `schemas.test.ts` enumerates every exported schema plus every method's params/result, and fails if any lacks a valid **and** an invalid fixture (and flags orphan fixtures).
- AC2: every type is `z.infer`/`z.input`, with no hand-written interfaces except the `ParsedTaskEvent` / `ProtocolCompatibility` helper return types, which aren't wire schemas.
- AC3: `jev.test.ts`, three example states, one per pack.
- AC4: `docs/protocol.md`, and `docs.test.ts` fails if a method, notification, event type, or error code is missing from it.

**Deviations:**
- *The three example Jev states were reconstructed.* The "original brief" isn't in the repo. I made one state per pack (`workflow_select` bug fix, `risk_gate` = `npm run migrate` + sensitive billing files on `main`, `cost_route` small refactor), plus two extra risk_gate goldens for JEV-2: `git status` (read-only) and `git push --force origin main` (deny-listed). **Confirmed by the user on 2026-09-29.**
- *Added `edits.report` (ext → orch).* COR-2 waits for per-file applied/rejected/stale results and UI-4 must send them, but the brief's method list had no way to do that.
- *Added `jev.preview {pack}`.* UI-6's "Preview payload" needs the orchestrator to build a live sample state.
- *`Task.context` is `{refs: ContextRef[], openEditors[], tests[]}`* instead of the skill's `{files, selections, diffs, tests}`. ContextRef already expresses files, selections, and diffs as one typed list.
- *Tool names follow COR-3* (`read_file`, `list_files`, …), not the skill's short names (`read`, `search`, …).
- *Blocked calls don't emit `approval_required`.* They finish as `tool_call_finished` with `error.kind = blocked` + `reasons`, and `approval_required.outcome` is always `confirm`.
- *`DecisionRecord.state` is an open record* (not `JevPackState`), so logs from other pack versions still parse. It also carries an optional `workflow` for routing decisions, which have no auto/confirm/block outcome.
- *Default `allowedTools`* are the read-only tools + `propose_edit`. `shell`/`run_tests`/`lint` must be requested explicitly, which is conservative per ADR-006.
- *`WorkspacePath` rejects absolute paths and `..` at the boundary.* This is defense in depth. COR-3 still does realpath confinement.

**Known gaps:** coverage isn't measured (there's no coverage provider yet; see the FND-1 follow-up). The tests exercise every schema.

**Follow-ups:**
- REL-3 owns the README. A pre-alpha README with an About section was added on this branch at the user's request, and REL-3 should extend it (quickstart, GIF, privacy statement) rather than replace it.
