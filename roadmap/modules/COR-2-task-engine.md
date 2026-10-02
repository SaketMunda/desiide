# COR-2 · Task engine & agent loop

**Status:** review · **Milestone:** Alpha · **Size:** L · **Depends on:** FND-2, COR-1, MOD-1 (interface + FakeModelAdapter) · **Skills:** ide-orchestration-core

## Purpose
The heart of the product: take a `Task` and run model turns → tool calls → gate → approvals → verification until done, within hard budgets.

## Scope
- `TaskManager`: create/list/cancel, and the state machine `queued → planning → running ⇄ awaiting_approval → verifying → done | failed | cancelled`. Concurrency limit (default 2 running, the rest queued).
- `AgentLoop` (the core used by every workflow): builds the model request from context + history, streams text as `text_delta` events, validates tool calls, asks the **Gate**, executes via **ToolRunner**, and feeds results back.
- `Gate` interface: `evaluate(toolCall, task) → {outcome, reasons, decisionId?}`. Ships `ConfirmAllGate` (default until JEV-2 lands, then replaced by DI).
- Approvals: `approval_required` event → pause → `task.approve/reject`. `scope: task` remembers an exact-match approval for the rest of the task. Rejects go back to the model as a tool result ("user rejected: <reason>").
- Edit proposals: `propose_edit` results become `edit_proposed` events. The loop waits for the extension to report applied/rejected/stale per file.
- Verification: run `success` checks (tests/lint via ToolRunner). On failure, feed a summary back and iterate.
- Budgets: `maxIterations`, `maxToolCalls`, `maxTokens` (from `usage`), wall clock, and the same tool+args 3× in a row → fail with reason `loop_detected`.
- Cancellation: an AbortSignal through everything.
- Registers RPC handlers: `task.create/cancel/list/approve/reject`.

## Out of scope
Workflow selection and multi-model patterns (COR-5); real policy (JEV-2); context gathering (COR-4, which is injected via an interface with a trivial default).

## Acceptance criteria (tests with FakeModelAdapter + fake ToolRunner)
1. Happy path: model proposes an edit → approval → applied → tests pass → `done`.
2. Test failure → iterate → pass on second attempt.
3. Each budget limit triggers `failed` with the right reason label.
4. Loop detection fires on 3 identical calls.
5. Cancel during a running shell tool kills it and ends `cancelled` within 1 s.
6. Rejected command → the model receives the rejection and the loop continues.
7. Malformed tool args → error fed to the model, not a crash.
8. Two concurrent tasks don't share state, and a third is queued.

## Handoff notes
**Built (branch `mod/COR-2-task-engine`):** `packages/orchestrator/src/tasks/`, exported from `@desiide/orchestrator`. It's wired into `host/main.ts`, so the app's orchestrator now answers `task.create/cancel/list/approve/reject` and `edits.report`.

**Entry points**
- `registerTaskEngine(host, {models, gate?, context?, logger?, maxRunning?})` builds the manager and registers the RPC handlers. It also cancels every task on shutdown.
  - **JEV-2:** pass `gate: () => policyGate`. It's read when each task starts.
  - **COR-4:** pass `context: contextEngine`.
- `Gate { evaluate(call: ToolCall, task, signal) → {outcome, reasons, decisionId?} }`. `confirmAllGate` is the default.
- `ContextProvider { gather(task, signal) → {text}; describeFiles(paths, signal) → FileMeta[] }`. `pathOnlyContext` is the default: it lists the attached refs by path and reads nothing.
- `createTaskManager(options)` holds the state machine, the FIFO queue (default 2 running), approvals, and edit reports. Options: `emit`, `resolveModel`, `prepareTools`, `gate()`, `context`, `costPerMTok?`, `maxRetained` (default 100 finished tasks).
- `runAgentLoop({task, model, gate, context, runTool, io, signal, newId, costPerMTok?})` is the core loop that **COR-5's workflows** reuse. It resolves when the task is done. It throws `TaskFailure(reason)` for a failed task, or the signal's reason once aborted.
- `prepareTaskTools(task, env)` builds COR-3's `ToolContext` per task and checks the preconditions up front (`no_workspace`, `ripgrep_missing`, `no_check_command`).
- `roleForTask(task)`: `quality` → `strong`, otherwise `cheap`. This stays a placeholder until COR-5.
- The lifecycle and every `failureReason` are documented in `docs/protocol.md` → "Task lifecycle (COR-2)".

**Evidence** (`pnpm -F @desiide/orchestrator test`, 52 new tests in `src/tasks/`, stable over 5 repeated runs)
1. AC1: `taskManager.test.ts` › "edit proposed → applied → tests approved and passing → done". It checks the full state sequence, the context in the first message, the apply result sent to the model, usage totals, and that every event is wire-valid with contiguous `seq`.
   - `engine.test.ts` › "runs a task end to end" does the same over JSON-RPC with the **real** COR-3 tools (`read_file` approval → `propose_edit` → `edits.report`). It also checks that the file on disk is unchanged (ADR-004).
