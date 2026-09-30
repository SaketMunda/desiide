# COR-3 · Tool runner

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-orchestration-core

## Purpose
Safe, workspace-confined implementations of every tool the agent can call, plus the model-facing tool specs.

## Scope
Each tool = `{name, argsSchema (zod), spec (JSON schema for models), sideEffect, run(args, ctx, signal)}`.

| Tool | sideEffect | Notes |
|---|---|---|
| `read_file` | none | line ranges; max 2,000 lines per call |
| `list_files` | none | gitignore-aware, depth-limited |
| `search` | none | ripgrep via bundled `@vscode/ripgrep`; result cap |
| `propose_edit` | workspace | validates search blocks exist *now*; returns `EditProposal`; never writes |
| `shell` | external | cwd = workspace root, scrubbed env (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`), timeout 120 s default, 64 KB tail cap, `detached` + process-group kill |
| `run_tests` / `lint` | external | commands from `ProjectConfig`; exit code + summarized tail |
| `git_read` | none | `status`, `diff`, `log`, `show` only |

- Path confinement: resolve `realpath`, reject anything outside the workspace root(s), including through symlinks and `..`.
- `ProjectConfig` loader for `.desiide/project.json`, with auto-detection fallback (package.json `test`/`lint` scripts, `pytest`, `cargo test`, `go test`).

## Out of scope
Deciding *whether* a tool may run (JEV-2 / COR-2 gate).

## Acceptance criteria
1. Adversarial path tests: `../`, absolute paths, symlink to `/etc`, and Unicode tricks all rejected.
2. Shell: timeout kills grandchildren. Output over the cap is tail-truncated with a marker. Env scrub verified.
3. `propose_edit` with a missing search block returns a structured error (so the model can retry).
4. Test-command auto-detection works for a Node, a Python, and a Go fixture repo.
5. Tool specs validate as JSON Schema and round-trip through the fake model.

## Handoff notes
_(filled by the build session)_
