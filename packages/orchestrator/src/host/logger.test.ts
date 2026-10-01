import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { RotatingFile } from './rotatingFile.ts';
import { parseArgs } from './start.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desiide-orch-log-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RotatingFile', () => {
  it('rotates by size and keeps a bounded number of files', () => {
    const dir = tempDir();
    const file = new RotatingFile({ dir, name: 'o.log', maxBytes: 10, keep: 2 });
    for (const line of ['aaaaaaaa\n', 'bbbbbbbb\n', 'cccccccc\n', 'dddddddd\n']) file.write(line);
    file.close();
    expect(readFileSync(join(dir, 'o.log'), 'utf8')).toBe('dddddddd\n');
    expect(readFileSync(join(dir, 'o.log.1'), 'utf8')).toBe('cccccccc\n');
    expect(readFileSync(join(dir, 'o.log.2'), 'utf8')).toBe('bbbbbbbb\n');
    expect(existsSync(join(dir, 'o.log.3'))).toBe(false);
  });

  it('appends to an existing file and counts its size', () => {
    const dir = tempDir();
    const first = new RotatingFile({ dir, name: 'o.log', maxBytes: 12 });
    first.write('12345678\n');
    first.close();
    const second = new RotatingFile({ dir, name: 'o.log', maxBytes: 12 });
    second.write('abcdefgh\n');
    second.close();
    expect(readFileSync(join(dir, 'o.log.1'), 'utf8')).toBe('12345678\n');
    expect(readFileSync(join(dir, 'o.log'), 'utf8')).toBe('abcdefgh\n');
  });
});

describe('createLogger', () => {
  it('writes JSON lines to stderr and the log file, redacting secret-looking fields', () => {
    const dir = tempDir();
    const lines: string[] = [];
    const { logger, close } = createLogger({
      level: 'debug',
      logDir: dir,
      stderr: { write: (l: string) => lines.push(l) },
    });
    logger.debug({ value: 'sk-secret', nested: { apiKey: 'k' } }, 'hello');
    logger.trace('below level');
    close();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({ msg: 'hello', name: 'orchestrator', value: '[redacted]' });
    expect(entry.nested).toEqual({ apiKey: '[redacted]' });
    const file = readFileSync(join(dir, 'orchestrator.log'), 'utf8');
    expect(file).toContain('"msg":"hello"');
    expect(file).not.toContain('sk-secret');
  });
});

describe('parseArgs', () => {
  it('reads --log-dir and --log-level, ignoring unknown or invalid values', () => {
    expect(parseArgs([])).toEqual({ logLevel: 'info' });
    expect(parseArgs(['--log-dir', '/l', '--log-level', 'debug'])).toEqual({
      logDir: '/l',
      logLevel: 'debug',
    });
    expect(parseArgs(['--log-level', 'loud', '--other', 'x', '--log-dir'])).toEqual({
      logLevel: 'info',
    });
  });
});
