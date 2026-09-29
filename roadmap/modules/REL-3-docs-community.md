# REL-3 · Docs & community

**Status:** todo · **Milestone:** Alpha + Beta (final pass before each release) · **Size:** S · **Depends on:** continuous · **Skills:** none

## Purpose
Make Mutt trustworthy and adoptable by professional teams on day one. The docs *are* part of the privacy/safety pitch.

## Scope
- `README.md`: one-line pitch, GIF (Prompt Box → Jev decision → diff approve), 2-minute quickstart (Ollama path + Claude path), feature list, privacy statement.
- `docs/`: `architecture.md`, `protocol.md` (from FND-2), `adding-a-model.md`, `jev.md` (what is sent, exactly; how to disable; rules vs Jev), `gating.md` (policy order, deny-list honesty note), `privacy.md`, `manual-qa.md` (REL-2).
- `SECURITY.md` (private vulnerability reporting via GitHub), `CONTRIBUTING.md` (module workflow, standards link), `CODE_OF_CONDUCT.md`, issue templates (bug, feature, model-provider request), `LICENSE` (after open decision #2).
- Marketplace listing: description, screenshots, categories, keywords (for Alpha).

## Acceptance criteria
1. A developer who has never seen the repo installs and runs a first task using only the README (tested with one person).
2. `jev.md` shows a real sample payload taken from JEV-1's builder.
3. All links resolve (link check in CI).

## Handoff notes
_(filled by the build session)_
