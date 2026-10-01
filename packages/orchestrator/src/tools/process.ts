import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

/** Names that look like credentials. Matching vars never reach a child process. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
/**
 * Vars that would let a child drive the editor (`code` CLI over the IPC hook) or change how the
 * Electron binary behaves; the orchestrator itself runs with ELECTRON_RUN_AS_NODE.
 */
const HOST_ONLY =
  /^(ELECTRON_RUN_AS_NODE|VSCODE_IPC_HOOK.*|VSCODE_GIT_IPC_HANDLE|VSCODE_GIT_ASKPASS.*|GIT_ASKPASS)$/;

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SECRET_NAME.test(name) || HOST_ONLY.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Keeps only the last `cap` bytes of a stream. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  dropped = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.size - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
        this.dropped += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
        this.dropped += excess;
      }
    }
  }

  text(): string {
    // The cut can land inside a multi-byte char; drop the replacement char it decodes to.
    const s = Buffer.concat(this.chunks).toString('utf8');
    return this.dropped > 0 ? s.replace(/^�+/, '') : s;
  }
}

export function truncationMarker(droppedBytes: number): string {
  return `[… output truncated: first ${droppedBytes} bytes omitted …]\n`;
}

export type ProcessCommand =
  { kind: 'shell'; command: string } | { kind: 'exec'; file: string; args: readonly string[] };

export interface ProcessOptions {
  cwd: string;
  /** Base environment; it's scrubbed before the child sees it. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputCapBytes?: number;
  /**
   * `tail` (default): stdout + stderr interleaved, keep the last bytes (logs, test output).
   * `head`: keep the first bytes of stdout and stop the process once the cap is hit (listings,
   * search results, diffs); stderr is returned separately.
   */
  capture?: 'tail' | 'head';
  signal?: AbortSignal;
  /** Called with the child's process-group id; returns an untrack fn (see Host.trackProcessGroup). */
  trackProcessGroup?: (pid: number) => () => void;
  /** Injected for tests. */
  killProcessGroup?: (pid: number) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  /**
   * `tail`: combined stdout + stderr in arrival order, with a marker when truncated.
   * `head`: the first `outputCapBytes` of stdout, no marker (the caller knows its format).
   */
  output: string;
  /** `head` capture only: the tail of stderr. */
  stderr?: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Set when the process couldn't be started (e.g. ENOENT). */
  spawnError?: string;
}

function defaultKillGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
}

/**
 * Runs a command in its own process group (`detached`). On timeout or abort the whole group is
 * SIGKILLed, so grandchildren die too. The group is also killed after the main process exits:
 * a leftover background child would keep the pipes open and leak.
 */
export function runProcess(cmd: ProcessCommand, opts: ProcessOptions): Promise<ProcessResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGroup = opts.killProcessGroup ?? defaultKillGroup;
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const head = opts.capture === 'head';
  const tail = new TailBuffer(head ? STDERR_TAIL_BYTES : cap);
  const headChunks: Buffer[] = [];
  let headSize = 0;
  let headFull = false;

  return new Promise((resolvePromise) => {
    if (opts.signal?.aborted) {
      resolvePromise({
        exitCode: null,
        output: '',
        truncated: false,
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      });
      return;
    }
    const spawnOpts = {
      cwd: opts.cwd,
      env: scrubEnv(opts.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    const child =
      cmd.kind === 'shell'
        ? spawn(cmd.command, { ...spawnOpts, shell: true })
        : spawn(cmd.file, [...cmd.args], spawnOpts);

    let timedOut = false;
    let cancelled = false;
    let exitCode: number | null = null;
    let spawnError: string | undefined;
    let settled = false;
    const pid = child.pid;
    const untrack = pid !== undefined ? opts.trackProcessGroup?.(pid) : undefined;

    const kill = (): void => {
      if (pid !== undefined) killGroup(pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => {
      if (!head) return tail.push(c);
      if (headFull) return;
      const room = cap - headSize;
      headChunks.push(c.length > room ? c.subarray(0, room) : c);
      headSize += Math.min(c.length, room);
      if (c.length >= room) {
        headFull = true;
        kill();
      }
    });
    child.stderr.on('data', (c: Buffer) => tail.push(c));

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      untrack?.();
      const truncated = head ? headFull : tail.dropped > 0;
      const output = head
        ? Buffer.concat(headChunks)
            .toString('utf8')
            .replace(/\uFFFD+$/, '')
        : (truncated ? truncationMarker(tail.dropped) : '') + tail.text();
      const result: ProcessResult = {
        exitCode,
        output,
        truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - start,
      };
      if (head) result.stderr = tail.text();
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolvePromise(result);
    };

    child.on('error', (err) => {
      spawnError = err.message;
      finish();
    });
    child.on('exit', (code) => {
      exitCode = code;
      // Reap anything the command left running in its group, so `close` can fire.
      kill();
    });
    child.on('close', finish);
  });
}
