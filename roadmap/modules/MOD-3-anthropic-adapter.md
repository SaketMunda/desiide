# MOD-3 · Anthropic adapter

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** MOD-1 · **Skills:** ide-model-adapters, **claude-api (load first for current model IDs, params, caching)**

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
**Built (branch `mod/MOD-3-anthropic-adapter`):** the `anthropic` provider is in `BUILTIN_PROVIDERS`, and reasoning (ADR-022) runs end to end from all three providers to the task stream.

**Entry points**
- **Protocol (additive):** `ReasoningLevel` (`off | low | medium | high`), `ModelConfig.reasoning?`, and the `reasoning_delta` task event `{messageId, delta}`. `messageId` matches the turn's `text_delta`s. Documented in `docs/protocol.md`.
- **Models core** (`@desiide/models`):
  - `ChatRequest.reasoning?` overrides `ModelConfig.reasoning` per call.
  - `StreamEvent` gains `reasoning_delta {text}` and `provider_state {state}` (at most one, before the terminal event; the contract checks it).
  - Assistant `ChatMessage.providerState?: {owner, data}` is opaque and owned by one adapter id. `historyFor(messages, adapterId)` drops state owned by another adapter.
  - User `ChatMessage.cacheable?` marks stable content (e.g. the repo map) for prompt caching.
  - `collectTurn` returns `reasoning` and `providerState`. `createFakeModelAdapter` turns take `reasoning` and `providerState`.
  - `ProviderDefinition.costPerMTok?(model)` (additive). `registry.config(id)` fills in the provider's published cost when the config has none.
  - `models.test` counts a `reasoning_delta` as the first answer.
- **Anthropic** (`anthropic.ts`, `anthropic-messages.ts`, `anthropic-models.ts`): `createAnthropicAdapter(ctx, {maxRetries?, timeouts?})`, `anthropicProvider`, `CLAUDE_MODELS`, `claudeModel`, `claudeCapabilities`.
  - Official `@anthropic-ai/sdk` (0.132), raw `messages.create({stream: true})`. The SDK retries 408/409/429/5xx up to 3× and honors `retry-after`. A watchdog adds the first-token (60 s) and idle (30 s) timeouts.
  - **Credentials:** a subclass turns off the SDK's ambient credential chain (env, `ant` profiles, workload identity). The key and base URL are always passed explicitly, `authToken: null`, and SDK logging is off, because stdout is the JSON-RPC channel. Without a key: `auth` + hint, and no request is sent.
  - **Mapping:** system prompt separate, consecutive same-role messages merged, `tool_result`s first in the user turn after their `tool_use`, empty text dropped. Broken pairing is repaired: an unanswered `tool_use` gets an error result, and an orphan result becomes text.
  - **Caching:** `cache_control` on the system prompt (which also covers the tools) and on `cacheable` user/tool messages only: the last flagged block of each of the latest turns, at most 4 breakpoints in all.
  - **Stream:** text and reasoning stream live. Tool calls (raw JSON, `eager_input_streaming`), `provider_state`, then one `usage` follow. `inputTokens` = input + cache read + cache write, with `cacheReadTokens` / `cacheWriteTokens` broken out.
  - **Errors:** overloaded (529 or in-stream) → `rate_limit`; prompt too long / 413 → `context_length`; 401/403 → `auth` + key hint; refusal → `bad_request` with the category; a stream without `message_stop` → `network`; a user abort → `cancelled`.
  - **Reasoning:** per-model `ThinkingStyle` (see Deviations). Thinking deltas → `reasoning_delta`. When a turn has thinking, all its blocks are kept verbatim as `providerState` and replayed by the same adapter id.
- **MOD-2 adapters:**
  - Ollama: `message.thinking` → `reasoning_delta`. `reasoning` → `think` (`ollamaThink`): `false` for off, `true` for a level, the level itself for gpt-oss, and nothing for models whose `/api/show` lacks the `thinking` capability.
  - OpenAI-compatible: `delta.reasoning_content` / `delta.reasoning` → `reasoning_delta`. `reasoning` → `reasoning_effort` (`off` → `none`). If the server rejects the field, the request is sent once more without it, and later requests leave it out.
  - Unset reasoning sends nothing anywhere.
