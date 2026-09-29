# UI-4 · Review & approval (diffs, commands)

**Status:** todo · **Milestone:** Alpha · **Size:** L · **Depends on:** UI-3, COR-2 · **Skills:** ide-editor-shell, ide-jev-decisions

## Purpose
Where the user says yes or no. Edits are reviewed in VS Code's native diff and applied safely (ADR-004). Gated commands are approved with full context. Blocked actions are explained.

## Scope
**Edit proposals**
- `mutt-proposed:` virtual document provider. "Review" opens the native diff editor (current file ↔ proposed) per file.
- Review card in the transcript: file list with +/− counts and a per-file accept/reject, plus **Accept all** / **Reject all**, and the critique attached if present (COR-5 Beta).
- Apply via a single `WorkspaceEdit` (one undo step), working on dirty buffers too. Re-validate search blocks at apply time. If a block is missing → mark the file **stale**, report it to COR-2, and let the agent regenerate.
- Report per-file results back to the orchestrator (applied / rejected / stale).
- Sensitive files are visually flagged (from `FileMeta.sensitive`).

**Command approvals**
- Approval card: command (monospace, full), cwd, policy outcome badge, **reason labels** (human text from JEV-2), a Jev probability summary, and a link to the full decision (UI-5).
- Actions: **Run once**, **Allow for this task** (exact match only), **Reject** (optional reason sent to the model).
- **Blocked** actions render as non-actionable cards with their reasons. No override in Alpha.
- Pending approvals: a badge on the Mutt view + a status bar highlight. Optional native notification when the panel isn't visible.
- Keyboard: `Cmd/Ctrl+Enter` approves the focused card, `Esc`/`Backspace` rejects.

## Acceptance criteria
1. A multi-file proposal: accept 2 of 3 files → exactly those applied, one undo reverts both, and the orchestrator is notified correctly.
2. The file edited by the user after the proposal → stale path works end to end with COR-2.
3. Approve once / allow for task / reject paths each work with COR-2 (integration test with the fake model).
4. A blocked command offers no approve control (test the view model, not just the CSS).
5. Works with dirty (unsaved) buffers.

## Handoff notes
_(filled by the build session)_
