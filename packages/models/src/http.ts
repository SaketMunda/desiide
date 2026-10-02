import { ModelError, defaultHint, isAbortError } from './errors.ts';
import { redact } from './redact.ts';
import type { ModelErrorKind } from './types.ts';

export interface HttpTimeouts {
  /** Until response headers arrive. */
  connectMs: number;
  /** From response headers to the first body chunk (the model's first token). */
  firstByteMs: number;
  /** Between body chunks. */
  idleMs: number;
}

export const DEFAULT_TIMEOUTS: HttpTimeouts = {
  connectMs: 10_000,
  firstByteMs: 60_000,
  idleMs: 30_000,
};

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A `retry-after` longer than this is not waited for; the request fails with `rate_limit`. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
};

/** Structural subset of pino's logger, so the orchestrator can pass its own. */
export interface ModelLogger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Serialized as JSON. */
  body?: unknown;
}

export interface HttpOptions {
  signal: AbortSignal;
  /** Values (API keys) scrubbed from every error message and log line. */
  secrets?: readonly string[];
  timeouts?: Partial<HttpTimeouts>;
  retry?: Partial<RetryPolicy>;
  fetch?: FetchLike;
  logger?: ModelLogger;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Body chunks with first-byte and idle timeouts. Errors here are never retried. */
  body(): AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const MAX_ERROR_BODY = 2_000;

/** Which failures may be retried. Only before any response body has been consumed. */
export function isRetryable(failure: number | 'network'): boolean {
  return failure === 'network' || failure === 429 || (failure >= 500 && failure <= 599);
}

/** `retry-after` as seconds or an HTTP date → ms. `undefined` when absent or unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with full jitter; a server-provided `retry-after` wins. */
export function retryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(cap / 2 + (random() * cap) / 2);
}

const CONTEXT_LENGTH =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|reduce the length|num_ctx/i;

export function classifyStatus(status: number, body = ''): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_LENGTH.test(body)) {
    return 'context_length';
  }
  if (status === 413) return 'context_length';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class TimeoutSignal {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal = this.controller.signal;
  phase: keyof HttpTimeouts | undefined;

  arm(phase: keyof HttpTimeouts, ms: number): void {
    this.clear();
    this.phase = phase;
    this.timer = setTimeout(() => this.controller.abort(new Error(`${phase} timeout`)), ms);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get fired(): boolean {
    return this.controller.signal.aborted;
  }
}

const PHASE_LABEL: Record<keyof HttpTimeouts, string> = {
  connectMs: 'connecting',
  firstByteMs: 'waiting for the first token',
  idleMs: 'waiting for more output',
};

/**
 * One provider HTTP call with the shared timeout, retry and redaction rules. Resolves once a 2xx
 * response's headers arrive; reading its body is never retried, so a stream that started is never
 * replayed. Every failure is a redacted `ModelError`.
 */
export async function httpRequest(req: HttpRequest, options: HttpOptions): Promise<HttpResponse> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const policy = { ...DEFAULT_RETRY, ...options.retry };
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? [];
  const { signal, logger } = options;
  const safeUrl = redact(req.url, secrets);
  const fail = (
    kind: ModelErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) => {
    const hint = defaultHint(kind);
    return new ModelError(kind, message, { ...extra, ...(hint ? { hint } : {}), secrets });
  };

  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw fail('cancelled', 'Request cancelled');
    const timeout = new TimeoutSignal();
    const combined = AbortSignal.any([signal, timeout.signal]);
    timeout.arm('connectMs', timeouts.connectMs);

    let response: Response;
    try {
      response = await doFetch(req.url, {
        method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...req.headers,
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: combined,
      });
    } catch (error) {
      timeout.clear();
      if (signal.aborted) throw fail('cancelled', 'Request cancelled');
      if (timeout.fired) {
        throw fail(
          'timeout',
          `No response from ${safeUrl} after ${timeouts.connectMs} ms (connecting)`,
        );
      }
      const reason =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error);
      if (attempt < policy.maxRetries && !isAbortError(error)) {
        const delay = retryDelay(attempt, undefined, policy, random);
        logger?.debug(
          { url: safeUrl, attempt: attempt + 1, delayMs: delay, error: redact(reason, secrets) },
          'model http: network error, retrying',
        );
        await sleepOrCancel(sleep, delay, signal, fail);
        continue;
      }
      throw fail('network', `Could not reach ${safeUrl}: ${reason}`);
    }

    if (response.ok) {
      timeout.clear();
      return wrapResponse(response, { timeout, timeouts, signal, fail, safeUrl });
    }

    let body = '';
    try {
      body = (await response.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      // The status alone is enough to classify.
    }
    timeout.clear();
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
    const kind = classifyStatus(status, body);
    const message = `HTTP ${status} from ${safeUrl}${body ? `: ${body.trim()}` : ''}`;
    const retryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };

    if (isRetryable(status) && attempt < policy.maxRetries) {
      if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
        throw fail(
          kind,
          `${message} (server asked to retry after ${Math.ceil(retryAfterMs / 1000)} s)`,
          { status, ...retryAfter },
        );
      }
      const delay = retryDelay(attempt, retryAfterMs, policy, random);
      logger?.debug(
        { url: safeUrl, status, attempt: attempt + 1, delayMs: delay },
        'model http: retrying',
      );
      await sleepOrCancel(sleep, delay, signal, fail);
      continue;
    }
    logger?.warn({ url: safeUrl, status, kind }, 'model http: request failed');
    throw fail(kind, message, { status, ...retryAfter });
  }
}

