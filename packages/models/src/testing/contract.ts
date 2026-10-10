import { describe, expect, it } from 'vitest';
import {
  ModelCapabilities,
  StreamEvent,
  type ChatRequest,
  type ModelAdapter,
  type ModelErrorKind,
} from '../types.ts';

/**
 * Fixtures for the adapter contract. `F` is whatever the adapter's factory needs to replay a
 * scenario: scripted turns for the fake, a recorded HTTP exchange for real providers.
 */
export interface ContractFixtures<F> {
  /** A plain text reply. */
  text: { fixture: F; expectText: string; expectUsage?: boolean };
  /** Required when the adapter reports `toolCalls: true`. */
  toolCalls?: { fixture: F; expectCalls: Array<{ name: string; args: unknown }> };
  /** Each fixture must end the stream with an `error` event of this kind (e.g. 401 → auth). */
  errors?: Array<{ fixture: F; kind: ModelErrorKind; label?: string }>;
  /** A slow stream with more than one event; the harness aborts after the first one. */
  cancel?: { fixture: F };
  /** Request sent for every scenario. */
  request?: ChatRequest;
}

export type ContractFactory<F> = (fixture: F) => ModelAdapter | Promise<ModelAdapter>;

const DEFAULT_REQUEST: ChatRequest = {
  system: 'You are a test.',
  messages: [{ role: 'user', content: 'Say hello.' }],
};

const TOOL_REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'Read a.ts' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
};

/** Invariants every stream must satisfy, whatever the scenario. Returns the parsed events. */
export function assertStreamInvariants(events: unknown[]): StreamEvent[] {
  const parsed = events.map((event, i) => {
    const result = StreamEvent.safeParse(event);
    if (!result.success)
      throw new Error(`event #${i} is not a valid StreamEvent: ${JSON.stringify(event)}`);
    return result.data;
  });
  const terminal = parsed.filter((e) => e.type === 'done' || e.type === 'error');
  expect(terminal, 'exactly one done/error event').toHaveLength(1);
  expect(parsed.at(-1), 'done/error is the last event').toBe(terminal[0]);
  expect(
    parsed.filter((e) => e.type === 'usage').length,
    'at most one usage event',
  ).toBeLessThanOrEqual(1);
  expect(
    parsed.filter((e) => e.type === 'provider_state').length,
    'at most one provider_state event',
  ).toBeLessThanOrEqual(1);
  const ids = parsed.flatMap((e) => (e.type === 'tool_call' ? [e.call.id] : []));
  expect(new Set(ids).size, 'tool call ids are unique').toBe(ids.length);
  return parsed;
}

/** Drains a stream. A throw is a contract violation: adapters report failures as events. */
export async function collectEvents(
  stream: AsyncIterable<StreamEvent>,
  onEvent?: (event: StreamEvent, index: number) => void,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
      onEvent?.(event, events.length - 1);
    }
  } catch (error) {
    throw new Error(`adapter threw instead of yielding an error event: ${String(error)}`, {
      cause: error,
    });
  }
  return events;
}

/**
 * The contract every `ModelAdapter` must pass (MOD-2, MOD-3, …). Registers Vitest tests; call it
 * inside a `describe`.
 */
export function runAdapterContract<F>(
  factory: ContractFactory<F>,
  fixtures: ContractFixtures<F>,
): void {
  const request = fixtures.request ?? DEFAULT_REQUEST;

  describe('adapter contract', () => {
    it('reports valid capabilities', async () => {
      const adapter = await factory(fixtures.text.fixture);
      expect(adapter.id).not.toBe('');
      expect(adapter.model).not.toBe('');
      const caps = ModelCapabilities.safeParse(await adapter.capabilities());
      expect(caps.success, caps.success ? '' : caps.error.message).toBe(true);
      if (caps.success && caps.data.toolCalls) {
        expect(
          fixtures.toolCalls,
          'adapter reports toolCalls: true, so a toolCalls fixture is required',
        ).toBeDefined();
      }
    });

    it('streams text and ends with done', async () => {
      const adapter = await factory(fixtures.text.fixture);
      const events = assertStreamInvariants(
        await collectEvents(adapter.chat(request, new AbortController().signal)),
      );
      const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
      expect(text).toBe(fixtures.text.expectText);
      expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' });
      if (fixtures.text.expectUsage) {
        const usage = events.find((e) => e.type === 'usage');
        expect(usage, 'usage event').toBeDefined();
      }
    });

    if (fixtures.toolCalls) {
      const { fixture, expectCalls } = fixtures.toolCalls;
      it('emits complete tool calls with raw JSON args', async () => {
        const adapter = await factory(fixture);
        const events = assertStreamInvariants(
          await collectEvents(adapter.chat(TOOL_REQUEST, new AbortController().signal)),
        );
        const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
        expect(calls.map((c) => ({ name: c.name, args: JSON.parse(c.args) as unknown }))).toEqual(
          expectCalls,
        );
        for (const call of calls) expect(call.id).not.toBe('');
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_calls' });
      });
    }

    for (const [i, { fixture, kind, label }] of (fixtures.errors ?? []).entries()) {
      it(`reports ${label ?? `error #${i + 1}`} as a ${kind} error event`, async () => {
        const adapter = await factory(fixture);
        const events = assertStreamInvariants(
          await collectEvents(adapter.chat(request, new AbortController().signal)),
        );
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind } });
      });
    }

    it('an already-aborted request ends with cancelled', async () => {
      const adapter = await factory(fixtures.text.fixture);
      const controller = new AbortController();
      controller.abort();
      const events = assertStreamInvariants(
        await collectEvents(adapter.chat(request, controller.signal)),
      );
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
      expect(events.some((e) => e.type === 'text_delta')).toBe(false);
    });

    if (fixtures.cancel) {
      const { fixture } = fixtures.cancel;
      it('aborting mid-stream ends with cancelled within 1 s', async () => {
        const adapter = await factory(fixture);
        const controller = new AbortController();
        const started = Date.now();
        const events = assertStreamInvariants(
          await collectEvents(adapter.chat(request, controller.signal), (_event, index) => {
            if (index === 0) controller.abort();
          }),
        );
        expect(Date.now() - started).toBeLessThan(1000);
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
      });
    }
  });
}
