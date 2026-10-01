import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess, scrubEnv, truncationMarker } from './process.ts';

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'desiide-proc-'));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

describe('scrubEnv', () => {
  it('drops credential-looking and host-only vars, keeps the rest', () => {
    const out = scrubEnv({
      PATH: '/bin',
      HOME: '/home/x',
      OPENAI_API_KEY: 'sk-1',
      GITHUB_TOKEN: 'ghp',
      aws_secret_access_key: 'aws',
      DB_PASSWORD: 'pw',
      MYSQL_PASSWD: 'pw',
      GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      SSH_AUTH_SOCK_KEYRING: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_IPC_HOOK_CLI: '/tmp/sock',
      GIT_ASKPASS: '/askpass.sh',
      UNSET: undefined,
    });
    expect(out).toEqual({ PATH: '/bin', HOME: '/home/x' });
  });

  it('a child process never sees scrubbed vars', async () => {
    const r = await runProcess(
      { kind: 'shell', command: 'env' },
      {
        cwd,
        env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-leak', NPM_TOKEN: 'npm-leak', KEEP_ME: 'ok' },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('KEEP_ME=ok');
    expect(r.output).not.toContain('sk-ant-leak');
    expect(r.output).not.toContain('npm-leak');
  });
});

describe('runProcess', () => {
  it('runs in the given cwd and reports the exit code', async () => {
    const r = await runProcess({ kind: 'shell', command: 'pwd; exit 3' }, { cwd, env });
    expect(r.exitCode).toBe(3);
    expect(r.output.trim()).toMatch(/desiide-proc-/);
    expect(r).toMatchObject({ timedOut: false, cancelled: false, truncated: false });
  });

  it('runs a file with args without a shell', async () => {
    const r = await runProcess(
      { kind: 'exec', file: 'echo', args: ['$HOME', ';', 'ls'] },
      { cwd, env },
    );
    expect(r.output.trim()).toBe('$HOME ; ls');
  });

  it('reports a spawn error instead of throwing', async () => {
    const r = await runProcess(
      { kind: 'exec', file: 'definitely-not-a-binary-xyz', args: [] },
      { cwd, env },
    );
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.exitCode).toBeNull();
  });

  it('tail-truncates output over the cap with a marker', async () => {
    const r = await runProcess(
      // 20,000 lines ≈ 200 KB, well over 64 KB; the last line must survive.
      {
        kind: 'shell',
        command: 'i=0; while [ $i -lt 20000 ]; do echo "line $i"; i=$((i+1)); done',
      },
      { cwd, env },
    );
    expect(r.truncated).toBe(true);
    expect(r.output.startsWith('[… output truncated: first ')).toBe(true);
    expect(r.output.trimEnd().endsWith('line 19999')).toBe(true);
    const body = r.output.slice(r.output.indexOf('\n') + 1);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024);
  });

  it('honors a custom cap and drops a split multi-byte char at the cut', async () => {
    const r = await runProcess(
      { kind: 'shell', command: "printf 'ééééééééééABC'" },
      { cwd, env, outputCapBytes: 6 },
    );
    expect(r.truncated).toBe(true);
    expect(r.output).toBe(truncationMarker(17) + 'éABC');
  });

  it('timeout kills the whole process group, including grandchildren', async () => {
    const pidFile = join(cwd, 'grandchild.pid');
    const r = await runProcess(
      // The grandchild is a background sleep in a subshell; it shares the process group.
      { kind: 'shell', command: `(sleep 30 & echo $! > ${pidFile}; wait) ; sleep 30` },
      { cwd, env, timeoutMs: 300 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(5000);
    const { readFile } = await import('node:fs/promises');
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
  });

  it('kills a background child left running after the command exits', async () => {
    const pidFile = join(cwd, 'bg.pid');
    const r = await runProcess(
      { kind: 'shell', command: `sleep 30 > /dev/null 2>&1 & echo $! > ${pidFile}` },
      { cwd, env, timeoutMs: 10_000 },
    );
    expect(r.exitCode).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const bg = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitFor(() => !isAlive(bg))).toBe(true);
  });

  it('abort cancels and kills the group', async () => {
    const ac = new AbortController();
    const p = runProcess({ kind: 'shell', command: 'sleep 30' }, { cwd, env, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('returns immediately when already aborted', async () => {
    const r = await runProcess(
      { kind: 'shell', command: 'echo should-not-run' },
      { cwd, env, signal: AbortSignal.abort() },
    );
    expect(r).toMatchObject({ cancelled: true, output: '' });
  });

  it('tracks the process group with the host and untracks it afterwards', async () => {
    const events: string[] = [];
    await runProcess(
      { kind: 'shell', command: 'true' },
      {
        cwd,
        env,
        trackProcessGroup: (pid) => {
          events.push(`track:${pid > 0}`);
          return () => events.push('untrack');
        },
      },
    );
    expect(events).toEqual(['track:true', 'untrack']);
  });

  it('head capture keeps the start of stdout, stops early, and separates stderr', async () => {
    const r = await runProcess(
      { kind: 'shell', command: 'echo oops >&2; yes line' },
      { cwd, env, capture: 'head', outputCapBytes: 100, timeoutMs: 10_000 },
    );
    expect(r.truncated).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Buffer.byteLength(r.output)).toBe(100);
    expect(r.output.startsWith('line\nline\n')).toBe(true);
    expect(r.stderr).toBe('oops\n');
  });

  it('head capture under the cap is complete and not truncated', async () => {
    const r = await runProcess(
      { kind: 'shell', command: 'echo a; echo b' },
      { cwd, env, capture: 'head' },
    );
    expect(r).toMatchObject({ output: 'a\nb\n', truncated: false, exitCode: 0, stderr: '' });
  });
});
