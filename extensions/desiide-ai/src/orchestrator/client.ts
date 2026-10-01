import {
  ClientMethods,
  LogNotification,
  PROTOCOL_VERSION,
  RpcErrorCode,
  ServerMethods,
  checkProtocolCompatibility,
  parseTaskEvent,
  type ClientMethod,
  type ParamsInputOf,
  type ResultOf,
  type TaskEvent,
} from '@desiide/protocol';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  CancellationTokenSource,
  ErrorCodes,
  ResponseError,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import * as z from 'zod';
import type { Logger } from '../log.ts';
import { RestartPolicy, type RestartPolicyOptions } from './restartPolicy.ts';
import { forwardStderrLine } from './stderr.ts';

export type OrchestratorStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'ready'; pid: number | undefined; serverVersion: string }
  | { state: 'restarting'; attempt: number; delayMs: number; reason: string }
  | { state: 'failed'; reason: 'crash_loop' | 'protocol_mismatch'; message: string }
  | { state: 'stopped' };

export type OrchestratorErrorKind =
  | 'unavailable'
  | 'protocol_mismatch'
  | 'no_workspace'
  | 'start_failed'
  | 'invalid_params'
  | 'invalid_response'
  | 'aborted'
  | 'disposed';

export class OrchestratorError extends Error {
  readonly kind: OrchestratorErrorKind;
  constructor(kind: OrchestratorErrorKind, message: string) {
    super(message);
    this.name = 'OrchestratorError';
    this.kind = kind;
  }
}

/** The slice of `ChildProcess` the client uses, so tests can substitute an in-process server. */
export interface OrchestratorProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnOrchestrator = (modulePath: string, args: string[]) => OrchestratorProcess;

/** Resolves `secret:<name>` refs. Returns `null` when the secret isn't set. */
export type SecretResolver = (ref: string) => Promise<string | null>;

export interface Disposable {
  dispose(): void;
}

export interface OrchestratorClientOptions {
  /** Path to the bundled `orchestrator.js`. */
  modulePath: string;
  /** The extension's log dir; the orchestrator writes a rotating `orchestrator.log` there. */
  logDir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  workspaceRoots: () => string[];
  client: { name: string; version: string };
  secrets: SecretResolver;
  log: Logger;
  spawn?: SpawnOrchestrator;
  restartPolicy?: RestartPolicyOptions;
  initTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL when stopping. */
  stopTimeoutMs?: number;
  now?: () => number;
}

/**
 * `fork` runs the bundle on the editor's own runtime (`process.execPath` with
 * `ELECTRON_RUN_AS_NODE`), so users don't need a system Node.
 */
