import { ollamaProvider } from './ollama.ts';
import { createOpenAICompatAdapter } from './openai-compat.ts';
import type { ProviderDefinitions } from './registry.ts';

/** Providers shipped in the orchestrator. MOD-3 adds `anthropic`. */
export const BUILTIN_PROVIDERS: ProviderDefinitions = {
  'openai-compatible': { create: createOpenAICompatAdapter },
  ollama: ollamaProvider,
};
