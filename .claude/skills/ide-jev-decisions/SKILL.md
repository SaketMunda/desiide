---
name: ide-jev-decisions
description: Jev (TypeSafe) integration — decision packs (workflow_select, risk_gate, cost_route), Choice/Score/Noul question templates, state schemas, policy thresholds that turn Jev output into auto/confirm/block and escalation, decision logging. Load before editing packages/jev or changing gating behavior.
---

# Jev decisions

> ⚠️ The HTTP wire format is **assumed** until the TypeSafe API docs are added under `docs/jev-api/`. Update `HttpJevEngine` and this file together once they are.

## Engines
- `HttpJevEngine`: TypeSafe API. Timeout 1.5 s → fall back to rules for that call.
- `RuleJevEngine`: deterministic. It's the default when Jev is unconfigured, and the test oracle.
Every result is tagged `engine: 'jev'|'rules'` and shown in the Decision panel.

## Question types
- **Choice**: pick one of N options → `{selected, probs}`
- **Score**: ordinal 0–4 → `{score, probs?}`
- **Noul**: yes/no/unknown → `{answer, pYes}`. Treat `unknown` as `no` for safety questions.

## Packs (state = metadata only, never file contents)

### `workflow_select@1`
State: `taskType, filesTouched[{path,sizeLines,language,sensitive}], estimatedDiffSize, lastRunStatus, userPreference, availableModels[{id,contextTokens,latencyMs,costTier}]`
- Choice "Which workflow should handle this task?" options: `local-single | cloud-single | local-cloud-cascade | cloud-with-critique`. Drop options whose models aren't configured.
- Score "complexity" 0–4, Score "escalation_need" 0–4.

### `risk_gate@1`
State: `actionType (run_command|apply_edit|git_push|...), command?, editFileCount?, context{branch,env,hasPendingMigrations}, filesTouched[{path,sensitive}]`
- Noul `safe_now`: "Is it safe to run this action in the current context?"
- Noul `reversible`: "Is this action reversible without human intervention?"
- Noul `high_risk_area`: "Does this touch security, auth, billing, or data-migration code?"

### `cost_route@1`
State: `taskType, filesTouchedCount, projectSizeLines, userCostBias, recentFailures`
- Score `cheap_success`: "How likely will a cheap/local model succeed without escalation?" 0–4

## Policy (conservative default)
Evaluated in this order. The first match wins.
1. **Hard deny-list** (regex on normalized command: `rm -rf /`, `rm -rf ~`, `mkfs`, `dd of=/dev/`, `:(){`, `curl|sh`, `git push --force` to main/master, `chmod -R 777 /`, writes outside workspace) → **block**. Jev is not consulted.
2. Read-only allow-list (`ls`, `cat`, `git status/diff/log`, configured test/lint commands) → **auto**.
3. `apply_edit` touching >1 file or any sensitive file → **confirm**.
4. Jev risk_gate: **auto** only if `safe_now.pYes ≥ 0.90` AND `reversible.pYes ≥ 0.80` AND `high_risk_area.pYes < 0.20` AND no sensitive files. If `safe_now.pYes < 0.30` or `answer = no` with a destructive actionType → **block**. Otherwise → **confirm**.
5. Jev unavailable → **confirm**.

Workflow/cost:
- `cost_route.cheap_success ≥ 3` and preference ≠ quality → local-first (single or cascade).
- `complexity ≥ 3` or any sensitive file → at least `cloud-single`. With preference = quality → `cloud-with-critique`.
- Cascade escalates when `escalation_need ≥ 3`, verification fails, or the draft doesn't parse.
- A policy override of Jev's choice is logged with reason `policy_override:<rule>`.

Thresholds live in `packages/jev/src/policy/thresholds.ts` as one exported object. Users can make them stricter via `desiide.gating.*` but never looser than the deny-list.

## Logging
Each decision → `DecisionRecord{id, taskId, pack@version, question, engine, stateHash, state, result, policyOutcome, reasons: string[] (labels like "sensitive_file", "deny_list:rm_rf"), latencyMs, ts}` appended to `.desiide/logs/decisions.jsonl` (gitignored) and emitted as an event. Reasons are structured labels. The UI maps them to text.

## Gotchas
- **Evolving schemas:** bump the pack version (`risk_gate@2`) for breaking state changes. Keep the old builder until Jev supports the new one. Golden tests are per version.
- **Token budget:** cap `filesTouched` at 50 entries (sort by sensitivity then size, add `truncatedCount`), and truncate commands to 500 chars.
- **Privacy:** paths and commands can themselves be sensitive. The settings page shows a sample payload, and `desiide.jev.redactPaths` hashes path segments outside a known list (`src`, `test`, `auth`, ...).
- **Debugging:** `desiide: Replay decision` re-runs a logged state through both engines and diffs the results.
