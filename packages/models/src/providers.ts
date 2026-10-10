import { anthropicProvider } from './anthropic.ts';
import { ollamaProvider } from './ollama.ts';
import { createOpenAICompatAdapter } from './openai-compat.ts';
import type { ProviderDefinitions } from './registry.ts';

/** Providers shipped in the orchestrator. */
export const BUILTIN_PROVIDERS: ProviderDefinitions = {
  'openai-compatible': { create: createOpenAICompatAdapter },
  ollama: ollamaProvider,
  anthropic: anthropicProvider,
};