2. AC2: "a failing test run goes back to the model; the second attempt passes" (`iteration: 2`, and the failure output reaches the model). Also: lint plus tests reported together; a rejected or blocked check ends the task instead of looping.
3. AC3: `AC3 budgets` has one test per limit: `budget:maxIterations`, `budget:maxToolCalls` (the 3rd call never runs), `budget:maxTokens` (the over-budget turn's tools never run), and `budget:wallClockMs` (a hanging model). Plus "time waiting on the user does not count against wallClockMs". Units are in `budget.test.ts`, including the pausable clock under fake timers.
4. AC4: "fails on the third identical call in a row, ignoring key order" (only 2 calls run). Also: no false positive when another call breaks the run, and repeated malformed calls count too.
5. AC5: `engine.test.ts` › "AC5: cancel during a running shell command…". A real `shell` call (`exec sleep 30`) is approved and running when `task.cancel` arrives over RPC. The task reaches `cancelled` in < 1 s, and the test asserts that the shell's pid is dead.
6. AC6: "a rejected command reaches the model with the reason, and the loop continues": the model gets `User rejected this shell call: no new dependencies` (`isError`), and the task ends `done`. Also covered: allow-for-task covers exact repeats only, a task-scoped approval never overrides a later block, a block never runs and never asks, and a throwing gate falls back to confirm.
7. AC7: "feeds each problem back to the model instead of crashing" covers invalid JSON, schema-invalid args, non-object args, an unknown tool, and a tool outside `allowedTools`. Each one is an `isError` tool message, and the task ends `done`.
8. AC8: "two tasks run with separate state, and a third waits in the queue": the third task stays `queued` and its model isn't even resolved until a slot frees. Approvals can't cross tasks, and no history leaks between them. Also covered: cancelling a queued task never starts it, and retention pruning.
- Also: RPC error codes (`TaskNotFound`, `ApprovalNotFound`, `InvalidParams`), shutdown cancels running tasks, model errors (retryable flag), a missing role (hint shown), internal errors (details only in the log), and cost estimates.
- **Bundle smoke test:** `dist/orchestrator.js` over real stdio: `initialize` → `task.create` with no models gives events `queued → planning → error("No model is assigned to the "cheap" role Set desiide.roles.cheap in settings.") → failed(model_unavailable)`.
- `scripts/verify.sh` is green (916 tests).

**Deviations**
- **An "iteration" is one verify→fix attempt, not one model turn.** The default `maxIterations: 8` would stop ordinary agent work (read, search, read, edit…) after 8 turns. Model turns are still bounded: every turn either calls a tool (counted against `maxToolCalls`) or ends the attempt.
- **The wall clock only runs while the task works.** Time in `awaiting_approval` (approvals and edit review) is excluded, because the budget guards against runaway work, not a user who stepped away.
- **`propose_edit` never raises `approval_required`.** The diff review (`edit_proposed` → `edits.report`) is its approval. Asking first would prompt twice for the same change. The gate is still consulted for it, and a `block` refuses it.
- **`confirmAllGate` confirms everything, reads included.** Deciding which files are sensitive belongs to policy (COR-3 noted that `.env` is readable). Until JEV-2 lands, a task in the app therefore asks before every read. `scope: task` takes care of repeated identical calls.
- **Success checks go through the gate too.** They are `external` commands, so the orchestrator never runs one unasked. If the user rejects a check or policy blocks it, the task ends (`verification_rejected` / `verification_blocked`) instead of looping on it.
- **Missing preconditions fail the task in `planning`** (`no_check_command`, `ripgrep_missing`, `no_workspace`) before any model call. Otherwise every attempt would fail the same way.
- **Loop detection runs on the parsed args with keys sorted**, so `{"a":1,"b":2}` and `{"b":2,"a":1}` count as the same call. Repeated unparsable args are compared as raw text.
- **A disallowed tool returns `blocked` with the reason `tool_not_allowed`** and no `tool_call_started`. A throwing gate returns `confirm` with `gate_error`. Both labels are new, and the UI renders unknown labels generically.
- **A failed task emits an `error` event** (kind = the model's error kind, or else the failure reason) before `state_changed → failed`. That way UI-3 has the human message, not just the label.

**Known gaps**
- `edit_proposed.files` (FileMeta) is empty until COR-4 provides `describeFiles`, so UI-4 has no `sensitive` flag yet.
- No `decision_made` events. JEV-2/JEV-4 emit them through their gate.
- Coverage isn't measured (no coverage provider; FND-1 follow-up). Every file in `src/tasks/` has direct tests.
- The workflow (`TaskSummary.workflow`) only echoes `workflowOverride`. Selection is COR-5.
- The model sees the full history every turn, with no truncation or compaction. Long tasks are bounded by `maxTokens`.

**Follow-ups**
- **Extension (needs an owner):** set `DESIIDE_RG_PATH` when forking the orchestrator (COR-3 follow-up). Without it, every task in the bundled app that allows `list_files`/`search` (the default) fails in `planning` with `ripgrep_missing` and an actionable message. This changes `OrchestratorClient`/`forkOrchestrator` (COR-1's API), so it wasn't done here.
- **JEV-2:** `registerTaskEngine(host, {gate: () => policyGate})` in `main.ts`. Truncate the shell command (`MAX_COMMAND_CHARS`) before building `RiskGateState`.
- **COR-4:** implement `ContextProvider`, including `describeFiles` for `FileMeta.sensitive`.
- **COR-5:** reuse `runAgentLoop` per model. Cascade can catch `TaskFailure` from the cheap model's run and retry with the strong one, carrying over the draft.
- **UI-3/UI-4:** an `awaiting_approval` state with an `edit_proposed` (no `approval_required`) means "review the diff".
