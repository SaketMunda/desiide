# UI-2 · Prompt Box

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, FND-2 (COR-1 for live submit; mock until then) · **Skills:** ide-editor-shell

## Purpose
The composer at the bottom of the Desiide panel where every task starts. It should feel as fast and precise as Cursor's composer, while showing the user what context and routing will be used *before* they send.

## Scope
**Input**
- Auto-growing multiline textarea (max ~12 lines, then scroll). `Enter` sends, `Shift+Enter` adds a newline, `Esc` blurs. IME-safe (no send while composing).
- **@-mentions** with a popup, keyboard-navigable and fuzzy-matched:
  - `@file` (workspace file search via the extension, using `workspace.findFiles` with a debounce and 50 results), `@folder`, `@selection` (current editor selection), `@diff` (working-tree changes).
  - Selected mentions render as removable **chips** above the input showing the file name + line range. The chip tooltip shows the full path.
- Paste of a file path or code from the editor: the "Desiide: Add selection to prompt" command (editor context menu + keybinding) inserts an `@selection` chip.
- Prompt history per workspace (`↑`/`↓` when the cursor is at the start/end). The draft persists across panel reloads.

**Routing controls (compact row under the input)**
- Workflow selector: **Auto (Jev)** (default) · Local · Cloud · Cascade · Critique (hidden until COR-5 Beta). Options with unconfigured roles are disabled with a tooltip explaining why.
- Cost preference: `cheap · balance · quality` segmented control (default from settings).
- Token estimate of the attached context (chars/4), turning to a warning color over the smallest configured model's context window.

