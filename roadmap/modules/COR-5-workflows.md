# COR-5 · Workflows (single / cascade / critique)

**Status:** todo · **Milestone:** Alpha (single + cascade), Beta (critique) · **Size:** M · **Depends on:** COR-2, JEV-2 · **Skills:** ide-orchestration-core, ide-jev-decisions

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
_(filled by the build session)_
