import { redact } from './redact.ts';
import type { ModelErrorInfo, ModelErrorKind, StreamEvent } from './types.ts';

export interface ModelErrorOptions {
  hint?: string;
  status?: number;
  /** Server-requested wait (from `retry-after`), used by the retry policy. */
  retryAfterMs?: number;
  /** Secret values to scrub from the message and hint. */
  secrets?: Iterable<string>;
  cause?: unknown;
}

/** The only error type adapters surface. Message and hint are redacted at construction. */
export class ModelError extends Error {
  override readonly name = 'ModelError';
  readonly kind: ModelErrorKind;
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ModelErrorKind, message: string, options: ModelErrorOptions = {}) {
    const secrets = options.secrets ? [...options.secrets] : [];
    // The cause is kept off the error: it may carry an unredacted request.
    super(redact(message, secrets));
    this.kind = kind;
    this.hint = options.hint === undefined ? undefined : redact(options.hint, secrets);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  toInfo(): ModelErrorInfo {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Normalizes anything thrown inside an adapter into a `ModelError`. */
export function toModelError(
  error: unknown,
  signal?: AbortSignal,
  secrets?: Iterable<string>,
): ModelError {
  if (error instanceof ModelError) return error;
  if (signal?.aborted) {
    return new ModelError('cancelled', 'Request cancelled', secrets ? { secrets } : {});
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelError('unknown', message, secrets ? { secrets } : {});
}

export function errorEvent(error: ModelError): StreamEvent {
  return { type: 'error', error: error.toInfo() };
}

const HINTS: Partial<Record<ModelErrorKind, string>> = {
  auth: 'Check the API key for this model in Desiide settings.',
  rate_limit: 'The provider is rate limiting. Wait a moment or switch models.',
  context_length: 'The request is too large for this model. Reduce context or pick a larger model.',
  network: 'Check the base URL and that the server is reachable.',
  timeout: 'The provider did not respond in time. Try again or pick a faster model.',
};

export function defaultHint(kind: ModelErrorKind): string | undefined {
  return HINTS[kind];
}
