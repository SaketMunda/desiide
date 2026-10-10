import Anthropic from '@anthropic-ai/sdk';
import {
  UNKNOWN_MODEL,
  claudeCapabilities,
  claudeModel,
  thinkingParams,
} from './anthropic-models.ts';
import {
  placeCacheBreakpoints,
  toAnthropicMessages,
  toAnthropicTools,
  type ReplayBlock,
} from './anthropic-messages.ts';
import { ModelError, errorEvent, isAbortError, toModelError } from './errors.ts';
import {
  DEFAULT_TIMEOUTS,
  classifyStatus,
  parseRetryAfter,
  type FetchLike,
  type HttpTimeouts,
} from './http.ts';
import type { ProviderContext, ProviderDefinition } from './registry.ts';
import type { ChatRequest, ModelAdapter, StopReason, StreamEvent } from './types.ts';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Room to answer when the request doesn't cap the output. Streaming, so no HTTP timeout risk. */
const DEFAULT_MAX_TOKENS = 32_000;

export const ANTHROPIC_KEY_HINT =
  'Add your Anthropic API key in Desiide settings (it is kept in VS Code SecretStorage).';

/**
 * The SDK resolves credentials it wasn't given from the environment, `ant auth login` profiles,
 * and workload identity. Desiide's keys come only from SecretStorage (CLAUDE.md), so the client
 * gets its key and base URL explicitly and never looks anywhere else.
 */
class ConfiguredAnthropic extends Anthropic {
  protected override _shouldResolveDefaultCredentials(): boolean {
    return false;
  }
}

export interface AnthropicAdapterOptions {
  /** SDK retries for 408/409/429/5xx and connection errors, honoring `retry-after`. */
  maxRetries?: number;
  timeouts?: Partial<HttpTimeouts>;
}

export function buildAnthropicParams(
  model: string,
  req: ChatRequest,
  owner: string,
  reasoningDefault: ChatRequest['reasoning'],
): Anthropic.MessageCreateParamsStreaming {
  const entry = claudeModel(model) ?? UNKNOWN_MODEL;
  const { messages, cacheable } = toAnthropicMessages(req.messages, owner);
  const system: Anthropic.TextBlockParam[] = req.system ? [{ type: 'text', text: req.system }] : [];
  placeCacheBreakpoints(system, cacheable);
  const thinking = thinkingParams(entry, req.reasoning ?? reasoningDefault);
  const maxTokens = Math.min(
    entry.maxOutputTokens,
    (req.maxTokens ?? DEFAULT_MAX_TOKENS) + thinking.extraMaxTokens,
  );
  const tools = req.tools ?? [];
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
    ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
    ...(thinking.output_config ? { output_config: thinking.output_config } : {}),
    // Rejected from Opus 4.7 on, and ignored with thinking on: only for models that take it.
    ...(req.temperature !== undefined && entry.sampling && !thinking.thinking
      ? { temperature: req.temperature }
      : {}),
  };
}

function stopReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case null:
    case undefined:
      return 'end';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'other';
  }
}

interface OpenBlock {
  block: ReplayBlock;
  /** `tool_use` input arrives as JSON fragments. */
  json?: string;
}

/**
 * Raw Anthropic stream events → normalized events. Text and reasoning stream as they arrive; tool
 * calls, `provider_state`, then one merged `usage` follow at the end. Throws `ModelError`.
 */
