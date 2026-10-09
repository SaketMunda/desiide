# Model fixtures

Recorded HTTP exchanges replayed by `replayFetch` (format: `src/testing/fixtures.ts`). Never record
`authorization`, `x-api-key` or cookie headers: the loader refuses them.

| Fixture | Source |
|---|---|
| `openai-compatible/text.jsonl`, `tools-single-chunk.jsonl` | Recorded from Ollama 0.40's OpenAI endpoint (`/v1/chat/completions`, `qwen2.5:7b`). Each tool call arrives whole in one chunk. |
| `openai-compatible/tools-fragmented.jsonl` | Hand-built in OpenAI's documented stream shape: id + name first, then argument fragments, two calls interleaved, with chunk boundaries cut mid-event and mid-JSON. |
| `openai-compatible/error-*`, `cancel`, `stream-options-rejected`, `text-tools` | Hand-built from the providers' documented error bodies. |
| `ollama/text.jsonl`, `tools.jsonl`, `not-pulled.jsonl`, `tags.jsonl` | Recorded from Ollama 0.40's native API (`/api/chat`, `/api/tags`). The `/api/show` exchange in front of each chat is trimmed to the fields the adapter reads. |
| `ollama/thinking.jsonl` | Recorded from `qwen3:4b` (thinking chunks), shortened, with two answer chunks added. |
| `ollama/text-tools`, `error-midstream`, `truncated`, `cancel` | Hand-built in the native NDJSON shape. |

Re-record with a plain `fetch` that writes `{"response":…}` then one `{"chunk":…}` line per body chunk.
