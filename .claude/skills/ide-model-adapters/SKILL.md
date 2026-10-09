---
name: ide-model-adapters
description: Adding or changing model providers — the ModelAdapter interface, model config format, OpenAI-compatible / Ollama / Anthropic adapters, streaming, tool calls, retries, rate limits. Load before editing packages/models or model settings.
---

# Model adapters

## Interface (`packages/models/src/types.ts`)
```ts
interface ModelAdapter {
  readonly id: string;                 // config id, e.g. "local-small"
  readonly provider: ModelProvider;    // 'openai-compatible' | 'ollama' | 'anthropic'
  readonly model: string;              // provider model name
  capabilities(signal?): Promise<ModelCapabilities>;
  chat(req: ChatRequest, signal): AsyncIterable<StreamEvent>;   // never throws
  complete?(req: CompleteRequest, signal): Promise<string>;     // fallback: `complete()` helper
  edit?(spec: DiffSpec, signal): Promise<FileEdit[]>;           // only if natively supported
}
// From @desiide/protocol:
type ModelCapabilities = { streaming: boolean; toolCalls: boolean; contextTokens: number;
                           maxOutputTokens?: number; vision: boolean };
```
- `ChatRequest = {messages, system?, tools?: ToolSpec[], maxTokens?, temperature?}`. `ChatMessage` is `user | assistant(+toolCalls) | tool(toolCallId, name, content, isError?)`.
- `ToolCallRequest.args` is the **raw JSON string**. The orchestrator parses it, so malformed args go back to the model.
- `StreamEvent` is normalized: `text_delta | tool_call | usage | done{stopReason} | error{error: {kind, message, hint?, status?}}`. Every stream ends with exactly one `done` or `error`, nothing follows it, and there's at most one `usage` (merge provider start/end usage).
- Cost is not a capability: it's `ModelConfig.costPerMTok`, read via `registry.config(id)`.
- If `edit` is missing, `edit()` in `src/edit-fallback.ts` uses `chat` with the search/replace block format.

## Config
The `desiide.models` setting, pushed to the orchestrator with `config.update` (`DesiideConfig`):
```json
{ "models": [
  { "id": "local-small", "provider": "ollama", "model": "qwen2.5-coder:7b",
    "baseUrl": "http://localhost:11434/v1" },
  { "id": "cloud-strong", "provider": "anthropic", "model": "<current id from the claude-api skill>",
    "apiKey": "secret:anthropic", "costPerMTok": { "input": 3, "output": 15 } },
  { "id": "any-openai", "provider": "openai-compatible", "model": "gpt-x",
    "baseUrl": "https://api.example.com/v1", "apiKey": "secret:example",
    "capabilities": { "contextTokens": 128000 }, "locality": "cloud" }
]}
```
- Keys are always `secret:<name>` references. The extension resolves them from VS Code SecretStorage (key `<name>`) when the orchestrator asks via the `secrets.get` RPC, and they're held in memory only.
- Workflows address models by role (`desiide.roles.cheap|strong|reviewer`), never by ID (ADR-007). With a single configured model, an unset role falls back to it.
- Config-declared `capabilities` override probed ones.
- `locality` (`local | cloud`, ADR-017) is optional: `inferLocality()` treats Ollama and loopback `baseUrl`s as local and everything else as cloud. Routing and privacy decisions rely on it.
- `quirks` (`{streamUsage?, maxTokensField?}`, openai-compatible only) is optional. Leave it unset unless a server needs an override (see Providers).

## Registry (`src/registry.ts`)
`createModelRegistry({providers, requestSecret})` gives `configure`, `get`, `forRole`, `capabilities`, `config`, `list({discover})`, `test`. New providers go in `BUILTIN_PROVIDERS` (`src/providers.ts`) as a `ProviderDefinition {create(ctx), discover?, defaultBaseUrl?}`. The orchestrator picks them up with no other change.
- `create` may throw for an unusable config (e.g. openai-compatible without a `baseUrl`). The registry then lists the model as unavailable, with that reason.
- `defaultBaseUrl` is used for models without a `baseUrl`. With `list({discover: true})`, a **loopback** default is also probed when nothing is configured: that's how onboarding (UI-6) finds a running Ollama. A non-loopback default is never probed. Otherwise discovery only touches configured base URLs.
- Discovered ids are `<provider>:<model>` and are deduped.

## Providers
- **openai-compatible** (`openai-compat.ts`): `POST {baseUrl}/chat/completions`, SSE. Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, vLLM, LM Studio and llama.cpp. A `baseUrl` is required: there's no implicit `api.openai.com`, because no request goes to an endpoint the user didn't configure.
  - Tool calls go through `createToolCallAccumulator` (`tool-calls.ts`): by `index`, else `id`, else onto the latest call. A new id on a reused index starts a new call. Calls are emitted after the text, before `usage` and `done`.
  - **Quirks** (`quirks.ts`, `ModelConfig.quirks`): `streamUsage` (send `stream_options.include_usage`) and `maxTokensField` (`max_tokens | max_completion_tokens`). Explicit config wins, then the host table (OpenAI/Azure → `max_completion_tokens`, Mistral → no `stream_options`), then the defaults. If a server rejects one of these fields, `adaptQuirks` retries once with the other setting and keeps it. Add new servers to the host table, not to the adapter.
  - Default capabilities: `toolCalls: true`, `contextTokens: 8192`. The server can't be asked, so users set `capabilities` in the config.
