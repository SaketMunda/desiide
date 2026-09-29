import * as z from 'zod';
import { Id, SecretRef } from './common.ts';

export const ModelProvider = z.enum(['openai-compatible', 'ollama', 'anthropic']);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** Workflows address models by role, never by ID (ADR-007). */
export const ModelRole = z.enum(['cheap', 'strong', 'reviewer']);
export type ModelRole = z.infer<typeof ModelRole>;

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
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const CostPerMTok = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type CostPerMTok = z.infer<typeof CostPerMTok>;

/** One entry of `mutt.models[]`, pushed to the orchestrator via `config.update`. */
export const ModelConfig = z.strictObject({
  id: Id,
  provider: ModelProvider,
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  apiKey: SecretRef.optional(),
  costPerMTok: CostPerMTok.optional(),
  capabilities: ModelCapabilities.partial().optional(),
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
