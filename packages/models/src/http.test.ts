import { describe, expect, it, vi } from 'vitest';
import { ModelError } from './errors.ts';
import {
  DEFAULT_RETRY,
  classifyStatus,
  httpRequest,
  isRetryable,
  parseRetryAfter,
  retryDelay,
  type FetchLike,
  type HttpOptions,
} from './http.ts';

const SENTINEL = 'sk-SENTINEL-KEY-do-not-leak-42';
const URL_ = 'https://api.example.test/v1/chat/completions';

type Step =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { stream: Array<string | Error>; delayMs?: number }
  | { networkError: string }
  | 'hang';

/** Fetch that plays one `Step` per call and records each call. */
function scriptedFetch(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error('scriptedFetch: no more steps');
    if (step === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if ('networkError' in step) {
      return Promise.reject(new TypeError('fetch failed', { cause: new Error(step.networkError) }));
    }
    if ('stream' in step) {
      const encoder = new TextEncoder();
      const chunks = [...step.stream];
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
          const next = chunks.shift();
          if (next === undefined) return controller.close();
          if (next instanceof Error) return controller.error(next);
          controller.enqueue(encoder.encode(next));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return Promise.resolve(
      new Response(step.body ?? '', { status: step.status, headers: step.headers ?? {} }),
    );
  };
  return { fetch, calls };
}

function opts(fetch: FetchLike, extra: Partial<HttpOptions> = {}) {
  const sleeps: number[] = [];
  const options: HttpOptions = {
    signal: new AbortController().signal,
    fetch,
    secrets: [SENTINEL],
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...extra,
  };
  return { options, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error('expected a ModelError');
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk, { stream: true });
  return out;
}

describe('retry policy table', () => {
  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [529, true],
    ['network' as const, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [408, false],
    [413, false],
    [422, false],
  ])('%s → retryable %s', (failure, expected) => {
    expect(isRetryable(failure)).toBe(expected);
  });

  it.each([
    [401, '', 'auth'],
    [403, '', 'auth'],
    [429, '', 'rate_limit'],
    [400, '{"error":"This model\'s maximum context length is 8192 tokens"}', 'context_length'],
    [400, 'prompt is too long: 210000 tokens > 200000 maximum', 'context_length'],
    [413, '', 'context_length'],
    [400, 'invalid temperature', 'bad_request'],
    [404, 'model not found', 'bad_request'],
    [408, '', 'timeout'],
    [500, '', 'server'],
    [503, '', 'server'],
  ])('HTTP %s %j → %s', (status, body, kind) => {
    expect(classifyStatus(status, body)).toBe(kind);
  });

  it('parses retry-after seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = Date.parse('2026-10-02T10:00:00Z');
    expect(parseRetryAfter('Fri, 02 Oct 2026 10:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Fri, 02 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('backs off exponentially with jitter, capped', () => {
    const p = DEFAULT_RETRY;
    expect(retryDelay(0, undefined, p, () => 0)).toBe(250);
    expect(retryDelay(0, undefined, p, () => 1)).toBe(500);
    expect(retryDelay(2, undefined, p, () => 1)).toBe(2000);
    expect(retryDelay(10, undefined, p, () => 1)).toBe(p.maxDelayMs);
    expect(retryDelay(3, 1234, p, () => 1)).toBe(1234);
  });
});

describe('httpRequest retries', () => {
  it('retries 429 and 5xx up to 3 times, then succeeds', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 429 },
      { status: 503 },
      { status: 500 },
      { status: 200, body: '{"ok":true}' },
    ]);
    const { options, sleeps } = opts(fetch);
    const res = await httpRequest({ url: URL_, body: { a: 1 } }, options);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([375, 750, 1500]);
  });

  it('gives up after 3 retries with the last error kind', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503, body: 'overloaded' },
    ]);
    const error = await failure(httpRequest({ url: URL_ }, opts(fetch).options));
    expect(calls).toHaveLength(4);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
    expect(error.message).toContain('overloaded');
  });

  it('honors retry-after', async () => {
    const { fetch } = scriptedFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: '{}' },
    ]);
    const { options, sleeps } = opts(fetch);
    await httpRequest({ url: URL_ }, options);
    expect(sleeps).toEqual([2000]);
  });

  it('does not wait for a retry-after beyond the cap', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, headers: { 'retry-after': '3600' } }]);
    const error = await failure(httpRequest({ url: URL_ }, opts(fetch).options));
    expect(calls).toHaveLength(1);
    expect(error.kind).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(3_600_000);
    expect(error.message).toContain('3600 s');
  });

  it.each([400, 401, 403, 404, 422])('never retries HTTP %s', async (status) => {
    const { fetch, calls } = scriptedFetch([{ status }, { status: 200 }]);
    await failure(httpRequest({ url: URL_ }, opts(fetch).options));
    expect(calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    const { fetch, calls } = scriptedFetch([
      { networkError: 'ECONNRESET' },
      { status: 200, body: '{}' },
    ]);
    await httpRequest({ url: URL_ }, opts(fetch).options);
    expect(calls).toHaveLength(2);
  });

  it('reports a network error after retries are exhausted', async () => {
    const { fetch } = scriptedFetch(
      Array.from({ length: 4 }, () => ({ networkError: 'ECONNREFUSED' })),
    );
    const error = await failure(httpRequest({ url: URL_ }, opts(fetch).options));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.hint).toBeDefined();
  });

  it('never retries once the body has started streaming', async () => {
    const { fetch, calls } = scriptedFetch([
      { stream: ['data: {"x":1}\n\n', new Error('socket hang up')] },
      { status: 200, body: 'should not be fetched' },
    ]);
    const res = await httpRequest({ url: URL_ }, opts(fetch).options);
    const error = await failure(drain(res.body()));
    expect(error.kind).toBe('network');
    expect(calls).toHaveLength(1);
  });

  it('does not retry when cancelled during backoff', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch([{ status: 503 }, { status: 200 }]);
    const error = await failure(
      httpRequest(
        { url: URL_ },
        opts(fetch, {
          signal: controller.signal,
          sleep: () => {
            controller.abort();
            return Promise.reject(new Error('aborted'));
          },
        }).options,
      ),
    );
    expect(error.kind).toBe('cancelled');
    expect(calls).toHaveLength(1);
  });
});

