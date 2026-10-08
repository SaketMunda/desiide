# MOD-2 · OpenAI-compatible + Ollama adapter

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** MOD-1 · **Skills:** ide-model-adapters

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
**Built (branch `mod/MOD-2-openai-compat-adapter`):** both providers are in `BUILTIN_PROVIDERS`, so the orchestrator serves them with no other change.

**Entry points** (all exported from `@desiide/models`)
- `createOpenAICompatAdapter(ctx)` (`openai-compat.ts`): `POST {baseUrl}/chat/completions`, SSE.
  - Text deltas stream as they arrive. Tool calls are accumulated (`tool-calls.ts`) and emitted before `usage` and `done`.
  - The accumulator joins deltas by `index`, else by `id`, else onto the latest call. A new id on a reused index starts a new call. Missing or duplicate ids are generated.
  - `usage` comes from `stream_options.include_usage`, and `cached_tokens` maps to `cacheReadTokens`.
  - A server error inside a 200 stream becomes an error event. A stream that ends with no `finish_reason` and no `[DONE]` is a `network` error, never a silent `done`.
  - `"stop"` with tool calls maps to `stopReason: 'tool_calls'`, because Ollama and older vLLM send it.
- **Quirks** (`quirks.ts`):
  - `resolveQuirks(config)` applies explicit `config.quirks`, then the host table (OpenAI/Azure → `max_completion_tokens`; Mistral → no `stream_options`), then the defaults.
  - `adaptQuirks(error, quirks)`: when a server rejects `stream_options` or the max-tokens field, the adapter retries once with the other setting and keeps it for later requests.
- `ollamaProvider` / `createOllamaAdapter(ctx)` / `discoverOllama` (`ollama.ts`), on Ollama's **native** API at the server root. A `/v1` `baseUrl` is accepted and stripped.
  - `capabilities()` probes `/api/show` for tool support (`capabilities` includes `tools`), vision, and the context window. The result is cached; a failure isn't cached.
  - `chat` calls `/api/chat` (NDJSON, `ndjson.ts`) with `options.num_ctx` = `contextTokens`. Thinking chunks are dropped.
  - Hints: an unreachable server gives `network` + `OLLAMA_NOT_RUNNING_HINT`. A model that isn't pulled gives `bad_request` + "`ollama pull <model>`".
  - `discoverOllama` reads `/api/tags`. It skips embedding-only models, dedupes names (Ollama really lists some twice), and fills `toolCalls`/`vision`/`contextTokens`.
- **Text tool protocol** (`text-tools.ts`), for models without native tools (Ollama probe says no tools, or `capabilities.toolCalls: false` in the config).
  - `textToolsSystem` describes the tools. The model writes Qwen/Hermes-style `<tool_call>{"name","arguments"}</tool_call>` blocks.
  - `createTextToolParser` turns those blocks into ordinary `tool_call` events. It handles tags split across chunks, fenced JSON, and `parameters`. A call whose name is readable but whose args are broken is kept, so COR-2 feeds the error back.
  - `textToolsMessages` renders history as `<tool_call>` text plus `<tool_result>` user turns.
  - Edits use MOD-1's search/replace fallback (no native `edit`).
- **Registry:**
  - `ProviderDefinition.defaultBaseUrl` (additive) is used for models without a `baseUrl`.
  - With `list({discover: true})`, a provider's **loopback** default is probed even when nothing is configured. That's how UI-6 onboarding finds a running Ollama. A non-loopback default is never probed.
  - Discovered ids are deduped.
- **Protocol (additive):** `ModelConfig.quirks?: ModelQuirks {streamUsage?, maxTokensField?: 'max_tokens'|'max_completion_tokens'}`.

**Evidence**
1. AC1: `runAdapterContract` runs over recorded fixtures for both providers.
   - `openai-compat.test.ts`: text, fragmented tool calls, 401 → `auth`, context length, 429 with a long `retry-after` → `rate_limit`, a mid-stream error, a truncated stream, cancel mid-stream.
   - `ollama.test.ts`: text, tools, model not pulled, runner crash mid-stream, truncated, cancel.
   - Fixture provenance is in `packages/models/test/fixtures/README.md`. The Ollama and Ollama-`/v1` streams were recorded from Ollama 0.40 on this machine.
2. AC2:
   - `openai-compat.test.ts` › "parses fragmented tool calls split mid-event": two interleaved calls, argument fragments, chunk cuts mid-event, mid-JSON and between the `\n\n`.
   - "parses single-chunk tool calls (recorded from Ollama /v1)".
   - `ollama.test.ts` › "native tool calls arrive whole".
   - `tool-calls.test.ts` covers the accumulator rules.