**Sending**
- Builds `task.create` params (instruction, `ContextRef[]`, open editors, preference, `workflowOverride?`) and validates them with protocol zod before sending.
- While a task runs: the Send button becomes **Stop** (`task.cancel`). New prompts can still be queued (they go to TaskManager's queue).
- Empty state: 3 example prompts that fill the box. If no model is configured → a CTA to open onboarding (UI-6) instead of sending.

**Keybindings**
- Focus Prompt Box and add selection: pick defaults that don't conflict with VS Code defaults (check with the Keyboard Shortcuts editor and note them in handoff). The IDE build (EDT-2) may later claim `Cmd/Ctrl+L`.

## Out of scope
Rendering the conversation (UI-3), slash commands (1.0), image attachments (1.0).

## Mock strategy
Until COR-1 is `done`, a `MockOrchestratorClient` echoes the validated `task.create` payload into the panel.

## Acceptance criteria
1. Keyboard-only flow: focus → type → `@` → pick a file → Enter sends, with no mouse.
2. The sent payload matches the protocol schema (unit test on the payload builder) and includes chips in order.
3. `@file` search returns in < 150 ms on a 10k-file workspace (debounced, cancelable).
4. The draft survives a view reload. History navigation works.
5. The Stop button cancels a running task (with COR-1/COR-2, or the mock).
6. No model configured → the onboarding CTA shows instead of a failing send.
7. Screen reader: the input has a label, the mention popup is an ARIA listbox, and chips are removable via keyboard.

## Handoff notes
**Built (branch `mod/UI-2-prompt-box`):**
- **Bridge contract** (`shared/messages.ts`, additive): `PromptChip {ref: ContextRef, label, detail, chars?}`, `WorkflowChoice = 'auto' | WorkflowOption`, `PromptConfig`, `MentionItem`.
  - Webview → host: `prompt.draft`, `prompt.submit`, `prompt.cancel`, `mention.search {requestId, query}`, `mention.pick`.
  - Host → webview: `prompt.restore`, `prompt.config`, `prompt.focus`, `prompt.addChip`, `prompt.fill`, `prompt.sent`, `prompt.error`, `prompt.tasks`, `mention.results`.
  - New allow-listed webview command: `desiide.setup`.
- **Host** (`src/prompt/`). Everything except `controller.ts` is pure and unit-tested.
  - `payload.ts`: `buildTaskCreateParams` → protocol-validated `TaskInput`. Chips become `context.refs` in order (exact duplicates dropped). Open editors go in, minus attached files. `auto` sends no `workflowOverride`.
  - `fuzzy.ts` + `fileIndex.ts`: `FileIndex` lists files once via `findFiles`, then fuzzy-ranks them in memory: 50 files plus 10 folders. It's invalidated by a file watcher created on the first `@`. Superseded searches are aborted.
  - `settings.ts`: reads `desiide.models` / `desiide.roles` / `desiide.defaultPreference` entry by entry and computes workflow availability by role (COR-5 mapping). Critique is hidden behind `CRITIQUE_AVAILABLE = false`.
  - `history.ts`: per-workspace history (50, consecutive duplicates collapse) and draft, both in `workspaceState`.
  - `taskClient.ts`: `TaskClient` with `orchestratorTaskClient` (real), `MockTaskClient`, and `FallbackTaskClient` (real first; on `NotImplemented` it switches to the mock for the session and logs it once).
  - `activeTasks.ts`: tasks started from the box. It drives Send/Queue/Stop and decides which task Stop cancels.
  - `controller.ts`: `PromptController` wires all of the above to the panel view.
- **Webview** (`webview/prompt/`):
  - `PromptBox.tsx`: the composer and the panel's empty, onboarding and mock-echo states.
  - `logic.ts`: pure helpers for mention parsing, history stepping, token estimate and chips.
  - `prompt.css`.
  - New UI kit component `Segmented` (ARIA radiogroup, roving tabindex, focusable disabled options with a reason).
- **Commands / manifest**:
  - New commands: `desiide.focusPrompt`, `desiide.addSelectionToPrompt` (also in the editor context menu when there is a selection), and `desiide.setup` (opens the `desiide.welcome` walkthrough).
  - New setting `desiide.defaultPreference`.
- **Keybindings**:
  - `Cmd+Alt+J` / `Ctrl+Alt+J` → Focus Prompt Box.
  - `Cmd+Alt+Shift+J` / `Ctrl+Alt+Shift+J` → Add Selection to Prompt (`editorTextFocus && editorHasSelection`).
  - The L variants clashed on macOS: `cmd+alt+l` is Find's toggle-in-selection, and `shift+alt+cmd+l` is Quick Chat.
- **Public API (additive):** `DesiideApi.prompt` → `fill(text)` (for UI-6's "Try it"), `focus()`, `searchFiles(query, signal)`.
- **Tools:**
  - `pnpm -F desiide-ai test:webview`: keyboard-only and ARIA run of the built bundle in headless Chromium, with a fake host.
  - `screenshots` now also renders the Prompt Box in all five themes.

**Evidence:**
1. **AC1 keyboard-only flow.** `test/webview/prompt.mjs` uses no mouse anywhere:
   - The host's `prompt.focus` puts focus in the input.
   - Typing `@pars`, ↓/↑ and Enter picks `src/parser.ts`; Enter in the popup picks and does not send.
   - `@diff` + Tab adds a second chip, Shift+Enter adds a newline, and Enter sends.
   - In real VS Code, `desiide.focusPrompt` and `desiide.addSelectionToPrompt` run in the integration suite. The keypress itself goes to the webview, so it's covered by the Chromium run.
2. **AC2 payload.**
   - `src/prompt/payload.test.ts` › "produces task.create params that pass the protocol schema, chips in order" validates against `ClientMethods['task.create'].params`. Other cases there: dedupe, open editors, `workflowOverride` only for explicit choices, and protocol-forbidden paths rejected.
   - The Chromium run asserts the submitted chips arrive in the order they were added.
3. **AC3 `@file` < 150 ms.**
   - Integration in VS Code 1.140.0 on a generated 10k-file workspace: the first search (including the one-time `findFiles` listing) took **130 ms**, and later searches took **1.3–2.4 ms**.
   - Unit test `fileIndex.test.ts` › "searches a 10k-file workspace in under 150 ms".
   - The webview debounces by 60 ms. The host aborts superseded searches ("a cancelled search rejects without breaking the shared load").
4. **AC4 draft and history.**
   - The Chromium run restores the draft (text + chip) on load and saves it, debounced, while typing.
   - ↑ at the start recalls the last prompt. ↓ mid-text moves the caret, and ↓ at the end returns to the draft.
   - `logic.test.ts` › `stepHistory` and `settings.test.ts` › history cover the rest.
   - Draft and history live in `workspaceState`, so they survive a webview reload and a window reload, per workspace.
5. **AC5 Stop.** `process.test.ts` › "Prompt Box send → Stop against the real orchestrator": send → the orchestrator answers `NotImplemented` → the mock runs the task → Stop → `cancelled`, and the active list empties. The Chromium run posts `prompt.cancel` from the keyboard and Stop disappears. `taskClient.test.ts` covers fallback and cancel routing.
6. **AC6 no model.** The Chromium run shows the "Set up a model" CTA, Enter does not post a submit, a status message appears, and the CTA runs `desiide.setup`. The host refuses to send without models as a second guard. `settings.test.ts` › "reports no models".
7. **AC7 screen reader.** The Chromium run checks:
   - The input's accessible name is "Prompt", and a hidden hint explains Enter, Shift+Enter and @.
   - The popup is `role=listbox` with `role=option`/`aria-selected`. The input has `aria-controls` and an `aria-activedescendant` that follows the arrow keys.
   - Chips are a labelled list. "Remove X" buttons work with Delete/Backspace/Enter, and focus returns to the input.
   - Workflow and cost are labelled radiogroups. Disabled options carry their reason in the tooltip and `aria-disabled`.
- **Keybinding conflicts:** the integration suite reads `vscode://defaultsettings/keybindings.json` (1,322 bindings on macOS, VS Code 1.140.0) and asserts no other command uses our keys.
- **Activation:** 0.98 ms, and 81 ms from opening the container to active. The orchestrator stays idle at activation.
- `scripts/verify.sh` green: 923 tests, +59.

**Deviations:**
- **Task `kind` is inferred by a keyword heuristic** (`taskKind.ts`). `task.create` requires a kind, the brief has no kind picker, and no other module sets it. Jev/COR-2 can re-score it. If a picker is wanted, that's a planning call.
- **Mock selection is automatic.** COR-1 is merged, but `task.create` has no handler until COR-2. Rather than a setting, `FallbackTaskClient` uses the real orchestrator and switches to the mock on `NotImplemented`. The panel shows a `mock` badge and echoes the validated payload. Once COR-2 registers the handler, the mock is never used and no change is needed here.
- **`@file` uses an in-memory index, not `findFiles` per keystroke.** `findFiles` can't fuzzy-match, and per-keystroke listing is slow on large trees. The index is capped at 20k files. It honors `files.exclude` and `search.exclude` (`true` keys), and always skips `node_modules` and `.git`. Patterns with `{…}` or `when` conditions are skipped. An empty `@` shows open editors first.
- **`desiide.focus` now also focuses the Prompt Box input.** EDT-2 asked UI-2 to repoint the app's Cmd/Ctrl+L. Doing it this way needs no `desiide-app` change in the `editor/` submodule (another repo), and Cmd+L lands in the input. The status bar item does the same.
- **Keys are Alt+J, not Alt+L** (see above). They were verified on macOS only, because the generated default-keybindings doc is per platform. `ctrl+alt+l` is also GNOME's lock-screen shortcut, which is another reason to avoid it.
- **Token estimate:** files use their on-disk size, and selections use the selected text length. Folders and diffs have no size until the orchestrator reads them, so the counter shows `~N+` with a tooltip saying so.
- **`desiide.models` / `desiide.roles` are read but not contributed as settings schema.** UI-6 owns those settings and their UI. `desiide.defaultPreference` *is* contributed, because UI-2 owns that default.
- **Workflow and cost preference are remembered per webview** (`usePersistentState`). A workflow choice whose roles were later removed falls back to Auto instead of failing.
- **`DIFF_CHIP` is always `scope: 'working'`.** There's no staged-diff mention yet.

**Known gaps:**
- **Multi-root workspaces:** refs are relative to their own root, with no root name, because the protocol's `WorkspacePath` has no root field. Files with the same relative path in two roots are ambiguous for the orchestrator.
- `test:webview` and `test:integration` aren't in `verify.sh` or CI, because they need a browser or a display (same as UI-1).
- The keypress-level shortcut and the real webview inside VS Code weren't exercised by automation. The webview logic was driven in Chromium and the commands in VS Code. A manual F5 pass is still worth doing.
- Windows/Linux default-keybinding conflicts weren't checked by tooling.

**Follow-ups:**
- **UI-6:** contribute `desiide.models` / `desiide.roles` schema. Use `DesiideApi.prompt.fill(text)` for "Try it". Retarget `desiide.setup` if onboarding moves out of the walkthrough.
- **UI-3:** the transcript goes into `.desiide-prompt-panel__main` above the composer (the mock echo card is a placeholder there). `prompt.tasks` already tracks active tasks.
- **COR-2:** register `task.create` / `task.cancel` in `main.ts` → `configure`. The Prompt Box then switches off the mock automatically. Consider using/overriding the inferred `kind`.
- **REL-1:** run `test:webview` (needs only Chromium, no display) in CI. `test:integration` under xvfb also runs the keybinding-conflict check on Linux.
- **Protocol (planning):** a workspace-root field on `ContextRef` for multi-root.
