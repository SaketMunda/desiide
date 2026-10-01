import { createHost, type Host } from '@desiide/orchestrator';
import { PROTOCOL_VERSION, RpcErrorCode, type TaskEvent } from '@desiide/protocol';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import {
  ResponseError,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../log.ts';
import {
  OrchestratorClient,
  type OrchestratorClientOptions,
  type OrchestratorProcess,
  type OrchestratorStatus,
  type SpawnOrchestrator,
} from './client.ts';

let nextPid = 1000;

/** An in-process orchestrator behind fake stdio pipes. */
class FakeChild extends EventEmitter implements OrchestratorProcess {
  readonly pid = nextPid++;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly connection: MessageConnection;
  readonly host: Host | undefined;
  readonly signals: string[] = [];
  private gone = false;

  constructor(setup: Setup) {
    super();
    this.connection = createMessageConnection(this.stdin, this.stdout);
    if (setup.raw) {
      setup.raw(this.connection);
    } else {
      this.host = createHost({ connection: this.connection, logger: pino({ level: 'silent' }) });
      setup.configure?.(this.host);
    }
    this.connection.listen();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (setupIgnoresSigterm.has(this) && signal === 'SIGTERM') return true;
    this.exit(null, signal);
    return true;
  }

  crash(code = 1): void {
    this.exit(code, null);
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.gone) return;
    this.gone = true;
    this.connection.dispose();
    setImmediate(() => this.emit('exit', code, signal));
  }
}
const setupIgnoresSigterm = new WeakSet<FakeChild>();

interface Setup {
  configure?: (host: Host) => void;
  /** Replace the real host with a hand-written server. */
  raw?: (connection: MessageConnection) => void;
  ignoreSigterm?: boolean;
}

function memoryLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (m: string) => lines.push(`${level}: ${m}`);
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const clients: OrchestratorClient[] = [];

function setup(server: Setup = {}, overrides: Partial<OrchestratorClientOptions> = {}) {
  const children: FakeChild[] = [];
  const log = memoryLog();
  const statuses: OrchestratorStatus[] = [];
  const secrets = vi.fn((ref: string) => Promise.resolve(ref === 'secret:set' ? 'sk-123' : null));
  const spawn = vi.fn<SpawnOrchestrator>(() => {
    const child = new FakeChild(server);
    if (server.ignoreSigterm) setupIgnoresSigterm.add(child);
    children.push(child);
    return child;
  });
  const client = new OrchestratorClient({
    modulePath: '/ext/dist/orchestrator.js',
    logDir: '/logs',
    workspaceRoots: () => ['/ws'],
    client: { name: 'desiide-ai', version: '0.0.1' },
    secrets,
    log,
    spawn,
    restartPolicy: { baseDelayMs: 1, maxDelayMs: 5 },
    initTimeoutMs: 1_000,
    stopTimeoutMs: 50,
    ...overrides,
  });
  client.onStatus((s) => statuses.push(s));
  clients.push(client);
  return { client, children, spawn, log, statuses, secrets };
}

const states = (statuses: OrchestratorStatus[]) => statuses.map((s) => s.state);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
});

