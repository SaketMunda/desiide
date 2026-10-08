import type { ModelConfig, ModelQuirks } from '@desiide/protocol';
import { ModelError } from './errors.ts';

export type ResolvedQuirks = { [K in keyof ModelQuirks]-?: NonNullable<ModelQuirks[K]> };

const DEFAULT_QUIRKS: ResolvedQuirks = { streamUsage: true, maxTokensField: 'max_tokens' };

/**
 * Known servers, matched on the `baseUrl` host. Anything else (vLLM, LM Studio, llama.cpp,
 * OpenRouter, Gemini's OpenAI endpoint, …) gets the defaults. Tool-call argument streaming (one
 * chunk vs fragments) needs no entry: the accumulator handles both.
 */
const BY_HOST: Array<{ host: RegExp; quirks: Partial<ResolvedQuirks> }> = [
  // Reasoning models reject `max_tokens`; every current OpenAI model accepts the new field.
  { host: /(^|\.)openai\.com$/, quirks: { maxTokensField: 'max_completion_tokens' } },
  { host: /(^|\.)openai\.azure\.com$/, quirks: { maxTokensField: 'max_completion_tokens' } },
  // Mistral reports usage on the last chunk anyway and rejects unknown fields.
  { host: /(^|\.)mistral\.ai$/, quirks: { streamUsage: false } },
];

/** Quirks for a model: explicit `quirks` in the config win over the host table and the defaults. */
export function resolveQuirks(config: Pick<ModelConfig, 'baseUrl' | 'quirks'>): ResolvedQuirks {
  let host = '';
  try {
    host = config.baseUrl ? new URL(config.baseUrl).hostname.toLowerCase() : '';
  } catch {
    // An invalid URL fails later, when the request is made.
  }
  const known = BY_HOST.find((entry) => entry.host.test(host))?.quirks ?? {};
  const explicit = config.quirks ?? {};
  return {
    streamUsage: explicit.streamUsage ?? known.streamUsage ?? DEFAULT_QUIRKS.streamUsage,
    maxTokensField:
      explicit.maxTokensField ?? known.maxTokensField ?? DEFAULT_QUIRKS.maxTokensField,
  };
}

/**
 * When a server rejects a request because of one of the quirk-controlled fields, the quirks to
 * retry with. `undefined` when the error isn't about them. The adapter retries once and keeps the
 * result, so a misjudged server costs one request, not every request.
 */
export function adaptQuirks(error: unknown, quirks: ResolvedQuirks): ResolvedQuirks | undefined {
  if (!(error instanceof ModelError) || error.kind !== 'bad_request') return undefined;
  const message = error.message;
  if (quirks.streamUsage && /stream_options|include_usage/.test(message)) {
    return { ...quirks, streamUsage: false };
  }
  if (quirks.maxTokensField === 'max_tokens' && /max_completion_tokens/.test(message)) {
    return { ...quirks, maxTokensField: 'max_completion_tokens' };
  }
  if (quirks.maxTokensField === 'max_completion_tokens' && /max_completion_tokens/.test(message)) {
    return { ...quirks, maxTokensField: 'max_tokens' };
  }
  return undefined;
}
