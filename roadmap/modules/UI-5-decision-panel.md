# UI-5 · Decision panel

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, JEV-4 · **Skills:** ide-editor-shell, ide-jev-decisions

## Purpose
The visible Jev brain and the product's differentiator. It shows *why* Mutt chose a model and *why* an action was gated, in structured form, with the savings made visible.

## Scope
- **Decision timeline** (per task, with a filter for all tasks): cards showing `pack@version`, question, result (selected option / score dots / yes-no-unknown), `ProbabilityBar` per option, **engine badge** (Jev / Rules), latency, policy outcome, and reason labels.
- **"Why?" expander**: the exact state sent (pretty JSON, post-redaction) and the thresholds that applied.
- **Replay** button → `decisions.replay` → side-by-side rules vs Jev result.
- **Savings meter** (header): per session, tasks routed local vs cloud and **estimated cost saved** against an "always strong model" baseline (from COR-5 usage + `costPerMTok`), clearly labeled "estimate". Hidden when no costs are known.
- Jev status: connected / rules-only / degraded (circuit open), with a link to settings.
- Microinteractions: a new card fades in and pulses in the Jev accent once. Outcome color transitions. All under 250 ms and disabled with reduced motion.
- An inline decision chip component exported for UI-3's transcript.

## Acceptance criteria
1. Renders the three golden decision fixtures (from JEV-2) correctly in all themes.
2. The "Why?" view never shows data that wasn't in the stored record.
3. The savings math is unit-tested and shows "—" when the cost data is incomplete.
4. Replay shows the diff when the engines disagree.

## Handoff notes
_(filled by the build session)_