describe('OrchestratorClient: lifecycle', () => {
  it('does not spawn until the first request', async () => {
    const { client, spawn } = setup();
    expect(client.status).toEqual({ state: 'idle' });
    expect(spawn).not.toHaveBeenCalled();
    await client.request('health.ping', {});
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toEqual([
      '/ext/dist/orchestrator.js',
      ['--log-level', 'info', '--log-dir', '/logs'],
    ]);
  });

  it('spawns once for concurrent first requests and reports starting → ready', async () => {
    const { client, spawn, statuses, children } = setup();
    const [a, b] = await Promise.all([
      client.request('health.ping', {}),
      client.request('health.ping', {}),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(states(statuses)).toEqual(['starting', 'ready']);
    expect(client.status).toMatchObject({ state: 'ready', pid: children[0]?.pid });
    expect(children[0]?.host?.session?.client).toEqual({ name: 'desiide-ai', version: '0.0.1' });
  });

  it('validates params before spawning', async () => {
    const { client, spawn } = setup();
    // @ts-expect-error: unknown key
    await expect(client.request('health.ping', { nope: 1 })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses to start without a workspace folder', async () => {
    const { client, spawn } = setup({}, { workspaceRoots: () => [] });
    await expect(client.request('health.ping', {})).rejects.toMatchObject({
      kind: 'no_workspace',
      message: 'Open a folder to use Desiide.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes server errors through as ResponseErrors', async () => {
    const { client } = setup();
    const err: unknown = await client.request('task.list', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseError);
    expect((err as ResponseError).code).toBe(RpcErrorCode.NotImplemented);
  });

  it('rejects results that break the contract', async () => {
    const { client, log } = setup({
      configure: (host) =>
        // @ts-expect-error: deliberately broken server
        host.register('task.list', () => ({ tasks: 'nope' })),
    });
    // The host validates its own results first, so this surfaces as an InternalError.
    await expect(client.request('task.list', {})).rejects.toBeInstanceOf(ResponseError);
    expect(log.lines.join('\n')).not.toContain('sk-');
  });

  it('honors AbortSignal on requests', async () => {
    const { client } = setup({
      configure: (host) => host.register('task.list', () => new Promise(() => {})),
    });
    await client.request('health.ping', {});
    const abort = new AbortController();
    const pending = client.request('task.list', {}, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('dispose stops the process with SIGTERM, escalating to SIGKILL', async () => {
    const { client, children, statuses } = setup({ ignoreSigterm: true });
    await client.request('health.ping', {});
    await client.dispose();
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(states(statuses).at(-1)).toBe('stopped');
    await expect(client.request('health.ping', {})).rejects.toMatchObject({ kind: 'disposed' });
  });
});

describe('OrchestratorClient: supervisor', () => {
  it('restarts after a crash and reports restarting → starting → ready', async () => {
    const { client, children, statuses, spawn } = setup();
    await client.request('health.ping', {});
    children[0]?.crash();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(client.status.state).toBe('ready'));
    expect(states(statuses)).toEqual(['starting', 'ready', 'restarting', 'starting', 'ready']);
    expect(statuses[2]).toMatchObject({ state: 'restarting', attempt: 1, delayMs: 1 });
    await expect(client.request('health.ping', {})).resolves.toMatchObject({ ok: true });
  });

  it('gives up after 3 restarts in the window, then recovers on a manual restart', async () => {
    let t = 0;
    const { client, children, spawn } = setup({}, { now: () => t });
    await client.request('health.ping', {});
    for (let i = 0; i < 3; i++) {
      children.at(-1)?.crash();
      t += 1_000;
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(i + 2));
      await vi.waitFor(() => expect(client.status.state).toBe('ready'));
    }
    children.at(-1)?.crash();
    await vi.waitFor(() => expect(client.status.state).toBe('failed'));
    expect(client.status).toMatchObject({ reason: 'crash_loop' });
    expect(spawn).toHaveBeenCalledTimes(4);
    await expect(client.request('health.ping', {})).rejects.toMatchObject({ kind: 'unavailable' });

    await client.restart();
    expect(client.status.state).toBe('ready');
    await expect(client.request('health.ping', {})).resolves.toMatchObject({ ok: true });
  });

  it('forgets crashes older than the window', async () => {
    let t = 0;
    const { client, children } = setup({}, { now: () => t });
    await client.request('health.ping', {});
    for (let i = 0; i < 5; i++) {
      children.at(-1)?.crash();
      t += 30_000;
      await vi.waitFor(() => expect(children).toHaveLength(i + 2));
      await vi.waitFor(() => expect(client.status.state).toBe('ready'));
    }
  });

  it('treats an initialize timeout as a crash', async () => {
    let calls = 0;
    const { client, statuses } = setup(
      {
        raw: (conn) =>
          conn.onRequest('initialize', () =>
            ++calls === 1
              ? new Promise(() => {})
              : { protocolVersion: PROTOCOL_VERSION, server: { name: 's', version: '1' } },
          ),
      },
      { initTimeoutMs: 30 },
    );
    await expect(client.request('health.ping', {})).rejects.toMatchObject({ kind: 'start_failed' });
    await vi.waitFor(() => expect(client.status.state).toBe('ready'));
    expect(states(statuses)).toContain('restarting');
  });
});

describe('OrchestratorClient: protocol version', () => {
  it('fails with a clear message and does not restart on ProtocolMismatch from the server', async () => {
    const message =
      'Protocol mismatch: extension speaks 1.0.0, orchestrator speaks 2.0.0. Update Desiide so both sides match.';
    const { client, spawn, children } = setup({
      raw: (conn) =>
        conn.onRequest('initialize', () => {
          throw new ResponseError(RpcErrorCode.ProtocolMismatch, message);
        }),
    });
    await expect(client.request('health.ping', {})).rejects.toMatchObject({
      kind: 'protocol_mismatch',
      message,
    });
    expect(client.status).toEqual({ state: 'failed', reason: 'protocol_mismatch', message });
    expect(children[0]?.signals).toContain('SIGTERM');
    await expect(client.request('health.ping', {})).rejects.toMatchObject({
      kind: 'protocol_mismatch',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails when the server answers with a different major version', async () => {
    const { client } = setup({
      raw: (conn) =>
        conn.onRequest('initialize', () => ({
          protocolVersion: '2.1.0',
          server: { name: 's', version: '9' },
        })),
    });
    await expect(client.request('health.ping', {})).rejects.toMatchObject({
      kind: 'protocol_mismatch',
    });
    expect(client.status).toMatchObject({ state: 'failed', reason: 'protocol_mismatch' });
    expect(client.status.state === 'failed' && client.status.message).toMatch(/Update Desiide/);
  });
});

describe('OrchestratorClient: reverse requests and events', () => {
  it('answers secrets.get from the resolver', async () => {
    const { client, children, secrets } = setup();
    await client.request('health.ping', {});
    const host = children[0]?.host;
    await expect(host?.requestSecret('secret:set')).resolves.toBe('sk-123');
    await expect(host?.requestSecret('secret:unset')).resolves.toBeNull();
    expect(secrets.mock.calls).toEqual([['secret:set'], ['secret:unset']]);
  });

  it('rejects malformed secrets.get params without calling the resolver', async () => {
    const { client, children, secrets } = setup();
    await client.request('health.ping', {});
    await expect(
      children[0]?.connection.sendRequest('secrets.get', { ref: 'raw-key' }),
    ).rejects.toBeInstanceOf(ResponseError);
    expect(secrets).not.toHaveBeenCalled();
  });

  it('delivers valid task events and drops unknown or invalid ones', async () => {
    const { client, children, log } = setup();
    const events: TaskEvent[] = [];
    client.onEvent((e) => events.push(e));
    await client.request('health.ping', {});
    const conn = children[0]?.connection;
    const event = {
      taskId: 't1',
      seq: 0,
      ts: '2026-10-01T00:00:00.000Z',
      type: 'state_changed',
      from: null,
      to: 'queued',
    };
    await conn?.sendNotification('task.event', { ...event, type: 'from_the_future' });
    await conn?.sendNotification('task.event', { ...event, seq: -1 });
    await conn?.sendNotification('task.event', event);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'state_changed', to: 'queued' });
    expect(log.lines.some((l) => l.startsWith('debug') && l.includes('from_the_future'))).toBe(
      true,
    );
    expect(log.lines.some((l) => l.startsWith('warn') && l.includes('invalid task event'))).toBe(
      true,
    );
  });

  it('forwards log notifications and stderr lines to the log', async () => {
    const { client, children, log } = setup();
    await client.request('health.ping', {});
    const child = children[0];
    await child?.host?.notify('log', {
      level: 'warn',
      message: 'heads up',
      ts: '2026-10-01T00:00:00.000Z',
    });
    child?.stderr.write(
      '{"level":50,"time":1,"pid":1,"name":"orchestrator","msg":"bad thing","method":"x"}\n',
    );
    child?.stderr.write('plain console line\n');
    await vi.waitFor(() => {
      expect(log.lines).toContain('info: [orchestrator] plain console line');
      expect(log.lines).toContain('warn: [orchestrator] heads up');
      expect(log.lines).toContain('error: [orchestrator] bad thing {"method":"x"}');
    });
  });
});
