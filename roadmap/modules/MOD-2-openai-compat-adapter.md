# MOD-2 · OpenAI-compatible + Ollama adapter

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** MOD-1 · **Skills:** ide-model-adapters

## Purpose
One adapter that covers most of the world: OpenAI, OpenRouter, Gemini's OpenAI endpoint, vLLM, LM Studio, llama.cpp, and **Ollama** (as a preset).

## Scope
- `OpenAICompatAdapter`: `chat` (streaming, tool calls accumulated by index), `complete`, `edit` via fallback, `usage` from the stream (`stream_options.include_usage` when supported).
- Provider quirks table (per base-URL heuristics or explicit `quirks` in config): no `stream_options`, tool-call args as a single chunk, `max_tokens` vs `max_completion_tokens`.
- `OllamaPreset`: default `baseUrl http://localhost:11434/v1`, discovery via `GET /api/tags`, capability probe via `/api/show` (context length, tool support), explicit `num_ctx`. Non-tool models use the edit-fallback protocol and a text-based tool format.
- Auto-detect a running Ollama for onboarding (UI-6 calls `models.list` with `discover: true`).

## Acceptance criteria
1. Passes the MOD-1 contract suite with recorded fixtures for OpenAI-style and Ollama-style streams.
2. Fragmented and single-chunk tool-call fixtures both parse correctly.
3. Ollama not running → `network` error kind with a friendly "Is Ollama running?" hint.
4. Live smoke (`DESIIDE_LIVE=1`) against a local Ollama `qwen2.5-coder` completes a tool call.

## Handoff notes
_(filled by the build session)_
