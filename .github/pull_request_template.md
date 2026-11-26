## Module

Brief: `roadmap/modules/<ID>-*.md`

## What changed

## Definition of Done

- [ ] Every item in the brief's **Acceptance criteria** is met and demonstrated (test or recorded manual check).
- [ ] `scripts/verify.sh` is green (typecheck, lint, unit tests).
- [ ] New logic in `packages/*` has unit tests (target ≥80% line coverage on new files). UI logic (state, reducers, parsers) is tested. Pure presentation isn't required to be.
- [ ] No `any` / `as unknown as` at package boundaries. Every external input is validated with zod.
- [ ] No new network destinations except ones the user configured. No telemetry.
- [ ] Security (CONTRIBUTING.md): new dependencies are listed below with a reason, none run install scripts, and no supply-chain policy was relaxed. Changes to `.github/`, `scripts/`, `editor/` or package scripts are explained.
- [ ] Errors are handled: user-facing failures show an actionable message, and nothing fails silently.
- [ ] Brief updated: **Status**, **Handoff notes** (what was built, deviations, known gaps, follow-ups).
- [ ] PR opened from `mod/<ID>-<slug>`, description links the brief, CI green.

## New dependencies

_None_, or `name@version`: why it's needed.

## Acceptance criteria evidence

| # | Criterion | Evidence |
|---|---|---|
