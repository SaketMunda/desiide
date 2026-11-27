# COR-5 · Workflows (single / cascade / critique)

**Status:** review (Alpha: single + cascade; critique is Beta, not started) · **Milestone:** Alpha (single + cascade), Beta (critique) · **Size:** M · **Depends on:** COR-2, JEV-2 · **Skills:** ide-orchestration-core, ide-jev-decisions

## Purpose
Multi-model patterns layered on the AgentLoop, chosen per task by the Jev `workflow_select` decision. This is the cost-saving story.

## Scope
- `Workflow` interface: `run(task, deps, signal) → TaskResult`.
- Role resolution: Jev options map to **roles**, not model IDs (ADR-007). `local-single` → `cheap`. `cloud-single` → `strong`. `local-cloud-cascade` → `cheap` then `strong`. `cloud-with-critique` → `strong` + `reviewer` (reviewer defaults to `strong`). If a role isn't configured, the option is removed before Jev is asked.
- **single**: one AgentLoop.
- **cascade**: run on `cheap`. Escalate to `strong` (once) when verification fails, the edit fails to parse/apply, or `escalation_need ≥ 3`. Carry over the draft + failure summary. Emit an `escalated` reason label.
- **critique** (Beta): the `strong` draft → `reviewer` returns zod-validated `{verdict: approve|revise|reject, issues[{file, line?, severity, note}]}`. One revise round max. The critique is attached to the `EditProposal` for UI-4.
- At task start: call the JEV-2 workflow policy, honor the user's `workflowOverride`, and log the decision.
- Usage + estimated cost per model per task (from `costPerMTok`) in the `usage` event. UI-5's savings meter reads this.

## Acceptance criteria
1. Cascade: the fake cheap model fails tests → escalation to strong → success. The decision log shows both.
2. Cascade with cheap success never calls strong.
3. Missing `cheap` role → only cloud options are offered to Jev.
4. `workflowOverride` bypasses selection but still logs a decision with reason `user_override`.
5. (Beta) Critique `revise` → exactly one revision. `reject` → the proposal is shown with the critique and not auto-applied.

## Handoff notes
**Built (branch `mod/COR-5-workflows`), Alpha scope: single + cascade.** Wired into the app's orchestrator (`host/main.ts`). Critique (AC5) is Beta and not built; see Known gaps.

