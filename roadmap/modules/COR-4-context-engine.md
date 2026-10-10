# COR-4 · Context engine

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** COR-3 · **Skills:** ide-orchestration-core

## Purpose
Turn a task's context refs plus the editor state into a token-budgeted `ContextBundle` for the model, and the file **metadata** that Jev state builders need.

## Scope (Alpha: lean and deterministic, no embeddings)
- Inputs: `ContextRef[]` from the Prompt Box (`@file`, `@folder`, `@selection`, `@diff`), open editors + active selection (sent by the extension in `task.create`), and the working-tree `git diff`.
- A repo map: a gitignore-aware file tree summary (depth- and size-limited) with language detection.
- Priority packing into the model's context budget: explicit refs > selection > diff > open editors > repo map. Truncate large files around the selection or relevant ranges and mark the truncation.
- Output `ContextBundle {sections[], tokenEstimate, files: FileMeta[]}`, where `FileMeta = {path, sizeLines, language, sensitive}` is used by JEV-1. `sensitive` comes from `ProjectConfig.sensitiveGlobs` + defaults.
- The agent can still pull more context via `search` / `read_file`. Tell the model that in the system prompt section this module provides.

## Out of scope
Semantic/embedding index (1.0 backlog).

## Acceptance criteria
1. Given refs whose total exceeds the budget, output stays within it (chars/4 estimate) and keeps the explicit refs first.
2. Binary files, lockfiles, and gitignored paths are excluded.
3. `FileMeta.sensitive` is true for the default globs (`**/auth/**`, `**/billing/**`, `**/payment*/**`, `**/*.env*`, `**/migrations/**`, `**/secrets/**`, infra files like `*.tf`, `Dockerfile`, `.github/workflows/**`).
4. Snapshot tests on a fixture repo.

## Handoff notes
**Built (branch `mod/COR-4-context-engine`):** `packages/orchestrator/src/context/`, exported from `@desiide/orchestrator`. It's wired into `host/main.ts` in place of COR-2's `pathOnlyContext`, so the app's tasks now get real context.

