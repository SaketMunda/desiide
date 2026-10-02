# JEV-1 · Jev core (packs, rules engine, state builders)

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-jev-decisions

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
**Built (branch `mod/JEV-1-jev-core`):** `@desiide/jev`, consumed as TS source. Pure logic, no I/O and no `vscode` imports. The only Node API it uses is `node:crypto`, for HMAC.

**Public API (`packages/jev/src/index.ts`):**
- **Engine contract:** `JevEngine {kind, choice, score, noul}`. Every method takes `(request, signal?)` and returns a `JevAnswer {engine, result, rationale: string[], latencyMs, fallbackReason?}`. Bad state, question, or options throw `JevRequestError` with `code: invalid_state | unknown_pack | unknown_question | wrong_question_type | invalid_options`. These are caller bugs and never trigger a fallback.
- **Packs:** `listPacks`, `getPack`, `getQuestion`, `parsePackState`, `allowedWorkflowOptions`, `resolveChoiceOptions`, and `workflowSelectPack` / `riskGatePack` / `costRoutePack`. Each pack registers FND-2's protocol schema rather than redefining it, and carries the question templates and choice options from the skill.
- **Rules engine:** `createRuleJevEngine()`. It's deterministic, and probabilities are fixed per rule: Noul `pYes` is set per rule, Score puts 0.8 on the chosen value, and Choice gives 0.85 to the selection (0.7 when the wanted option is unavailable). Every answer carries `rationale` labels such as `read_only_command`, `destructive_command`, `migration_command`, `protected_branch`, `sensitive_file`, `task_type:bug_fix`, `option_unavailable:cloud-with-critique`.
- **Builders:** `buildWorkflowSelectState`, `buildRiskGateState`, `buildCostRouteState`, `truncateCommand`, `actionFromToolCall`. Each builder copies fields one at a time and runs the result through the strict pack schema.
- **Redaction:** `createPathRedactor({salt, allowList?})` returns `{path, command}`. It uses HMAC-SHA256 per path segment (`h_<10 hex>`) and keeps the file extension and allow-listed folder names (`DEFAULT_PATH_ALLOWLIST`). `command()` redacts path-like tokens inside commands.
- **Selector:** `createEngineSelector({rules, jev?, config, timeoutMs=1500, cooldownMs=30000})`. It is itself a `JevEngine` and also exposes `select()`, `status()`, and `update({config, jev})`. "Configured" means `enabled && endpoint && a jev engine was supplied`. When a Jev call fails, times out, or returns a malformed or mismatched result, that call is answered by rules with `fallbackReason: jev_error | jev_timeout`, and Jev is skipped for the cooldown (`jev_unavailable`). Caller aborts and `JevRequestError`s propagate instead.

**Evidence (all in `packages/jev`, `pnpm -F @desiide/jev test`, 106 tests):**
- AC1: `packs/registry.test.ts` → "example %s validates against its pack schema" (all three FND-2 examples), plus the two extra risk_gate goldens.
- AC2: `rules/engine.test.ts` → "npm run migrate + sensitive billing file is not safe now" (`no`, pYes 0.1) and "git status is safe now…" (`yes`, 0.95). Also a 26-row `safe_now` table (chained, substituted, and redirected commands, `rm -fr`/`-r -f`, force push, protected-branch push), plus tables for `reversible`, `high_risk_area`, workflow, complexity, and cheap_success.
- AC3: `state/builders.test.ts` → "metadata only" block. Inputs carry contents at runtime (`content`/`text` keys on FileMeta, ContextBundle `sections`, model `apiKey`, propose_edit search/replace text). The test asserts that every key in the output is on a metadata allow-list and that the secret string appears nowhere.
- AC4: `state/redact.test.ts` → "hashes the same path the same way, across redactor instances with the same salt", "hashes differently in another workspace", and builder-level determinism in `builders.test.ts`.

**Deviations:**
- *Builders take `ContextFiles = {files: FileMeta[]}`*, not COR-4's `ContextBundle`, which doesn't exist yet. The bundle will satisfy it structurally, so no change is needed when COR-4 lands.
- *Local vs cloud is inferred from `costTier`*: `free` counts as local and any paid tier as cloud. `availableModels` has no locality field. If that's too coarse, a `local` flag would need an additive protocol change, which the planning session should decide.
- *The redaction salt is a caller-supplied input*, at least 16 characters. The brief says hashes must be stable "within a workspace". A salt derived from the workspace path would be guessable by dictionary, so the salt should be a random per-workspace value (see Follow-ups).
- *`EngineSelector` also enforces the 1.5 s budget and zod-validates Jev answers.* JEV-3 still owns HTTP-level timeouts and wire validation; this layer protects against any engine misbehaving.
- *Tool-call mapping:* `shell` is classified as `git_push` / `git_commit` / `install_dependency` / `run_command` from the command head. `git_read` maps to `run_command` with `git <sub>`. The read tools map to `other`, and gating them is JEV-2's call.

**Known gaps:**
- The rules engine's command heuristics are *not* the deny-list. JEV-2 must still normalize commands and match the deny-list on the **raw** command.
- With `redactPaths` on, the rules engine sees the redacted command, so a script name like `scripts/migrate.sh` loses its `migration_command` signal and the answer becomes `unknown` → confirm. This is safe, but JEV-2 may prefer to run rules on the unredacted state and send only the redacted state to Jev.
- `context.branch` is not redacted, because protected-branch detection needs it.
- Coverage isn't measured because there's no coverage provider yet (FND-1 follow-up). Every exported function has tests.

**Follow-ups:**
- COR-2/UI-6: generate a random salt per workspace (for example in extension `workspaceState`) and pass it to the orchestrator when `desiide.jev.redactPaths` is on.
- `jev.preview` RPC handler (UI-6): the builders are ready. It needs COR-4 file metadata plus the model list.
- JEV-4: `stateHash` (canonical JSON + sha256) isn't provided here.
