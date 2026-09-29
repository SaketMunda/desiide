# COR-4 · Context engine

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** COR-3 · **Skills:** ide-orchestration-core

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
_(filled by the build session)_
