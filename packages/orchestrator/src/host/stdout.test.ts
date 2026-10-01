import { PROTOCOL_VERSION } from '@desiide/protocol';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkg = join(import.meta.dirname, '../..');
let dir: string;
let bundle: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'desiide-orch-stdout-'));
  bundle = join(dir, 'noisy.js');
  execFileSync(process.execPath, [
    join(pkg, 'scripts/build.mjs'),
    '--entry',
    join(import.meta.dirname, '__fixtures__/noisy-main.ts'),
    '--outfile',
    bundle,
  ]);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function frame(message: object): string {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Strict LSP-style framing parser: throws on anything that isn't a well-formed frame. */
function parseFrames(raw: Buffer): unknown[] {
  const messages: unknown[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0)
      throw new Error(`trailing bytes on stdout: ${JSON.stringify(rest.toString())}`);
    const header = rest.subarray(0, headerEnd).toString('ascii');
    const match = /^Content-Length: (\d+)(\r\nContent-Type: [^\r\n]+)?$/.exec(header);
    if (!match?.[1]) throw new Error(`not a frame header: ${JSON.stringify(header)}`);
    const start = headerEnd + 4;
    const end = start + Number(match[1]);
    if (end > rest.length) throw new Error('truncated frame on stdout');
    const message = JSON.parse(rest.subarray(start, end).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(message.jsonrpc).toBe('2.0');
    messages.push(message);
    rest = rest.subarray(end);
  }
  return messages;
}

describe('stdout carries only RPC frames (bundled process)', () => {
  it('redirects console and stdout writes from handlers to stderr', async () => {
    const logDir = join(dir, 'logs');
    const child = spawn(process.execPath, [bundle, '--log-dir', logDir, '--log-level', 'debug'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

    child.stdin.write(
      frame({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: 't', version: '1' },
          workspaceRoots: ['/ws'],
        },
      }),
    );
    child.stdin.write(frame({ id: 2, method: 'task.list', params: {} }));
    child.stdin.write(frame({ id: 3, method: 'health.ping', params: {} }));

    // Wait for all three responses, then close stdin: the process must exit on its own.
    const deadline = Date.now() + 10_000;
    while (parseSafe(Buffer.concat(stdout)).length < 3) {
      if (Date.now() > deadline) throw new Error(`no responses; stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    child.stdin.end();
    expect(await exited).toBe(0);

    const messages = parseFrames(Buffer.concat(stdout));
    expect(messages).toHaveLength(3);
    expect(messages).toEqual([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ protocolVersion: PROTOCOL_VERSION }),
      }),
      { jsonrpc: '2.0', id: 2, result: { tasks: [] } },
      expect.objectContaining({ id: 3, result: expect.objectContaining({ ok: true }) }),
    ]);

    expect(stderr).toContain('console.log from a handler');
    expect(stderr).toContain('console.info');
    expect(stderr).toContain('process.stdout.write from a handler');
    expect(stderr).toContain('"msg":"initialized"');

    const logFile = readFileSync(join(logDir, 'orchestrator.log'), 'utf8');
    expect(logFile).toContain('"msg":"orchestrator started"');
    expect(logFile).toContain('"msg":"orchestrator shutting down"');
  }, 20_000);
});

function parseSafe(raw: Buffer): unknown[] {
  try {
    return parseFrames(raw);
  } catch {
    return [];
  }
}
