import type { ProviderDefinitions } from './registry.ts';

/**
 * Providers shipped in the orchestrator. MOD-2 adds `openai-compatible` + `ollama`, MOD-3 adds
 * `anthropic`. Until then configured models list as unavailable.
 */
export const BUILTIN_PROVIDERS: ProviderDefinitions = {};
