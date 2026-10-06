# MOD-1 · Model core

**Status:** done · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-model-adapters

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
**Built (branch `mod/MOD-1-model-core`):** `@desiide/models` (`src/`) and `@desiide/models/testing`, plus the orchestrator wiring.

**Entry points**
- **Interface** (`types.ts`):
  - `ModelAdapter {id, provider, model, capabilities(signal?), chat(req, signal), complete?, edit?}`.
  - `ChatRequest {messages, system?, tools?, maxTokens?, temperature?}`.
  - `ChatMessage` is `user | assistant(+toolCalls) | tool(toolCallId, name, content, isError?)`.
  - `ToolSpec {name, description, inputSchema}`. COR-3's `toolSpecs()` output is assignable to it.
  - `ToolCallRequest {id, name, args}`. `args` is the **raw JSON string**, so COR-2 parses it and can feed malformed args back to the model (its AC7).
  - `StreamEvent` is `text_delta | tool_call | usage | done{stopReason} | error{error: {kind, message, hint?, status?}}`, with zod schemas for each.
  - `DiffSpec`, `CompleteRequest`.
  - **Stream rule:** every stream ends with exactly one `done` or `error`, nothing follows it, and adapters never throw.
- **Errors** (`errors.ts`):
  - `ModelError(kind, message, {hint, status, retryAfterMs, secrets})` uses the protocol's `ModelErrorKind`. Message and hint are redacted at construction and the cause is dropped.
  - Helpers: `toModelError`, `errorEvent`, `defaultHint`.
- **`FakeModelAdapter`:** `createFakeModelAdapter({turns, capabilities, …})` from `@desiide/models/testing`.
  - A turn is `FakeTurn {text, toolCalls, usage, error, stopReason, delayMs, hang}`.
  - It records `calls` and has `push()`. When it runs out of turns it ends with an `unknown` error, so runaway loops fail loudly.
  - A `hang` turn waits until aborted, which COR-2's cancel test needs.
- **HTTP** (`http.ts`): `httpRequest(req, {signal, secrets, timeouts, retry, fetch, logger, sleep, random})` resolves once a 2xx response's headers arrive. `res.body()` yields chunks under the first-byte and idle timeouts.
  - The pieces are exported for table tests: `isRetryable`, `classifyStatus`, `parseRetryAfter`, `retryDelay`.
  - `ModelLogger` is a structural subset of pino.
- **SSE** (`sse.ts`): `parseSse(chunks, {stopAtDone})`.
- **Edit fallback** (`edit-fallback.ts`):
  - `EDIT_FORMAT_PROMPT`, `buildEditPrompt`.
  - `parseEditBlocks(text, {files?})` returns `{ok, edits} | {ok: false, errors[]}`.
  - `editViaChat(adapter, spec, signal)` and `edit(adapter, spec, signal)` (native edit when available, else the fallback).
  - Also here: `complete(adapter, req, signal)` (chat fallback) and `collectTurn(stream)`.
- **Secrets** (`secrets.ts`): `createSecretResolver(requestSecret)` caches values in memory and shares concurrent lookups. Misses and failures aren't cached, and `clear()` resets it.
- **Registry** (`registry.ts`): `createModelRegistry({providers, requestSecret, fetch?, logger?})` provides:
  - `configure(config)`, `get(id)`, `forRole(role)`, `capabilities(id)` (config values override probed ones), `config(id)`, `list({discover})`, `test(id)`, `knownSecrets()`.
  - Providers plug in as a `ProviderDefinition {create(ctx), discover?}`. `ctx` is `{config, apiKey(signal), secrets(), fetch?, logger?}`.
  - **MOD-2/MOD-3 add their providers to `BUILTIN_PROVIDERS` in `providers.ts`.** The orchestrator picks them up with no other change.
- **Contract harness:** `runAdapterContract(factory, fixtures)` from `@desiide/models/testing`.
  - `fixtures` is `{text, toolCalls?, errors?, cancel?, request?}`.
  - Every scenario runs the stream invariants (`assertStreamInvariants`): valid events, exactly one terminal event and it's last, at most one `usage`, unique tool call ids, never throws.
  - If an adapter reports `toolCalls: true`, the `toolCalls` fixture is mandatory.
  - `parseFixture` / `loadFixture` / `replayFetch` replay the recorded `.jsonl` exchanges (format documented in `testing/fixtures.ts`). They refuse fixtures that record `authorization`, `x-api-key` or cookie headers.
- **Orchestrator:**
  - `host/main.ts` creates the registry and registers `models.list`, `models.test` (`models/handlers.ts`) and `config.update` (`config/handler.ts`).
  - `registerConfigUpdate(host, listeners[])`: **JEV-\* add a listener there**, because a method can only be registered once.
  - `StartOptions.configure` now also receives `{logger}` (additive).

**Evidence**
1. AC1: `sse.test.ts`. Every split point is tested for `\n`, `\r\n` and `\r` line endings (string chunks), and every byte split is tested, including inside multi-byte UTF-8 characters. Also covered: one-byte chunks, a CR and LF split across chunks, multi-line `data:`, `:` comments, `[DONE]` (stops pulling the source), a final event with no trailing blank line, and empty/lone `data` fields.
2. AC2: `http.test.ts` › "retry policy table" (which statuses retry, error classification, `retry-after` as seconds and as an HTTP date, backoff and jitter).
   - "httpRequest retries" covers: 429/5xx retried 3×, then success or giving up; `retry-after` honored; a `retry-after` over 60 s isn't waited for; 400/401/403/404/422 are never retried; network errors are retried.
   - **"never retries once the body has started streaming"** (fetch is called once).
   - Cancel during backoff is covered too, and the timeouts: connect, first token, idle, user abort mid-stream.
