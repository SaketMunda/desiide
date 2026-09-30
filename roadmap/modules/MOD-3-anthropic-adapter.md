# MOD-3 · Anthropic adapter

**Status:** todo · **Milestone:** Alpha · **Size:** S · **Depends on:** MOD-1 · **Skills:** ide-model-adapters, **claude-api (load first for current model IDs, params, caching)**

## Purpose
A native Claude adapter using the official `@anthropic-ai/sdk`. It's the default `strong` role for most users.

## Scope
- Map normalized messages ↔ Anthropic format (system separate, alternating turns, tool results as user-role `tool_result` blocks).
- Streaming with tool use. `usage` including cache read/write tokens.
- Prompt caching on the system prompt + stable repo-map section (COR-4 marks cacheable sections).
- Capabilities from a small model table (context window, max output, cost per MTok). Config can override it.
- Error mapping to `ModelError` kinds (overloaded → `rate_limit`, prompt too long → `context_length`).

## Acceptance criteria
1. Passes the MOD-1 contract suite with recorded fixtures.
2. Message-mapping tests: consecutive same-role messages merged; tool call/result pairing preserved.
3. Cache-control markers placed only on cacheable sections (asserted from request snapshot).
4. Live smoke under `DESIIDE_LIVE=1`.

## Handoff notes
_(filled by the build session)_
