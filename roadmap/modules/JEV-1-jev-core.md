# JEV-1 · Jev core (packs, rules engine, state builders)

**Status:** in-progress · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-jev-decisions

## Purpose
Everything about Jev decisions that doesn't need the TypeSafe API. Alpha ships fully functional on the rules engine, and JEV-3 swaps in the real Jev with no other changes.

## Scope
- `JevEngine` interface: `choice / score / noul` (see skill).
- Pack registry with **versioned** zod state schemas: `workflow_select@1`, `risk_gate@1`, `cost_route@1`, with question templates and allowed options.
- `RuleJevEngine`: deterministic, explainable answers for all three packs. It returns probabilities too (calibrated-looking but fixed per rule, e.g. 0.95/0.05) so the UI is identical to Jev.
- State builders: `Task` + `ContextBundle` (COR-4 `FileMeta`) + `ToolCall` + git info → pack state. Metadata only. Caps: 50 files (sensitive first, `truncatedCount`), command ≤ 500 chars.
- Redaction option `redactPaths`: hash path segments not in an allow-list of common folder names.
- `EngineSelector`: returns the Jev engine when configured and healthy, else rules. Every result is tagged `engine`.

## Out of scope
Turning answers into auto/confirm/block (JEV-2), HTTP (JEV-3), persistence (JEV-4).

## Acceptance criteria
1. The three example states from the original brief validate against the pack schemas (fixtures from FND-2).
2. Rules engine table tests: e.g. `npm run migrate` + sensitive billing file → `safe_now = no` or `unknown`. `git status` → yes.
3. State builders never include file contents (test asserts no key other than allowed metadata fields).
4. Redaction is deterministic and the same path always hashes the same way within a workspace.

## Handoff notes
_(filled by the build session)_
