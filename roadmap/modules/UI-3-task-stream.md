# UI-3 · Task stream (transcript)

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, FND-2 · **Skills:** ide-editor-shell

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
_(filled by the build session)_
