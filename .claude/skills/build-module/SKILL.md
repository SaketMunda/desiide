---
name: build-module
description: Start or continue building a Desiide roadmap module. Use whenever the user names a module or feature to build or work on — by ID (e.g. "UI-2", "COR-2") or by name (e.g. "Prompt Box", "task engine", "decision panel", "Anthropic adapter", "policy gate", "fork build") — or says "build the next module". Loads the module brief, standards, and the right domain skills, then builds to the brief's acceptance criteria.
---

# Build a roadmap module

You are a **build session**. The planning session owns scope and decisions. You own a high-quality implementation of **one** module.

## 1. Identify the module
- Look up the user's phrase in the module index in `roadmap/README.md` (match ID or name; "Prompt Box" → UI-2).
- "Next module" → the first `todo` module in the earliest wave whose dependencies are all `done`.
- Ambiguous → ask with the 2–3 candidate IDs. Don't guess.

## 2. Load context (in this order)
1. `roadmap/modules/<ID>-*.md`: the brief. Its **Scope** and **Acceptance criteria** are your contract.
2. `roadmap/STANDARDS.md`: the Definition of Done.
3. `roadmap/DECISIONS.md`: accepted ADRs you must not violate.
4. Every skill listed in the brief's **Skills** field.
5. Handoff notes of each dependency module (they may record deviations you must build on).
6. The actual code of the dependencies' public APIs (`src/index.ts`). Trust the code over the brief if they disagree, and note it.

## 3. Preconditions
- All dependencies `done`? If not, and the brief has a **Mock strategy**, proceed with the mock. Otherwise stop and tell the user which dependency is missing.
- Status `blocked`? Stop and report why (e.g. JEV-3 waits for API docs).
- Branch: `git switch master && git pull`, then `git switch -c mod/<ID>-<slug>` (reuse it if it exists).
- Set the brief's **Status** and the index row to `in-progress`.

## 4. Build
- Brief the user in ≤5 lines: what you'll build, in what order, and anything unclear.
- Work in small verified steps: implement → test → `scripts/verify.sh`. Commit per step (`feat(<ID>): …`).
- Stay inside the brief's scope. Useful ideas outside it go into **Handoff notes → Follow-ups**, not code.

## 5. When the brief doesn't fit reality
| Situation | Action |
|---|---|
| A small gap or ambiguity inside the module | Decide sensibly and record it in Handoff notes → Deviations |
| A needed **additive** change to `packages/protocol` | Allowed. Keep it additive, mention it in the PR, and record it |
| A breaking protocol change, a change to another module's public API, loosening safety/gating, or contradicting an ADR | **Stop and ask the user.** It goes back to the planning session |
| An acceptance criterion is impossible or clearly wrong | Stop and ask. Don't silently drop it |

## 6. Finish
- Walk the Definition of Done checklist from STANDARDS explicitly, including each acceptance criterion with its evidence (test name or manual step).
- Fill **Handoff notes** in the brief: what was built, public API entry points, deviations, known gaps, follow-ups.
- Set Status to `review` (the PR is open) and update your index row only.
- Push the branch and open a PR (`gh pr create`): link the brief, and paste the DoD checklist with evidence.
- Tell the user: PR link, what's done, anything that needs a planning-session decision.
