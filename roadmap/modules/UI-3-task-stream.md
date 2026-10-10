# UI-3 · Task stream (transcript)

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, FND-2 · **Skills:** ide-editor-shell

## Purpose
Render a running or finished task from the `task.event` stream: what the agent is saying, doing, and costing.

## Scope
- Event reducer (pure, unit-tested): `task.event[]` → view model. Tolerates unknown event types (FND-2 rule).
- **Task header**: instruction (truncated), state pill with a subtle pulse while running, workflow + model(s) used, iteration counter, tokens and estimated cost.
- **Transcript**: user message; streaming assistant markdown (`markdown-it`, code blocks with copy / "insert at cursor", highlight via `highlight.js` core + lazy languages); **tool-call cards** (collapsed: icon, tool, one-line args summary, status, duration; expanded: args + output tail, with "open full output" going to the output channel).
- **Reasoning (ADR-022)**: `reasoning_delta` renders as a collapsed "Thinking…" block above the answer it belongs to, with elapsed time; it expands to plain text (not markdown). Before MOD-3 lands, the event is unknown and ignored.
- Placeholders for UI-4 (edit proposal / approval cards) and UI-5 (inline decision chip "routed via Jev → cascade"), rendered by kind so those modules plug in cleanly.
- **Task list**: switch between tasks in this workspace, with state badges. Cancel / retry (re-create with the same params).
- Error rendering: `ModelError` kinds map to actionable messages (auth → "Check your key in Settings", rate limit → retry-after countdown).
- Performance: virtualize transcripts over ~300 items and batch `text_delta` rendering per animation frame.

## Acceptance criteria
1. Reducer tests from recorded event sequences (happy path, escalation, failure, cancel).
2. Streaming 5,000 deltas keeps the panel responsive (no long tasks > 50 ms in a DevTools profile).
3. Unknown event types are ignored with a debug log.
4. Theme + keyboard checks per STANDARDS.

## Handoff notes
**Built (branch `mod/UI-3-task-stream`):**
- **Reducer** (`shared/transcript/`, pure, shared by host and webview):
  - `reducer.ts`: `applyEvents(state, rawEvents, log?, {replay?})`, `upsertSummary`, `removeTask`, `streamingItemId`, `isTerminal`, `taskTotals`. Raw payloads go through `parseTaskEvent`. Unknown types are ignored with a debug log, invalid payloads are dropped with a warning, and duplicate or out-of-order `seq`s are dropped. It's copy-on-write per batch, so untouched items keep their identity and memoized rows skip re-rendering.
  - `model.ts`: `TaskView {meta, items, index, lastSeq}`. Items are `user | assistant (text + reasoning) | tool | edit_proposal | approval | decision | error | status`.
  - `compact.ts`: `appendCompacted` merges consecutive deltas of the same message for the host's retained log.
- **Fixtures** (`shared/transcript/fixtures/{happy,escalation,failure,cancel}.json`) are **recorded from the real bundled orchestrator**: task engine, policy gate, and decision log, driven by the extension's own `OrchestratorClient` against a scripted OpenAI-compatible server on loopback. Re-record with `DESIIDE_RECORD=1 pnpm -F desiide-ai exec vitest run src/transcript/record.test.ts`.
- **Host** (`src/transcript/`):
  - `TaskStore` (no `vscode` import) keeps per task the summary, the `task.create` params, and a compacted event log. It batches events to the panel every 16 ms, replays a snapshot when the panel reloads, and keeps 30 tasks (it drops the oldest finished ones first, never running ones).
  - `TranscriptController` handles cancel, retry (re-create with the same params; the new task joins the Prompt Box's active list), insert at cursor (`WorkspaceEdit` via `editor.edit` on the active editor's selections), and "open full output" (a `Desiide: Tool Output` channel). When a task ends it refreshes summaries from `task.list`.
- **Bridge** (`shared/messages.ts`, additive):
  - Host → webview: `tasks.snapshot`, `tasks.events`, `tasks.summary`, `tasks.removed`, `tasks.select`.
  - Webview → host: `task.cancel`, `task.retry`, `code.insert`, `tool.openOutput`.
- **Webview** (`webview/transcript/`):
  - `store.ts` applies the queued bridge messages once per animation frame.
  - `TaskStream.tsx`: the task list (state badges), the header (state pill that pulses while live, instruction, workflow, models, iteration, tokens, ~cost, Stop / Retry), and the transcript (`role=log`, follows the stream, a "Latest" button when scrolled up, virtualized over 300 rows).
  - `items.tsx`: tool cards, Thinking blocks, error cards with a retry-after countdown, the status line, and **`ITEM_RENDERERS`**, where UI-4/UI-5 replace the `edit_proposal` / `approval` / `decision` placeholders.
  - `Markdown.tsx` + `mdBlocks.ts`: markdown-it with raw HTML off and only http(s)/mailto links. Code blocks get copy and insert at cursor.
  - `highlight.ts`: highlight.js core, 25 grammars lazy-loaded as chunks.
  - `errors.ts`: error kind → action.
- **Public API for UI-4 / UI-5:** `ITEM_RENDERERS` (`webview/transcript/items.tsx`) and `ItemProps` (`item`, `taskId`, `live`, `streaming`, `retryable`, `onRetry`). The `ApprovalItem` / `EditProposalItem` / `DecisionItem` shapes are in `shared/transcript/model.ts`.