describe('httpRequest timeouts and cancellation', () => {
  it('connect timeout when headers never arrive', async () => {
    const { fetch } = scriptedFetch(['hang']);
    const error = await failure(
      httpRequest({ url: URL_ }, opts(fetch, { timeouts: { connectMs: 20 } }).options),
    );
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('connecting');
  });

  it('first-token timeout when the body never starts', async () => {
    const { fetch } = scriptedFetch([{ stream: ['late'], delayMs: 200 }]);
    const res = await httpRequest(
      { url: URL_ },
      opts(fetch, { timeouts: { firstByteMs: 20 } }).options,
    );
    const error = await failure(drain(res.body()));
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('first token');
  });

  it('idle timeout between chunks', async () => {
    let n = 0;
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (n++ > 0) await new Promise((r) => setTimeout(r, 200));
              controller.enqueue(new TextEncoder().encode('x'));
            },
          }),
        ),
      );
    const res = await httpRequest({ url: URL_ }, opts(fetch, { timeouts: { idleMs: 20 } }).options);
    const error = await failure(drain(res.body()));
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('more output');
  });

  it('user abort mid-stream ends with cancelled', async () => {
    const controller = new AbortController();
    const { fetch } = scriptedFetch([{ stream: ['a', 'b', 'c'], delayMs: 30 }]);
    const res = await httpRequest(
      { url: URL_ },
      opts(fetch, { signal: controller.signal }).options,
    );
    setTimeout(() => controller.abort(), 40);
    const error = await failure(drain(res.body()));
    expect(error.kind).toBe('cancelled');
  });

  it('already-aborted signal never calls fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = scriptedFetch([{ status: 200 }]);
    const error = await failure(
      httpRequest({ url: URL_ }, opts(fetch, { signal: controller.signal }).options),
    );
    expect(error.kind).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('sends JSON with content-type and caller headers', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: '{}' }]);
    await httpRequest(
      { url: URL_, headers: { authorization: `Bearer ${SENTINEL}` }, body: { q: 1 } },
      opts(fetch).options,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"q":1}');
    expect(calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });
});

describe('key redaction (sentinel key)', () => {
  it('never puts the key in errors or logs, across every failure path', async () => {
    const logs: string[] = [];
    const logger = {
      debug: vi.fn((obj: object, msg?: string) => logs.push(JSON.stringify(obj) + (msg ?? ''))),
      warn: vi.fn((obj: object, msg?: string) => logs.push(JSON.stringify(obj) + (msg ?? ''))),
    };
    const keyUrl = `https://gen.example.test/v1/models?key=${SENTINEL}`;
    const echo = `{"error":"invalid api key ${SENTINEL}","headers":{"authorization":"Bearer ${SENTINEL}"}}`;
    const scenarios: Step[][] = [
      [{ status: 401, body: echo }],
      [
        { status: 503, body: echo },
        { status: 503, body: echo },
        { status: 503, body: echo },
        { status: 503, body: echo },
      ],
      Array.from({ length: 4 }, () => ({ networkError: `connect failed for ${SENTINEL}` })),
      [{ status: 429, body: echo, headers: { 'retry-after': '9999' } }],
      [{ status: 400, body: `context length exceeded ${SENTINEL}` }],
    ];
    const errors: ModelError[] = [];
    for (const steps of scenarios) {
      const { fetch } = scriptedFetch(steps);
      errors.push(
        await failure(
          httpRequest(
            { url: keyUrl, headers: { authorization: `Bearer ${SENTINEL}` } },
            opts(fetch, { logger }).options,
          ),
        ),
      );
    }
    const { fetch } = scriptedFetch(['hang']);
    errors.push(
      await failure(
        httpRequest({ url: keyUrl }, opts(fetch, { logger, timeouts: { connectMs: 10 } }).options),
      ),
    );

    expect(logs.length).toBeGreaterThan(0);
    for (const error of errors) {
      const surface = [
        error.message,
        error.hint ?? '',
        JSON.stringify(error.toInfo()),
        String(error.stack),
        JSON.stringify(error),
      ];
      for (const text of surface) expect(text).not.toContain(SENTINEL);
    }
    for (const line of logs) expect(line).not.toContain(SENTINEL);
    expect(errors[0]?.message).toContain('***');
  });

  it('redacts credential-shaped values even when the key is not registered', async () => {
    const { fetch } = scriptedFetch([
      { status: 401, body: 'bad header Authorization: Bearer abcdefghijkl' },
    ]);
    const error = await failure(httpRequest({ url: URL_ }, opts(fetch, { secrets: [] }).options));
    expect(error.message).not.toContain('abcdefghijkl');
  });
});
