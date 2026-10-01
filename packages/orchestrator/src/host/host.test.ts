import { PROTOCOL_VERSION, RpcErrorCode } from '@desiide/protocol';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import {
  ErrorCodes,
  ResponseError,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHost, type Host, type HostOptions } from './host.ts';

const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  client: { name: 'test', version: '1.0.0' },
  workspaceRoots: ['/ws'],
};

interface Pair {
  host: Host;
  client: MessageConnection;
  server: MessageConnection;
}

const pairs: Pair[] = [];

/** Two connections wired back to back over in-memory pipes. */
function connect(options: Partial<HostOptions> = {}): Pair {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createMessageConnection(toServer, toClient);
  const client = createMessageConnection(toClient, toServer);
  const host = createHost({ connection: server, logger: pino({ level: 'silent' }), ...options });
  server.listen();
  client.listen();
  const pair = { host, client, server };
  pairs.push(pair);
  return pair;
}

async function rpcError(promise: Promise<unknown>): Promise<ResponseError<unknown>> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof ResponseError))
    throw new Error(`expected a ResponseError, got ${String(err)}`);
  return err;
}

afterEach(() => {
  for (const { client, server } of pairs.splice(0)) {
    client.dispose();
    server.dispose();
  }
});

describe('host router', () => {
  it('round-trips initialize and health.ping', async () => {
    let t = 1000;
    const { client, host } = connect({ now: () => t, server: { name: 'orch', version: '9.9.9' } });
    await expect(client.sendRequest('initialize', INIT)).resolves.toEqual({
      protocolVersion: PROTOCOL_VERSION,
      server: { name: 'orch', version: '9.9.9' },
    });
    expect(host.session?.workspaceRoots).toEqual(['/ws']);
    t = 1250;
    await expect(client.sendRequest('health.ping', {})).resolves.toEqual({
      ok: true,
      uptimeMs: 250,
    });
  });

  it('rejects invalid params with InvalidParams and the zod message', async () => {
    const { client } = connect();
    const err = await rpcError(
      client.sendRequest('initialize', { ...INIT, workspaceRoots: [], extra: 1 }),
    );
    expect(err.code).toBe(ErrorCodes.InvalidParams);
    expect(err.message).toContain('Invalid params for "initialize"');
    expect(err.message).toMatch(/workspaceRoots/);
    expect(err.message).toMatch(/Unrecognized key.*extra/);

    await client.sendRequest('initialize', INIT);
    const ping = await rpcError(client.sendRequest('health.ping', { unexpected: true }));
    expect(ping.code).toBe(ErrorCodes.InvalidParams);
    expect(ping.message).toMatch(/Unrecognized key.*unexpected/);
  });

  it('treats missing params as {}', async () => {
    const { client } = connect();
    await client.sendRequest('initialize', INIT);
    await expect(client.sendRequest('health.ping')).resolves.toMatchObject({ ok: true });
  });

  it('requires initialize first', async () => {
    const { client } = connect();
    const err = await rpcError(client.sendRequest('health.ping', {}));
    expect(err.code).toBe(RpcErrorCode.NotInitialized);
  });

  it('rejects a second initialize', async () => {
    const { client } = connect();
    await client.sendRequest('initialize', INIT);
    const err = await rpcError(client.sendRequest('initialize', INIT));
    expect(err.code).toBe(ErrorCodes.InvalidRequest);
  });

  it('answers a protocol major mismatch with ProtocolMismatch and a user-facing message', async () => {
    const { client, host } = connect();
    const err = await rpcError(
      client.sendRequest('initialize', { ...INIT, protocolVersion: '2.0.0' }),
    );
    expect(err.code).toBe(RpcErrorCode.ProtocolMismatch);
    expect(err.message).toMatch(/Protocol mismatch.*Update Desiide/);
    expect(err.data).toEqual({ serverVersion: PROTOCOL_VERSION });
    expect(host.session).toBeUndefined();
  });

  it('accepts a newer minor version', async () => {
    const { client } = connect();
    await expect(
      client.sendRequest('initialize', { ...INIT, protocolVersion: '1.7.0' }),
    ).resolves.toBeTruthy();
  });

  it('answers unknown methods with MethodNotFound and unregistered ones with NotImplemented', async () => {
    const { client } = connect();
    await client.sendRequest('initialize', INIT);
    expect((await rpcError(client.sendRequest('nope', {}))).code).toBe(ErrorCodes.MethodNotFound);
    const err = await rpcError(client.sendRequest('task.list', {}));
    expect(err.code).toBe(RpcErrorCode.NotImplemented);
    expect(err.message).toContain('task.list');
  });

  it('dispatches registered handlers with parsed params (defaults applied)', async () => {
    const { client, host } = connect();
    const seen: unknown[] = [];
    host.register('models.list', (params) => {
      seen.push(params);
      return { models: [], discovered: [] };
    });
    await client.sendRequest('initialize', INIT);
    await expect(client.sendRequest('models.list', {})).resolves.toEqual({
      models: [],
      discovered: [],
    });
    expect(seen).toEqual([{ discover: false }]);
  });

  it('refuses duplicate and built-in registrations', () => {
    const { host } = connect();
    host.register('task.list', () => ({ tasks: [] }));
    expect(() => host.register('task.list', () => ({ tasks: [] }))).toThrow(/already registered/);
    expect(() => host.register('health.ping', () => ({ ok: true, uptimeMs: 0 }))).toThrow(
      /already registered/,
    );
  });

  it('turns handler exceptions and invalid results into InternalError', async () => {
    const { client, host } = connect();
    host.register('task.list', () => {
      throw new Error('boom');
    });
    // @ts-expect-error: deliberately returns a result that breaks the contract.
    host.register('jev.test', () => ({ ok: 'yes' }));
    await client.sendRequest('initialize', INIT);
    const thrown = await rpcError(client.sendRequest('task.list', {}));
    expect(thrown.code).toBe(ErrorCodes.InternalError);
    expect(thrown.message).toContain('boom');
    const invalid = await rpcError(client.sendRequest('jev.test', {}));
    expect(invalid.code).toBe(ErrorCodes.InternalError);
    expect(invalid.message).toContain('invalid result');
  });

  it('passes through ResponseErrors thrown by handlers', async () => {
    const { client, host } = connect();
    host.register('task.cancel', () => {
      throw new ResponseError(RpcErrorCode.TaskNotFound, 'no such task');
    });
    await client.sendRequest('initialize', INIT);
    const err = await rpcError(client.sendRequest('task.cancel', { taskId: 't1' }));
    expect(err.code).toBe(RpcErrorCode.TaskNotFound);
  });
});