3. AC3: `edit-fallback.test.ts`.
   - Accepted: fenced (path inside or before the fence) and unfenced blocks, decorated path lines, CRLF output, CRLF kept for CRLF files, multiple files and blocks, empty SEARCH/REPLACE, marker lengths 5–9, and fences inside content.
   - Rejected as ambiguous: two dividers, a SEARCH that matches more than once, a block whose file can't be determined, a missing divider, unterminated or nested blocks, stray markers, unsafe paths, and files the model wasn't shown.
   - Any bad block rejects the whole reply.
4. AC4: a sentinel key is checked in three places:
   - `http.test.ts` › "key redaction (sentinel key)": the key appears in the URL `?key=`, the `Authorization` header, an echoed error body, network error text, and every failure path (401, retried 503, network, 429 over the cap, context length, connect timeout). It's in none of `message`, `hint`, `toInfo()`, `stack`, the JSON form, or any log line.
   - `registry.test.ts` › "sentinel key never leaks": end to end through registry, provider, http and `models.test`/`models.list` results and logs.
   - A raw key pasted where a `secret:` ref belongs is not echoed.
5. AC5: `testing/contract.test.ts` runs `runAdapterContract` against `FakeModelAdapter` and against a small SSE adapter over recorded fixtures (a template for MOD-2/3). It also has negative tests showing the invariants catch broken adapters.

Also:
- `orchestrator/src/models/handlers.test.ts`: `config.update`, then `models.list`/`models.test` over in-memory JSON-RPC, including the key coming through `secrets.get` and a missing key giving `auth` with a hint.
- A manual smoke run of the **bundled** `orchestrator.js` over stdio: `config.update` → `models.list` → `models.test` gives the expected "provider not available in this build".
- `scripts/verify.sh` green: 760 tests (132 in `@desiide/models`).

**Deviations**
- **No separate interface PR.** The whole module landed in one session and COR-2 hadn't started, so the interface is the first commit of this PR (`feat(MOD-1): ModelAdapter interface…`) instead of its own PR.
- **The protocol wins over the skill doc:**
  - The provider is `openai-compatible` (not `openai-compat`).
  - Capabilities are the protocol's `ModelCapabilities {streaming, toolCalls, contextTokens, maxOutputTokens?, vision}`. There's no `costTier`/`typicalLatencyMs`: cost is `ModelConfig.costPerMTok`, read via `registry.config(id)`.
  - Error kinds are the protocol's (`server`/`bad_request`/`cancelled`/`unknown`, no `provider`).
  - The skill doc (`ide-model-adapters`) should be updated by the planning session.
- **`complete` is optional** on the interface, like `edit`. The `complete()` helper falls back to one tool-less chat turn.
- **Timeouts:**
  - "Connect 10 s" is measured until response headers arrive.
  - "First token 60 s" is measured from the headers to the first body chunk.
  - Timeouts aren't retried (only 429/5xx/network are).
  - All of them can be overridden per call.
- **Retry:** 3 retries (4 attempts), backoff of 50–100 % of min(8 s, 500 ms·2ⁿ) (jittered). `retry-after` wins, but a `retry-after` over 60 s fails fast as `rate_limit` (with `retryAfterMs`) instead of blocking a task.
- **Roles:** an unset role falls back to the only configured model, so a single Ollama model works without role setup. With 2+ models, an unset role is an actionable error. `ModelInfo.role` shows the first matching role (cheap → strong → reviewer), because the protocol has a single field.
- **Discovery** only queries base URLs the user configured (privacy rule). Discovered ids are `<provider>:<model>`.
- **Health:** `healthy` is false when the provider is missing from the build, the capability probe failed, or the last `models.test` failed. It resets on `config.update`.
- **Edit-block line endings:** output is normalized to `\n`. When the original file uses CRLF, SEARCH/REPLACE are converted back to CRLF so `propose_edit` matches exactly. Pathless blocks continue the previous file only if nothing but blank or fence lines separate them.
- **COR-3 follow-up done:** `orchestrator/src/tools/specs.test.ts` now drives its round-trip through `FakeModelAdapter` (`ChatRequest.tools` → `tool_call` events → `executeToolCall`). The assertions are unchanged.

**Known gaps**
- No providers yet: a configured model lists as `healthy: false` and tests as "provider not available in this build" until MOD-2/MOD-3.
- The extension doesn't send `config.update` yet (UI-6), so in the app the registry stays empty.
- Coverage isn't measured (no coverage provider; FND-1 follow-up). Every file has direct tests.
- The usage invariant (at most one `usage` event per stream) means adapters must merge provider usage, e.g. Anthropic's start and end usage.

**Follow-ups**
- **MOD-2:** Ollama can hold response headers while it loads a model, which can exceed the 10 s connect timeout. Pass `timeouts: {connectMs: …}` for the Ollama preset, or probe `/api/ps`. Set `num_ctx` from the capabilities.
- **MOD-2/3:** add a provider to `BUILTIN_PROVIDERS`, call `runAdapterContract` with `replayFetch(loadFixture('test/fixtures/<provider>/*.jsonl'))`, pass `ctx.secrets()` to `httpRequest`, and yield `errorEvent(toModelError(e, signal, ctx.secrets()))` from a catch-all.
- **COR-2:** use `registry.forRole(...)`, and `collectTurn` or the raw stream. Use `createFakeModelAdapter` with `hang: true` for the cancel AC.
- **UI-6:** push `config.update` on activation and on settings change, and show `models.test` errors' `hint`.
- **Planning:** update `ide-model-adapters` (provider name, capability fields, error kinds, test paths are `src/testing/`).
