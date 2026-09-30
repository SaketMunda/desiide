# UI-2 · Prompt Box

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, FND-2 (COR-1 for live submit; mock until then) · **Skills:** ide-editor-shell

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
_(filled by the build session)_
