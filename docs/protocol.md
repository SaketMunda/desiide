# Mutt protocol (extension ↔ orchestrator)

JSON-RPC 2.0 over stdio (ADR-003). Every schema lives in [`packages/protocol`](../packages/protocol/src) as zod; the TypeScript types are inferred from it. This page summarizes the surface. The source is authoritative, and a test fails if a method or event is missing here.

- **Version:** `PROTOCOL_VERSION = 1.0.0`. `initialize` must be the first request. A different **major** fails with error `ProtocolMismatch` (-32001) and a message telling the user to update. Minor versions only add optional fields, methods, and event types.
- **Requests are strict:** unknown params are rejected. **Results and events are tolerant:** unknown fields are stripped, and unknown event `type`s are ignored (`parseTaskEvent` returns `status: 'unknown'`).
- **Additive-only** after FND-2 (ADR-010). Breaking changes need an ADR and a major bump.
- **Paths** are workspace-relative POSIX paths. Absolute paths and `..` are rejected.
- **Secrets** appear only as `secret:<name>` refs. Values travel only in the `secrets.get` result.

## Requests: extension → orchestrator

| Method | Params | Result | Notes |
|---|---|---|---|
| `initialize` | `protocolVersion, client{name,version}, workspaceRoots[]` | `protocolVersion, server{name,version}` | Version handshake. Must come first. |
| `task.create` | `TaskInput` (`kind, instruction, context?, allowedTools?, success?, budget?, preference?, workflowOverride?`) | `{task: TaskSummary}` | The orchestrator assigns `id`. Defaults: read-only tools + `propose_edit`, budget 8 iterations / 40 tool calls / 200k tokens / 10 min. |
| `task.cancel` | `{taskId}` | `{cancelled}` | |
| `task.list` | `{}` | `{tasks: TaskSummary[]}` | |
| `task.approve` | `{taskId, approvalId, scope: once\|task}` | `{ok: true}` | `task` remembers an exact-match approval for the rest of the task. |
| `task.reject` | `{taskId, approvalId, reason?}` | `{ok: true}` | The reason is forwarded to the model. |
| `edits.report` | `{taskId, proposalId, files: {path, status: applied\|rejected\|stale, reason?}[]}` | `{ok: true}` | The extension reports per-file results after applying edits (ADR-004). |
| `models.list` | `{discover?}` | `{models: ModelInfo[], discovered: ModelInfo[]}` | `discover` probes for local models (Ollama). |
| `models.test` | `{modelId}` | `{ok, latencyMs?, error?{kind: ModelErrorKind, message, hint?}}` | |
| `jev.test` | `{}` | `{ok, latencyMs?, error?}` | |
| `jev.preview` | `{pack: KnownPack}` | `{state: JevPackState}` | A sample payload for the settings page. Metadata only. |
| `decisions.list` | `{taskId?, pack?, outcome?, limit=50 (≤500), cursor?}` | `{decisions: DecisionRecord[], nextCursor?}` | |
| `decisions.replay` | `{id}` | `{record, rules: EngineRun, jev?: EngineRun, jevError?, differs}` | |
| `config.update` | `MuttConfig` (`models[], roles, jev, gating`) | `{ok: true}` | A full snapshot of the `mutt.*` settings. API keys are `secret:` refs only. |
| `health.ping` | `{}` | `{ok: true, uptimeMs}` | |

## Reverse requests: orchestrator → extension

| Method | Params | Result | Notes |
|---|---|---|---|
| `secrets.get` | `{ref: "secret:<name>"}` | `{value: string \| null}` | Answered from VS Code SecretStorage. `null` means the secret isn't set. |

There is deliberately no `workspace.applyEdit`: the extension applies edits itself after approval (ADR-004).

## Notifications: orchestrator → extension

| Notification | Payload |
|---|---|
| `task.event` | `TaskEvent`, see below |
| `log` | `{level: debug\|info\|warn\|error, message, ts, fields?}` |

### `task.event` types

Every event carries `taskId`, `seq` (monotonic per task, starting at 0), and `ts` (ISO 8601).

| `type` | Payload | UI consumer |
|---|---|---|
| `state_changed` | `from: TaskState \| null, to: TaskState, reason?` | UI-3 header |
| `text_delta` | `messageId, delta` | UI-3 transcript |
| `tool_call_started` | `call: ToolCall` | UI-3 tool card |
| `tool_call_finished` | `result: ToolResult` (blocked/rejected calls have `error.kind` + `reasons`) | UI-3 tool card, UI-4 blocked card |
| `edit_proposed` | `proposal: EditProposal, files: FileMeta[]` | UI-4 review card |
| `approval_required` | `approvalId, call: ToolCall, outcome: confirm, reasons: ReasonLabel[], decisionId?, paths[]` | UI-4 approval card |
| `decision_made` | `decision: DecisionRecord` | UI-5 timeline, UI-3 chip |
| `usage` | `modelId, usage{inputTokens, outputTokens, costUsd?}` | UI-3 header, UI-5 savings |
| `error` | `kind` (a `ModelErrorKind` or another label), `message, retryable, retryAfterMs?` | UI-3 error rendering |

Task states: `queued → planning → running ⇄ awaiting_approval → verifying → done | failed | cancelled`.

## Error codes

| Code | Name |
|---|---|
| -32001 | `ProtocolMismatch` |
| -32002 | `NotInitialized` |
| -32003 | `NotImplemented` |
| -32004 | `TaskNotFound` |
| -32005 | `ApprovalNotFound` |
| -32006 | `SecretMissing` |

## Jev packs (metadata only, ADR-005)

| Pack | State fields |
|---|---|
| `workflow_select@1` | `taskType, filesTouched: FileMeta[] (≤50), truncatedCount?, estimatedDiffSize, lastRunStatus, userPreference, availableModels[{id, contextTokens, latencyMs, costTier}]` |
| `risk_gate@1` | `actionType, command? (≤500 chars), editFileCount?, context{branch, env, hasPendingMigrations}, filesTouched[{path, sensitive}] (≤50), truncatedCount?` |
| `cost_route@1` | `taskType, filesTouchedCount, projectSizeLines, userCostBias, recentFailures` |

Results are `choice {selected, probs}`, `score {score 0–4, probs?}`, or `noul {answer: yes|no|unknown, pYes}`. The example states (one per pack) and the extra risk-gate golden cases are exported from `@mutt/protocol/fixtures`.