- **COR-2 agent loop:** forwards `reasoning_delta` as a task event, never puts reasoning text into history, stores `providerState` on the assistant turn, and sends `historyFor(history, model.id)`. Every user and tool message it appends is `cacheable` (the history only grows).

**Evidence**
1. AC1: `anthropic.test.ts` › `adapter contract` runs `runAdapterContract` over the `anthropic/*` fixtures: text, two tool calls with fragmented input, 401, 529, 429, prompt too long, overloaded mid-stream, truncated, refusal, pre-abort, cancel mid-stream.
2. AC2: `anthropic.test.ts` › `message mapping (AC2)`: system separate, consecutive same-role messages merged, tool call/result pairing with results ahead of text, empty and malformed content, repaired pairing, provider state from another owner ignored.
3. AC3: `anthropic.test.ts` › `prompt caching (AC3)`: markers only on the system prompt and the `cacheable` block (not on a message merged into the same turn), none when nothing is cacheable, at most 4 (latest kept), plus an inline snapshot of the request body as sent.
4. AC4: `anthropic.live.test.ts` (`DESIIDE_LIVE=1 DESIIDE_LIVE_ANTHROPIC_KEY=…`, model from `DESIIDE_LIVE_ANTHROPIC_MODEL`, default `claude-opus-5-5`): a tool call, then the answer with the thinking blocks round-tripped. **Not run:** there's no Anthropic key on the build machine (see Known gaps).
5. AC5:
   - Anthropic: `reasoning (ADR-022, AC5)` › "streams thinking as reasoning_delta…" and "thinking blocks survive a tool-use turn: replayed verbatim and in order" (the second request's assistant turn holds thinking + redacted_thinking + text + tool_use, byte for byte). "a different model gets no thinking blocks from history".
   - Ollama: `ollama.test.ts` › "streams message.thinking as reasoning_delta…" on the recorded `ollama/thinking` fixture, plus the `think` mapping tests.
   - OpenAI-compatible: `openai-compat.test.ts` › "streams reasoning deltas…" on a fixture **recorded from Ollama 0.40's `/v1`** (`qwen3:8b`, `delta.reasoning`), and "accepts reasoning_content (DeepSeek / vLLM shape)".
   - Agent loop: `taskManager.test.ts` › `reasoning (ADR-022)`: reasoning reaches the task stream with the turn's `messageId`, isn't in the next request's history, and the provider state rides along unchanged. `history.test.ts` covers the drop on a model change.
- Also:
  - `anthropic.test.ts` › "ignores ANTHROPIC_* environment credentials and base URL".
  - "never leaks the key into events" (sentinel key across the error paths).
  - "a stalled stream ends with timeout".
  - "the SDK retries an overloaded response, then succeeds".
  - `providers.test.ts` › "Anthropic end to end": key via `secrets.get`, `models.test`, published cost, no discovery.
- Manual smoke of the **bundled** `orchestrator.js` over stdio, with `ANTHROPIC_API_KEY` and `ANTHROPIC_LOG=debug` in its environment:
  - `config.update` with an Anthropic model, then `models.list` lists it healthy with the table's capabilities.
  - `models.test` with no stored key gives `auth` + hint. The env key was not used, and nothing was logged to stdout.
  - `initialize` answered in 47 ms. The bundle is 615 KB (SDK included).
- `scripts/verify.sh` green: 1575 tests, 3 live tests skipped.

**Deviations**
- **No thinking budgets on current models.** Every current Claude model rejects `budget_tokens` (400). Levels map to adaptive thinking + `output_config.effort` instead, and only `budget`-style models (Haiku 4.5) get `low/medium/high` = 2k/8k/24k tokens, with `max_tokens` raised by the budget. `off` depends on the model:
  - `disabled` where the model allows it.
  - `between_tools` on Sonnet 5.5, where `disabled` is a 400.
  - Low effort on Opus 5.5 and Fable, where thinking can't be turned off. They still reason a little.
  - Unknown model ids get the newest behavior (adaptive, can't disable, no `temperature`), with 200k context and no cost.
- **Unset reasoning on models that think by default sends `thinking: {type: "adaptive", display: "summarized"}`.** This only changes visibility: those models think anyway, and their default display is `omitted` (empty thinking text). Without it, the Opus 5.5 default would never show reasoning, which defeats ADR-022's "showing it costs nothing". On models that don't think by default, unset sends nothing.
- **An extra `provider_state` StreamEvent.** The brief names only `reasoning_delta`, but the signed blocks need a way from the adapter to the loop's history. It's additive and validated by the contract.
- **The opaque field replays the whole turn, not only the thinking blocks.** Thinking blocks must come back unmodified and in their original order relative to text and `tool_use`, so the adapter stores every block of a turn that had thinking and replays it as-is. Without thinking, nothing is stored.
- **`temperature` is sent only to models that accept it** (Opus 4.6, Sonnet 4.6, Haiku 4.5) and never with thinking on. Elsewhere it's a 400.
- **Tool input streams eagerly** (`eager_input_streaming: true`). Buffered, a large `propose_edit` looks like a stalled stream to the 30 s idle timeout. Input cut off by `max_tokens` reaches the loop raw, and COR-2's AC7 path reports it to the model.
- **A refusal is an error** (`bad_request`, with the category), not `done: other`. Otherwise the loop would treat it as a finished answer and run the checks.
- **Prompt caching covers the whole agent loop, not just the repo map.** In a long autonomous run, each turn re-sends the whole growing history, so caching only the system prompt would waste most of the input cost. The loop only ever appends to history, so it marks every message `cacheable` (user and tool messages; `cacheable` was added to tool messages too). The adapter keeps breakpoints on the system prompt and on the last cacheable block of each of the latest three turns. AC3 still holds: markers go only where the caller marked stable content. Test: `anthropic.test.ts` › "an append-only agent loop keeps rolling breakpoints…" and `taskManager.test.ts` › `reasoning (ADR-022)`.
- **User decision (2026-10-10):** the user reviewed the deviations above and said to do what's best for the project: a fully autonomous, "build first, review after" agent. On that basis, the effort-based levels, the summarized display when unset, `provider_state`, and the rolling loop cache stand. The planning session may want to record the "summarized when unset" point in ADR-022.
- **The first commit also carries the SDK dependency** (`package.json` + lockfile), not only the protocol change.

**Known gaps**
- **AC4 hasn't run against the real API, and the `anthropic/*` fixtures are hand-built** from the documented SSE shapes (no key here). Run `DESIIDE_LIVE=1 DESIIDE_LIVE_ANTHROPIC_KEY=… pnpm -F @desiide/models test anthropic.live`, and re-record `text`, `tools` and `thinking-tool-turn` from a real stream.
- `costOf` (COR-2) prices all input at the full rate. With caching, cache reads cost ~0.1× and writes ~1.25×. The usage events carry the split, but `Usage` (protocol) and `costOf` don't use it yet.
- `ANTHROPIC_CUSTOM_HEADERS` in the environment is still applied by the SDK. It only adds headers to the configured endpoint, never credentials or a new destination.
- The SDK roughly doubles the orchestrator bundle (615 KB). Cold start measured at 47 ms to `initialize`.

**Follow-ups**
- **COR-4:** the loop already caches the whole task history. If the repo map should also be reused *across* tasks, send it as its own `cacheable` message ahead of the task instruction. Today the first message mixes the two.
- **UI-3:** render `reasoning_delta` as a collapsed "Thinking…" block grouped by `messageId`.
- **UI-6:** add `reasoning` (`off|low|medium|high`, unset = provider default) to the `desiide.models` settings schema, and explain that `off` on Opus 5.5 / Fable means "minimal".
- **COR-5 / JEV:** cost routing can set `ChatRequest.reasoning` per call. Cascades must keep calling `historyFor` (the loop already does) when the model changes.
- **Planning:** update `ide-model-adapters` (Anthropic section, `reasoning`, `provider_state`, `cacheable`, `costPerMTok` on providers). Consider adding `cacheReadTokens` / `cacheWriteTokens` to protocol `Usage` so the cost estimate can price cache hits.