3. AC3:
   - `ollama.test.ts` › "Ollama not running → network error with 'Is Ollama running?'" (refused fetch, for both chat and the capability probe).
   - "…against a real closed local port": real `fetch` to a port that was just freed gives `ECONNREFUSED` → `network` + hint.
   - The bundled orchestrator over stdio returns the same for `models.test`.
4. AC4: `ollama.live.test.ts` (`DESIIDE_LIVE=1`, model from `DESIIDE_LIVE_OLLAMA_MODEL`, default `qwen2.5-coder:7b`) completes a `read_file` tool call. It passed on 2026-10-08 against local Ollama 0.40 with:
   - `qwen2.5:7b` (native tools).
   - `qwen3:4b-instruct-2507` (native tools).
   - `qwen2.5vl:3b`, which has no tool support, so this run went through the **text tool protocol**.
   - `qwen2.5-coder` isn't pulled on this machine (see Deviations).
- Manual smoke of the **bundled** `orchestrator.js` over stdio:
  - `models.list {discover: true}` with no config lists the local Ollama models with no duplicates.
  - After `config.update`, `models.test` returns ok for Ollama (native) and for openai-compatible pointed at Ollama's `/v1`. An Ollama at an unreachable URL gives `network` + the hint.
- `scripts/verify.sh` green: 1488 tests (217 in `@desiide/models`) + 2 live tests skipped.

**Deviations**
- **The Ollama preset talks to the native API, not `/v1`.** Measured on Ollama 0.40, `/v1/chat/completions` ignores `options.num_ctx`: the loaded context stayed at 4096. `/api/chat` honored 12288. With `/v1`, every agent prompt over 4k tokens would be silently truncated, which is exactly the gotcha the brief's "explicit `num_ctx`" is there to prevent. The `baseUrl` stays `…:11434/v1` as the brief says (`/v1` is stripped), so configs are unchanged. Nothing else knows the transport.
- **Default `num_ctx` is 32,768**, capped at the model's maximum. A `PARAMETER num_ctx` in the Modelfile wins, and `capabilities.contextTokens` in the config wins over both. Requesting a model's full window (128k–256k) would allocate gigabytes of KV cache on a laptop. The reported `contextTokens` is the window actually requested, so context trimming (COR-4) matches what Ollama keeps.
- **No native `complete`.** The legacy `/completions` endpoint is deprecated or missing on most servers. MOD-1's `complete()` helper (one tool-less chat turn) covers it.
- **"Tool-call args as a single chunk" isn't a quirk flag.** The accumulator handles fragments and whole calls (with or without `index`) on every server, so there's nothing to configure. The quirks are `streamUsage` and `maxTokensField`.
- **Ollama chat retries once, not 3×.** A refused local connection almost always means Ollama isn't running, and the user should hear that in under a second. Probes and discovery don't retry.
- **openai-compatible needs a `baseUrl`.** There's no implicit `api.openai.com`, because no request goes to an endpoint the user didn't configure. Without one, the model lists as unavailable with the reason.
- **Discovery probes Ollama's default loopback URL when asked.** MOD-1 discovered only configured base URLs. This brief asks for auto-detect, so `discover: true` also probes `defaultBaseUrl`. That's only an explicit discover call, only a loopback address, and only a `GET /api/tags` with no data sent.
- **AC4 ran on `qwen2.5:7b`, not `qwen2.5-coder:7b`** (same family and tool template; the coder model isn't pulled here). Run `ollama pull qwen2.5-coder:7b` and `DESIIDE_LIVE=1 pnpm -F @desiide/models test ollama.live` to reproduce it as written.

**Known gaps**
- openai-compatible has no discovery: `/models` usually needs the key, and discovery has no key context.
- openai-compatible defaults to `contextTokens: 8192` (MOD-1's fallback) because the server can't be asked. Users of large cloud models should set `capabilities.contextTokens` (UI-6).
- Thinking or reasoning output (Ollama `thinking`, `reasoning_content`) is dropped. `StreamEvent` has no type for it.
- `ChatMessage` is text-only, so `vision: true` is reported but images can't be sent yet.
- The fragmented OpenAI fixture is hand-built in OpenAI's documented shape, not recorded from api.openai.com (no key on this machine).

**Follow-ups**
- **Planning:** update `ide-model-adapters` (Ollama on the native API, `num_ctx` default, quirks, `defaultBaseUrl`). Decide whether thinking should become an additive `reasoning_delta` event (UI-3 could show it collapsed).
- **UI-6:** onboarding calls `models.list {discover: true}`. Show discovered Ollama models with `toolCalls`, and show `models.test` hints. Expose `capabilities.contextTokens` and `quirks` in the settings schema.
- **COR-4:** budget with `registry.capabilities(id).contextTokens`. For Ollama it is the real `num_ctx`.
- **COR-2:** text-protocol tool calls arrive as normal `tool_call` events. Malformed args come back raw, so the existing AC7 path covers them.
