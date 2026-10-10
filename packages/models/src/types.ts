import {
  FileEdit,
  ModelCapabilities,
  ModelErrorKind,
  ReasoningLevel,
  WorkspacePath,
  type ModelProvider,
} from '@desiide/protocol';
import * as z from 'zod';

export { ModelCapabilities, ModelErrorKind, ReasoningLevel };

/** Model-facing tool spec. COR-3's `toolSpecs()` output is assignable to it. */
export const ToolSpec = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

/** A complete tool call. `args` is the raw JSON text the model produced; the caller parses it. */
export const ToolCallRequest = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.string(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequest>;

/**
 * Opaque, provider-owned data attached to an assistant turn, e.g. Anthropic's signed thinking
 * blocks, which must be sent back during tool use (ADR-022). Only the adapter whose `id` is
 * `owner` reads it; every other adapter ignores it, and `historyFor` drops it on a model change.
 */
export const ProviderState = z.object({ owner: z.string().min(1), data: z.unknown() });
export type ProviderState = z.infer<typeof ProviderState>;

/** Provider-neutral history. Adapters normalize to their wire format (e.g. Anthropic turn rules). */
export const ChatMessage = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.string(),
    /**
     * The content is stable across calls (e.g. the repo map), so providers with prompt caching may
     * cache the prefix up to and including it. The system prompt is always treated as stable.
     */
    cacheable: z.boolean().optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(ToolCallRequest).optional(),
    /** Never reasoning text in the clear; see `ProviderState`. */
    providerState: ProviderState.optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Overrides the model's configured `reasoning` for this call (ADR-022). */
  reasoning?: ReasoningLevel;
}

export const StopReason = z.enum(['end', 'tool_calls', 'max_tokens', 'other']);
export type StopReason = z.infer<typeof StopReason>;

export const ModelErrorInfo = z.object({
  kind: ModelErrorKind,
  message: z.string(),
  hint: z.string().optional(),
  status: z.int().optional(),
});
export type ModelErrorInfo = z.infer<typeof ModelErrorInfo>;

/**
 * Normalized stream. Every stream ends with exactly one `done` or `error`, and nothing follows it.
 * Adapters yield failures as `error` events instead of throwing.
 */
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  /** Reasoning ("thinking") text: shown to the user, never put back into history (ADR-022). */
  z.object({ type: z.literal('reasoning_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), call: ToolCallRequest }),
  /** At most one, before the terminal event: store it on the assistant turn's `providerState`. */
  z.object({ type: z.literal('provider_state'), state: ProviderState }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative().optional(),
    cacheWriteTokens: z.int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('done'), stopReason: StopReason }),
  z.object({ type: z.literal('error'), error: ModelErrorInfo }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

/** One-shot completion over a code snippet (no tools, no history). */
export interface CompleteRequest {
  codeContext: string;
  instruction: string;
  maxTokens?: number;
}

/** Input for an edit: the instruction plus the current content of each file the model may change. */
export const DiffSpec = z.object({
  instruction: z.string().min(1),
  files: z.array(z.object({ path: WorkspacePath, content: z.string() })).min(1),
  system: z.string().optional(),
});
export type DiffSpec = z.infer<typeof DiffSpec>;

export interface ModelAdapter {
  /** Config id, e.g. "local-small". */
  readonly id: string;
  readonly provider: ModelProvider;
  /** Provider model name, e.g. "qwen2.5-coder:7b". */
  readonly model: string;
  /** Probed or default capabilities. The registry overlays config-declared ones on top. */
  capabilities(signal?: AbortSignal): Promise<ModelCapabilities>;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /** Optional; `complete()` falls back to `chat`. */
  complete?(req: CompleteRequest, signal: AbortSignal): Promise<string>;
  /** Only when the provider supports edits natively; `edit()` falls back to search/replace blocks. */
  edit?(spec: DiffSpec, signal: AbortSignal): Promise<FileEdit[]>;
}