**Entry points** (`packages/orchestrator/src/workflows/`, exported from `@desiide/orchestrator`)
- `createWorkflowEngine(deps)` → `{ assertRunnable(), run(workflowRun) }`. Deps: `roles()`, `engine()` (the policy's engine selector: rules, or Jev after JEV-3), `onDecision` (JEV-4 log + task stream), `describeFiles` (COR-4), `availableModels`, `redactor?`, `newId`.
- `roles.ts`: `resolveRoles(forRole)`, `planFor(option, roles)`, `runnableOptions(roles)`, `SUPPORTED_WORKFLOWS`. Options map to roles (ADR-007): `local-single` → cheap, `cloud-single` → strong, `local-cloud-cascade` → cheap then strong (needs two different models).
- **Task manager:** new optional `workflows` option (`registerTaskEngine(host, {workflows})`). It hands the workflow a `runLoop(model, extras)` bound to the task's IO, gate, and tools, plus `lastRunStatus` / `recentFailures` from retained tasks. Without it, COR-2's single-model path is unchanged.
- **Agent loop (additive options):**
  - `history` (continue a conversation)
  - `handoff` (a user message; joins a trailing user message so two user turns never sit in a row)
  - `budget` (shared tracker)
  - `escalateOn(trigger)` → throws `EscalationRequested`, only at the end of a turn with every tool call answered
  - Triggers: `verification_failed`, and `edit_failed` (a `propose_edit` that doesn't parse, or whose blocks don't validate). Stale or user-rejected edits are not model failures.

**How a task runs**
1. `assertRunnable()` runs before tool setup. With no role, the task fails `model_unavailable` with the "set desiide.roles.cheap / strong" hint.
2. The workflow_select and cost_route states are built from the task's attached files (COR-4 metadata, redacted when on) and the role models. Then JEV-2's `decideWorkflow` runs, offered **only the role-runnable options**. It logs workflow / complexity / cheap_success.
3. **single:** one loop.
   **cascade:**
   - Ask `escalation_need` (logged). At ≥ 3, go straight to strong.
   - Otherwise run cheap with `escalateOn`. On a trigger, log an `escalate` decision (`escalated`, `escalated:<kind>`), then run strong **once** on the same conversation and budget, with a handoff note.
   - The strong model has no escalation hook.
4. `TaskSummary.workflow` is the chosen workflow, and `models` lists every model used. `usage` events carry `modelId` and `costUsd` per turn (from each model's `costPerMTok`), which is what UI-5's savings meter reads.

**Evidence**
1. **AC1:**
   - `workflows.test.ts` › "cheap draft fails tests → strong continues…": models `[cheap, strong]`; the strong model's first request holds the instruction, both cheap turns, the test failure, and the handoff, with no two consecutive user messages.
   - The decision log is `workflow, complexity, cheap_success, escalation_need, escalate(escalated:verification_failed)`. Per-model `costUsd` is checked.
   - `workflows.rpc.test.ts` › AC1 does the same over JSON-RPC with the real rules engine, context engine, COR-3 tools, and a **real test command** (`node check.mjs`). The cheap edit makes the test fail, and the strong model sees the real output `expected 3, got 2` and fixes it.
   - Also: an unparsable edit escalates; escalation happens at most once (the strong model iterates on its own failures); `escalation_need ≥ 3` skips the cheap model.
2. **AC2:** `workflows.test.ts` and `workflows.rpc.test.ts` › AC2: the cheap model passes, the strong model has 0 calls, and nothing is escalated.
3. **AC3:** `workflows.test.ts` › "missing cheap role → only cloud options are offered to Jev" (the engine's choice request has `options: ['cloud-single']`), plus the role→option table and "no role at all" (fails before any model call).
4. **AC4:**
   - `workflows.test.ts` › AC4: the override asks no engine question and logs one `workflow` decision with `user_override`.
   - JEV-2's `workflow.test.ts` › "COR-5 AC4" covers the same, plus "explicit options (from roles) replace the locality inference".
5. **AC5 (Beta):** not built.
- `scripts/verify.sh` green (2118 tests).

**Deviations**
- **Options follow roles, not locality.** JEV-2 inferred options from `availableModels[].locality` (local → `local-*`). ADR-007 and this brief map options to roles, so an all-cloud setup (e.g. Haiku cheap, Sonnet strong) can cascade. `decideWorkflow` gained an optional `options` input (additive to JEV-2's API); without it, behaviour is unchanged.
- **Override logging lives in `decideWorkflow`** (additive): an available `workflowOverride` now logs one `workflow` record (engine `rules`, reasons `user_override`, `policy_override:user_choice`). Before, it returned without a record.
- **New reason labels** (additive): `user_override`, `escalated`, `escalated:<verification_failed|edit_failed|escalation_need>`, in protocol `KNOWN_REASON_LABELS` and JEV-2's `describeReason`.
- **Escalation is a logged pseudo-decision** (question `escalate`, engine `rules`, noul yes), like JEV-2's `policy` records, so every escalation appears in the decision log and the task stream.
- **`escalation_need` is asked once, before the cheap run.** Its state is task metadata that doesn't change during the run, so asking again would give the same answer.
- **The strong model continues the cheap model's conversation** (shared history + budget) rather than starting fresh with a summary. That's the fullest "draft + failure" carry-over. Provider state from the cheap model is dropped per ADR-022 (`historyFor`).
- **`estimatedDiffSize`** is a rough guess from the attached files' sizes (capped at 500). Nothing better is known before the model runs.
- **`WorkspacePolicy` exposes `engine` and `onDecision`** (additive), so routing uses the same engine and sink as gating.

**Known gaps**
- **Critique (Beta, AC5) not built.** `cloud-with-critique` is never offered (`SUPPORTED_WORKFLOWS`), so the quality floor lands on `cloud-single`. Note that the brief's issue shape `{file, line?, severity, note}` differs from protocol `Critique.issues: string[]`; the Beta session will need an additive field (e.g. `findings`).
- The cascade escalates only on this brief's triggers. A cheap-model `TaskFailure` (model error, loop detection, budget) still fails the task.
- `availableModels[].latencyMs` stays 0 (unmeasured), as in JEV-2's preview.

**Follow-ups**
- **Beta session:** critique workflow (reviewer role, zod-validated verdict, one revise round, critique on `EditProposal`), then add `cloud-with-critique` to `SUPPORTED_WORKFLOWS`.
- **Planning:** decide whether a cheap-model model error or loop detection should escalate in a cascade (cheap local models going down is common).
- **UI-5:** the savings meter can sum `usage.costUsd` per `modelId`. Escalations arrive as `decision_made` with question `escalate`.
- **UI-2:** the critique option can stay hidden until the Beta session.