**Evidence:**
1. **AC1** `src/transcript/reducer.test.ts` › "recorded sequences (AC1)" has one test each for happy path, escalation, failure, and cancel. They check item kinds and order, reasoning, tool status, approval resolutions, grouped decisions, header totals, iteration, and `failureReason`. Mid-stream prefixes are checked too (awaiting approval; streaming before cancel).
   - Each fixture also gives the same result when applied in one batch, one event at a time, or as a compacted replay.
   - Robustness tests cover invalid payloads, duplicates, purity, events arriving before the summary, an authoritative terminal summary, and iteration counting.
2. **AC2** `test/webview/stream.mjs` streams 5,000 token-sized `text_delta`s (28.8 KB of markdown, 13 code blocks) the way `TaskStore` batches them, at ~2,000 tokens/s, into the built bundle under the real CSP.
   - Result: **0 long tasks** (`PerformanceObserver('longtask')`) at 1× CPU, and also 0 at 4× CPU throttling.
   - The harness first proves the observer works: a deliberate 80 ms block is recorded.
   - Virtualization: 1,000 tool calls render ~30 of 1,001 rows. Scrolling to the top renders the start.
3. **AC3** Two places:
   - The reducer test "ignores unknown event types with a debug log" injects a `plan_updated` event, checks the transcript is unchanged, and checks the debug line.
   - At the host boundary, `OrchestratorClient` already drops unknown types with a debug log (COR-1).
4. **AC4**
   - **Keyboard:** `stream.mjs` reaches and uses the following with Tab + Enter only, and asserts a visible focus outline on the header buttons and the transcript region:
     - Retry
     - the transcript region
     - Thinking
     - a tool card
     - "Open full output"
     - "Insert at cursor"
     - the task list
     - the error action
   - **Themes:** `pnpm -F desiide-ai screenshots` renders the stream in Dark+, Light+, High Contrast, Desiide Dark, and Desiide Light (`.screenshots/*-stream.png`). Animations are off under `prefers-reduced-motion`.
- Also:
  - `taskStore.test.ts` (batching, snapshot equivalence, pruning, tool output).
  - `transcript.test.ts` (markdown safety, lazy highlighting, error mapping, formatting, the virtual window, one-notification-per-frame).
  - `pnpm -F desiide-ai test:webview` covers UI-2 plus UI-3.
  - `test:integration` passes on VS Code 1.140: activation 1.08 ms, orchestrator idle at activation, both views ready.
  - First contentful paint is 28–36 ms with the new bundle (`main.js` 293 KB, 106 KB gzipped).
  - `scripts/verify.sh` is green (1744 tests).

**Deviations:**
- **Iteration isn't in the event stream.** The header derives it (1 once running, +1 per `verifying → running`) and replaces it with `TaskSummary.iteration` from `task.list` when the task ends.
- **`tool_call_started` comes before `approval_required`** for the same call (the engine announces the call, then gates it). The tool card shows "awaiting approval" until the user answers. The approval slot is resolved from `tool_call_finished` (ok → approved; rejected/blocked/cancelled).
- **Decisions are grouped.** One risk_gate check emits one `decision_made` per question (3 per action). Consecutive decisions with the same pack and `stateHash` become one `DecisionItem {decisions[]}`, so UI-5 gets one chip per check.
- **CSP gains `'strict-dynamic'`** (UI-1's `views/html.ts`) so the nonce'd bundle can load its own highlight.js grammar chunks. Any other script is still refused. The harness runs under this exact CSP.
- **Small additions to UI-2 code:**
  - `TaskClient.list()` (plus the mock and fallback versions).
  - `PromptController` takes an `onCreated(task, params)` hook and has `track(task)`, so Retry's new task drives Stop.
  - `PromptBox` takes `stream` / `hasTasks`. The panel is a fixed-height column while there are tasks, and the transcript scrolls on its own.
- **Tasks last for the window session** (host memory, 30 retained). They survive a panel reload, but not a window reload: the orchestrator restarts then, so the tasks are gone too.
- **Retry only works for tasks started in this window**, because the host must still hold their `task.create` params.
- **Syntax colors** use VS Code's debug-console token variables (themes don't expose per-token colors to webviews), with Dark+/Light+ fallbacks.

**Known gaps:**
- No pass with real VS Code pixels or a screen reader. The webview was driven in Chromium, and the host commands in VS Code. A manual F5 pass is worth doing (watch a live task stream, use Insert at cursor, Open full output).
- `test:webview` isn't in `verify.sh` or CI (it needs Chromium), same as UI-2.
- `usage` cost uses COR-2's estimate, which prices cached input at the full rate (MOD-3 known gap), so the header's ~cost overstates cached runs.

**Follow-ups:**
- **UI-4:** set `ITEM_RENDERERS.approval` / `.edit_proposal`. Post approve/reject from there (new bridge messages). `ApprovalItem.resolution` and `ToolItem.status === 'awaiting_approval'` are already derived.
- **UI-5:** set `ITEM_RENDERERS.decision`. `DecisionItem.decisions` holds every question of one check.
- **REL-1:** run `test:webview` in CI (Chromium only, no display).
- **Planning:** decide whether to persist transcripts across window reloads (`workspaceState`, metadata-only?), and whether to add an `iteration` field to `state_changed` (additive) so clients don't have to derive it.
