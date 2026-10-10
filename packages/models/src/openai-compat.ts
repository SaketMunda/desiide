import * as z from 'zod';
import { ModelError, errorEvent, toModelError } from './errors.ts';
import { classifyStatus, httpRequest, type HttpResponse, type HttpTimeouts } from './http.ts';
import { inferLocality } from './locality.ts';
import { adaptQuirks, resolveQuirks, type ResolvedQuirks } from './quirks.ts';
import { FALLBACK_CAPABILITIES, type ProviderContext } from './registry.ts';
import { redact } from './redact.ts';
import { parseSse } from './sse.ts';
import { createTextToolParser, textToolsMessages, textToolsSystem } from './text-tools.ts';
import { createToolCallAccumulator } from './tool-calls.ts';
import type {
  ChatMessage,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ReasoningLevel,
  StopReason,
  StreamEvent,
} from './types.ts';

/** Local servers (LM Studio, llama.cpp, vLLM) may hold the response while they load the model. */
export const LOCAL_TIMEOUTS: Partial<HttpTimeouts> = { connectMs: 120_000 };

/** Most current OpenAI-compatible servers call tools; set `capabilities.toolCalls: false` if not. */
const DEFAULT_CAPABILITIES: ModelCapabilities = { ...FALLBACK_CAPABILITIES, toolCalls: true };

const ToolCallDeltaWire = z.looseObject({
  index: z.int().nonnegative().optional(),
  id: z.string().nullish(),
  function: z
    .looseObject({
      name: z.string().nullish(),
      // Usually a string fragment; a few servers send the parsed object.
      arguments: z.unknown().optional(),
    })
    .nullish(),
});

const ChunkWire = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            // DeepSeek, vLLM and llama.cpp say `reasoning_content`; OpenRouter and Ollama `reasoning`.
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z.array(ToolCallDeltaWire).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .looseObject({
      prompt_tokens: z.number().nonnegative().nullish(),
      completion_tokens: z.number().nonnegative().nullish(),
      prompt_tokens_details: z
        .looseObject({ cached_tokens: z.number().nonnegative().nullish() })
        .nullish(),
    })
    .nullish(),
  error: z
    .union([
      z.string(),
      z.looseObject({
        message: z.string().optional(),
        code: z.union([z.string(), z.number()]).nullish(),
        type: z.string().nullish(),
      }),
    ])
    .nullish(),
});
type ChunkWire = z.infer<typeof ChunkWire>;

export function finishToStop(reason: string | undefined, hasToolCalls: boolean): StopReason {
  // Some servers (Ollama, older vLLM) say "stop" even when the turn ended in tool calls.
  if (hasToolCalls && (reason === undefined || reason === 'stop' || reason === 'tool_calls')) {
    return 'tool_calls';
  }
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case undefined:
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/** An error the server put inside the stream (after a 200). */
export function streamError(
  error: NonNullable<ChunkWire['error']>,
  url: string,
  secrets: readonly string[],
): ModelError {
  const message = typeof error === 'string' ? error : (error.message ?? 'unknown error');
  const code = typeof error === 'string' ? '' : `${error.code ?? ''} ${error.type ?? ''}`;
  const kind = /rate_limit/.test(code) ? 'rate_limit' : classifyStatus(400, `${code} ${message}`);
  return new ModelError(
    kind === 'bad_request' ? 'server' : kind,
    `Error from ${url} mid-response: ${message}`,
    { secrets },
  );
}

function toWireMessages(system: string | undefined, messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      out.push({
        role: 'assistant',
        content: m.content === '' && calls.length > 0 ? null : m.content,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.args },
              })),
            }
          : {}),
      });
    } else {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.isError ? `Error: ${m.content}` : m.content,
      });
    }
  }
  return out;
}

/**
 * `reasoning_effort` for a reasoning level (ADR-022). Unset sends nothing; `off` is `none`, which
 * current OpenAI reasoning models and OpenRouter accept. A server that rejects the field gets the
 * request again without it (see `createOpenAICompatAdapter`).
 */
export function reasoningEffort(level: ReasoningLevel | undefined): string | undefined {
  return level === 'off' ? 'none' : level;
}

