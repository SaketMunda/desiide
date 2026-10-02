import type { ModelProvider } from '@desiide/protocol';
import { ModelError, errorEvent } from '../errors.ts';
import type {
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ModelErrorKind,
  StopReason,
  StreamEvent,
  ToolCallRequest,
} from '../types.ts';

/** One scripted model turn. Fields are emitted in order: text, tool calls, usage, then done. */
export interface FakeTurn {
  /** A string is streamed as one delta; an array as one delta per item. */
  text?: string | string[];
  toolCalls?: Array<Omit<ToolCallRequest, 'args'> & { args: string | Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number };
  /** Ends the turn with this error instead of `done` (after any text/tool calls). */
  error?: { kind: ModelErrorKind; message?: string };
  stopReason?: StopReason;
  /** Delay before each event, in ms. */
  delayMs?: number;
  /** Stream the text, then wait until the request is aborted. */
  hang?: boolean;
}

export interface FakeModelAdapterOptions {
  id?: string;
  provider?: ModelProvider;
  model?: string;
  turns?: FakeTurn[];
  capabilities?: Partial<ModelCapabilities>;
}

export interface FakeModelAdapter extends ModelAdapter {
  /** Every `chat` request received, in order (deep-copied). */
  readonly calls: ChatRequest[];
  /** Appends more scripted turns. */
  push(...turns: FakeTurn[]): void;
  readonly remaining: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalls: true,
  contextTokens: 32_000,
  maxOutputTokens: 4_096,
  vision: false,
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

const cancelled = (): StreamEvent => errorEvent(new ModelError('cancelled', 'Request cancelled'));

/**
 * Scripted adapter for orchestrator tests: each `chat` call plays the next `FakeTurn`. Running out
 * of turns ends the stream with an `unknown` error so a runaway loop fails loudly.
 */
export function createFakeModelAdapter(options: FakeModelAdapterOptions = {}): FakeModelAdapter {
  const turns = [...(options.turns ?? [])];
  const calls: ChatRequest[] = [];
  const capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  let callCount = 0;

  async function* play(turn: FakeTurn, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const events: StreamEvent[] = [];
    const texts = turn.text === undefined ? [] : Array.isArray(turn.text) ? turn.text : [turn.text];
    for (const text of texts) events.push({ type: 'text_delta', text });
    for (const call of turn.toolCalls ?? []) {
      const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args);
      events.push({ type: 'tool_call', call: { id: call.id, name: call.name, args } });
    }

    for (const event of events) {
      if (turn.delayMs) await sleep(turn.delayMs, signal);
      if (signal.aborted) return yield cancelled();
      yield event;
    }
    if (turn.hang) {
      await sleep(2 ** 31 - 1, signal);
      return yield cancelled();
    }
    if (turn.usage) yield { type: 'usage', ...turn.usage };
    if (turn.error) {
      const message = turn.error.message ?? `Fake ${turn.error.kind} error`;
      return yield errorEvent(new ModelError(turn.error.kind, message));
    }
    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'end');
    yield { type: 'done', stopReason };
  }

  return {
    id: options.id ?? 'fake',
    provider: options.provider ?? 'openai-compatible',
    model: options.model ?? 'fake-model',
    calls,
    get remaining() {
      return turns.length;
    },
    push(...more) {
      turns.push(...more);
    },
    capabilities() {
      return Promise.resolve({ ...capabilities });
    },
    async *chat(req, signal) {
      calls.push(structuredClone(req));
      callCount += 1;
      if (signal.aborted) return yield cancelled();
      const turn = turns.shift();
      if (!turn) {
        const message = `FakeModelAdapter "${options.id ?? 'fake'}" has no scripted turn for call #${callCount}`;
        return yield errorEvent(new ModelError('unknown', message));
      }
      yield* play(turn, signal);
    },
  };
}
