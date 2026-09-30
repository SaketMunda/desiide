---
name: ide-model-adapters
description: Adding or changing model providers — the ModelAdapter interface, model config format, OpenAI-compatible / Ollama / Anthropic adapters, streaming, tool calls, retries, rate limits. Load before editing packages/models or model settings.
---

# Model adapters

## Interface
```ts
interface ModelAdapter {
  readonly id: string;                 // config id, e.g. "local-small"
  capabilities(): Promise<ModelCapabilities>;
  complete(req: { codeContext: string; instruction: string }, signal): Promise<string>;
  chat(req: { messages: ChatMessage[]; tools?: ToolSpec[]; system?: string }, signal): AsyncIterable<StreamEvent>;
  edit?(spec: DiffSpec, signal): Promise<FileEdit[]>;  // only if natively supported
}
type ModelCapabilities = {
  contextTokens: number; maxOutputTokens: number;
  toolCalling: boolean; streaming: boolean;
  typicalLatencyMs?: number;
  costTier: 'free'|'cheap'|'standard'|'expensive';
  costPerMTok?: { input: number; output: number };
  languages?: string[];
};
```
`StreamEvent` is normalized: `text_delta | tool_call | usage | done | error`. The orchestrator never sees provider-specific shapes.

If `edit` is missing, `packages/models/src/edit-fallback.ts` implements it via `chat` using the search/replace block format.

## Config
The `desiide.models` setting (or `~/.desiide/models.json`):
```json
{ "models": [
  { "id": "local-small", "provider": "ollama", "model": "qwen2.5-coder:7b",
    "baseUrl": "http://localhost:11434/v1", "costTier": "free" },
  { "id": "cloud-strong", "provider": "anthropic", "model": "claude-sonnet-5",
    "apiKey": "secret:anthropic", "costTier": "expensive" },
  { "id": "any-openai", "provider": "openai-compat", "model": "gpt-x",
    "baseUrl": "https://api.example.com/v1", "apiKey": "secret:example" }
]}
```
Keys are always `secret:<name>` references. The extension resolves them from VS Code SecretStorage when the orchestrator asks via the `secrets.get` RPC, and they are held in memory only. Workflows address models by role (`desiide.roles.cheap|strong|reviewer`), never by ID. Config-declared capabilities override probed ones.

## Providers
- **openai-compat**: `POST {baseUrl}/chat/completions` with `stream: true`, SSE parse, and accumulate `tool_calls` deltas by index. Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, vLLM, LM Studio, and llama.cpp server.
- **ollama**: openai-compat preset plus `GET /api/tags` for discovery and `/api/show` to detect tool support and context length. If the model can't call tools, fall back to the edit protocol.
- **anthropic**: official `@anthropic-ai/sdk`. **Load the `claude-api` skill first** for current model IDs, params, and caching rules. Use prompt caching on the system prompt and the stable repo context.

## HTTP rules (shared `http.ts`)
- Timeouts: connect 10 s, first token 60 s, idle between chunks 30 s.
- Retry 429/5xx/network up to 3× with exponential backoff + jitter, honoring `retry-after`. Never retry 4xx other than 429. Never retry once streaming has started.
- Errors are normalized to `ModelError{kind: auth|rate_limit|context_length|timeout|provider|network}`, with the key redacted from any logged URL or header.

## Testing
- Contract suite `test/contract.ts` runs against every adapter using recorded fixtures (`test/fixtures/<provider>/*.jsonl`).
- Live tests only run with `DESIIDE_LIVE=1` and keys in the env.

## Gotchas
- Some OpenAI-compat servers send `tool_calls` arguments as full JSON in one chunk and others as fragments. Always accumulate by index.
- Ollama silently truncates at `num_ctx`. Set it explicitly from the capabilities.
- Anthropic requires alternating user/assistant turns, and tool results are user-role content blocks. Normalize in the adapter, not the loop.
- Token counts: use provider-reported `usage` for budgets. Only estimate (chars/4) for pre-flight context trimming.
