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

## Registry (`src/registry.ts`)
`createModelRegistry({providers, requestSecret})` gives `configure`, `get`, `forRole`, `capabilities`, `config`, `list({discover})`, `test`. New providers go in `BUILTIN_PROVIDERS` (`src/providers.ts`) as a `ProviderDefinition {create(ctx), discover?}`. The orchestrator picks them up with no other change.

## Providers
- **openai-compatible**: `POST {baseUrl}/chat/completions` with `stream: true`, SSE parse, and accumulate `tool_calls` deltas by index. Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, vLLM, LM Studio, and llama.cpp server.
- **ollama**: `openai-compatible` preset plus `GET /api/tags` for discovery and `/api/show` to detect tool support and context length. If the model can't call tools, fall back to the edit protocol.
- **anthropic**: official `@anthropic-ai/sdk`. **Load the `claude-api` skill first** for current model IDs, params, and caching rules. Use prompt caching on the system prompt and the stable repo context.

## HTTP rules (shared `http.ts`)
- Timeouts: connect 10 s, first token 60 s, idle between chunks 30 s.
- Retry 429/5xx/network up to 3× with exponential backoff + jitter, honoring `retry-after`. Never retry 4xx other than 429. Never retry once streaming has started.
- Errors are normalized to `ModelError(kind)` with the protocol's `ModelErrorKind`: `auth | rate_limit | context_length | bad_request | server | network | timeout | cancelled | unknown`. Message and hint are redacted at construction (`secrets`), so a key never reaches a log, URL, or header dump.
- Adapters yield `errorEvent(toModelError(e, signal, ctx.secrets()))` from a catch-all instead of throwing.

## Testing
- `runAdapterContract(factory, fixtures)` from `@desiide/models/testing` runs against every adapter, replaying recorded fixtures (`test/fixtures/<provider>/*.jsonl`) via `replayFetch(loadFixture(...))`. Fixtures that record `authorization`, `x-api-key`, or cookie headers are refused.
- Orchestrator tests use `createFakeModelAdapter({turns})` from `@desiide/models/testing`.
- Live tests only run with `DESIIDE_LIVE=1` and keys in the env.

## Gotchas
- Some OpenAI-compat servers send `tool_calls` arguments as full JSON in one chunk and others as fragments. Always accumulate by index.
- Ollama silently truncates at `num_ctx`. Set it explicitly from the capabilities.
- Anthropic requires alternating user/assistant turns, and tool results are user-role content blocks. Normalize in the adapter, not the loop.
- Token counts: use provider-reported `usage` for budgets. Only estimate (chars/4) for pre-flight context trimming.