async function sleepOrCancel(
  sleep: NonNullable<HttpOptions['sleep']>,
  ms: number,
  signal: AbortSignal,
  fail: (kind: ModelErrorKind, message: string) => ModelError,
): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch {
    throw fail('cancelled', 'Request cancelled');
  }
  if (signal.aborted) throw fail('cancelled', 'Request cancelled');
}

interface WrapContext {
  timeout: TimeoutSignal;
  timeouts: HttpTimeouts;
  signal: AbortSignal;
  fail: (kind: ModelErrorKind, message: string) => ModelError;
  safeUrl: string;
}

function wrapResponse(response: Response, ctx: WrapContext): HttpResponse {
  let consumed = false;
  const take = (): void => {
    if (consumed) throw new Error('Response body already consumed');
    consumed = true;
  };

  async function* body(): AsyncGenerator<Uint8Array> {
    take();
    const { timeout, timeouts, signal, fail, safeUrl } = ctx;
    if (!response.body) return;
    const reader = response.body.getReader();
    const stop = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void =>
        reject(
          signal.aborted
            ? fail('cancelled', 'Request cancelled')
            : fail(
                'timeout',
                `${safeUrl} stopped responding while ${PHASE_LABEL[timeout.phase ?? 'idleMs']}`,
              ),
        );
      AbortSignal.any([signal, timeout.signal]).addEventListener('abort', onAbort, { once: true });
    });
    stop.catch(() => {});
    let finished = false;
    try {
      timeout.arm('firstByteMs', timeouts.firstByteMs);
      for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await Promise.race([reader.read(), stop]);
        } catch (error) {
          if (error instanceof ModelError) throw error;
          if (signal.aborted) throw fail('cancelled', 'Request cancelled');
          const reason = error instanceof Error ? error.message : String(error);
          throw fail('network', `Connection to ${safeUrl} dropped mid-response: ${reason}`);
        }
        if (result.done) {
          finished = true;
          return;
        }
        timeout.arm('idleMs', timeouts.idleMs);
        yield result.value;
      }
    } finally {
      timeout.clear();
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function text(): Promise<string> {
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of body()) out += decoder.decode(chunk, { stream: true });
    return out + decoder.decode();
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    text,
    async json() {
      const raw = await text();
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw ctx.fail('server', `Invalid JSON from ${ctx.safeUrl}`);
      }
    },
  };
}
