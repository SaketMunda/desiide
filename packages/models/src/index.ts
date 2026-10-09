export const PACKAGE_NAME = '@desiide/models';
export * from './types.ts';
export { ModelError, defaultHint, errorEvent, isAbortError, toModelError } from './errors.ts';
export type { ModelErrorOptions } from './errors.ts';
export { redact, redactHeaders } from './redact.ts';
export { parseSse } from './sse.ts';
export type { ParseSseOptions, SseEvent } from './sse.ts';
export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUTS,
  classifyStatus,
  httpRequest,
  isRetryable,
  parseRetryAfter,
  retryDelay,
} from './http.ts';
export type {
  FetchLike,
  HttpOptions,
  HttpRequest,
  HttpResponse,
  HttpTimeouts,
  ModelLogger,
  RetryPolicy,
} from './http.ts';
export { collectTurn } from './stream.ts';
export type { CollectedTurn } from './stream.ts';
export { complete } from './complete.ts';
export {
  EDIT_FORMAT_PROMPT,
  buildEditPrompt,
  edit,
  editViaChat,
  parseEditBlocks,
} from './edit-fallback.ts';
export type {
  EditBlockError,
  EditBlockErrorCode,
  ParseEditOptions,
  ParseEditResult,
} from './edit-fallback.ts';
export { createSecretResolver } from './secrets.ts';
export type { RequestSecret, SecretResolver } from './secrets.ts';
export { FALLBACK_CAPABILITIES, createModelRegistry } from './registry.ts';
export type {
  DiscoveredModel,
  ModelRegistry,
  ModelRegistryOptions,
  ModelTestResult,
  ProviderContext,
  ProviderDefinition,
  ProviderDefinitions,
} from './registry.ts';
export { BUILTIN_PROVIDERS } from './providers.ts';
export { inferLocality, isLoopback } from './locality.ts';
export { parseNdjson } from './ndjson.ts';
export { createToolCallAccumulator } from './tool-calls.ts';
export type { ToolCallDelta } from './tool-calls.ts';
export { createTextToolParser, textToolsMessages, textToolsSystem } from './text-tools.ts';
export { adaptQuirks, resolveQuirks } from './quirks.ts';
export type { ResolvedQuirks } from './quirks.ts';
export { createOpenAICompatAdapter } from './openai-compat.ts';
export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT,
  OLLAMA_NOT_RUNNING_HINT,
  createOllamaAdapter,
  discoverOllama,
  ollamaProvider,
} from './ollama.ts';
