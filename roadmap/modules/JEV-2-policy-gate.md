# JEV-2 · Policy & risk gate

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** JEV-1 · **Skills:** ide-jev-decisions

## Purpose
Turn Jev (or rules) answers into IDE behavior: `auto | confirm | block` for actions, and the workflow choice for tasks. **This is the trust layer, so it gets the most adversarial testing.**

## Scope
- `thresholds.ts`: a single exported, documented object (values from the skill's conservative defaults). User overrides via `mutt.gating.*` can only be **stricter**; this is enforced by a validation function.
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
_(filled by the build session)_
