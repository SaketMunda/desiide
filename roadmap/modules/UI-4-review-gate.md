# UI-4 · Review & approval (diffs, commands)

**Status:** review · **Milestone:** Alpha · **Size:** L · **Depends on:** UI-3, COR-2 · **Skills:** ide-editor-shell, ide-jev-decisions

## Purpose
Where the user says yes or no. Edits are reviewed in VS Code's native diff and applied safely (ADR-004). Gated commands are approved with full context. Blocked actions are explained.

## Scope
**Edit proposals**
- `desiide-proposed:` virtual document provider. "Review" opens the native diff editor (current file ↔ proposed) per file.
- Review card in the transcript: file list with +/− counts and a per-file accept/reject, plus **Accept all** / **Reject all**, and the critique attached if present (COR-5 Beta).
- Apply via a single `WorkspaceEdit` (one undo step), working on dirty buffers too. Re-validate search blocks at apply time. If a block is missing → mark the file **stale**, report it to COR-2, and let the agent regenerate.
- Report per-file results back to the orchestrator (applied / rejected / stale).
- Sensitive files are visually flagged (from `FileMeta.sensitive`).

**Command approvals**
- Approval card: command (monospace, full), cwd, policy outcome badge, **reason labels** (human text from JEV-2), a Jev probability summary, and a link to the full decision (UI-5).
- Actions: **Run once**, **Allow for this task** (exact match only), **Reject** (optional reason sent to the model).
- **Blocked** actions render as non-actionable cards with their reasons. No override in Alpha.
- Pending approvals: a badge on the Desiide view + a status bar highlight. Optional native notification when the panel isn't visible.
- Keyboard: `Cmd/Ctrl+Enter` approves the focused card, `Esc`/`Backspace` rejects.

## Acceptance criteria
1. A multi-file proposal: accept 2 of 3 files → exactly those applied, one undo reverts both, and the orchestrator is notified correctly.
2. The file edited by the user after the proposal → stale path works end to end with COR-2.
3. Approve once / allow for task / reject paths each work with COR-2 (integration test with the fake model).
4. A blocked command offers no approve control (test the view model, not just the CSS).
5. Works with dirty (unsaved) buffers.

## Handoff notes
**Built (branch `mod/UI-4-review-gate`):** all in `extensions/desiide-ai`. No protocol or other-module API changes.

- **Pure core** (`shared/review/`): `blocks.ts` re-validates search/replace blocks against the *current* text with COR-3's rules (in order, exactly one match, empty search = insert/create), plus `minimalReplace` (common prefix/suffix, so cursors and markers outside the change stay put) and `editStats` (+/− per file). `model.ts` holds `ProposalReview`, `FileDecision`, and `ApprovalAnswer`.
- **Host** (`src/review/`):
  - `ReviewService` (no `vscode`) follows the event stream for proposals and approvals. `submit()` re-reads accepted files, marks non-matching ones `stale`, applies the rest as **one** edit, and sends one `edits.report` covering every file. `answer()` maps once/task/reject to `task.approve`/`task.reject` and ignores double clicks. `pending()` drives the "needs you" signals. `reasons()` maps labels to text via JEV-2's `describeReason`.
  - `vscodeReviewWorkspace` reads through text documents, so an open (dirty) buffer is what gets validated and edited. It checks `before` synchronously right before one `workspace.applyEdit`; a conflict is re-read once, then called stale.
  - `ReviewController` registers the `desiide-proposed:` content provider (the right side follows the file live as you type) and opens the native `vscode.diff` (current ↔ proposed; a new file diffs against empty). It handles the card messages, sets the view badge (`DesiideViewProvider.setBadge`), highlights the status bar (`formatStatus` → `highlight`, warning background, `$(bell-dot) N`), and shows a notification when the panel is hidden (setting `desiide.review.notify`, default on).
  - `orchestratorReviewRpc(client)`.
