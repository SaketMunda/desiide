# REL-2 · E2E & QA

**Status:** todo · **Milestone:** Alpha (extension), Beta (app) · **Size:** M · **Depends on:** UI-4, COR-2 · **Skills:** ide-editor-shell, ide-orchestration-core

## Purpose
Prove the whole product works the way a user uses it, before every release.

## Scope
- `@vscode/test-electron` suite with the extension loaded and the orchestrator using a **scripted fake model** (enabled via a test-only setting, which isn't reachable in production builds).
- Scenarios (Alpha):
  1. Bug-fix task → edit proposed → accept → file changed → tests pass → `done`.
  2. Gated command → confirm → runs.
  3. Deny-listed command → blocked, no approve control.
  4. Cascade escalation visible in the Decision panel.
  5. Cancel mid-task.
  6. Orchestrator crash → auto-restart → next task works.
- `docs/manual-qa.md`: the timed onboarding check (UI-6), theme checks, keyboard-only pass, and a live-model smoke with Ollama + Claude.
- Perf checks: activation time and orchestrator cold start against the STANDARDS budgets, reported in CI.
- (Beta) Run the same suite against the built app binary.

## Acceptance criteria
1. All Alpha scenarios are green in CI on macOS + Linux.
2. The manual QA doc has been executed once, with results recorded in the PR.
3. Perf numbers are within budget or have a filed follow-up.

## Handoff notes
_(filled by the build session)_
