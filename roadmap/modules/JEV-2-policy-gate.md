# JEV-2 · Policy & risk gate

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** JEV-1 · **Skills:** ide-jev-decisions

## Purpose
Turn Jev (or rules) answers into IDE behavior: `auto | confirm | block` for actions, and the workflow choice for tasks. **This is the trust layer, so it gets the most adversarial testing.**

## Scope
- `thresholds.ts`: a single exported, documented object (values from the skill's conservative defaults). User overrides via `desiide.gating.*` can only be **stricter**; this is enforced by a validation function.
- Hard **deny-list** with command normalization before matching: strip `sudo`/env prefixes, collapse whitespace, expand `bash -c`/`sh -c` one level, split on `;`, `&&`, `||`, `|`, and flag `$(…)`/backticks as `confirm` minimum.
- Read-only **allow-list** (`ls`, `cat`, `pwd`, `git status|diff|log|show`, and configured test/lint commands).
- `PolicyGate` implements COR-2's `Gate`: deny-list → allow-list → edit rules (multi-file or sensitive → confirm) → risk_gate pack → thresholds. Always returns `reasons: ReasonLabel[]` + `decisionId`.
- `WorkflowPolicy`: workflow_select + cost_route + complexity → final workflow, honoring user preference and configured roles. Overrides are logged as `policy_override:<rule>`.
- Reason label → human text map (exported for UI-4/UI-5).

**Honesty note for docs:** the deny-list is best-effort pattern matching. The real safety net is confirm-by-default.

## Acceptance criteria
1. Golden tests: the three example states from the original brief → expected outcomes under both the rules engine and a mocked "overconfident" Jev (all yes, p=0.99). Deny-listed actions stay **blocked** even then.
2. An adversarial command corpus (≥40 cases: spacing, quoting, `sudo`, `env X=1`, `bash -c`, chained, subshells, `git push -f origin main`, `curl … | sh`) → none auto-run.
3. Jev unavailable → `confirm` with reason `jev_unavailable`.
4. A user override attempting to loosen a threshold is rejected with a visible warning.

## Handoff notes
**Built (branch `mod/JEV-2-policy-gate`, stacked on `plan/decisions-2026-10-05`):** `packages/jev/src/policy/`, exported from `@desiide/jev`. It's wired into the orchestrator (`packages/orchestrator/src/policy/workspacePolicy.ts` → `host/main.ts`) **in place of COR-2's `confirmAllGate`**.

**Behavior (ADR-019: ask for what's sensitive or risky, not for everything).** Checks run in order, and the first match wins:
1. **Deny-list → block.** Jev isn't consulted.
2. **Auto, no question:** plain reads (`read_file` / `list_files` / `search` / `git_read`) of non-sensitive workspace paths, read-only shell commands, and the configured test/lint commands.
3. **Floors force at least `confirm`, whatever Jev says:**
   - sensitive files, or paths outside the workspace
   - multi-file edits
   - destructive, irreversible, or migration commands
   - inline code (`python -c`, `… | sh`)
   - `sudo`, `$(…)`, background jobs, unparsable commands
4. **Strict mode → confirm.**
5. **risk_gate questions against the thresholds.** Any Jev fallback → `confirm` + `jev_unavailable`.

**Entry points**
- `createPolicyGate({engine, settings, project, git, newId, onDecision?})` implements COR-2's `Gate` structurally.
- `evaluateRiskState(state, ctx)` is the same policy on a risk_gate state. It's used for the goldens, and JEV-4's replay can use it.
- `assessCommand(cmd, ctx)` → `{deny, confirm, readOnly}`. `analyzeCommand(cmd)` is the shell analyzer underneath.
- `createSensitivity(globs)` / `DEFAULT_SENSITIVE_GLOBS`: **COR-4 should use these for `FileMeta.sensitive`.** Also `pathScope`, `globToRegExp`.
- `DEFAULT_THRESHOLDS` and `resolveThresholds(overrides)` → `{thresholds, warnings}`. Overrides can only make thresholds stricter.
- `decideWorkflow({task, workflowState, costState}, {engine, newId})` → `{workflow, reasons, decisionId}`. **For COR-5.**
- `REASON_TEXT` and `describeReason(label)`: human text for UI-4/UI-5.
- `stateHash(state)`: canonical-JSON sha256. **JEV-4 can reuse it.**
- Orchestrator side: `createWorkspacePolicy(host, {newId, logger?, onDecision?})` → `{gate, onConfig}`.
  - It reads `gating.mode` / `gating.thresholds` / `jev.*` from `config.update`.
  - It reads the project's `sensitiveGlobs` and test/lint commands once per task, and the branch via hardened `git rev-parse`.
  - Rejected overrides go to the client as `log` warnings.

**Evidence** (`pnpm -F @desiide/jev test`, plus `@desiide/orchestrator` `src/policy`)
1. AC1: `gate.test.ts` › "AC1 goldens". Each of the three risk_gate example states runs under the rules engine **and** an overconfident Jev (yes, p=0.99):
   - The migration next to sensitive billing files → confirm under both engines (ADR-021: only the deny-list blocks).
   - `git status` → auto, without asking Jev.
   - `git push --force origin main` → blocked, Jev never called.
   
   `workflow.test.ts` › "AC1 goldens" covers the workflow_select and cost_route examples under both engines.
2. AC2: 90 adversarial commands in total.
   - `commands.test.ts` › `DENY_CORPUS`: 64 commands, each mapped to its deny rule. They cover spacing, quoting (`r''m`, `"rm"`, `\rm`), `/bin/rm`, `sudo -u`, `env X=1`, `FOO=bar`, `nohup`, `timeout`, `bash -c`, nested `bash -c "sh -c …"`, `eval`, `env -S`, `;` `&&` `||`, `$(…)`, backticks, subshells, `{ …; }`, `find -exec`, `--no-preserve-root`, `curl|sh` / `wget|python3`, `bash <(curl)`, `sh -c "$(curl)"`, force-push variants (`-f`, `+main`, `HEAD:main`, `-uf`, `--delete`, `:master`, `--mirror`), and system writes.
   - `gate.test.ts` › "AC2" pushes all of them through the full gate with the overconfident Jev: every one is blocked and Jev is never called.
   - A further 26 `NEVER_AUTO` commands are confirmed or blocked under both engines, never auto: `xargs rm -rf`, `python3 -c`, `base64 -d | sh`, force push to a feature branch, `npm publish`, migrations, `cat .env`, `cp .env /tmp`, `curl -d @.env`, `terraform apply`, and more.
3. AC3: "a configured Jev that fails gives confirm with jev_unavailable, even when rules say yes" goes through the real `EngineSelector`: first the error, then the cooldown. Also: an engine that throws gives confirm, and aborts propagate.
4. AC4: `thresholds.ts` tests: loosening, out-of-range, and unknown overrides are each ignored with a warning, and stricter ones apply and change outcomes.
   - **Visible:** `workspacePolicy.test.ts` › "AC4" sends `config.update` over JSON-RPC, and the client receives a `log` warning ("…autoSafeNowMin = 0.1: it would loosen gating (default 0.9; only higher values are allowed)").
   - The same warning came through on a smoke test of the bundled `orchestrator.js` over real stdio.
- **ADR-019 table:** "asks for what is sensitive or risky" covers 20 tool calls. `src/a.ts` reads, `list_files`, `search`, `git diff`, `ls`, `pnpm test`, and a single-file edit → auto. `.env`, `.pem`, `secrets/`, `git show … .npmrc`, multi-file edits, and `.env` edits → confirm. `.env.example` → auto.
- **End to end:** `workspacePolicy.test.ts` runs a real task over RPC. `src/a.ts` is read unasked; the `.env` read raises one approval with `sensitive_file`; the sentinel secret never reaches the model after the rejection; and `curl … | sh` is blocked without a prompt, with the reason passed to the model.
- `scripts/verify.sh` is green (1405 tests).

**Deviations**
- **Floors (beyond the skill's list).** With an overconfident Jev, any non-deny-listed command with no floor would auto-run, which AC2 forbids. So local heuristics for destructive / irreversible / migration / inline-code / `sudo` / substitution / outside-workspace / background commands force `confirm`. This is the "Jev can only make it stricter" rule made concrete.
- **Sensitivity lives here, not only in COR-4.** ADR-019 needs it now. COR-4 should call `createSensitivity` rather than duplicate it.
- **Policy-only decisions are logged as the pseudo-question `policy`.** These are deny, allow-list, floor-only, and strict decisions. The result is noul yes/no/unknown for auto/block/confirm, with engine `rules`, so every gate decision has a `decisionId`.
- **The configured test/lint commands are allow-listed** (per the skill), after the deny-list. A repo's own `.desiide/project.json` therefore decides what `run_tests` runs unasked. Running tests runs repo code anyway; see Follow-ups (workspace trust).
- **Strict mode** asks before every shell command and check, including read-only ones. Plain read tools still run unasked.
- **Risk answers don't block by default (ADR-021, decided by the user 2026-10-06).** `blockSafeNowBelow` defaults to 0, not the skill's 0.3, so `rm -rf dist`, migrations, `git reset --hard` and the like are asked, not blocked. Only the deny-list blocks. Raising the threshold is a stricter override and brings blocking back. Tests: `gate.test.ts` › "ADR-021".
- **`decideWorkflow`'s sensitive floor** raises to `cloud-single`, per the skill. Note this sends sensitive-file tasks to a cloud model.

**Known gaps**
- `search` can return matching lines from a sensitive file that isn't gitignored. The gate checks the `path` argument, not the results. Fix in COR-3/COR-4: exclude sensitive globs from the rg walk.
- No `decision_made` events or persisted log yet. `onDecision` logs at debug level, and JEV-4 / UI-5 wire them.
- `hasPendingMigrations` is always `false` (not detected). Migration commands are still caught by the command floor.
- Path redaction isn't wired in the orchestrator, because the salt comes from UI-6.
- Shell analysis is best effort (the brief's honesty note). Confirm-by-default is the real safety net, and unparsable input always asks.

**Follow-ups**
- **COR-4:** `FileMeta.sensitive` via `createSensitivity(projectConfig.sensitiveGlobs)`. Exclude sensitive files from `search` / `list_files` results, or mark them.
- **JEV-4:** persist `onDecision` records (`createWorkspacePolicy({onDecision})`) and reuse `stateHash`.
- **UI-5 / COR-2:** emit `decision_made` events for gate decisions (`approval_required.decisionId` already links them).
- **UI-6:** show rejected-override warnings next to the gating settings (they arrive as `log` warnings today), and pass the redaction salt.
- **Extension (workspace trust):** in an untrusted workspace, don't allow-list the repo-configured test/lint commands.