- **ollama** (`ollama.ts`): **native API**, not `/v1`. Ollama's `/v1` ignores `num_ctx` and silently truncates at 4096 (measured on 0.40). A `/v1` `baseUrl` is accepted and stripped (`ollamaRoot`).
  - `capabilities()` probes `POST /api/show`: tools and vision from `capabilities[]`, the window from `model_info.*.context_length`. A successful probe is cached; a failed one isn't.
  - `num_ctx` is sent on every `/api/chat` and equals the reported `contextTokens`. Precedence: config `capabilities.contextTokens`, then a Modelfile `num_ctx`, then `OLLAMA_DEFAULT_CONTEXT` (32k). It's always capped at the model's maximum. Don't request the full 128k–256k window: the KV cache would take gigabytes.
  - Stream: NDJSON (`parseNdjson`). Each tool call arrives whole, and `done_reason` is `"stop"` even after tool calls (mapped to `tool_calls`). `message.thinking` is dropped for now.
  - Errors: an unreachable server gives `network` + `OLLAMA_NOT_RUNNING_HINT`. A 404 "not found" gives `bad_request` + "`ollama pull <model>`". Chat retries once, and probes and discovery don't retry, so "not running" shows up fast.
  - Discovery: `GET /api/tags`. Embedding-only models are skipped, and names are deduped (Ollama really lists some twice).
- **Models without native tool calls** (Ollama probe says no `tools`, or `capabilities.toolCalls: false`) use the text tool protocol in `text-tools.ts`:
  - The tools are described in the system prompt, and the model writes `<tool_call>{"name","arguments"}</tool_call>` blocks (Qwen/Hermes format).
  - `createTextToolParser` turns those blocks into normal `tool_call` events, so the loop can't tell the difference.
  - `textToolsMessages` renders history as text.
  - Edits use the search/replace fallback.
- **anthropic**: official `@anthropic-ai/sdk`. **Load the `claude-api` skill first** for current model IDs, params, and caching rules. Use prompt caching on the system prompt and the stable repo context. Merge start and end usage into one `usage` event.
- No adapter implements `complete` natively. The `complete()` helper (one tool-less chat turn) covers it.

## HTTP rules (shared `http.ts`)
- Timeouts: connect 10 s, first token 60 s, idle between chunks 30 s.
- Retry 429/5xx/network up to 3× with exponential backoff + jitter, honoring `retry-after`. Never retry 4xx other than 429. Never retry once streaming has started.
- Errors are normalized to `ModelError(kind)` with the protocol's `ModelErrorKind`: `auth | rate_limit | context_length | bad_request | server | network | timeout | cancelled | unknown`. Message and hint are redacted at construction (`secrets`), so a key never reaches a log, URL, or header dump.
- Adapters yield `errorEvent(toModelError(e, signal, ctx.secrets()))` from a catch-all instead of throwing.

## Testing
- `runAdapterContract(factory, fixtures)` from `@desiide/models/testing` (source in `src/testing/`) runs against every adapter: text, tool calls (mandatory if the adapter reports `toolCalls: true`), error kinds, pre-abort, and cancel mid-stream. It replays `packages/models/test/fixtures/<provider>/*.jsonl` via `replayFetch(loadFixture(...))`. Fixtures that record `authorization`, `x-api-key`, or cookie headers are refused.
- Record fixtures from a real server when you can: a plain `fetch` that writes `{"response":…}`, then one `{"chunk":…}` line per body chunk. Trim large bodies to the fields the adapter reads. Write down where each fixture came from in `test/fixtures/README.md`.
- An adapter that probes first (Ollama `/api/show`) needs that exchange **before** the chat exchange in the fixture. `replayFetch` serves exchanges in order, and running out is a loud error.
- Cover both tool-call shapes (fragmented and single-chunk), a truncated stream (must end with `network`, never `done`), an error inside a 200 stream, and a sentinel key that never appears in events.
- Orchestrator tests use `createFakeModelAdapter({turns})` from `@desiide/models/testing`.
- Live tests are `*.live.test.ts` with `describe.skipIf(process.env.DESIIDE_LIVE !== '1')`. Pick the model with an env var (e.g. `DESIIDE_LIVE_OLLAMA_MODEL`, default `qwen2.5-coder:7b`). Keys come from the env and never from fixtures.

## Gotchas
- Some OpenAI-compat servers send `tool_calls` arguments as full JSON in one chunk and others as fragments, some without `index`. Always use the accumulator.
- Ollama silently truncates at `num_ctx`, and `/v1` ignores it. Use the native API.
- Some servers end a tool-call turn with `finish_reason: "stop"`. When calls were emitted, the stop reason is `tool_calls`.
- A stream that closes with no `finish_reason`/`[DONE]` (OpenAI) or `done: true` (Ollama) was cut off. Report `network`.
- Anthropic requires alternating user/assistant turns, and tool results are user-role content blocks. Normalize in the adapter, not the loop.
- Token counts: use provider-reported `usage` for budgets. Only estimate (chars/4) for pre-flight context trimming.
