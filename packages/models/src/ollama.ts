import * as z from 'zod';
import { ModelError, errorEvent, toModelError } from './errors.ts';
import { classifyStatus, httpRequest, type FetchLike, type ModelLogger } from './http.ts';
import { parseNdjson } from './ndjson.ts';
import { LOCAL_TIMEOUTS } from './openai-compat.ts';
import type { DiscoveredModel, ProviderContext, ProviderDefinition } from './registry.ts';
import { redact } from './redact.ts';
import { createTextToolParser, textToolsMessages, textToolsSystem } from './text-tools.ts';
import type {
  ChatMessage,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  StopReason,
  StreamEvent,
} from './types.ts';

/** The preset's base URL. `/v1` is accepted (it's what people copy) and stripped: see below. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * The context window Desiide asks Ollama for when the config doesn't say. Ollama's own default is
 * 4096 and it truncates silently past `num_ctx`; asking for a model's full window (often 128k–256k)
 * would allocate gigabytes of KV cache on a laptop. Set `capabilities.contextTokens` to change it.
 */
export const OLLAMA_DEFAULT_CONTEXT = 32_768;

export const OLLAMA_NOT_RUNNING_HINT =
  'Is Ollama running? Open the Ollama app or run `ollama serve`, then try again.';

const pullHint = (model: string): string => `Pull it first: \`ollama pull ${model}\`.`;

/**
 * Ollama's OpenAI endpoint (`/v1`) ignores `num_ctx`, so the preset talks to the native API
 * (`/api/chat`, `/api/show`, `/api/tags`) at the server root.
 */
export function ollamaRoot(baseUrl: string | undefined): string {
  return (baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Ollama-specific hints on top of the generic error: not running, model not pulled. */
function ollamaError(error: unknown, model: string, signal?: AbortSignal, secrets?: string[]) {
  const err = toModelError(error, signal, secrets);
  if (err.kind === 'network') {
    return new ModelError('network', err.message, { hint: OLLAMA_NOT_RUNNING_HINT });
  }
  if (err.status === 404 && /not found/i.test(err.message)) {
    return new ModelError('bad_request', `Ollama doesn't have the model "${model}"`, {
      hint: pullHint(model),
      status: 404,
    });
  }
  return err;
}

const ShowWire = z.looseObject({
  capabilities: z.array(z.string()).nullish(),
  model_info: z.record(z.string(), z.unknown()).nullish(),
  parameters: z.string().nullish(),
});

/** Capabilities from `/api/show`: tool support, vision, and the context window to request. */
export function capabilitiesFromShow(raw: unknown, configured?: number): ModelCapabilities {
  const show = ShowWire.parse(raw);
  const caps = show.capabilities ?? [];
  let modelMax: number | undefined;
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) modelMax = value;
  }
  // A `PARAMETER num_ctx` in the Modelfile is the user's own choice; respect it.
  const fromModelfile = Number(/(?:^|\n)num_ctx\s+(\d+)/.exec(show.parameters ?? '')?.[1]);
  const wanted =
    configured ??
    (fromModelfile > 0
      ? fromModelfile
      : Math.min(modelMax ?? OLLAMA_DEFAULT_CONTEXT, OLLAMA_DEFAULT_CONTEXT));
  return {
    streaming: true,
    toolCalls: caps.includes('tools'),
    contextTokens: modelMax === undefined ? wanted : Math.min(wanted, modelMax),
    vision: caps.includes('vision'),
  };
}

const ChunkWire = z.looseObject({
  message: z
    .looseObject({
      content: z.string().nullish(),
      tool_calls: z
        .array(
          z.looseObject({
            id: z.string().nullish(),
            function: z.looseObject({ name: z.string(), arguments: z.unknown().optional() }),
          }),
        )
        .nullish(),
    })
    .nullish(),
  done: z.boolean().nullish(),
  done_reason: z.string().nullish(),
  prompt_eval_count: z.number().nonnegative().nullish(),
  eval_count: z.number().nonnegative().nullish(),
  error: z.string().nullish(),
});