**Entry points**
- `createContextEngine({workspaceRoots, env?, trackProcessGroup?, logger?})` → `ContextEngine`. It implements COR-2's `ContextProvider` and adds one method:
  - `gather(task, signal, {modelContextTokens?})` → `{text, system}`. `text` goes into the first message. `system` is `CONTEXT_GUIDANCE`, which the agent loop appends to the system prompt.
  - `describeFiles(paths, signal)` → `FileMeta[]`. Files that don't exist yet get `sizeLines: 0`.
  - `build(task, signal, opts)` → the full `ContextBundle {sections[], text, tokenEstimate, budgetTokens, files: FileMeta[], omitted[]}`. Use it for the Jev state builders (`bundle` satisfies JEV-1's `ContextFiles`) and the `jev.preview` RPC.
- `buildContextBundle(inputs)` is the core with I/O injected (listing, diff). `describeFiles(workspace, paths, sensitivity, signal)` is the standalone metadata helper.
- `createContextSensitivity(projectGlobs)` → `{secret, sensitive}`. `contextBudget(window)`. Also `detectLanguage`, `excludedByName`, `DEFAULT_HIGH_RISK_GLOBS`, and `estimateTokens` (chars/4).
- **COR-2 changes (additive):**
  - `ContextProvider.gather` takes an optional third argument, `GatherOptions {modelContextTokens?}`.
  - `GatheredContext` has an optional `system`.
  - `runAgentLoop` reads `model.capabilities()` for the window. If that fails, it continues without one.
- **COR-3 change:** `rgWalkArgs(ignoreGlobs)` is now exported, so the context listing and the agent's `list_files`/`search` see the same files.

**How the bundle is built**
- **Priority tiers, in order:**
  1. Attached files, folder listings, and `context.tests`.
  2. Selections.
  3. Diffs: the ones attached, or the uncommitted working-tree changes when none are.
  4. Contents of an attached folder's files.
  5. Open editors (up to 10).
  6. The repo map.
- **Packing:** inside a tier, small items are kept whole and large ones split the rest equally. If even an equal share is below a useful minimum (~300 tokens; ~150 around a selection), the lowest-priority item in the tier is left out. Priority across tiers is strict: once a tier has left something out, later tiers get nothing, so a small open editor can never take the place of an attached file. A "Not included" section lists what was left out and why.
- **Truncation:** large files are cut around the selection (or from the top) with `[… lines a-b not shown; read_file startLine a endLine b]` markers, and the header says `partial`. Lines use the same `     12\t` prefix as `read_file`.
- **Repo map:** gitignore-aware (the same rg walk as `list_files`), 3 levels deep, 15 files per directory, with a per-language file count. Lockfiles, binaries, and generated files are left out.
- **Diffs:** hardened like `git_read` (`SAFE_GIT`, `--no-ext-diff --no-textconv`, no locks). Hunks of lockfiles, binaries, and secrets are replaced by a one-line note. Diffs are capped at 1 MB.
- **Budget:** 25% of the model's window, between 2k and 32k tokens, or 8k tokens when the window is unknown.

**Evidence** (`pnpm -F @desiide/orchestrator test src/context`: 89 tests in 7 files; `scripts/verify.sh` green, 1664 tests)
1. AC1: `engine.test.ts` › "AC1 budget":
   - "stays within the budget and keeps the explicit refs first": four attached files with a 2,000-token budget. The four sections come first, in the user's order. The 400-line file is cut, and the small ones stay whole.
   - "never exceeds any budget, from tiny to large" sweeps 12 budgets from 50 to 32k tokens with files, a folder, a selection, a large diff, and open editors. `tokenEstimate ≤ budget` every time, attached files come first, and nothing of lower priority appears once an attached file was left out.
   - `pack.test.ts` and `truncate.test.ts` sweep budgets as well: the output never exceeds `maxChars`.
2. AC2: `engine.test.ts` › "AC2 exclusions". Attached lockfile, PNG, binary-content `.txt`, gitignored `dist/bundle.js` and `debug.log`, `.env`, and `config/secrets/prod.json` are all left out with their reason. The sentinel secret appears nowhere. The repo map and the folder listing skip them.
   - "keeps secret and lockfile hunks out of the diff" covers the diff side. `workspaceIO.test.ts › filterDiff` covers quoted paths, renames to `.env`, and binary diffs.
3. AC3: `filters.test.ts` checks the brief's globs one by one, plus look-alikes that must stay false (`src/authorize.ts`, `docs/billing.md`). `engine.test.ts` › "AC3 FileMeta.sensitive" checks them through `describeFiles` on the fixture, and checks that project `sensitiveGlobs` from `.desiide/project.json` apply.
4. AC4: `engine.test.ts` › "AC4 snapshot of the fixture repo":
   - `__snapshots__/fixture-bundle.md`: the full rendered context for files, a selection, a folder, `.env`, working and staged diffs, and open editors.
   - `__snapshots__/fixture-tight.md`: the selection-centred cut at 400 tokens.
   - `engine.test.ts.snap`: sections, `FileMeta[]`, and the omitted list.
   - The fixture repo is `__fixtures__/repo.ts`. It's built in a temp dir with real git, gitignored and binary files, and staged and unstaged changes.
- Also tested: a selection merged into its attached file, missing paths, a non-git workspace, no ripgrep (no map, folder reported), no workspace, abort, and repo config that names programs (`diff.external`, `core.pager`, `core.fsmonitor`) never running them.
- **Task engine:** `engine.test.ts` › "with the task engine". The fake model's first request has the file's numbered contents in the first message and `CONTEXT_GUIDANCE` in `system`.
- **Bundle smoke test:** the bundled `dist/orchestrator.js` over real stdio, with a local Ollama (`qwen2.5vl:3b`) and a temp git repo:
  - Setup: `src/app.ts` attached, plus an uncommitted change and an attached `.env`.
  - Log: `context gathered`, `budgetTokens: 8192` (from the model's 32k window), 4 sections, and `.env` omitted.
  - The model answered "returns `raw.trim().toLowerCase()`, while before the uncommitted change it returned `toUpperCase()`" with no tool calls, so it read the file and the diff from the context.
  - With a wrong `DESIIDE_RG_PATH`, the task still ran and the warning was logged.

**Deviations**
- **Secrets are never inlined, even when attached.** Files matching JEV-2's sensitive globs (its defaults plus the project's `sensitiveGlobs`: `.env`, keys, `secrets/`, …) are listed as "may contain secrets, not shown; read_file asks the user first". Otherwise attaching `.env`, or just having it open, would send it to the model past the gate that makes `read_file` ask. The model can still `read_file` it, and the user approves.
- **Two levels of "sensitive".** `FileMeta.sensitive` = JEV-2's secret globs plus the brief's high-risk globs (auth, billing, payment*, `*.env*`, migrations, secrets, `*.tf`/`*.tfvars`/`*.hcl`, Dockerfiles, compose files, CI workflows). The high-risk files are ordinary code, so they *are* inlined. JEV-2's gate still uses only the secret globs for reads, so reading `src/auth/x.ts` doesn't ask. I didn't change gating, because that's JEV-2's scope (see Follow-ups).
- **`ContextBundle` is an orchestrator type, not a protocol schema.** It never crosses the RPC boundary, so FND-2 has no change.
- **The active selection arrives as `selection` refs.** `TaskContext` has no separate active-selection field: UI-2 sends the selection as a chip. A selection on a file that is also attached is merged into that file's section.
- **The implicit working-tree diff** is added only when the user attached no diff. Staged changes appear only when asked for.
- **Folder refs** list the folder (up to 200 paths) in tier 1. Its files' contents (up to 40, path order) go after the diffs (see above), so a big folder can't push out a selection.
- **Open editors** are capped at 10.
- **Line-numbered file content** matches `read_file`'s format, so line references agree across the two. `propose_edit` search text must not include the prefix, and `CONTEXT_GUIDANCE` says so.

**Known gaps**
- **Multi-root:** the listing, gitignore check, folder refs, and diff use the first root, the same as COR-3. Files in other roots are still read, but without the gitignore check. ADR-018 / COR-6 will qualify paths.
- **Binary detection without a known extension** needs a read (NUL sniff), so such files can show in the repo map by path (e.g. `data.bin.txt`). Their contents never do.
- **No caching:** the listing and diff are recomputed for each task. On a very large repo, the listing is capped at 8 MB of paths; a truncated listing disables the gitignore check for refs (they're then included).
- **`omitted` text is English-only**, the same as the rest of the model-facing text.
- **Coverage isn't measured** (no coverage provider; FND-1 follow-up). Every file in `src/context/` has direct tests.

**Follow-ups**
- **JEV-2 / planning:** decide whether reads or edits in the high-risk areas (`FileMeta.sensitive` but not secret) should affect gating. Today they only reach Jev state and UI-4.
- **JEV-2 known gap (`search` showing lines from sensitive files):** `createContextSensitivity().secret` can drive rg `--glob !…` excludes in COR-3's `search`.
- **COR-5 / JEV state:** call `engine.build()` once per task and pass `bundle` (it has `files`) to `buildWorkflowSelectState` and `buildCostRouteState`, instead of calling `gather` and `build` separately.
- **UI-4:** `edit_proposed.files` now carries real `FileMeta` (`sensitive`, `language`, `sizeLines`).
- **UI-3 (optional):** show what context was sent (sections, tokens, omitted). That needs an additive task event; `ContextBundle` already has the data.
