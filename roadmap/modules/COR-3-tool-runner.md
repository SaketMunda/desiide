# COR-3 · Tool runner

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-orchestration-core

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
**Built (branch `mod/COR-3-tool-runner`):** `packages/orchestrator/src/tools/`, exported from `@desiide/orchestrator`.

**Entry points (for COR-2):**
- `executeToolCall({id, tool, args}, ctx, signal)` → `{result: ToolResult, proposal?, editErrors?}`. It **never throws**: an unknown tool, bad args, a path escape, a crash, or an abort all come back as a `ToolResult` with `error.kind` (`invalid_args` / `failed` / `timeout` / `cancelled`). Feed `result.output` back to the model as-is. Gating (`blocked`) happens before this call.
- `toolSpecs(task.allowedTools)` → `ToolSpec[] {name, description, inputSchema}` (JSON Schema 2020-12, `$schema` stripped, top level `type: object`, except `git_read`, which is a `oneOf` keyed on `command`). Model adapters (MOD-*) map these to provider formats.
- `TOOLS[name]` → `{name, argsSchema, spec, sideEffect, run}`. `sideEffect` matches the brief's table.
- `ToolContext`: `{workspace, taskId, projectConfig, env, rgPath, newId, trackProcessGroup?, timeouts?}`. Build it with `createWorkspace(session.workspaceRoots)`, `(await loadProjectConfig(ws)).config`, `env: process.env` (scrubbed per call), `rgPath: await resolveRgPath()`, and `trackProcessGroup: host.trackProcessGroup`.
- `loadProjectConfig(ws)` → `{config, sources: {testCommand?: 'project.json'|'detected', …}, warnings[]}`. Surface `warnings` to the user (UI-6/COR-2).
- Lower level: `resolveWorkspacePath`, `PathError`, `runProcess`, `scrubEnv`.

**Evidence:**
- AC1: `paths.test.ts`: `../` variants, absolute (POSIX, drive letter, `~`), symlink to `/etc` and to a sibling dir (existing and *new* files under it), a dangling symlink, and Unicode tricks (fullwidth/one-dot-leader dots, fullwidth/division/fraction slashes, NUL, RTL override, zero-width chars, BOM, newline, U+2028) are all rejected. The same rejections are checked end to end through `read_file`, `list_files`, `search`, `git_read`, and `propose_edit`, plus `.desiide/project.json` symlinked from outside.
- AC2: `process.test.ts`: "timeout kills the whole process group, including grandchildren" (it checks the grandchild's pid is dead); "tail-truncates output over the cap with a marker" (64 KB, the last line survives); "a child process never sees scrubbed vars"; and the `scrubEnv` unit test. `tools.test.ts › shell` repeats these through the tool.
- AC3: `proposeEdit.test.ts`: "a missing search block returns a structured error the model can retry from" (`editErrors[]` with `path`, `editIndex`, `code`, plus the same JSON as the last line of `output`). Ambiguous, whitespace-only mismatch (with a hint), missing file, binary, duplicate, and protected-path cases are covered too.
- AC4: `projectConfig.test.ts › auto-detection on fixture repos` uses the Node (pnpm), Python (pytest + ruff), and Go fixtures in `src/tools/__fixtures__/projects/`, plus yarn/bun/npm/cargo variants and `project.json` overrides.
- AC5: `specs.test.ts`: every spec passes Ajv 2020 meta-validation and compiles in strict mode. For every tool, JSON Schema and zod agree on valid and invalid samples. A fake model sees only the wire JSON of the specs, refuses spec-violating args, and drives all 8 tools through `executeToolCall` successfully.

**Deviations:**
- *No `FakeModelAdapter` yet (MOD-1 is todo).* AC5 uses a minimal fake model inside `specs.test.ts`. When MOD-1 lands, swap it in and keep the assertions.
- *`propose_edit` args are `{files: [{path, edits: [{search, replace}]}]}`* (mirrors `FileEdit[]`). Blocks within a file apply in order, each to the previous result. Every non-empty search must match **exactly once** (`search_ambiguous` otherwise), which is stricter than "exists". Empty search = insert at start / create file. All problems are reported in one go, and nothing is proposed if any block fails. Edits under `.git/` are refused (`protected_path`), because writing a hook would be code execution.
- *A non-zero exit from `shell`/`run_tests`/`lint` is `ok: false, error.kind: 'failed'`* with `exitCode` and output kept, so COR-2's success checks can use `ok` directly.
- *Background processes are killed when a shell command exits* (the group is reaped on exit as well as on timeout/abort). Otherwise a leftover child holds the pipes open and leaks. The tool description tells the model it's not for servers.
- *Env scrub is broader than the brief:* it adds `*PASSWD*` and `*CREDENTIAL*`, plus host-only vars (`ELECTRON_RUN_AS_NODE`, `VSCODE_IPC_HOOK*`, `VSCODE_GIT_*`, `GIT_ASKPASS`), so a child can't drive the editor through its IPC hook. Stricter only.
- *Timeouts:* shell 120 s (the brief), `run_tests`/`lint` 300 s, rg/git 30 s. All can be overridden via `ctx.timeouts`. `run_tests`/`lint` take **no args**, so the model can't inject into the configured command; for a filtered run it uses `shell`.
- *`git_read` hardening:* `core.fsmonitor=false`, `core.pager=cat`, `diff.external=`, `--no-ext-diff --no-textconv`, `GIT_OPTIONAL_LOCKS=0`. Repo config can otherwise make a "read" run a program (tested). Refs must match a revision pattern with no leading `-`.
- *Shell command length cap is 10,000 chars*, not `MAX_COMMAND_CHARS` (500), which caps the Jev state field. COR-2/JEV-2 must truncate the command before putting it in `RiskGateState`.
- *Multi-root:* a path resolves against the first root where it exists; new files and the shell/test cwd use the first root. `FileEdit.path` has no root identifier, so editing a not-yet-existing file in root #2 isn't expressible. That's a protocol question for later, not needed for Alpha.
- *Auto-detected lint commands:* `<pm> run lint`, `ruff check .` (only when ruff is configured), `go vet ./...`, and `cargo clippy --all-targets`. The brief only named test commands.

**Known gaps:**
- *ripgrep inside the app bundle:* esbuild can't carry `@vscode/ripgrep`'s platform binary, so in the bundled orchestrator `resolveRgPath()` returns `undefined` unless `DESIIDE_RG_PATH` is set (checked: bundled `tools` loads fine and falls back). Tests and dev use the npm binary.
- Coverage isn't measured (there's still no coverage provider; see the FND-1 follow-up). Every tool, error branch, and AC has tests (149 new tests in `src/tools/`).
- `read_file` has no sensitive-file filter (`.env` is readable and listed). Deciding what may be read is gating (JEV-2/COR-2), which is out of scope here.

**Follow-ups:**
- **Extension/COR-2:** when spawning the orchestrator, set `DESIIDE_RG_PATH` to the editor's bundled rg (`<vscode.env.appRoot>/node_modules/@vscode/ripgrep/bin/rg`, or the `node_modules.asar.unpacked` path), and have COR-2 fail the task with an actionable message if `resolveRgPath()` is `undefined`.
- **COR-2:** detect "same tool + args 3× in a row" on the `RawToolCall` (args are already JSON); `executeToolCall` is stateless.
- **COR-4** can reuse `resolveWorkspacePath`, `readTextFile`/`looksBinary`, and the rg walk rules instead of re-implementing them.
