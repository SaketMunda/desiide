# COR-2 · Task engine & agent loop

**Status:** in-progress · **Milestone:** Alpha · **Size:** L · **Depends on:** FND-2, COR-1, MOD-1 (interface + FakeModelAdapter) · **Skills:** ide-orchestration-core

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
_(filled by the build session)_