- **Bridge (additive):** webview → host `review.openDiff`, `review.submit`, `approval.answer`, `decision.open`. Host → webview `review.state` (every proposal's state plus reason texts) and `decisions.focus` (to the Decisions view).
- **Webview** (`webview/review/`):
  - `view.ts` holds the card view models (`approvalCardView`, `blockedCardView`, `proposalCardView`, `cardKey`).
  - `cards.tsx` has three cards:
    - `ApprovalCard`: the full command, cwd, a `policy: confirm` badge, reason text, the gate's `DecisionChip` (which links to the decision), **Run once** (nudges) / **Allow for this task** / **Reject** with an optional reason.
    - `EditReviewCard`: per-file checkboxes, +/−, a **sensitive** badge, a path link that opens the diff, the critique when present, **Accept all / Apply N of M / Reject all**, an optional reason for rejected files, and per-file results afterwards.
    - `BlockedCard`: reasons only, no controls.
  - `register.ts` installs the cards into UI-3's `ITEM_RENDERERS` (approval, edit_proposal, and tool, where a blocked call becomes a `BlockedCard`). `TaskViewContext` lets an approval find its decision records.
  - Keyboard: on a focused card, `Cmd/Ctrl+Enter` approves (Run once / apply the selection) and `Esc`/`Backspace` rejects (a card-level reject sends no reason). Keys pressed inside the reason field belong to the field.

**Public API:** `DesiideApi.review.service` (`ReviewService`: `pending()`, `state()`, `submit()`, `answer()`, `proposedText()`). Messages are in `shared/messages.ts`.

**Evidence**
1. **AC1**:
   - `src/review/service.test.ts` › "AC1: accept 2 of 3…" (exactly one `apply` with 2 files; per-file report).
   - `review.process.test.ts` › "AC1" with the real bundled orchestrator: the files on disk, and the model told `a: applied / b: user rejected: leave b / c: applied`.
   - `test:integration` (real VS Code 1.148, real task with a scripted model): exactly `a.ts` and `c.ts` change, and **one `undo` in a.ts reverts both** (`reviewUndo` asserted).
2. **AC2**: `review.process.test.ts` › "AC2". The user rewrites the line after the proposal → `stale` → COR-2 tells the model `src/a.ts: stale…` → it re-reads the file and re-proposes → the second proposal is applied → task `done`. Unit tests also cover a change between read and apply (re-validated, not overwritten).
3. **AC3**: `review.process.test.ts` › "AC3", using real `rm -f` shell calls through the JEV-2 gate:
   - allow-for-task → the identical second call runs without asking
   - run once → runs
   - reject with a reason → the model receives `User rejected this shell call: keep that one` and the file survives
   - asked exactly 3 times; task `done`
4. **AC4**:
   - `webview/review/review.test.tsx` › "AC4": the view model has `actions: []`, and the rendered blocked card contains no `<button>`.
   - `test/webview/review.mjs` asserts the blocked card has no button or input in the real bundle.
5. **AC5**: `service.test.ts` › "AC5" (the dirty buffer is validated and kept), plus `test:integration`: `a.ts` is open with an unsaved line, the edit applies on top of it, the unsaved line is kept, and the buffer is left unsaved.
- Also:
  - `test/webview/review.mjs` (part of `test:webview`):
    - Tab reaches both cards; Cmd+Enter runs once (sent once despite a double press).
    - The reason field keeps Backspace/Esc.
    - Esc rejects all files; Backspace rejects the approval.
    - Unchecking a file → "Apply 2 of 3" → the exact `review.submit`; the path link → `review.openDiff`; the decision chip → `decision.open`.
    - No CSP violations or page errors in Midnight, Daylight, HC.
    - Screenshots: `.screenshots/review-*.png`.
  - `scripts/verify.sh` green; activation 2.8 ms.

**Deviations**
- **Applied files that were clean are saved.** COR-2 runs tests/lint against disk, so an unsaved apply would verify the old code. A buffer that already had unsaved user edits is *not* saved (saving it would write the user's unfinished work too). The agent's checks won't see that file until the user saves it.
- **Stale is per file.** Accepted files that still match are applied, and only the changed ones are reported `stale`. It isn't all-or-nothing.
- **Reason text is translated on the host** (`review.state.reasons`): `@desiide/jev`'s index pulls Node-only modules, so the webview can't import `describeReason`. Unknown labels render generically.
- **The decision link** focuses the Decisions view and posts `decisions.focus {decisionId}`. UI-5 must handle that message; until then the link only focuses the view.
- **Reject from the keyboard sends no reason.** The Reject button opens the optional reason field.
- **`propose_edit` waits as `awaiting_review`.** A new `ToolStatus` in UI-3's reducer: set on `edit_proposed`, back to `running` when the task resumes. The tool card says "awaiting your review".
- **The gate decision shows once.** When an approval card shows a check's decision chip (with the landing pulse), the standalone decision row for that check is hidden (`makeDecisionRenderer`, `shownByApproval`). Decision rows with no approval (auto reads, routing) are unchanged.
- **Sensitive flag end to end:** COR-4's `describeFiles` is wired on master. `review.process.test.ts` › "UI-4 × COR-4" checks that `.env` arrives with `sensitive: true` and `src/a.ts` with `false`.
- `ITEM_RENDERERS.tool` is wrapped (`makeToolRenderer`), so blocked calls render as a `BlockedCard` instead of a failed tool card. UI-7's `states.mjs` now expects the blocked card.

**Known gaps**
- **Multi-root:** paths resolve against the first folder, as the orchestrator does (COR-6).
- No pass with a real screen reader. `test:webview` isn't in CI (needs Chromium, same as UI-2/3/7).

**Follow-ups**
- **UI-5:** handle `decisions.focus` in the Decisions view.
- **Planning:** confirm the save-after-apply rule (clean files saved, dirty ones left) as an ADR-004 addendum.
- **REL-2:** add the end-to-end review path in the built app (`test:app`).