export async function* readAnthropicStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  owner: string,
): AsyncGenerator<StreamEvent> {
  const blocks: ReplayBlock[] = [];
  // Raw tool input per call id: what the model wrote, even if it isn't valid JSON.
  const rawArgs = new Map<string, string>();
  const open = new Map<number, OpenBlock>();
  let reason: string | null | undefined;
  let stopDetails: string | undefined;
  let stopped = false;
  let usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        const u = event.message.usage;
        usage = {
          input: u.input_tokens,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens,
        };
        break;
      }
      case 'content_block_start': {
        const b = event.content_block;
        if (b.type === 'text') open.set(event.index, { block: { type: 'text', text: '' } });
        else if (b.type === 'thinking') {
          open.set(event.index, { block: { type: 'thinking', thinking: '', signature: '' } });
          if (b.thinking) yield { type: 'reasoning_delta', text: b.thinking };
        } else if (b.type === 'redacted_thinking') {
          open.set(event.index, { block: { type: 'redacted_thinking', data: b.data } });
        } else if (b.type === 'tool_use') {
          open.set(event.index, {
            block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
            json: '',
          });
        }
        // Server-tool blocks aren't requested, so anything else is ignored.
        break;
      }
      case 'content_block_delta': {
        const current = open.get(event.index);
        const d = event.delta;
        if (d.type === 'text_delta') {
          if (current?.block.type === 'text') current.block.text += d.text;
          if (d.text !== '') yield { type: 'text_delta', text: d.text };
        } else if (d.type === 'thinking_delta') {
          if (current?.block.type === 'thinking') current.block.thinking += d.thinking;
          if (d.thinking !== '') yield { type: 'reasoning_delta', text: d.thinking };
        } else if (d.type === 'signature_delta') {
          if (current?.block.type === 'thinking') current.block.signature += d.signature;
        } else if (d.type === 'input_json_delta') {
          if (current?.json !== undefined) current.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const current = open.get(event.index);
        if (!current) break;
        open.delete(event.index);
        if (current.block.type === 'tool_use') {
          const json = current.json?.trim() || '{}';
          rawArgs.set(current.block.id, json);
          current.block.input = parseToolInput(json);
        }
        blocks.push(current.block);
        break;
      }
      case 'message_delta': {
        reason = event.delta.stop_reason;
        const details = event.delta.stop_details;
        if (details?.type === 'refusal') stopDetails = details.category ?? undefined;
        const u = event.usage;
        usage.output = u.output_tokens;
        if (u.input_tokens != null) usage.input = u.input_tokens;
        if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
        break;
      }
      case 'message_stop':
        stopped = true;
        break;
    }
    if (stopped) break;
  }

  if (!stopped) {
    throw new ModelError('network', 'The stream from Anthropic ended before the reply finished', {
      hint: 'The connection dropped. Try again.',
    });
  }
  if (reason === 'refusal') {
    throw new ModelError(
      'bad_request',
      `Claude declined to continue this request${stopDetails ? ` (${stopDetails})` : ''}`,
      { hint: 'Rephrase the task, or switch to another model for it.' },
    );
  }

  const calls = blocks.filter((b) => b.type === 'tool_use');
  for (const call of calls) {
    const args = rawArgs.get(call.id) ?? JSON.stringify(call.input);
    yield { type: 'tool_call', call: { id: call.id, name: call.name, args } };
  }
  if (blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
    yield { type: 'provider_state', state: { owner, data: { blocks } } };
  }
  yield {
    type: 'usage',
    // Total input, like the other providers; the cached parts are broken out.
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
  yield { type: 'done', stopReason: stopReason(reason, calls.length > 0) };
}

/**
 * Tool input streams eagerly, so it isn't validated by the API: a reply cut off by `max_tokens`
 * can leave broken JSON. The raw text goes to the caller (which reports the error to the model);
 * the replayed block gets `{}`, since the API only accepts an object there.
 */
function parseToolInput(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Handled by the caller via the raw args.
  }
  return {};
}

/** SDK errors → `ModelError`. Overloaded is a rate limit (back off), not a server fault. */
export function anthropicError(
  error: unknown,
  signal: AbortSignal,
  secrets: readonly string[],
  timedOut: 'first' | 'idle' | undefined,
): ModelError {
  // An abort can surface as a cut-off stream; the user's cancel is the real reason.
  if (signal.aborted) return new ModelError('cancelled', 'Request cancelled', { secrets });
  if (error instanceof ModelError) return error;
  if (timedOut) {
    const what = timedOut === 'first' ? 'start answering' : 'continue its answer';
    return new ModelError('timeout', `Anthropic did not ${what} in time`, { secrets });
  }
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError || isAbortError(error)) {
    return new ModelError('cancelled', 'Request cancelled', { secrets });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelError('timeout', 'Anthropic did not respond in time', { secrets });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError('network', `Could not reach Anthropic: ${error.message}`, {
      secrets,
      hint: 'Check your connection and the base URL.',
    });
  }
  if (error instanceof Anthropic.APIError) {
    const detail = apiMessage(error);
    const status = typeof error.status === 'number' ? error.status : undefined;
    const retryAfterMs = parseRetryAfter(error.headers?.get('retry-after') ?? null);
    const kind = errorKind(status, error.type, detail);
    return new ModelError(kind, `Anthropic: ${detail}`, {
      secrets,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(kind === 'auth' ? { hint: ANTHROPIC_KEY_HINT } : {}),
      ...(error.type === 'overloaded_error'
        ? { hint: 'Anthropic is overloaded right now. Try again shortly or switch models.' }
        : {}),
    });
  }
  return toModelError(error, signal, secrets);
}

function apiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body: unknown = error.error;
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const inner: unknown = body.error;
    if (typeof inner === 'object' && inner !== null && 'message' in inner) {
      if (typeof inner.message === 'string') return inner.message;
    }
  }
  return error.message;
}

function errorKind(
  status: number | undefined,
  type: string | null,
  message: string,
): ReturnType<typeof classifyStatus> {
  if (type === 'overloaded_error' || status === 529 || type === 'rate_limit_error') {
    return 'rate_limit';
  }
  if (type === 'authentication_error' || type === 'permission_error') return 'auth';
  if (type === 'request_too_large') return 'context_length';
  if (status !== undefined) return classifyStatus(status, message);
  // An `error` event inside a 200 stream.
  if (type === 'invalid_request_error') return classifyStatus(400, message);
  return 'server';
}

/**
 * Wraps the SDK stream so a stalled one fails: the first event must arrive within `firstTokenMs`
 * and each next one within `idleMs`. Aborting `controller` ends the SDK request.
 */
async function* watchdog<T>(
  source: AsyncIterable<T>,
  controller: AbortController,
  timeouts: HttpTimeouts,
  onTimeout: (which: 'first' | 'idle') => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let first = true;
  try {
    for (;;) {
      const ms = first ? timeouts.firstByteMs : timeouts.idleMs;
      const which = first ? 'first' : 'idle';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout(which);
            controller.abort();
            reject(new Error('stream timeout'));
          }, ms);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) return;
      first = false;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

/** The SDK's fetch signature over our `FetchLike` (tests replay through it). */
function sdkFetch(fetch: FetchLike) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init ?? {},
    );
}

/** Native Claude adapter on the official SDK: streaming, tool use, prompt caching, thinking. */
export function createAnthropicAdapter(
  ctx: ProviderContext,
  options: AnthropicAdapterOptions = {},
): ModelAdapter {
  const { config } = ctx;
  const baseURL = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeouts: HttpTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  let client: { key: string; sdk: Anthropic } | undefined;

  const clientFor = (key: string): Anthropic => {
    if (client?.key !== key) {
      client = {
        key,
        sdk: new ConfiguredAnthropic({
          apiKey: key,
          authToken: null,
          baseURL,
          maxRetries: options.maxRetries ?? 3,
          timeout: timeouts.connectMs,
          // Never the SDK's console logger: stdout is the JSON-RPC channel.
          logLevel: 'off',
          ...(ctx.fetch ? { fetch: sdkFetch(ctx.fetch) } : {}),
        }),
      };
    }
    return client.sdk;
  };

  return {
    id: config.id,
    provider: config.provider,
    model: config.model,
    capabilities: () => Promise.resolve(claudeCapabilities(config.model)),

    async *chat(req, signal) {
      const local = new AbortController();
      const combined = AbortSignal.any([signal, local.signal]);
      let timedOut: 'first' | 'idle' | undefined;
      try {
        if (signal.aborted) throw new ModelError('cancelled', 'Request cancelled');
        const key = await ctx.apiKey(signal);
        if (!key) {
          throw new ModelError('auth', `No API key is configured for "${config.id}"`, {
            hint: ANTHROPIC_KEY_HINT,
          });
        }
        const params = buildAnthropicParams(config.model, req, config.id, config.reasoning);
        const stream = await clientFor(key).messages.create(params, { signal: combined });
        yield* readAnthropicStream(
          watchdog(stream, local, timeouts, (which) => (timedOut = which)),
          config.id,
        );
      } catch (error) {
        yield errorEvent(anthropicError(error, signal, ctx.secrets(), timedOut));
      } finally {
        local.abort();
      }
    },
  };
}

export const anthropicProvider: ProviderDefinition = {
  create: (ctx) => createAnthropicAdapter(ctx),
  costPerMTok: (model) => claudeModel(model)?.costPerMTok,
};