export const forkOrchestrator: SpawnOrchestrator = (modulePath, args) =>
  fork(modulePath, args, {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

interface Session {
  child: OrchestratorProcess;
  connection: MessageConnection;
  exited: Promise<void>;
  hasExited: boolean;
  /** Set when we stop the process on purpose, so its exit isn't treated as a crash. */
  intentional: boolean;
}

/**
 * Spawns the orchestrator lazily (first `request`), restarts it after crashes within the restart
 * policy, answers `secrets.get`, and exposes typed `request` / `onEvent`. Has no `vscode` import.
 */
export class OrchestratorClient {
  private readonly opts: OrchestratorClientOptions;
  private readonly policy: RestartPolicy;
  private readonly spawnProcess: SpawnOrchestrator;
  private readonly now: () => number;
  private current: Session | undefined;
  private starting: Promise<Session> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private statusValue: OrchestratorStatus = { state: 'idle' };
  private disposed = false;
  private readonly statusListeners = new Set<(status: OrchestratorStatus) => void>();
  private readonly eventListeners = new Set<(event: TaskEvent) => void>();

  constructor(opts: OrchestratorClientOptions) {
    this.opts = opts;
    this.policy = new RestartPolicy(opts.restartPolicy);
    this.spawnProcess = opts.spawn ?? forkOrchestrator;
    this.now = opts.now ?? Date.now;
  }

  get status(): OrchestratorStatus {
    return this.statusValue;
  }

  onStatus(listener: (status: OrchestratorStatus) => void): Disposable {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  onEvent(listener: (event: TaskEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  async request<M extends ClientMethod>(
    method: M,
    params: ParamsInputOf<M>,
    signal?: AbortSignal,
  ): Promise<ResultOf<M>> {
    const schema = ClientMethods[method];
    const parsed = schema.params.safeParse(params);
    if (!parsed.success) {
      throw new OrchestratorError(
        'invalid_params',
        `Invalid params for "${method}": ${z.prettifyError(parsed.error)}`,
      );
    }
    signal?.throwIfAborted();
    const session = await this.ensureStarted();
    const raw = await this.send(session, method, parsed.data, signal);
    const result = schema.result.safeParse(raw);
    if (!result.success) {
      this.opts.log.error(
        `"${method}" returned an invalid result: ${z.prettifyError(result.error)}`,
      );
      throw new OrchestratorError(
        'invalid_response',
        `The orchestrator sent an invalid "${method}" result.`,
      );
    }
    return result.data as ResultOf<M>;
  }

  /** Manual restart (e.g. the "Restart orchestrator" button): clears the crash-loop guard. */
  async restart(): Promise<void> {
    if (this.disposed)
      throw new OrchestratorError('disposed', 'The orchestrator client was disposed.');
    this.policy.reset();
    this.clearRestartTimer();
    this.starting = undefined;
    if (this.current) await this.stop(this.current);
    this.setStatus({ state: 'idle' });
    await this.beginLaunch();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRestartTimer();
    this.starting = undefined;
    if (this.current) await this.stop(this.current);
    this.setStatus({ state: 'stopped' });
    this.statusListeners.clear();
    this.eventListeners.clear();
  }

  private ensureStarted(): Promise<Session> {
    if (this.disposed) {
      return Promise.reject(
        new OrchestratorError('disposed', 'The orchestrator client was disposed.'),
      );
    }
    const status = this.statusValue;
    if (status.state === 'failed') {
      const kind = status.reason === 'protocol_mismatch' ? 'protocol_mismatch' : 'unavailable';
      return Promise.reject(new OrchestratorError(kind, status.message));
    }
    if (this.current && status.state === 'ready') return Promise.resolve(this.current);
    if (this.starting) return this.starting;
    if (this.opts.workspaceRoots().length === 0) {
      return Promise.reject(new OrchestratorError('no_workspace', 'Open a folder to use Desiide.'));
    }
    return this.beginLaunch();
  }

  private beginLaunch(delayMs = 0): Promise<Session> {
    const launch = (delayMs > 0 ? this.delay(delayMs) : Promise.resolve()).then(() =>
      this.launch(),
    );
    this.starting = launch;
    const clear = (): void => {
      if (this.starting === launch) this.starting = undefined;
    };
    launch.then(clear, clear);
    return launch;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.disposed)
          reject(new OrchestratorError('disposed', 'The orchestrator client was disposed.'));
        else resolve();
      }, ms);
    });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private async launch(): Promise<Session> {
    this.setStatus({ state: 'starting' });
    const args = ['--log-level', this.opts.logLevel ?? 'info'];
    if (this.opts.logDir) args.push('--log-dir', this.opts.logDir);

    let child: OrchestratorProcess;
    try {
      child = this.spawnProcess(this.opts.modulePath, args);
    } catch (err) {
      throw this.startFailed(`Could not start the Desiide orchestrator: ${String(err)}`);
    }
    if (!child.stdin || !child.stdout) {
      child.kill('SIGKILL');
      throw this.startFailed('Could not start the Desiide orchestrator: no stdio pipes.');
    }

    const connection = createMessageConnection(child.stdout, child.stdin);
    let markExited = (): void => {};
    const session: Session = {
      child,
      connection,
      exited: new Promise<void>((resolve) => (markExited = resolve)),
      hasExited: false,
      intentional: false,
    };
    const onGone = (detail: string): void => {
      if (session.hasExited) return;
      session.hasExited = true;
      markExited();
      connection.dispose();
      this.onExit(session, detail);
    };
    child.once('exit', (code, signal) => onGone(`code ${String(code)}, signal ${String(signal)}`));
    child.once('error', (err) => {
      this.opts.log.error(`Orchestrator process error: ${err.message}`);
      onGone(err.message);
    });
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) =>
        forwardStderrLine(line, this.opts.log),
      );
    }
    this.wireConnection(connection);
    connection.listen();
    this.current = session;

    let result: unknown;
    try {
      result = await this.send(
        session,
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          client: this.opts.client,
          workspaceRoots: this.opts.workspaceRoots(),
        },
        AbortSignal.timeout(this.opts.initTimeoutMs ?? 10_000),
      );
    } catch (err) {
      if (err instanceof ResponseError && err.code === RpcErrorCode.ProtocolMismatch) {
        await this.failProtocol(session, err.message);
        throw new OrchestratorError('protocol_mismatch', err.message);
      }
      // A hung or broken process: kill it and let the supervisor decide whether to restart.
      if (!session.hasExited) session.child.kill('SIGKILL');
      throw this.startFailed(`The Desiide orchestrator did not start: ${errorMessage(err)}`);
    }

    const init = ClientMethods.initialize.result.safeParse(result);
    if (!init.success) {
      const message = 'The Desiide orchestrator sent an invalid initialize result. Update Desiide.';
      await this.failProtocol(session, message);
      throw new OrchestratorError('protocol_mismatch', message);
    }
    const compat = checkProtocolCompatibility(PROTOCOL_VERSION, init.data.protocolVersion);
    if (!compat.ok) {
      await this.failProtocol(session, compat.message);
      throw new OrchestratorError('protocol_mismatch', compat.message);
    }
    if (session.hasExited)
      throw this.startFailed('The Desiide orchestrator exited during startup.');

    this.opts.log.info(
      `Orchestrator ready (pid ${String(child.pid)}, server ${init.data.server.version})`,
    );
    this.setStatus({ state: 'ready', pid: child.pid, serverVersion: init.data.server.version });
    return session;
  }

  private startFailed(message: string): OrchestratorError {
    this.opts.log.error(message);
    return new OrchestratorError('start_failed', message);
  }

  private async failProtocol(session: Session, message: string): Promise<void> {
    this.opts.log.error(message);
    // Restarting can't fix a version mismatch: stop and stay failed until a manual restart.
    await this.stop(session);
    this.setStatus({ state: 'failed', reason: 'protocol_mismatch', message });
  }

  private wireConnection(connection: MessageConnection): void {
    connection.onRequest('secrets.get', async (raw: unknown) => {
      const params = ServerMethods['secrets.get'].params.safeParse(raw);
      if (!params.success) {
        throw new ResponseError(ErrorCodes.InvalidParams, z.prettifyError(params.error));
      }
      return { value: await this.opts.secrets(params.data.ref) };
    });
    connection.onNotification('task.event', (raw: unknown) => {
      const parsed = parseTaskEvent(raw);
      if (parsed.status === 'unknown') {
        this.opts.log.debug(`Ignoring unknown task event type "${parsed.type}"`);
      } else if (parsed.status === 'invalid') {
        this.opts.log.warn(`Dropped an invalid task event: ${z.prettifyError(parsed.error)}`);
      } else {
        for (const listener of this.eventListeners) listener(parsed.event);
      }
    });
    connection.onNotification('log', (raw: unknown) => {
      const parsed = LogNotification.safeParse(raw);
      if (parsed.success) this.opts.log[parsed.data.level](`[orchestrator] ${parsed.data.message}`);
    });
  }

  private async send(
    session: Session,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const source = new CancellationTokenSource();
    const races: Array<Promise<unknown>> = [
      session.connection.sendRequest(method, params, source.token),
      session.exited.then(() => {
        throw new OrchestratorError('unavailable', 'The Desiide orchestrator stopped.');
      }),
    ];
    let onAbort: (() => void) | undefined;
    if (signal) {
      races.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            source.cancel();
            reject(new OrchestratorError('aborted', `"${method}" was cancelled.`));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    try {
      return await Promise.race(races);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      source.dispose();
    }
  }

  private onExit(session: Session, detail: string): void {
    if (session !== this.current) return;
    this.current = undefined;
    if (session.intentional || this.disposed) return;

    this.opts.log.warn(`Orchestrator exited unexpectedly (${detail})`);
    const decision = this.policy.onCrash(this.now());
    if (!decision.restart) {
      this.starting = undefined;
      this.setStatus({
        state: 'failed',
        reason: 'crash_loop',
        message:
          'The Desiide orchestrator keeps crashing, so it was stopped. Check the Desiide log, then restart it.',
      });
      return;
    }
    this.setStatus({
      state: 'restarting',
      attempt: decision.attempt,
      delayMs: decision.delayMs,
      reason: detail,
    });
    this.beginLaunch(decision.delayMs).catch((err: unknown) =>
      this.opts.log.debug(`Orchestrator restart attempt failed: ${errorMessage(err)}`),
    );
  }

  private async stop(session: Session): Promise<void> {
    session.intentional = true;
    if (session.hasExited) return;
    session.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!session.hasExited) session.child.kill('SIGKILL');
    }, this.opts.stopTimeoutMs ?? 2_000);
    await session.exited;
    clearTimeout(timer);
  }

  private setStatus(status: OrchestratorStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        this.opts.log.error(`Orchestrator status listener failed: ${errorMessage(err)}`);
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
