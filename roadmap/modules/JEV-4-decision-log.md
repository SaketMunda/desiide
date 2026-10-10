# JEV-4 · Decision log & replay

**Status:** review · **Milestone:** Alpha · **Size:** S · **Depends on:** JEV-1 · **Skills:** ide-jev-decisions

## Purpose
Every decision is recorded, inspectable, and replayable. This is the transparency promise and the debugging tool.

## Scope
- `DecisionRecord` writer → `.desiide/logs/decisions.jsonl` in the workspace (gitignored), rotated at 10 MB (keep 3).
- Emits the `decision_made` event for each record.
- `decisions.list {taskId?, pack?, outcome?, limit, cursor}`.
- `decisions.replay {id}`: re-run the stored state through the rules engine and Jev (if configured) and return both results + a diff.
- Stored state = exactly what was sent to Jev (post-redaction). Never more.

## Acceptance criteria
1. Concurrent writes from two tasks produce valid JSONL (no interleaved lines).
2. Rotation works and `list` spans rotated files.
3. Replay on a rules-engine record reproduces the same result (determinism test).

## Handoff notes
**Built (branch `mod/JEV-4-decision-log`):**
- The log store and replay live in `packages/jev/src/log/`, exported from `@desiide/jev`.
- They're wired into the orchestrator by `packages/orchestrator/src/decisions/service.ts`, which `host/main.ts` uses as the policy's `onDecision` sink.

**What happens to each decision now:**
1. It's appended to `<first workspace folder>/.desiide/logs/decisions.jsonl`, mode 0600.
2. On first write, the log directory gets a `.gitignore` containing `*`, so the user's repo `.gitignore` isn't touched.
3. It's emitted as `decision_made` in the task's event stream, before the `approval_required` it explains (same `seq` ordering).

**Entry points**
- `createDecisionLog({dir, maxBytes=10 MB, keep=3, onInvalidLine?})` returns `{path, append, list, get, flush}`.
  - Appends run through one promise chain, one `appendFile` per line.
  - When a write would pass `maxBytes`, the file rotates: `decisions.jsonl` → `.1` → `.2` → `.3`, and the oldest is dropped.
  - `list(query)` returns newest first across all files. It reads the active file first and only opens older files when the page needs them.
  - The cursor is the opaque (base64url) id of the last returned record. If that record has rotated away, everything older has too, so the page comes back empty. A garbage cursor throws `InvalidCursorError`.
  - Torn or invalid lines are skipped and reported via `onInvalidLine`.
- `replayDecision(record, {rules, jev?, settings}, signal?)` returns `{record, rules, jev?, jevError?, differs}`, matching the `decisions.replay` result.
- Orchestrator: `createDecisionService(host, {replayOptions, publish?, logger?})` registers `decisions.list` and `decisions.replay` and returns `{record, flush}`.
- Additive: `TaskManager.publishDecision(record)` and `WorkspacePolicy.replayOptions()`.

**Evidence** (`scripts/verify.sh` green, 1701 tests)
1. **AC1** `decisionLog.test.ts`:
   - "concurrent writes from two tasks…": 300 concurrent appends of ~1.3 KB records from two task ids, with rotation active. Every line parses, all 300 records are whole, and there are no duplicates.
   - "two writers on the same file": a second log instance (e.g. a second window) also produces whole lines.
2. **AC2** `decisionLog.test.ts`:
   - "rotates at maxBytes, keeps `keep` files, and list spans the rotated files": 45 records produce exactly 4 files, none over the cap, and the oldest file is dropped. `list` returns all kept records in order. Paging with limit 7 crosses file boundaries with no gaps or repeats. `get` finds a record in a rotated file.
   - "reopened over existing files": a restart picks up the existing size and keeps rotating correctly.
3. **AC3** `replay.test.ts`:
   - 15 gate paths, each replayed from a rules-engine record with `differs: false` and an identical `result` + `policyOutcome`: plain, sensitive and list reads; `git_read`; a read-only command; deny-list; force push; migration; plain command; install; configured tests; single and multi edit; strict mode.
   - Also covered: run_tests with nothing configured; the three routing questions (`workflow`, `complexity`, `cheap_success`); and the full round trip gate → JSONL on disk → `list` → replay.
   - End to end over JSON-RPC (`orchestrator/src/decisions/service.test.ts`): a real task produces `decision_made` events before the approval, the log holds no file contents, `list` filters and pages, and both decisions replay with `differs: false`.
- Smoke test of the bundled `orchestrator.js` over real stdio: `decisions.list` returns `{decisions: []}`, and `decisions.replay` of an unknown id returns InvalidParams with an actionable message.

**Deviations**
- **What replay re-runs.**
  - risk_gate records go through the full `evaluateRiskState`, so the policy outcome is replayed, not only the one question. The run reports that question's answer, or, if the run took another path (for example policy alone decided this time), the first record of that path.
  - The gate's context is rebuilt from the state alone, which is never more than was sent to Jev:
    - read tools, and checks with nothing configured, are `other`/check actions with no command;
    - a run_tests/lint command is the trusted configured one;
    - `outside_workspace` comes from the paths.
  - Replay uses the **current** gating settings: it answers "what would policy decide now?". A record made in strict mode replays differently in conservative mode, and `differs` shows it.
  - Routing records (workflow_select / cost_route) replay their one question. They have no policy outcome, and `decideWorkflow`'s overrides need both states, so they aren't re-applied.
- **`differs`** is true when the record, the rules run and the Jev run don't all agree on the decisive value (`selected`, `score`, `answer`) and the policy outcome. Probabilities are left out on purpose: Jev and rules always differ there.
- **Jev on replay** uses the raw Jev engine, not the selector, so a failure shows up as `jevError` instead of being hidden by a silent rules fallback. The gate turns engine errors into `jev_unavailable`, so replay wraps the engine to catch the failure. Today there is no Jev engine (JEV-3), so `jev` is always absent.
- **Errors.** Both of these return `InvalidParams` with an explanation, so the protocol doesn't need a new error code:
  - an unknown id (or one that has rotated out);
  - an unknown pack version.
- **Write failures** don't affect the decision. The user gets one `log` warning per failure streak ("…won't be listed or replayable"), and the details are logged at error level.

**Known gaps**
- Without a workspace folder nothing is persisted: `decision_made` still fires and `list` is empty. With multiple roots, only the first folder holds the log.
- Two orchestrators on the same workspace each keep their own size counter. Lines stay whole (one O_APPEND write each), but rotation can race and drop or overshoot one file.
- `list` and `get` re-read and parse the files on each call (up to ~40 MB at the caps). That's fine at Alpha volumes; an index would help later.
- With `redactPaths` on, the stored state holds the redacted command. A rules replay may then answer `unknown` where the original gate saw the raw command (it ran `assessCommand` on it). That's by design: the brief says "never more" than what was sent.
- `assessCommand` in replay uses the default sensitive globs for command arguments, not the project's `sensitiveGlobs`. Paths in `filesTouched` keep the flags they were recorded with.

**Follow-ups**
- **UI-5:** consume `decision_made` and `decisions.list` / `replay`. The `desiide: Replay decision` command from the skill belongs there.
- **COR-5:** pass `onDecision` from the same service to `decideWorkflow`, so routing decisions get persisted and emitted too. The service is ready, it only needs wiring.
- **JEV-3:** return the HTTP engine from `WorkspacePolicy.replayOptions()` (one line, marked in `workspacePolicy.ts`).
- Retention or erase: a `decisions.clear` command for users who want the log wiped (planning decision).