function parseArgs(args: string): unknown {
  try {
    const value = JSON.parse(args) as unknown;
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

function toWireMessages(system: string | undefined, messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                function: { name: c.name, arguments: parseArgs(c.args) },
              })),
            }
          : {}),
      });
    } else {
      out.push({
        role: 'tool',
        tool_name: m.name,
        content: m.isError ? `Error: ${m.content}` : m.content,
      });
    }
  }
  return out;
}

export function buildOllamaBody(
  model: string,
  req: ChatRequest,
  numCtx: number,
  textTools: boolean,
): Record<string, unknown> {
  const tools = req.tools ?? [];
  const system = textTools ? textToolsSystem(req.system, tools) : req.system;
  const messages = textTools ? textToolsMessages(req.messages) : req.messages;
  return {
    model,
    stream: true,
    messages: toWireMessages(system, messages),
    ...(!textTools && tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
    options: {
      num_ctx: numCtx,
      ...(req.maxTokens === undefined ? {} : { num_predict: req.maxTokens }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    },
  };
}

const newCallId = (): string => `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

function doneToStop(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'length') return 'max_tokens';
  return reason === undefined || reason === 'stop' ? 'end' : 'other';
}

/**
 * Ollama, through its native API. Tool-capable models (per `/api/show`) use native tool calls;
 * the rest get the text-based tool protocol, and edits use the search/replace fallback.
 */
export function createOllamaAdapter(ctx: ProviderContext): ModelAdapter {
  const { config } = ctx;
  const root = ollamaRoot(config.baseUrl);
  const http = {
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.logger ? { logger: ctx.logger } : {}),
  };
  let probe: Promise<ModelCapabilities> | undefined;

  const capabilities = (signal?: AbortSignal): Promise<ModelCapabilities> => {
    probe ??= (async () => {
      const own = signal ?? new AbortController().signal;
      try {
        const res = await httpRequest(
          { url: `${root}/api/show`, body: { model: config.model } },
          { signal: own, retry: { maxRetries: 0 }, ...http },
        );
        return capabilitiesFromShow(await res.json(), config.capabilities?.contextTokens);
      } catch (error) {
        throw ollamaError(error, config.model, own);
      }
    })();
    // A failed probe (Ollama not running yet) is retried on the next call.
    probe.catch(() => (probe = undefined));
    return probe;
  };

  return {
    id: config.id,
    provider: config.provider,
    model: config.model,
    capabilities,

    async *chat(req, signal) {
      try {
        if (signal.aborted) throw new ModelError('cancelled', 'Request cancelled');
        const probed = await capabilities(signal);
        const toolCalls = config.capabilities?.toolCalls ?? probed.toolCalls;
        const textTools = (req.tools?.length ?? 0) > 0 && !toolCalls;
        const url = `${root}/api/chat`;
        // Only set when Ollama sits behind an authenticating proxy.
        const key = await ctx.apiKey(signal);
        const res = await httpRequest(
          {
            url,
            headers: key ? { authorization: `Bearer ${key}` } : {},
            body: buildOllamaBody(config.model, req, probed.contextTokens, textTools),
          },
          {
            signal,
            secrets: ctx.secrets(),
            timeouts: LOCAL_TIMEOUTS,
            // A local server that refuses the connection is almost always not running: say so fast.
            retry: { maxRetries: 1 },
            ...http,
          },
        );
        yield* readOllamaStream(res.body(), { url: redact(url, ctx.secrets()), textTools });
      } catch (error) {
        yield errorEvent(ollamaError(error, config.model, signal, ctx.secrets()));
      }
    },
  };
}

/** Reads Ollama's NDJSON chat stream into normalized events. Throws `ModelError` on failure. */
export async function* readOllamaStream(
  body: AsyncIterable<Uint8Array>,
  opts: { url: string; textTools: boolean },
): AsyncGenerator<StreamEvent> {
  const calls: Array<Extract<StreamEvent, { type: 'tool_call' }>> = [];
  const parser = opts.textTools ? createTextToolParser(newCallId) : undefined;
  const seen = new Set<string>();

  const text = function* (chunk: string): Generator<StreamEvent> {
    if (!parser) {
      if (chunk !== '') yield { type: 'text_delta', text: chunk };
      return;
    }
    for (const event of parser.push(chunk)) {
      if (event.type === 'tool_call') calls.push(event);
      else yield event;
    }
  };

  for await (const line of parseNdjson(body)) {
    if ('invalid' in line) throw new ModelError('server', `Invalid stream data from ${opts.url}`);
    const parsed = ChunkWire.safeParse(line.value);
    if (!parsed.success) throw new ModelError('server', `Unexpected stream data from ${opts.url}`);
    const chunk = parsed.data;
    if (chunk.error) {
      const kind = classifyStatus(400, chunk.error);
      throw new ModelError(kind === 'context_length' ? kind : 'server', `Ollama: ${chunk.error}`);
    }
    if (chunk.message?.content) yield* text(chunk.message.content);
    // Ollama sends each tool call whole, in one chunk.
    for (const call of chunk.message?.tool_calls ?? []) {
      let id = call.id ?? '';
      if (id === '' || seen.has(id)) id = newCallId();
      seen.add(id);
      const args = call.function.arguments;
      calls.push({
        type: 'tool_call',
        call: {
          id,
          name: call.function.name,
          args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      });
    }
    if (chunk.done) {
      if (parser) {
        for (const event of parser.end()) {
          if (event.type === 'tool_call') calls.push(event);
          else yield event;
        }
      }
      yield* calls;
      if (chunk.prompt_eval_count != null || chunk.eval_count != null) {
        yield {
          type: 'usage',
          inputTokens: Math.round(chunk.prompt_eval_count ?? 0),
          outputTokens: Math.round(chunk.eval_count ?? 0),
        };
      }
      yield {
        type: 'done',
        stopReason: doneToStop(chunk.done_reason ?? undefined, calls.length > 0),
      };
      return;
    }
  }
  throw new ModelError('network', `The stream from ${opts.url} ended before the reply finished`, {
    hint: OLLAMA_NOT_RUNNING_HINT,
  });
}

const TagsWire = z.looseObject({
  models: z.array(
    z.looseObject({
      name: z.string().min(1),
      capabilities: z.array(z.string()).nullish(),
      details: z.looseObject({ context_length: z.number().positive().nullish() }).nullish(),
    }),
  ),
});

/** Installed models from `/api/tags`. Embedding-only models are left out: they can't chat. */
export async function discoverOllama(
  ctx: { baseUrl: string; fetch?: FetchLike; logger?: ModelLogger },
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  const res = await httpRequest(
    { url: `${ollamaRoot(ctx.baseUrl)}/api/tags` },
    {
      signal,
      retry: { maxRetries: 0 },
      timeouts: { connectMs: 2_000 },
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.logger ? { logger: ctx.logger } : {}),
    },
  );
  const tags = TagsWire.parse(await res.json());
  return tags.models.flatMap((m): DiscoveredModel[] => {
    const caps = m.capabilities;
    if (caps && !caps.includes('completion')) return [];
    const max = m.details?.context_length ?? undefined;
    return [
      {
        model: m.name,
        capabilities: {
          ...(caps ? { toolCalls: caps.includes('tools'), vision: caps.includes('vision') } : {}),
          ...(max ? { contextTokens: Math.min(max, OLLAMA_DEFAULT_CONTEXT) } : {}),
        },
      },
    ];
  });
}

export const ollamaProvider: ProviderDefinition = {
  create: createOllamaAdapter,
  discover: discoverOllama,
  defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
};
