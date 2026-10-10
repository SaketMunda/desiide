# MOD-3 · Anthropic adapter

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** MOD-1 · **Skills:** ide-model-adapters, **claude-api (load first for current model IDs, params, caching)**

## Purpose
A native Claude adapter using the official `@anthropic-ai/sdk`. It's the default `strong` role for most users.

## Scope
- Map normalized messages ↔ Anthropic format (system separate, alternating turns, tool results as user-role `tool_result` blocks).
- Streaming with tool use. `usage` including cache read/write tokens.
- Prompt caching on the system prompt + stable repo-map section (COR-4 marks cacheable sections).
- Capabilities from a small model table (context window, max output, cost per MTok). Config can override it.
- Error mapping to `ModelError` kinds (overloaded → `rate_limit`, prompt too long → `context_length`).
- **Reasoning (ADR-022), across packages:**
  - `packages/models`: additive `reasoning_delta` `StreamEvent`; optional `ChatRequest.reasoning` and an opaque provider-owned field on assistant `ChatMessage`s.
  - `packages/protocol`: additive `ModelConfig.reasoning` (`off | low | medium | high`) and a `reasoning_delta` `TaskEvent`.
  - Anthropic: extended thinking from `reasoning` (budget per level); thinking blocks streamed as `reasoning_delta`; signed blocks round-tripped through the opaque field during tool use.
  - MOD-2 adapters: emit `reasoning_delta` from Ollama `message.thinking` and OpenAI-compatible `reasoning_content` / `reasoning` deltas; map `reasoning` to Ollama `think` and OpenAI `reasoning_effort`. Unset sends nothing.
  - COR-2 agent loop: forward `reasoning_delta` as a task event; never put reasoning text in history; drop the opaque field when the next call goes to a different model.

## Acceptance criteria
1. Passes the MOD-1 contract suite with recorded fixtures.
2. Message-mapping tests: consecutive same-role messages merged; tool call/result pairing preserved.
3. Cache-control markers placed only on cacheable sections (asserted from request snapshot).
4. Live smoke under `DESIIDE_LIVE=1`.
5. Reasoning: fixtures show `reasoning_delta` from Anthropic, Ollama (`ollama/thinking`) and an OpenAI-compatible server; an agent-loop test shows reasoning reaches the task stream but not the next request's history, and that Anthropic thinking blocks survive a tool-use turn.

## Handoff notes
_(filled by the build session)_
