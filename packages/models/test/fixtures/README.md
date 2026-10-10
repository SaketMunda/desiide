# Model fixtures

Recorded HTTP exchanges replayed by `replayFetch` (format: `src/testing/fixtures.ts`). Never record
`authorization`, `x-api-key` or cookie headers: the loader refuses them.

| Fixture | Source |
|---|---|
| `openai-compatible/text.jsonl`, `tools-single-chunk.jsonl` | Recorded from Ollama 0.40's OpenAI endpoint (`/v1/chat/completions`, `qwen2.5:7b`). Each tool call arrives whole in one chunk. |
| `openai-compatible/tools-fragmented.jsonl` | Hand-built in OpenAI's documented stream shape: id + name first, then argument fragments, two calls interleaved, with chunk boundaries cut mid-event and mid-JSON. |
| `openai-compatible/reasoning.jsonl` | Recorded from Ollama 0.40's OpenAI endpoint (`qwen3:8b`, `reasoning_effort: low`, 2026-10-10). Reasoning arrives as `delta.reasoning`; 166 of the 172 reasoning chunks were cut. |
| `openai-compatible/reasoning-effort-rejected.jsonl` | Hand-built from OpenAI's documented "unrecognized argument" error body. |
| `openai-compatible/error-*`, `cancel`, `stream-options-rejected`, `text-tools` | Hand-built from the providers' documented error bodies. |
| `ollama/text.jsonl`, `tools.jsonl`, `not-pulled.jsonl`, `tags.jsonl` | Recorded from Ollama 0.40's native API (`/api/chat`, `/api/tags`). The `/api/show` exchange in front of each chat is trimmed to the fields the adapter reads. |
| `ollama/thinking.jsonl` | Recorded from `qwen3:4b` (thinking chunks), shortened, with two answer chunks added. |
| `ollama/text-tools`, `error-midstream`, `truncated`, `cancel` | Hand-built in the native NDJSON shape. |
| `anthropic/*` | **Hand-built** in the Messages API's documented SSE shape (`message_start` … `message_stop`, `ping`, `thinking_delta` / `signature_delta`, `input_json_delta`, an `error` event inside a 200 stream) and its documented error bodies. No API key was available on the build machine; signatures and redacted-thinking payloads are placeholders. `thinking-tool-turn` holds two exchanges: a thinking + tool-use turn, then the answer after the tool result. Re-record with a key when one is available. |

Re-record with a plain `fetch` that writes `{"response":…}` then one `{"chunk":…}` line per body chunk.
