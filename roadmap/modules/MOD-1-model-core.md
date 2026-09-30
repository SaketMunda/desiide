# MOD-1 · Model core

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-model-adapters

## Purpose
The provider-agnostic layer: adapter interface, registry, config, secrets, shared HTTP, and the test harness every adapter must pass.

## Scope
- **Land the interface first** (`ModelAdapter`, `ModelCapabilities`, `ChatMessage`, `ToolSpec`, `StreamEvent`, `ModelError`) as its own small PR. COR-2 depends on it.
- `FakeModelAdapter` (scripted turns, including tool calls and usage) exported from `@desiide/models/testing`.
- Config schema: `desiide.models[]` + `desiide.roles {cheap, strong, reviewer}` (ADR-007). The extension sends config via `config.update`.
- `secret:<name>` resolution through COR-1's `requestSecret`. Resolved keys are cached in memory only, and the cache is cleared on `config.update`.
- `ModelRegistry`: build adapters from config, `models.list`, `models.test` (tiny request, latency + error kind).
- Shared `http.ts`: timeouts (connect 10 s, first token 60 s, idle 30 s), retry policy (429/5xx/network, 3×, jittered backoff, `retry-after`, never after streaming starts), SSE parser, key redaction.
- `edit-fallback.ts`: search/replace block prompt + tolerant parser → `FileEdit[]`, used by adapters without native edit.
- Contract test harness `runAdapterContract(factory, fixtures)`.

## Acceptance criteria
1. The SSE parser handles chunk boundaries mid-line, multi-line `data:`, comments, and `[DONE]`.
2. Retry policy table tests (which statuses retry, `retry-after` honored, no retry after first byte).
3. The edit-fallback parser handles fenced and unfenced blocks, CRLF, and multiple files, and rejects ambiguous blocks.
4. Keys never appear in logs or error messages (test with a sentinel key).
5. The contract harness runs against FakeModelAdapter.

## Handoff notes
_(filled by the build session)_
