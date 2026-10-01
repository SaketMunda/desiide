import {
  ClientMethods,
  PROTOCOL_VERSION,
  RpcErrorCode,
  SecretRef,
  ServerMethods,
  ServerNotifications,
  checkProtocolCompatibility,
  type ClientMethod,
  type NotificationOf,
  type ParamsOf,
  type ResultOf,
  type ServerNotification,
} from '@desiide/protocol';
import {
  CancellationTokenSource,
  ErrorCodes,
  ResponseError,
  type CancellationToken,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import * as z from 'zod';
import type { Logger } from './logger.ts';

export interface HandlerContext {
  /** Aborted when the client cancels the request or the host shuts down. */
  signal: AbortSignal;
  host: Host;
}

export type Handler<M extends ClientMethod> = (
  params: ParamsOf<M>,
  ctx: HandlerContext,
) => ResultOf<M> | Promise<ResultOf<M>>;

export interface Session {
  protocolVersion: string;
  client: { name: string; version: string };
  workspaceRoots: string[];
}

export interface Host {
  /** Plug a method in without editing the router. Each method can be registered once. */
  register<M extends ClientMethod>(method: M, handler: Handler<M>): void;
  /** Reverse request to the extension. `null` when the secret isn't set. */
  requestSecret(ref: string, signal?: AbortSignal): Promise<string | null>;
  notify<N extends ServerNotification>(name: N, payload: NotificationOf<N>): Promise<void>;
  /** Runs on shutdown (e.g. abort tasks). Hooks must not throw; failures are logged. */
  onShutdown(hook: () => void | Promise<void>): void;
  /** Child process groups (spawned `detached`) that are killed on shutdown. Returns an untrack fn. */
  trackProcessGroup(pid: number): () => void;
  /** Set once `initialize` succeeded. */
  readonly session: Session | undefined;
  /** Aborted on shutdown. Long-running work should link to it. */
  readonly signal: AbortSignal;
  shutdown(reason: string): Promise<void>;
}

export interface HostOptions {
  connection: MessageConnection;
  logger: Logger;
  server?: { name: string; version: string };
  now?: () => number;
  killProcessGroup?: (pid: number) => void;
}

type InternalHandler = (params: unknown, ctx: HandlerContext) => unknown;

const BUILT_IN = new Set<ClientMethod>(['initialize', 'health.ping']);

function isClientMethod(method: string): method is ClientMethod {
  return Object.hasOwn(ClientMethods, method);
}

function defaultKillProcessGroup(pid: number): void {
  process.kill(-pid, 'SIGKILL');
}

export function createHost({
  connection,
  logger,
  server = { name: 'desiide-orchestrator', version: '0.0.0' },
  now = Date.now,
  killProcessGroup = defaultKillProcessGroup,
}: HostOptions): Host {
  const startedAt = now();
  const handlers = new Map<ClientMethod, InternalHandler>();
  const shutdownHooks: Array<() => void | Promise<void>> = [];
  const processGroups = new Set<number>();
  const lifetime = new AbortController();
  let session: Session | undefined;
  let shuttingDown: Promise<void> | undefined;

  const set = <M extends ClientMethod>(method: M, handler: Handler<M>): void => {
    handlers.set(method, (params, ctx) => handler(params as ParamsOf<M>, ctx));
  };

  const host: Host = {
    register(method, handler) {
      if (BUILT_IN.has(method) || handlers.has(method)) {
        throw new Error(`RPC method "${method}" is already registered`);
      }
      set(method, handler);
    },

    async requestSecret(ref, signal) {
      const parsedRef = SecretRef.parse(ref);
      signal?.throwIfAborted();
      const source = new CancellationTokenSource();
      // jsonrpc's cancel only notifies the peer; reject locally so callers never hang.
      let onAbort = (): void => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          source.cancel();
          reject(
            signal?.reason instanceof Error ? signal.reason : new Error('secrets.get aborted'),
          );
        };
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const raw: unknown = await Promise.race([
          connection.sendRequest('secrets.get', { ref: parsedRef }, source.token),
          aborted,
        ]);
        const result = ServerMethods['secrets.get'].result.safeParse(raw);
        if (!result.success) {
          // Don't echo the payload: it may contain the secret.
          throw new Error('secrets.get returned a malformed result');
        }
        return result.data.value;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        source.dispose();
      }
    },

    async notify(name, payload) {
      const parsed = ServerNotifications[name].parse(payload);
      await connection.sendNotification(name, parsed);
    },

    onShutdown(hook) {
      shutdownHooks.push(hook);
    },

    trackProcessGroup(pid) {
      processGroups.add(pid);
      return () => processGroups.delete(pid);
    },

    get session() {
      return session;
    },

    get signal() {
      return lifetime.signal;
    },

    shutdown(reason) {
      shuttingDown ??= (async () => {
        logger.info({ reason }, 'orchestrator shutting down');
        lifetime.abort(new Error(`orchestrator shutting down: ${reason}`));
        for (const hook of shutdownHooks) {
          try {
            await hook();
          } catch (err) {
            logger.error({ err }, 'shutdown hook failed');
          }
        }
        for (const pid of processGroups) {
          try {
            killProcessGroup(pid);
          } catch (err) {
            // ESRCH: the group already exited.
            logger.debug({ err, pid }, 'process group kill failed');
          }
        }
        processGroups.clear();
        connection.dispose();
      })();
      return shuttingDown;
    },
  };

  set('initialize', (params) => {
    if (session) {
      throw new ResponseError(ErrorCodes.InvalidRequest, 'initialize was already called');
    }
    const compat = checkProtocolCompatibility(PROTOCOL_VERSION, params.protocolVersion);
    if (!compat.ok) {
      logger.warn({ remote: params.protocolVersion }, compat.message);
      throw new ResponseError(RpcErrorCode.ProtocolMismatch, compat.message, {
        serverVersion: PROTOCOL_VERSION,
      });
    }
    session = {
      protocolVersion: params.protocolVersion,
      client: params.client,
      workspaceRoots: params.workspaceRoots,
    };
    logger.info({ client: params.client, roots: params.workspaceRoots.length }, 'initialized');
    return { protocolVersion: PROTOCOL_VERSION, server };
  });
  set('health.ping', () => ({ ok: true as const, uptimeMs: Math.max(0, now() - startedAt) }));

  connection.onRequest(async (method, rawParams, token) => dispatch(method, rawParams, token));

  async function dispatch(method: string, rawParams: unknown, token: CancellationToken) {
    if (!isClientMethod(method)) {
      throw new ResponseError(ErrorCodes.MethodNotFound, `Unknown method "${method}"`);
    }
    if (!session && method !== 'initialize') {
      throw new ResponseError(
        RpcErrorCode.NotInitialized,
        '"initialize" must be the first request',
      );
    }
    if (Array.isArray(rawParams)) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'params must be an object');
    }
    const schema = ClientMethods[method];
    const params = schema.params.safeParse(rawParams ?? {});
    if (!params.success) {
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `Invalid params for "${method}": ${z.prettifyError(params.error)}`,
      );
    }
    const handler = handlers.get(method);
    if (!handler) {
      throw new ResponseError(RpcErrorCode.NotImplemented, `"${method}" is not implemented yet`);
    }

    const requestAbort = new AbortController();
    const cancel = token.onCancellationRequested(() =>
      requestAbort.abort(new Error('request cancelled')),
    );
    const signal = AbortSignal.any([requestAbort.signal, lifetime.signal]);
    try {
      const result: unknown = await handler(params.data, { signal, host });
      const checked = schema.result.safeParse(result);
      if (!checked.success) {
        logger.error(
          { method, issues: checked.error.issues },
          'handler returned an invalid result',
        );
        throw new ResponseError(ErrorCodes.InternalError, `"${method}" produced an invalid result`);
      }
      return checked.data;
    } catch (err) {
      if (err instanceof ResponseError) throw err;
      logger.error({ err, method }, 'handler failed');
      const message = err instanceof Error ? err.message : String(err);
      throw new ResponseError(ErrorCodes.InternalError, `"${method}" failed: ${message}`);
    } finally {
      cancel.dispose();
    }
  }

  return host;
}
