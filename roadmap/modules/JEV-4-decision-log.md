# JEV-4 · Decision log & replay

**Status:** in-progress · **Milestone:** Alpha · **Size:** S · **Depends on:** JEV-1 · **Skills:** ide-jev-decisions

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
_(filled by the build session)_
