import { SecretRef } from '@desiide/protocol';
import { ModelError } from './errors.ts';

/** COR-1's `host.requestSecret`: asks the extension (`secrets.get`). `null` when unset. */
export type RequestSecret = (ref: string, signal?: AbortSignal) => Promise<string | null>;

export interface SecretResolver {
  /** The key for `secret:<name>`. Throws an `auth` ModelError when it isn't set. */
  resolve(ref: string, signal?: AbortSignal): Promise<string>;
  /** Values resolved so far, for redaction. */
  known(): string[];
  /** Forgets every cached value (on `config.update`). */
  clear(): void;
}

/**
 * Resolves `secret:<name>` refs on demand and caches the values in memory only. Concurrent
 * lookups share one request; a missing key or a failed lookup is not cached, so a key the user
 * adds later is picked up on the next call.
 */
export function createSecretResolver(request: RequestSecret): SecretResolver {
  let cache = new Map<string, Promise<string>>();
  const values = new Set<string>();

  return {
    resolve(ref, signal) {
      const parsed = SecretRef.safeParse(ref);
      if (!parsed.success) {
        return Promise.reject(
          new ModelError('auth', 'API key setting is not a secret:<name> reference', {
            hint: 'Use secret:<name>.',
          }),
        );
      }
      const cached = cache.get(ref);
      if (cached) return cached;

      const owner = cache;
      const name = ref.slice('secret:'.length);
      const pending = request(ref, signal).then(
        (value) => {
          if (value === null || value === '') {
            throw new ModelError('auth', `No API key is stored for "${name}"`, {
              hint: `Add the "${name}" key in Desiide settings.`,
            });
          }
          // Ignore results that arrive after a clear(); the config they belong to is gone.
          if (owner === cache) values.add(value);
          return value;
        },
        (error: unknown) => {
          if (error instanceof ModelError) throw error;
          const kind = signal?.aborted ? 'cancelled' : 'auth';
          throw new ModelError(kind, `Could not read the "${name}" key from the editor`, {
            hint: 'Restart the orchestrator if this persists.',
          });
        },
      );
      cache.set(ref, pending);
      pending.catch(() => {
        if (cache.get(ref) === pending) cache.delete(ref);
      });
      return pending;
    },
    known() {
      return [...values];
    },
    clear() {
      cache = new Map();
      values.clear();
    },
  };
}
