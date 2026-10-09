import * as z from 'zod';
import { Id, SecretRef } from './common.ts';

export const ModelProvider = z.enum(['openai-compatible', 'ollama', 'anthropic']);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** Workflows address models by role, never by ID (ADR-007). */
export const ModelRole = z.enum(['cheap', 'strong', 'reviewer']);
export type ModelRole = z.infer<typeof ModelRole>;

/**
 * Where a model runs. `local` means requests stay on this machine (or the user's own network),
 * which routing and privacy decisions rely on; anything unknown counts as `cloud`.
 */
export const ModelLocality = z.enum(['local', 'cloud']);
export type ModelLocality = z.infer<typeof ModelLocality>;

export const ModelCapabilities = z.object({
  streaming: z.boolean(),
  toolCalls: z.boolean(),
  contextTokens: z.int().positive(),
  maxOutputTokens: z.int().positive().optional(),
  vision: z.boolean().default(false),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ModelInfo = z.object({
  id: Id,
  provider: ModelProvider,
  model: z.string().min(1),
  role: ModelRole.optional(),
  capabilities: ModelCapabilities,
  healthy: z.boolean(),
  /** Optional for older servers; current ones always send it. */
  locality: ModelLocality.optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const CostPerMTok = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type CostPerMTok = z.infer<typeof CostPerMTok>;

/**
 * Provider wire differences an OpenAI-compatible server may have. Unset fields are inferred from
 * the `baseUrl`; set them when a server needs something else.
 */
export const ModelQuirks = z.strictObject({
  /** Send `stream_options.include_usage` so the stream reports token usage. */
  streamUsage: z.boolean().optional(),
  /** Which request field carries the output-token limit. */
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
});
export type ModelQuirks = z.infer<typeof ModelQuirks>;

/** One entry of `desiide.models[]`, pushed to the orchestrator via `config.update`. */
export const ModelConfig = z.strictObject({
  id: Id,
  provider: ModelProvider,
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  apiKey: SecretRef.optional(),
  costPerMTok: CostPerMTok.optional(),
  capabilities: ModelCapabilities.partial().optional(),
  /** Overrides the inferred locality (Ollama or a loopback `baseUrl` → local, else cloud). */
  locality: ModelLocality.optional(),
  quirks: ModelQuirks.optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelErrorKind = z.enum([
  'auth',
  'rate_limit',
  'context_length',
  'bad_request',
  'server',
  'network',
  'timeout',
  'cancelled',
  'unknown',
]);
export type ModelErrorKind = z.infer<typeof ModelErrorKind>;