describe('host services', () => {
  it('requestSecret asks the extension via secrets.get', async () => {
    const { client, host } = connect();
    const seen: unknown[] = [];
    client.onRequest('secrets.get', (params: unknown) => {
      seen.push(params);
      return { value: 'sk-test' };
    });
    await expect(host.requestSecret('secret:anthropic')).resolves.toBe('sk-test');
    expect(seen).toEqual([{ ref: 'secret:anthropic' }]);
  });

  it('requestSecret returns null for unset secrets and rejects malformed refs and results', async () => {
    const { client, host } = connect();
    let reply: unknown = { value: null };
    client.onRequest('secrets.get', () => reply);
    await expect(host.requestSecret('secret:missing')).resolves.toBeNull();
    await expect(host.requestSecret('not-a-ref')).rejects.toThrow();
    reply = { value: 42 };
    const err: unknown = await host.requestSecret('secret:x').catch((e: unknown) => e);
    expect(String(err)).toContain('malformed');
    expect(String(err)).not.toContain('42');
  });

  it('requestSecret honors its AbortSignal', async () => {
    const { client, host } = connect();
    client.onRequest('secrets.get', () => new Promise(() => {}));
    const abort = new AbortController();
    const pending = host.requestSecret('secret:slow', abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
  });

  it('notify validates and sends notifications', async () => {
    const { client, host } = connect();
    const received = new Promise((resolve) => client.onNotification('log', resolve));
    const payload = { level: 'info' as const, message: 'hi', ts: '2026-10-01T00:00:00.000Z' };
    await host.notify('log', payload);
    await expect(received).resolves.toEqual(payload);
    // @ts-expect-error: invalid level
    await expect(host.notify('log', { ...payload, level: 'loud' })).rejects.toThrow();
  });

  it('shutdown aborts handlers, runs hooks, kills tracked process groups, once', async () => {
    const killed: number[] = [];
    const { client, host } = connect({ killProcessGroup: (pid) => killed.push(pid) });
    let handlerSignal: AbortSignal | undefined;
    host.register('task.list', (_p, { signal }) => {
      handlerSignal = signal;
      return new Promise(() => {});
    });
    const hook = vi.fn();
    host.onShutdown(hook);
    host.onShutdown(() => {
      throw new Error('hook failure is logged, not fatal');
    });
    host.trackProcessGroup(101);
    const untrack = host.trackProcessGroup(102);
    untrack();
    await client.sendRequest('initialize', INIT);
    void client.sendRequest('task.list', {}).catch(() => {});
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());

    await Promise.all([host.shutdown('test'), host.shutdown('again')]);
    expect(handlerSignal?.aborted).toBe(true);
    expect(host.signal.aborted).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(killed).toEqual([101]);
  });

  it('cancelling a request aborts its handler signal', async () => {
    const { client, host } = connect();
    let handlerSignal: AbortSignal | undefined;
    host.register('task.list', (_p, { signal }) => {
      handlerSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    });
    await client.sendRequest('initialize', INIT);
    const { CancellationTokenSource } = await import('vscode-jsonrpc/node');
    const source = new CancellationTokenSource();
    const pending = client.sendRequest('task.list', {}, source.token).catch((e: unknown) => e);
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());
    source.cancel();
    await pending;
    expect(handlerSignal?.aborted).toBe(true);
  });
});
