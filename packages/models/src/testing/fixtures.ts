import { readFileSync } from 'node:fs';
import * as z from 'zod';
import type { FetchLike } from '../http.ts';

/**
 * Recorded HTTP exchanges, one JSON object per line (`test/fixtures/<provider>/*.jsonl`):
 *
 *     {"response":{"status":200,"headers":{"content-type":"text/event-stream"}}}
 *     {"chunk":"data: {...}\n\n"}
 *     {"chunk":"data: [DONE]\n\n"}
 *
 * Several exchanges (e.g. a 429 then a 200) follow each other in one file. An optional
 * `{"delayMs":n}` line pauses before the next chunk. Record without keys: never commit an
 * `authorization` or `x-api-key` header.
 */
const Line = z.union([
  z.strictObject({
    response: z.strictObject({
      status: z.int().min(100).max(599),
      headers: z.record(z.string(), z.string()).default({}),
    }),
  }),
  z.strictObject({ chunk: z.string() }),
  z.strictObject({ delayMs: z.int().nonnegative() }),
]);

export interface RecordedExchange {
  status: number;
  headers: Record<string, string>;
  /** Strings are body chunks; numbers are pauses in ms. */
  body: Array<string | number>;
}

const FORBIDDEN_HEADERS = /^(authorization|x-api-key|api-key|cookie|set-cookie)$/i;

export function parseFixture(text: string): RecordedExchange[] {
  const exchanges: RecordedExchange[] = [];
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .forEach((raw, i) => {
      const line = Line.parse(JSON.parse(raw), { error: () => `fixture line ${i + 1} is invalid` });
      if ('response' in line) {
        for (const name of Object.keys(line.response.headers)) {
          if (FORBIDDEN_HEADERS.test(name))
            throw new Error(`fixture line ${i + 1} records a "${name}" header`);
        }
        exchanges.push({ status: line.response.status, headers: line.response.headers, body: [] });
        return;
      }
      const current = exchanges.at(-1);
      if (!current) throw new Error(`fixture line ${i + 1}: a chunk before any response`);
      current.body.push('chunk' in line ? line.chunk : line.delayMs);
    });
  return exchanges;
}

export function loadFixture(path: string): RecordedExchange[] {
  return parseFixture(readFileSync(path, 'utf8'));
}

export interface ReplayFetch {
  fetch: FetchLike;
  /** Each request made, with the parsed JSON body. Headers are kept so tests can assert auth. */
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
}

/** A `fetch` that serves recorded exchanges in order and honors abort signals mid-body. */
export function replayFetch(exchanges: readonly RecordedExchange[]): ReplayFetch {
  const queue = [...exchanges];
  const requests: ReplayFetch['requests'] = [];
  const fetch: FetchLike = (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, method: init.method ?? 'GET', headers, body });
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const exchange = queue.shift();
    if (!exchange)
      return Promise.reject(new Error(`replayFetch: no recorded exchange left for ${url}`));
    const encoder = new TextEncoder();
    const parts = [...exchange.body];
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const next = parts.shift();
          if (next === undefined) return controller.close();
          if (typeof next === 'number') {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, next);
              signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), {
                once: true,
              });
            });
            if (signal?.aborted) return controller.error(signal.reason);
            continue;
          }
          return controller.enqueue(encoder.encode(next));
        }
      },
    });
    return Promise.resolve(
      new Response(stream, { status: exchange.status, headers: exchange.headers }),
    );
  };
  return { fetch, requests };
}