export function buildChatBody(
  model: string,
  req: ChatRequest,
  quirks: ResolvedQuirks,
  textTools: boolean,
  reasoning?: ReasoningLevel,
): Record<string, unknown> {
  const effort = reasoningEffort(reasoning);
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
    ...(req.maxTokens === undefined ? {} : { [quirks.maxTokensField]: req.maxTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(quirks.streamUsage ? { stream_options: { include_usage: true } } : {}),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };
}

/** The server doesn't know `reasoning_effort` (or this value of it). */
function rejectsReasoningEffort(error: unknown): boolean {
  return (
    error instanceof ModelError &&
    error.kind === 'bad_request' &&
    /reasoning[_ ]effort/i.test(error.message)
  );
}

const newCallId = (): string => `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

/** Reads an OpenAI-style SSE chat stream into normalized events. Throws `ModelError` on failure. */
export async function* readChatStream(
  res: HttpResponse,
  opts: { url: string; secrets: () => readonly string[]; textTools: boolean },
): AsyncGenerator<StreamEvent> {
  const calls = createToolCallAccumulator(newCallId);
  const textCalls: Array<Extract<StreamEvent, { type: 'tool_call' }>> = [];
  const parser = opts.textTools ? createTextToolParser(newCallId) : undefined;
  let finish: string | undefined;
  let finished = false;
  let usage: Extract<StreamEvent, { type: 'usage' }> | undefined;

  const emitText = function* (text: string): Generator<StreamEvent> {
    if (!parser) {
      if (text !== '') yield { type: 'text_delta', text };
      return;
    }
    for (const event of parser.push(text)) {
      if (event.type === 'tool_call') textCalls.push(event);
      else yield event;
    }
  };

  for await (const event of parseSse(res.body(), { stopAtDone: false })) {
    const data = event.data.trim();
    if (data === '[DONE]') {
      finished = true;
      break;
    }
    if (data === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw new ModelError('server', `Invalid stream data from ${opts.url}`);
    }
    const parsed = ChunkWire.safeParse(raw);
    if (!parsed.success) throw new ModelError('server', `Unexpected stream data from ${opts.url}`);
    const chunk = parsed.data;
    if (chunk.error) throw streamError(chunk.error, opts.url, opts.secrets());
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        type: 'usage',
        inputTokens: Math.round(chunk.usage.prompt_tokens ?? 0),
        outputTokens: Math.round(chunk.usage.completion_tokens ?? 0),
        ...(cached ? { cacheReadTokens: Math.round(cached) } : {}),
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (reasoning) yield { type: 'reasoning_delta', text: reasoning };
    if (choice.delta?.content) yield* emitText(choice.delta.content);
    for (const delta of choice.delta?.tool_calls ?? []) {
      const args = delta.function?.arguments;
      calls.add({
        ...(delta.index === undefined ? {} : { index: delta.index }),
        ...(delta.id ? { id: delta.id } : {}),
        ...(delta.function?.name ? { name: delta.function.name } : {}),
        ...(args === undefined || args === null
          ? {}
          : { args: typeof args === 'string' ? args : JSON.stringify(args) }),
      });
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason;
      finished = true;
    }
  }

  if (!finished) {
    throw new ModelError('network', `The stream from ${opts.url} ended before the reply finished`, {
      hint: 'The connection dropped. Try again.',
    });
  }
  if (parser) {
    for (const event of parser.end()) {
      if (event.type === 'tool_call') textCalls.push(event);
      else yield event;
    }
  }
  const toolCalls = [
    ...calls.finish().map((call) => ({ type: 'tool_call' as const, call })),
    ...textCalls,
  ];
  yield* toolCalls;
  if (usage) yield usage;
  yield { type: 'done', stopReason: finishToStop(finish, toolCalls.length > 0) };
}

/**
 * Any server that speaks OpenAI's `/chat/completions` with SSE streaming: OpenAI, OpenRouter,
 * Gemini's OpenAI endpoint, vLLM, LM Studio, llama.cpp. Models without tool calling
 * (`capabilities.toolCalls: false`) get the text-based tool protocol.
 */
export function createOpenAICompatAdapter(ctx: ProviderContext): ModelAdapter {
  const { config } = ctx;
  if (!config.baseUrl) {
    throw new Error('An openai-compatible model needs a baseUrl, e.g. https://api.openai.com/v1');
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeouts = inferLocality(config) === 'local' ? LOCAL_TIMEOUTS : {};
  let quirks = resolveQuirks(config);
  // Cleared for good once the server rejects `reasoning_effort`.
  let sendEffort = true;
  const toolCalls = config.capabilities?.toolCalls ?? DEFAULT_CAPABILITIES.toolCalls;

  return {
    id: config.id,
    provider: config.provider,
    model: config.model,

    capabilities: () => Promise.resolve(DEFAULT_CAPABILITIES),

    async *chat(req, signal) {
      try {
        if (signal.aborted) throw new ModelError('cancelled', 'Request cancelled');
        const textTools = (req.tools?.length ?? 0) > 0 && !toolCalls;
        const key = await ctx.apiKey(signal);
        const reasoning = sendEffort ? (req.reasoning ?? config.reasoning) : undefined;
        const send = (q: ResolvedQuirks, level: ReasoningLevel | undefined) =>
          httpRequest(
            {
              url,
              headers: key ? { authorization: `Bearer ${key}` } : {},
              body: buildChatBody(config.model, req, q, textTools, level),
            },
            {
              signal,
              secrets: ctx.secrets(),
              timeouts,
              ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
              ...(ctx.logger ? { logger: ctx.logger } : {}),
            },
          );
        let res: HttpResponse;
        try {
          res = await send(quirks, reasoning);
        } catch (error) {
          if (reasoning !== undefined && rejectsReasoningEffort(error)) {
            ctx.logger?.debug({ modelId: config.id }, 'retrying without reasoning_effort');
            sendEffort = false;
            res = await send(quirks, undefined);
          } else {
            const adapted = adaptQuirks(error, quirks);
            if (!adapted) throw error;
            ctx.logger?.debug(
              { modelId: config.id, quirks: adapted },
              'retrying with adapted quirks',
            );
            quirks = adapted;
            res = await send(quirks, reasoning);
          }
        }
        yield* readChatStream(res, {
          url: redact(url, ctx.secrets()),
          secrets: () => ctx.secrets(),
          textTools,
        });
      } catch (error) {
        yield errorEvent(toModelError(error, signal, ctx.secrets()));
      }
    },
  };
}
