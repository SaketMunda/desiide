# COR-6 · Multi-root workspaces

**Status:** todo · **Milestone:** Beta · **Size:** M · **Depends on:** COR-3, UI-2, UI-4 · **Skills:** ide-orchestration-core, ide-editor-shell

## Purpose
Make every Desiide feature work the same in a VS Code workspace with several folders (multi-repo setups, monorepo plus tooling repo), as decided in ADR-018: in a multi-root workspace, a path starts with its folder's label.

## Scope
- **Protocol (additive):** `initialize` gains `workspaceFolders?: {name, path}[]`. The orchestrator falls back to `workspaceRoots` with basenames as labels when it's absent. Document the rule in `docs/protocol.md`: one folder → plain relative paths; two or more → `<label>/<relative path>`.
- **Labels:** the extension sends `WorkspaceFolder.name`, made unique within the session (`api`, `api-2`). Labels are fixed for the session; renaming or adding a folder restarts the orchestrator session the way a workspace change does today.
- **COR-3:** `resolveWorkspacePath` takes the first segment as the folder label when there's more than one root. An unknown label is an error the model can retry from ("unknown folder `x`; folders: api, web"). Confinement is per folder: realpath must stay inside *that* folder. `list_files` / `search` results and `shell` / `run_tests` / `lint` take a folder: tools that run commands gain an optional `folder` arg (default: the first folder), and test/lint commands come from each folder's own `.desiide/project.json`.
- **Extension:** UI-2's `@file` / `@folder` chips emit qualified paths. UI-4's apply step and the `desiide-proposed:` diff provider map qualified paths back to URIs. Open-editor lists are qualified.
- **Jev / decision log:** labels are path segments like any other (redacted unless allow-listed). No absolute path is ever logged or sent.
- **Single-folder workspaces must not change at all.**

## Out of scope
Remote / virtual file systems (they're filtered out today and stay so), and workspace trust differences between folders.

## Acceptance criteria
1. The model creates a new file in folder #2 and edits a file in folder #1 in one task. The diff review and apply land in the right folders.
2. The same relative path in two folders (`api/src/index.ts`, `web/src/index.ts`) is never confused by read, search, edit, or apply.
3. Adversarial: `api/../web/x`, a label spoofed via Unicode lookalikes, a symlink from one folder into another or outside, and an unknown label are all rejected or confined (reuse COR-3's adversarial suite).
4. A single-folder workspace produces byte-identical paths to before (regression test).
5. `shell` / `run_tests` with `folder: "web"` run in that folder with its own project config.

## Handoff notes
_(filled by the build session)_
